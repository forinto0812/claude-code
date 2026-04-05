# Claude Code：架构全景解析

> 报告日期：2026-04-01
> 代码库：`claude-code2`（Claude Code 反编译版）

---

## 目录

1. [核心技术栈](#11-核心技术栈)
2. [核心架构设计](#12-核心架构设计)
   - [1.2.1 Agent Loop](#121-agent-loop整个系统的心跳)
   - [1.2.2 工具体系](#122-工具体系内置工具的分类逻辑)
   - [1.2.3 MCP](#123-mcp工具体系的无限扩展口)
   - [1.2.4 Skill 系统](#124-skill-系统把工作流固化成命令)
   - [1.2.5 上下文管理](#125-上下文管理五层机制)
   - [1.2.6 任务系统](#126-任务系统ai-的外部记忆)
   - [1.2.7 Hooks](#127-hooks-扩展机制嵌入已有工具链)
   - [1.2.8 流式执行引擎](#128-流式执行引擎边收边跑)
3. [高级特性](#13-高级特性)
   - [1.3.1 权限系统](#131-权限系统安全边界)
   - [1.3.2 bun:bundle 特性门控](#132-bunbundle-特性门控构建时消除死代码)
   - [1.3.3 IDE 桥接层](#133-ide-桥接层bridge_mode)
   - [1.3.4 多 Agent 协调](#134-多-agent-协调)
4. [其他功能模块](#14-其他功能模块)
   - [1.4.1 记忆系统](#141-记忆系统memdir)
   - [1.4.2 Vim 模式](#142-vim-模式)
   - [1.4.3 协调器模式](#143-协调器模式coordinator)
   - [1.4.4 插件系统](#144-插件系统plugins)
   - [1.4.5 配置迁移](#145-配置迁移migrations)
   - [1.4.6 服务器与远程模块](#146-服务器与远程模块)
   - [1.4.7 伴侣系统](#147-伴侣系统buddy)
5. [架构亮点与缺点](#15-架构亮点与缺点)

---

读完 ClaudeCode 的源码，最大的感受是：这不是一个功能堆砌出来的工具。Agent Loop、工具体系、权限系统、上下文压缩——每个模块都在回答同一个问题：**怎么让 AI 在生产环境里可信赖地执行复杂任务**。想理解它的强处和弱处，得从整体结构开始看。

---

### 1.1 核心技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| **运行时** | Bun | 非 Node.js；原生 TypeScript，无需 tsc 编译 |
| **语言** | TypeScript + TSX | `strict: false`，反编译产物存在 ~1341 个 tsc 错误 |
| **构建产物** | 25MB 单文件 Bundle | `bun build --target bun`，零运行时依赖 |
| **终端 UI** | React 19 + Ink | `react-reconciler` 自定义渲染器驱动终端 |
| **LLM 接入** | `@anthropic-ai/sdk ^0.80.0` | 直连 Anthropic；另有 Bedrock / Vertex / Foundry SDK |
| **Schema 验证** | Zod v4 | 工具输入、配置、权限规则统一用 Zod 验证 |
| **并发控制** | `p-map ^7.0.4` | 工具并发执行的并发数限制 |
| **扩展协议** | `@modelcontextprotocol/sdk ^1.29.0` | MCP 标准 SDK |
| **LSP** | `vscode-languageserver-protocol ^3.17.5` | 语言服务协议（目前仅部分启用）|
| **可观测性** | `@opentelemetry/*` | 链路追踪，反编译版已 stub |

```bash
# 开发运行
bun run src/entrypoints/cli.tsx

# 构建单文件产物
bun build src/entrypoints/cli.tsx --outdir dist --target bun
# → dist/cli.js（25.75 MB，可直接分发，无需 node_modules）
```

---

### 1.2 核心架构设计

#### 1.2.1 Agent Loop：整个系统的心跳

Agent Loop 是 Claude Code 所有能力的执行引擎，位于 `src/query.ts`（1732 行）。理解它需要从三个维度切入：ReAct 模式的消息流转、状态机的控制逻辑、Token 预算的跟踪与恢复。

---

##### ReAct 模式的具体实现

ReAct（Reason → Act → Observe）不是架构文档里的概念，是 `query.ts` 里 `while(true)` 每一轮的实际执行路径。

**Reason**：调用 LLM，流式接收输出

```typescript
for await (const message of deps.callModel(...)) {
  if (message.type === 'assistant') {
    assistantMessages.push(message)

    // 从 content 里提取 tool_use 块
    const toolUseBlocks = message.content
      .filter(c => c.type === 'tool_use') as ToolUseBlock[]

    if (toolUseBlocks.length > 0) {
      needsFollowUp = true   // 触发 Act 阶段的唯一信号
    }

    // 流式执行：不等 LLM 输出完，立即调度
    for (const block of toolUseBlocks) {
      streamingToolExecutor.addTool(block, message)
    }
  }
}
```

`needsFollowUp` 是判断是否执行工具的唯一可靠标志——`stop_reason === 'tool_use'` 在部分模型上不稳定，代码里用 flag 代替。

**Act**：执行工具，收集结果

```typescript
for await (const update of toolUpdates) {
  yield update.message   // 实时输出给 UI

  // 规范化为 Anthropic API 的 user 消息格式
  toolResults.push(
    ...normalizeMessagesForAPI([update.message], tools)
      .filter(m => m.type === 'user')   // tool_result 包在 user 消息里
  )
}
```

每个 `tool_result` 块对应一个 `tool_use` 块，通过 `tool_use_id` 严格关联：

```typescript
{
  type: 'tool_result',
  tool_use_id: toolUseID,   // 必须与对应的 tool_use id 一致
  content: toolOutput,
  is_error: false,
}
```

**Observe**：把工具结果注入下一轮的消息数组

```typescript
state = {
  messages: [
    ...messagesForQuery,    // 历史消息
    ...assistantMessages,   // 本轮 LLM 输出（含 tool_use 块）
    ...toolResults,         // ✅ tool_result 作为新 user 消息追加
  ],
  transition: { reason: 'next_turn' },
  turnCount: turnCount + 1,
  // ...
}
continue  // 带着新 state 回到 while(true) 顶部
```

下一轮 LLM 看到的 messages 就包含了上一轮的工具执行结果——这就是 Observe 阶段。

一个完整的两轮 ReAct 消息结构长这样：

```
Turn 1 messages（发给 LLM）：
  [user: "帮我看下 src/auth.ts 有没有问题"]

Turn 1 LLM 输出：
  [assistant: "我来读一下这个文件 [tool_use id=abc name=FileRead]"]

Turn 2 messages（发给 LLM）：
  [user: "帮我看下 src/auth.ts 有没有问题"]
  [assistant: "我来读一下这个文件 [tool_use id=abc]"]
  [user: [{type: 'tool_result', tool_use_id: 'abc', content: "文件内容..."}]]
                                    ↑ Observe：工具结果注入这里

Turn 2 LLM 输出：
  [assistant: "这个文件有个 SQL 注入风险，在第 47 行..."]
  stop_reason: 'end_turn'，needsFollowUp: false → 完成
```

---

##### 状态机设计与迭代控制逻辑

`State` 对象是整个循环的血液，每轮循环消费它、产出新的 `State`，传给下一轮：

```typescript
type State = {
  messages: Message[]                              // 累积的消息历史
  toolUseContext: ToolUseContext                   // 工具权限、配置、文件快照
  turnCount: number                               // 当前轮次（从 1 开始）
  transition: Transition | undefined             // 本轮为何继续循环（见下）
  autoCompactTracking: AutoCompactTrackingState  // 压缩状态追踪
  maxOutputTokensRecoveryCount: number           // 已尝试 max_tokens 恢复次数
  maxOutputTokensOverride: number | undefined    // 当前请求的 max_tokens 覆盖值
  hasAttemptedReactiveCompact: boolean           // 是否已做过反应式压缩
  pendingToolUseSummary: Promise<...> | undefined // 异步工具摘要
  stopHookActive: boolean | undefined            // 停止钩子是否活跃
}
```

**`transition` 字段**是控制流的核心。循环不是简单的"执行完就退出"，而是根据 `transition.reason` 决定下一步怎么走：

| transition.reason | 触发条件 | 下一步动作 |
|-------------------|---------|----------|
| `next_turn` | 工具执行完，继续对话 | 正常进入下一轮 |
| `collapse_drain_retry` | 首次遇到 PTL（prompt_too_long）| 尝试 context collapse |
| `reactive_compact_retry` | collapse 失败或遇到媒体过大 | 执行反应式压缩 |
| `max_output_tokens_escalate` | 首次 max_tokens，尝试升级 | 8k → 64k max_tokens |
| `max_output_tokens_recovery` | 升级后仍不够，注入恢复消息 | 最多重试 3 次 |
| `stop_hook_blocking` | stop hook 返回阻塞错误 | 注入错误消息重新查询 |
| `token_budget_continuation` | token budget 系统要求继续 | 注入 nudge 消息 |

`transition` 同时还防止无限循环——比如 `collapse_drain_retry` 分支会检查 `state.transition?.reason !== 'collapse_drain_retry'`，确保同一个恢复路径只走一次。

**所有退出路径**（循环的终点）：

```
正常完成：   return { reason: 'completed' }
用户中断：   return { reason: 'aborted_streaming' | 'aborted_tools' }
轮次上限：   return { reason: 'max_turns', turnCount }
PTL 无法恢复：return { reason: 'prompt_too_long' }
模型错误：   return { reason: 'model_error' | 'image_error' }
Hook 停止：  return { reason: 'hook_stopped' | 'blocking_limit' }
```

Turn 计数与上限：

```typescript
const nextTurnCount = turnCount + 1
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({ type: 'max_turns_reached', maxTurns })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

默认无上限，`--max-turns` 可控制。超出时 yield 一条提示消息后干净退出，不截断当前输出。

---

##### Token 预算跟踪与恢复机制

**max_tokens 恢复的三步策略**

当 LLM 因 token 不足返回 `stop_reason: 'max_tokens'` 时，系统不是直接报错，而是逐级尝试恢复：

```
第 1 步：升级（只走一次）
  maxOutputTokensOverride === undefined
  → 设置 maxOutputTokensOverride = 64k
  → transition: { reason: 'max_output_tokens_escalate' }
  → 重新请求

第 2 步：注入恢复消息（最多 3 次）
  maxOutputTokensRecoveryCount < 3
  → 向消息里注入："Output token limit hit. Resume directly from where you left off."
  → maxOutputTokensRecoveryCount++
  → transition: { reason: 'max_output_tokens_recovery', attempt: 1|2|3 }
  → 重新请求

第 3 步：放弃
  maxOutputTokensRecoveryCount >= 3
  → yield 错误消息给用户
  → return { reason: 'completed' }
```

`maxOutputTokensRecoveryCount` 在每次 `next_turn` 时重置为 0，确保每轮独立计数。

**Task Budget 跨压缩边界追踪**

这是一个很容易被忽视的机制。压缩会清除大量消息，但 LLM 需要知道整个任务还剩多少 token 预算——不然压缩后它不知道自己"花了多少"。

```typescript
// 每次压缩前，记录当前已消耗的 context
if (params.taskBudget) {
  const consumed = finalContextTokensFromLastResponse(messagesForQuery)
  taskBudgetRemaining = Math.max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - consumed
  )
}

// 传给 API，让 LLM 知道剩余预算
taskBudget: {
  total: params.taskBudget.total,
  remaining: taskBudgetRemaining,  // 压缩后的剩余量
}
```

**Token 使用量的累积逻辑**（`QueryEngine.ts`）

```typescript
// 每条消息的 token 使用单独追踪
let currentMessageUsage: NonNullableUsage = EMPTY_USAGE

// 流式更新：message_delta 事件携带增量
updateUsage(currentMessageUsage, partUsage)  // 选最新的非零值，避免 0 覆盖

// 消息完成时累加到总量
if (event.type === 'message_stop') {
  this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
}
// totalUsage 跨所有 turn 累积：input + output + cache_read + cache_write
```

**PTL（Prompt Too Long）的完整恢复链**

PTL 的恢复比 max_tokens 更复杂，因为要判断哪种压缩策略有效：

```
PTL 触发
  ↓
① collapse_drain_retry（只走一次）
   → 尝试释放 context collapse 标记之前的消息
   → 如果有效，继续循环
  ↓
② reactive_compact_retry（如果 collapse 无效或遇到媒体过大）
   → 执行反应式压缩（需要 REACTIVE_COMPACT feature flag 开启）
   → hasAttemptedReactiveCompact = true，防止重复
  ↓
③ 两种恢复均失败
   → return { reason: 'prompt_too_long' }
```

反编译版里 `REACTIVE_COMPACT` feature flag 关闭，所以 PTL 只有 collapse_drain 一次机会，失败了就直接报错——这是反编译版和正式版行为差异最明显的地方之一。

---

#### 1.2.2 工具体系：内置工具的分类逻辑

##### Tool 接口：工具的元数据结构

每个工具都是一个实现了 `Tool<Input, Output>` 泛型接口的对象，定义在 `src/Tool.ts`。接口字段不只是功能声明，更是调度引擎用来决定”怎么对待这个工具”的元数据：

```typescript
export type Tool<Input extends AnyObject, Output = unknown> = {
  readonly name: string
  aliases?: string[]

  // Zod schema，用于运行时解析和验证 LLM 输入
  readonly inputSchema: Input

  // 核心执行函数
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress,
  ): Promise<ToolResult<Output>>

  // 调度决策依据：是否可以与其他工具并发执行
  isConcurrencySafe(input: z.infer<Input>): boolean
  // 是否只读（不修改文件系统或环境状态）
  isReadOnly(input: z.infer<Input>): boolean
  // 是否为不可逆操作（影响权限审批提示）
  isDestructive?(input: z.infer<Input>): boolean

  // 权限检查钩子
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>

  // 结果持久化阈值（超过此字符数写磁盘，默认 50k）
  maxResultSizeChars: number
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
}
```

每个工具通过 `buildTool()` 构建，未声明的字段从 `TOOL_DEFAULTS` 填充保守默认值：`isConcurrencySafe` 默认 `false`，`isReadOnly` 默认 `false`。只读工具需要显式声明，主动”解锁”并发权限：

```typescript
// src/tools/GlobTool/GlobTool.ts
export const GlobTool = buildTool({
  name: 'Glob',
  maxResultSizeChars: 100_000,
  isConcurrencySafe() { return true },   // 显式声明安全
  isReadOnly()        { return true },
  // ...
})

// src/tools/BashTool/BashTool.ts — 条件并发安全
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false
},
isReadOnly(input) {
  // 含有 cd、文件写入等操作时返回 false
  return checkReadOnlyConstraints(input).isReadOnly
},
```

---

##### 工具注册：运行时动态组装

工具列表不是静态数组，而是在 `src/tools.ts` 的 `getAllBaseTools()` 里按条件组装。部分工具依赖环境变量或 feature flag：

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool, TaskOutputTool, BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    FileReadTool, FileEditTool, FileWriteTool,
    NotebookEditTool, WebFetchTool, WebSearchTool,
    AskUserQuestionTool, SkillTool,
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool, TungstenTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    // ...
  ]
}
```

最终可用工具池由 `assembleToolPool()` 合并内置工具和 MCP 动态工具，按名称排序以保证提示缓存（Prompt Cache）命中率稳定：

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

---

##### 执行链路：从 tool_use 到结果归还

一次 `tool_use` 从 LLM 发出到结果归还，经过 `src/services/tools/toolExecution.ts` 里的 `checkPermissionsAndCallTool()` 完整链路：

```
[LLM 产出 tool_use block]
  ↓
1. Zod 解析 inputSchema（失败立即返回错误，不进入执行）
  ↓
2. tool.validateInput?()（工具自定义校验逻辑）
  ↓
3. runPreToolUseHooks()（PreToolUse Hook，可修改输入或拦截执行）
  ↓
4. resolveHookPermissionDecision()（合并 Hook 结论与 canUseTool() 决策）
  ↓
5. 权限决策检查：behavior !== 'allow' → 返回拒绝消息，终止
  ↓
6. tool.call()（真正执行）
  ↓
7. mapToolResultToToolResultBlockParam()（输出归一化为 API 格式）
  ↓
8. maybePersistLargeToolResult()（超阈值写磁盘，替换为摘要引用）
  ↓
9. runPostToolUseHooks()（PostToolUse Hook，触发格式化/检查等后续操作）
  ↓
[yield MessageUpdate，作为下一轮 user 消息中的 tool_result 块]
```

---

##### 并发调度：partitionToolCalls 分区逻辑

LLM 可以在一次输出中声明多个 `tool_use` 块。调度引擎 `src/services/tools/toolOrchestration.ts` 不是全部并行也不是全部串行，而是先按 `isConcurrencySafe` 分区：

```typescript
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? Boolean(tool?.isConcurrencySafe(parsedInput.data))
      : false  // 解析失败时保守处理

    // 连续的安全工具合并进同一批次，不安全工具单独成批
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

分区完成后按批执行：

```typescript
for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
  if (isConcurrencySafe) {
    // 并发批次：用 all() 生成器组合器并行执行，上限由 getMaxToolUseConcurrency() 控制（默认 10）
    for await (const update of runToolsConcurrently(blocks, ...)) { yield update }
  } else {
    // 串行批次：逐个执行，前一个完成后才启动下一个
    for await (const update of runToolsSerially(blocks, ...)) { yield update }
  }
}
```

某个工具失败时，`siblingAbortController` 会取消同批次内其他正在运行的工具，避免状态继续漂移。

---

##### 结果持久化：超阈值写磁盘

工具结果不是无条件原样回灌上下文。`src/utils/toolResultStorage.ts` 定义了完整的大结果处理管道：

```typescript
// 全局阈值常量
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000      // 工具声明的默认上限
export const MAX_TOOL_RESULT_TOKENS       = 100_000      // 全局 token 上限
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000 // 单条消息内所有结果合计上限

async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold: number,
): Promise<ToolResultBlockParam> {
  const size = contentSize(toolResultBlock.content)

  if (size <= persistenceThreshold) {
    return toolResultBlock  // 小结果直接返回，不落盘
  }

  // 超阈值：完整内容持久化到临时文件
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)

  // tool_result 替换为摘要 + 路径 + 建议后续操作
  return { ...toolResultBlock, content: buildLargeToolResultMessage(result) }
}
```

每个工具可以通过 `maxResultSizeChars` 字段声明自己的阈值（`GlobTool` 是 100k，`GrepTool` 是 50k，设为 `Infinity` 则禁用持久化）。持久化后模型收到的是”摘要 + 文件路径”，需要细节时再通过 `FileRead` 按需钻取，而不是一次性把完整输出压进上下文。

截断时在换行符边界切割，避免中断结构化输出：

```typescript
export function generatePreview(content: string, maxBytes: number) {
  if (content.length <= maxBytes) return { preview: content, hasMore: false }
  const truncated = content.slice(0, maxBytes)
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes
  return { preview: content.slice(0, cutPoint), hasMore: true }
}
```

---

这套设计的核心逻辑是：`Tool` 接口里的每个布尔方法（`isConcurrencySafe`、`isReadOnly`、`isDestructive`）都是运行时决策依据，不是文档注释。调度引擎、权限系统、结果持久化管道都直接读这些方法的返回值来决定行为。工具不是函数，而是携带了完整调度元数据的执行节点。

**工具目录现状**：`src/tools/` 目录下共 52 个工具目录（另有 `shared/`、`src/`、`testing/`、`utils.ts` 等辅助目录），与文档原文"65 个工具"的说法不符——"65"可能包含了内置工具通过 feature flag 动态加载的变体数量，但实际工具目录为 52 个。部分工具（如 `PowerShellTool`、`TeamCreateTool`、`TeamDeleteTool`、`WorkflowTool`、`ReviewArtifactTool` 等）在反编译版中为存根或 ANT-ONLY 工具。

---

#### 1.2.2.1 查询引擎子模块（src/query/）

`src/query.ts`（1732 行）的伴生目录 `src/query/`（5 个文件）提供专项子模块：

| 文件 | 职责 |
|------|------|
| `tokenBudget.ts` | Token 预算跟踪：`COMPLETION_THRESHOLD = 0.9`、`DIMINISHING_THRESHOLD = 500`，管理 continuation 计数、增量 token、全局 turn token |
| `stopHooks.ts` | Stop Hook 行为实现：与 `src/memdir/paths.ts` 的 `isExtractModeActive()` 集成，记忆提取模式下调整 stop hook 逻辑 |
| `config.ts` | 查询配置常量和配置对象定义 |
| `deps.ts` | 依赖注入类型（测试可替换 `callModel` 等实现） |
| `transitions.ts` | 状态转换辅助函数（补充 `query.ts` 里的 State 机器）|

`tokenBudget.ts` 里的 `BudgetTracker` 是 `src/query.ts` 里 Token 预算跨压缩边界追踪的数据结构载体，二者共同构成完整的 token 预算系统。

---

#### 1.2.3 MCP

MCP 对 Claude Code 的意义，不只是”可以接第三方工具”，而是把外部系统转换成 Agent Loop 能统一调度的能力单元。内置工具解决的是通用操作，MCP 解决的是企业现场里永远接不完的专有系统：代码搜索、工单系统、内部知识库、审计接口、部署平台。`src/services/mcp/client.ts`（3351 行）把本地脚本、远程服务、进程内集成都拉到了同一张执行面上——模型看到的是统一的 tool/resource 接口，背后连的是什么，MCP 客户端已经吃掉了。

---

##### 配置：多范围、多协议、运行时解析

配置文件可以出现在多个层级，按优先级合并：

```
enterprise managed-mcp.json  ← 最高，企业锁定，用户无法覆盖
~/.claude/config.json         ← 用户全局
.mcp.json（项目根）           ← 项目级
--mcp-config CLI 参数         ← 动态注入
claude.ai 连接器              ← 最低（自动去重，与手动配置重复时被抑制）
```

配置解析（`src/services/mcp/config.ts`）会做三件事：展开 `${ENV_VAR}` 占位符、在 Windows 上检测裸 `npx` 并提示加 `cmd /c` 包装、按 URL 签名去重（防止 claude.ai 自动连接器和手动配置的同一服务重复注册）。

五种传输协议的配置格式各不相同：

```typescript
// Stdio — 本地子进程，stderr 重定向为管道避免污染 UI
{ type: 'stdio', command: 'python', args: ['-m', 'mcp_server'], env: { KEY: 'val' } }

// SSE — 单向流，EventSource 连接不受 60s 超时约束（长连接）
{ type: 'sse',  url: 'https://service.co/mcp', oauth: { clientId: '...' } }

// HTTP — Streamable HTTP，OAuth 令牌优先于 session ingress 令牌
{ type: 'http', url: 'https://service.co/mcp', headers: { 'X-API-Key': '...' } }

// WebSocket — 双向，Bun 原生 WebSocket / Node.js fallback，支持 mTLS
{ type: 'ws',   url: 'wss://service.co/mcp' }

// SDK Control — 进程内嵌入，通过控制请求/响应对通信，无网络开销
{ type: 'sdk',  name: 'embedded-server' }
```

---

##### 工具发现：从 MCP server 到 Agent Loop 可调用工具

连接建立后，`fetchToolsForClient()`（LRU 缓存，按服务器名称）调用 `tools/list`，把 MCP 工具定义转换成和内置工具结构完全相同的 `Tool` 对象：

```typescript
// 工具名规范化为 mcp__<server>__<tool>
const fullyQualifiedName = `mcp__${client.name}__${tool.name}`

return {
  ...MCPTool,
  name: fullyQualifiedName,
  // 工具注解直接映射到调度元数据
  isConcurrencySafe() { return tool.annotations?.readOnlyHint ?? false },
  isReadOnly()        { return tool.annotations?.readOnlyHint ?? false },
  isDestructive()     { return tool.annotations?.destructiveHint ?? false },
  // Anthropic 扩展元数据（_meta 字段）
  searchHint: tool._meta?.['anthropic/searchHint'],
  alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
  // 描述长度限制（OpenAPI 生成的 MCP server 可能有 15-60KB 文档）
  prompt() {
    return desc.length > MAX_MCP_DESCRIPTION_LENGTH
      ? desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + '… [truncated]'
      : desc
  },
}
```

这个转换的关键在于：MCP 工具的 `readOnlyHint` 注解直接变成了 `isConcurrencySafe`——内置工具体系里控制并发调度的那个字段。外部 server 只要在工具定义里声明只读，就能自动获得并发执行权限，和 `GlobTool`、`GrepTool` 的调度逻辑完全相同。

工具池组装时，MCP 工具和内置工具按名称排序合并（`assembleToolPool()`），排序的目的是让工具列表在请求间保持稳定，提高 Prompt Cache 命中率。

---

##### 认证：OAuth 2.0 完整实现

`ClaudeAuthProvider`（`src/services/mcp/auth.ts`，2465 行）实现了 `OAuthClientProvider` 接口，核心是令牌的主动管理：

```typescript
async tokens(): Promise<OAuthTokens | undefined> {
  const tokenData = await secureStorage.read()
  const expiresIn = (tokenData.expiresAt - Date.now()) / 1000

  // 过期前 5 分钟主动刷新，不等到 401 再补救
  if (expiresIn <= 300 && tokenData.refreshToken) {
    if (!this._refreshInProgress) {
      this._refreshInProgress = this.refreshAuthorization(tokenData.refreshToken)
        .finally(() => { this._refreshInProgress = undefined })
    }
    const refreshed = await this._refreshInProgress
    if (refreshed) return refreshed
  }

  return { access_token: tokenData.accessToken, ... }
}
```

Step-up 认证（403 `insufficient_scope`）：遇到权限不足时，auth provider 记录 `_pendingStepUpScope`，下次调用 `tokens()` 时省略 `refresh_token`，强制走完整 OAuth 流程重新申请更高权限的令牌。

XAA（Cross-App Access）：利用缓存的 IdP `id_token`，通过 RFC 8693 + RFC 7523 静默交换拿到目标 server 的 access token，全程无浏览器弹窗。`id_token` 不在时才退回交互式授权。

令牌存储在系统安全存储（keychain / Secret Service），不写明文文件。

---

##### 连接生命周期：重连与会话恢复

断线处理区分传输类型：`stdio` 和 `sdk` 不自动重连（子进程崩溃通常意味着更大的问题）；`sse`、`http`、`ws` 断开后走指数退避重试，最多 5 次（1s → 2s → 4s → 8s → 16s，上限 30s）。

HTTP 传输的会话过期（服务器返回 404 + JSON-RPC -32001）会触发特殊处理：清除 `connectToServer` 的 memoize 缓存，强制下次调用重新建立连接和协商会话，而不是用已失效的 session ID 重试。

---

##### 工具调用：URL Elicitation 与错误隔离

MCP 工具调用（`callMCPTool()`）有两个非显而易见的机制：

**URL Elicitation**：某些 MCP server 在工具执行中途需要用户通过外部 URL 完成操作（如 OAuth 授权、二次确认）。调用方收到 JSON-RPC -32042 错误时，弹出 `ElicitationDialog`，等用户操作完成后重试，最多 3 次。Hook 脚本可以以编程方式解决 elicitation，跳过 UI 弹窗。

**超时与进度**：工具调用用 `Promise.race()` 叠加独立超时（默认约 27.8 小时，长任务场景设计），每 30 秒写一次进度日志。调用方可以传 `onProgress` 回调接收流式进度（`sdkProgress.progress / total`）。

一个 MCP server 的工具调用失败不影响其他 server——`fetchToolsForClient` 里每个 server 独立 try/catch，`ListMcpResourcesTool` 里用 `Promise.all()` 并行拉取所有 server 的资源列表，任意一个失败单独记错误日志后继续。

---

##### Resources：非工具能力

除工具外，MCP server 还可以暴露 Resources（静态或动态内容）。`ListMcpResourcesTool` 调用 `resources/list`，`ReadMcpResourceTool` 调用 `resources/read`，都是只读并发安全工具。

Blob 类型的资源（二进制内容）不直接注入上下文，而是写到临时文件，`tool_result` 里只返回路径和大小——和内置工具的大结果持久化逻辑一致。

---

MCP 和 Skill 的边界：MCP 处理的是”接什么能力”，把外部系统拉进来；Skill 处理的是”按什么方法做”，把内部流程固化下来。前者扩的是系统边界，后者固化的是组织经验。

---

#### 1.2.4 Skill 系统

Skill 解决的不是”少打一段提示词”，而是把团队里反复出现的流程固化成可调用资产。每次 `/review-pr` 的背后，不是一段静态模板，而是一套带入口、带约束、可长期维护的工作流单元。

---

##### 两种 Skill 类型与执行差异

从加载来源看，Skill 有两类：

**本地文件型**（`.claude/skills/*.md`）：AI 调用 `SkillTool` 时，`SkillTool` 找到对应 Markdown 文件，把内容注入到 `invokedSkills` 状态（`src/bootstrap/state.ts`），再进入 Agent Loop 的上下文：

```typescript
// SkillTool 执行完后，skill 内容挂到会话状态
addInvokedSkill(skillName, skillPath, content, agentId)

// 状态键 = agentId:skillName，子代理的 skill 仅在自己作用域可见
// agentId === null 时全局可见（主线程调用）
```

**MCP Prompt 型**：来自 MCP server 暴露的 `prompts/list`，`type === 'prompt'` 的 MCP 命令自动合并进 Skill 列表（`getAllCommands()` 里用 `uniqBy` 去重）。MCP Skill 和本地 Skill 对 AI 完全透明，调用方式相同。

---

##### 执行路径：inline vs fork

Skill 有两种执行模式，取决于 Skill 定义里的 `context` 字段：

```
context: undefined（默认）→ inline 执行
  - Skill 内容注入当前对话上下文
  - 直接影响当前 Agent Loop 的后续行为
  - 返回 { status: 'inline', allowedTools, model }

context: 'fork' → 子代理执行
  - 通过 runAgent() 在独立子代理里运行
  - 有独立的 token 预算和 AbortController
  - 执行完成后返回完整结果文本
  - 返回 { status: 'forked', agentId, result }
```

Fork 模式适合那些需要多轮对话才能完成的 Skill（如代码审查、生成报告），结果汇报给父代理后子代理退出，不占用主会话的上下文预算。

---

##### Skill 内容注入机制

Skill Markdown 文件加载后，会自动添加 base directory header 并替换内置占位符：

```typescript
// 自动注入 skill 所在目录，供 skill 内部引用相对路径
let content = `Base directory for this skill: ${skillDir}\n\n${rawContent}`

// 替换内置变量
content = content.replace(/\${CLAUDE_SKILL_DIR}/g, skillDir)
content = content.replace(/\${CLAUDE_SESSION_ID}/g, getSessionId())

// $ARGUMENTS 替换为用户传入的参数
content = content.replace(/\$ARGUMENTS/g, args ?? '')
```

Skill 内容一旦注入，在上下文压缩时不会被直接丢弃——压缩恢复时会根据 `preservedAgentIds` 筛选后重新挂载，保证长任务里的 Skill 约束始终生效。

---

##### 权限模型

`SkillTool.checkPermissions()` 的审批逻辑分三级：

```
1. deny 规则前置检查 → 直接拒绝
2. allow 规则显式放行 → 直接允许
3. Skill 只包含”安全属性”（SAFE_SKILL_PROPERTIES 白名单）→ 自动允许
4. 默认 → 询问用户
```

`disableModelInvocation` 标志让某个 Skill 只能由用户手动 `/skill-name` 调用，AI 不能通过 `SkillTool` 主动触发——用于那些需要人工明确发起的操作（如”发布到生产”）。

---

##### 与 MCP 的边界

从注册机制上看，MCP 工具通过 `mcp.commands` 数组注入工具池，走 MCP 协议调用链；Skill 通过 `invokedSkills` 状态把内容注入当前上下文，走提示词注入链。两者在 AI 侧都表现为”可调用的能力”，但机制完全不同：

| | Skill | MCP 工具 |
|--|--|--|
| 执行载体 | 提示词注入 + 可选子代理 | MCP 协议 API 调用 |
| 结果形式 | 影响后续 AI 行为 | 返回结构化数据 |
| 权限模型 | Skill 级权限 + 工具白名单 | MCP server 级权限 |
| 适合场景 | 流程约束、检查清单、工作方法 | 外部系统读写、数据查询 |

MCP 解决”接什么能力”，Skill 解决”按什么方法做”。两者结合后，Claude Code 不只是会做事，还能按团队熟悉的方式做事。

---

#### 1.2.5 上下文管理：五层机制

Claude Code 的上下文管理不是"超出就压缩"，而是五层叠加的系统：

**第一层：静态记忆（CLAUDE.md）**

会话开始前注入系统提示。按优先级叠加：

```
/etc/claude-code/CLAUDE.md     ← 企业托管，最低优先级，不可覆盖
~/.claude/CLAUDE.md             ← 用户全局
{project}/CLAUDE.md             ← 项目根
{project}/.claude/rules/*.md   ← 规则文件集
{project}/CLAUDE.local.md      ← 本地私有（不提交 git），最高优先级
```

零 token 消耗，每次请求都带上去。

**第二层：触发机制（autoCompact）**

不是简单的"90% 触发"，而是动态计算：

```typescript
// 有效窗口 = 总窗口 - 为摘要保留的输出空间（最多 20k）
effectiveWindow = contextWindow - Math.min(maxOutputTokens, 20_000)
// 触发阈值 = 有效窗口 - 13k 缓冲
threshold = effectiveWindow - 13_000
// Claude 3.5 (200k)：阈值 ≈ 167k
```

电路断路器：连续失败 3 次停止重试。

**第三层：压缩执行**

两路策略，优先走 Session Memory 压缩：

```
Session Memory 压缩（精细）：
  保留最近 10k~40k tokens 的原始消息
  对早期历史生成 AI 摘要
  → 当前工作上下文保真度高

传统压缩（兜底）：
  整段历史 → AI 生成 9 段结构化摘要
  (Primary Request / Key Concepts / Files / Errors /
   Problem Solving / User Messages / Pending Tasks /
   Current Work / Next Step)
```

**第四层：Microcompact（工具结果轻量清理）**

不调用 AI，只清除旧工具输出的内容（保留消息结构）。计数触发或时间触发（距上次操作超过 N 分钟，判断用户重新开始）。适合"读了很多文件但文件内容不再重要"的场景。

**第五层：压缩边界标记**

每次压缩后插入 `compact_boundary` 系统消息，记录压缩元数据（触发方式、token 数量、保留段范围、已发现工具列表）。QueryEngine 看到边界标记后，释放压缩前消息供 GC 回收，避免进程内存持续增长。

---

#### 1.2.6 任务系统：AI 的外部记忆

任务系统不是一个简单的 Todo list，而是一套跨越进程边界、支撑多 Agent 协调的持久化状态基础设施。六个工具（`TaskCreate / TaskGet / TaskUpdate / TaskList / TaskOutput / TaskStop`）背后，是完整的状态机、文件锁并发控制、输出流管理和团队协调机制。

---

##### 为什么需要任务系统

这个问题值得先想清楚。上下文压缩会丢失信息，这是一个结构性问题，不是工程疏漏：

```
[上下文窗口]          [任务列表（外部存储）]
  ↓ 压缩发生            ↓ 不受影响
  历史细节丢失          待办事项完整保留
  重要文件路径？        → Task 里有记录
  已决定的架构？        → Task 里有记录
  还没做的步骤？        → Task 里有记录
```

但任务系统解决的不只是单 Agent 的记忆问题。在多 Agent 协调场景里，主 Agent 拆解任务、子 Agent 认领执行，任务列表是唯一的协调面——每个 Agent 自己的上下文窗口不相互可见，但任务状态是共享的。任务系统在这里充当了"团队共享白板"的角色。

---

##### 数据结构：两套 Task 类型

任务系统里有两种含义截然不同的"Task"，必须区分清楚：

**AI 可见的 Todo 类型**（`src/utils/tasks.ts`）——AI 调用工具操作的对象：

```typescript
type Task = {
  id: string
  subject: string               // 任务标题（简短）
  description: string           // 完整描述
  activeForm?: string           // "进行中"时显示的文本（如"Fixing auth bug"）
  owner?: string                // 认领此任务的 Agent ID 或名称
  status: 'pending' | 'in_progress' | 'completed'
  blocks: string[]              // 此任务阻止哪些任务
  blockedBy: string[]           // 哪些任务阻止此任务
  metadata?: Record<string, unknown>
}
```

**运行时内部 TaskState 类型**——`AppState.tasks` 里存的，对 AI 不可见，由系统自己管理：

```typescript
type TaskStateBase = {
  id: string
  type: TaskType          // 'local_bash' | 'local_agent' | 'remote_agent' | ...
  status: TaskStatus      // 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  description: string
  outputFile: string      // 输出写到哪个临时文件
  outputOffset: number    // 当前已读取的字节偏移
  notified: boolean       // 是否已通知 Agent 完成
  startTime: number
  endTime?: number
  toolUseId?: string      // 触发此任务的 tool_use ID
}
```

`local_bash`（Shell 命令）、`local_agent`（子 Agent 进程）、`remote_agent`（远程 Agent 会话）等类型在 `TaskStateBase` 之上各自扩展了特有字段，共同组成 `TaskState` 联合类型。

---

##### 六个工具的实现细节

**TaskCreate**：创建时不只是写文件

```typescript
// 执行流程
1. 文件锁（proper-lockfile）→ 读高水位标记 → 分配 ID → 写 JSON
2. 触发 TaskCreated Hook（企业合规脚本可以拦截）
3. Hook 返回 blockingError（exit code 2）→ 删除任务并抛出错误
4. 自动展开任务列表 UI
```

**TaskUpdate**：状态转换的核心

```typescript
Input:
{
  taskId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
  owner?: string
  addBlocks?: string[]      // 添加阻止关系（双向维护）
  addBlockedBy?: string[]
  metadata?: Record<string, unknown | null>  // null 表示删除该字段
}

核心逻辑：
- status === 'completed' → 触发 TaskCompleted Hook
- 更新 blocks/blockedBy 时双向维护一致性
- owner 变更后通过 mailbox 通知新 Agent
```

**TaskOutput / TaskStop**：管理异步执行的长任务

```typescript
// TaskOutput：等待异步任务完成
{
  task_id: string
  block?: boolean     // 默认 true，阻塞直到完成
  timeout?: number    // 毫秒，默认 30000
}

// block=true 时：每 100ms 轮询一次，等 status 离开 running/pending
// 完成后标记 notified=true，触发从 AppState 驱逐

// TaskStop：中止运行中的任务
// - local_bash：发 SIGTERM，抑制 exit code 137 通知（避免噪音）
// - local_agent：发 abort，AbortError 触发 partial result 写出
```

---

##### 持久化：基于文件系统的并发安全存储

任务存在本地文件系统，不是数据库，不依赖任何额外服务：

```
~/.config/claude/tasks/
└── [taskListId]/
    ├── 1.json          # 每个任务一个 JSON 文件
    ├── 2.json
    ├── .highwatermark  # 防止 ID 重用（记录已分配的最大 ID）
    └── .lock           # proper-lockfile 的锁文件
```

并发控制：

```typescript
// 所有写操作都经过文件锁，防止多个 Agent 同时写入
const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 }
}

async function createTask(taskListId, taskData): Promise<string> {
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS)
  try {
    const highestId = await findHighestTaskId(taskListId)
    const id = String(highestId + 1)
    await writeFile(getTaskPath(taskListId, id), JSON.stringify(taskData))
    return id
  } finally {
    await release()
  }
}
```

**TaskListId** 决定了哪些任务是"同一张白板"：

```typescript
function getTaskListId(): string {
  // 显式指定（子进程继承）
  if (process.env.CLAUDE_CODE_TASK_LIST_ID) return process.env.CLAUDE_CODE_TASK_LIST_ID
  // 多 Agent 模式：同一个团队共享一个 taskListId
  const teammateCtx = getTeammateContext()
  if (teammateCtx) return teammateCtx.teamName
  // 单会话模式：每个会话独立
  return getSessionId()
}
```

---

##### 输出管理：DiskTaskOutput

异步任务（`local_bash`、`local_agent`）的输出不会直接注入上下文，而是写到临时文件，增量轮询读取：

```typescript
class DiskTaskOutput {
  MAX_TASK_OUTPUT_BYTES = 5GB   // 容量上限
  #queue: string[] = []         // 写入队列（异步批量 drain）
  #bytesWritten = 0
  #capped = false

  append(content: string): void {
    if (this.#capped) return
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      this.#queue.push('\n[output truncated: exceeded 5GB]\n')
    } else {
      this.#queue.push(content)
    }
    void this.#drain()   // 排队异步写入，避免阻塞主流程
  }
}

// 增量读取（轮询时只读新增部分）
async function getTaskOutputDelta(taskId, fromOffset) {
  const result = await readFileRange(getTaskOutputPath(taskId), fromOffset, 8MB)
  return {
    content: result?.content ?? '',
    newOffset: fromOffset + (result?.bytesRead ?? 0),
  }
}
```

安全细节：使用 `O_NOFOLLOW` 标志防止 symlink 攻击，`O_EXCL` 确保文件是新建而非覆盖。

---

##### 轮询框架与通知机制

REPL 主循环每秒执行一次 `pollTasks`：

```typescript
// 轮询间隔：1000ms
async function pollTasks(getAppState, setAppState): Promise<void> {
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(getAppState())

  // 更新偏移，驱逐已通知的终止任务
  applyTaskOffsetsAndEvictions(setAppState, updatedTaskOffsets, evictedTaskIds)

  // 把完成通知发给 Agent Loop
  for (const attachment of attachments) {
    enqueueTaskNotification(attachment)
  }
}
```

通知以 XML 格式注入 Agent 的 user 消息，让 LLM 知道异步任务完成了：

```xml
<task-notification>
  <task-id>a1b2c3d4</task-id>
  <tool-use-id>tu-xxxxx</tool-use-id>
  <task-type>local_agent</task-type>
  <output-file>/path/to/output</output-file>
  <status>completed</status>
  <summary>Task "..." completed successfully</summary>
</task-notification>
```

任务驱逐：终止状态（completed/failed/killed）且已通知的任务，轮询时从 `AppState.tasks` 中删除。`local_agent` 类型的任务额外有 30 秒 grace period（`evictAfter` 字段），给 UI 留出展示时间。

---

##### 多 Agent 协调：任务认领与移交

这是任务系统最复杂的部分，也是与单 Agent 场景最大的差异：

```typescript
// 任务认领（原子性保证）
async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
): Promise<ClaimTaskResult> {
  const task = await getTask(taskListId, taskId)

  // 依赖检查：blockedBy 里有未完成的任务 → 不能认领
  const unresolvedBlockers = task.blockedBy.filter(id =>
    allTasks.find(t => t.id === id && t.status !== 'completed')
  )
  if (unresolvedBlockers.length > 0) {
    return { success: false, reason: 'blocked', blockedByTasks: unresolvedBlockers }
  }

  // 原子认领（文件锁保护）
  const updated = await updateTaskUnsafe(taskListId, taskId, {
    owner: claimantAgentId,
  })
  return { success: true, task: updated }
}

// Agent 退出时的任务移交
async function unassignTeammateTasks(
  teamName: string,
  teammateId: string,
  reason: 'terminated' | 'shutdown',
): Promise<UnassignTasksResult> {
  const ownedTasks = allTasks.filter(
    t => t.status !== 'completed' && t.owner === teammateId
  )

  // 重置为 pending，等待其他 Agent 认领
  for (const task of ownedTasks) {
    await updateTask(teamName, task.id, { owner: undefined, status: 'pending' })
  }

  return {
    unassignedTasks: ownedTasks.map(t => ({ id: t.id, subject: t.subject })),
    notificationMessage: `${teammateId} ${reason === 'terminated' ? 'was terminated' : 'has shut down'}. ${ownedTasks.length} task(s) were unassigned.`,
  }
}
```

主 Agent 可以随时调用 `TaskList` 看到所有 Agent 的任务状态，通过 `owner` 字段知道谁在做什么，通过 `status` 知道进展如何。`blocks/blockedBy` 关系则让 Agent 之间可以声明任务依赖，避免并行执行产生冲突。

对于"重构整个认证模块"这类跨越几十个文件、几百轮对话的任务：主 Agent 在开始时用 `TaskCreate` 写下拆解好的子任务（带依赖关系），子 Agent 用 `claimTask` 原子认领，完成后 `TaskUpdate` 标记，压缩发生后任何 Agent 都能用 `TaskList` 找回全局进度。任务系统是长任务可靠执行的关键基础设施，也是多 Agent 协调的唯一共享状态。

---

#### 1.2.7 Hooks 扩展机制：嵌入已有工具链

Hook 解决的是一个工程实际问题：**AI 改完文件之后，格式化、类型检查、测试怎么自动跟上**。

```json
{
  "hooks": {
    "post_tool_use": {
      "prettier": "prettier --write {FILE}",
      "tsc": "tsc --noEmit",
      "eslint": "eslint --fix {FILE}"
    },
    "permission_request": "scripts/approve-policy.sh {TOOL} {INPUT}",
    "post_compact": "scripts/notify-slack.sh '上下文已压缩，建议确认进度'"
  }
}
```

`{FILE}`、`{TOOL}`、`{INPUT}` 是运行时占位符。每次 FileEdit 执行后，Prettier → tsc → ESLint 自动串联跑一遍——这是在工具执行层面挂钩，不是让 AI 去手动调用这些工具。

`permission_request` Hook 让企业把权限决策外包给自己的合规脚本：AI 想执行某个命令，先走公司的审批逻辑，通过了再放行。对有安全审计要求的团队，这是硬需求。

五种 Hook 时机：`pre_tool_use` / `post_tool_use` / `permission_request` / `post_compact` / `stop`（会话结束时触发）。

---

#### 1.2.8 流式执行引擎：边收边跑

Claude Code 不等 LLM 全部输出完再执行工具，而是边接收流式输出边执行。`StreamingToolExecutor` 是这个机制的实现：

```typescript
// 工具状态机
type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

class StreamingToolExecutor {
  private siblingAbortController: AbortController  // 某个工具失败可取消兄弟工具

  addTool(toolUse: ToolUseBlock) {
    this.tools.push({ ...toolUse, status: 'queued' })
    this.processQueue()  // 立即尝试调度
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing')
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    )
  }
}
```

**工具批处理与并发策略**（`toolOrchestration.ts`）：

```typescript
// 1. 分区：连续的"并发安全"工具合并成一批，非安全工具单独成批
function partitionToolCalls(toolUses): Batch[] {
  // isConcurrencySafe 由每个工具自己声明
  // GlobTool、GrepTool、FileRead → 并发安全（只读）
  // BashTool、FileEdit、FileWrite → 非并发安全（有副作用）
}

// 2. 执行：并发安全批用 p-map 并行，非安全批串行
if (batch.isConcurrencySafe) {
  for await (const result of runToolsConcurrently(batch)) yield result
} else {
  for await (const result of runToolsSerially(batch)) yield result
}
```

实际效果：AI 同时调用 5 个文件读取工具时，5 个并发执行；调用一个 BashTool 时，等它完成再调度下一个。整体延迟比"全部串行"低很多，又比"无限并发"更安全。

---

### 1.3 高级特性

#### 1.3.1 权限系统：安全边界

`src/utils/permissions/permissions.ts` 有 1486 行，是整个代码库里权限决策的核心模块。

**六种权限模式**对应六种工作场景：

```typescript
type PermissionMode =
  | 'default'           // 每次弹窗询问（最保守，默认）
  | 'plan'              // 只读分析，写操作全部拦截，输出预览
  | 'acceptEdits'       // 文件修改自动通过，Shell 仍需确认
  | 'bypassPermissions' // 全自动，不问任何问题（YOLO 模式）
  | 'dontAsk'           // 全部自动拒绝（只看不动）
  | 'auto'              // AI 自己判断危险等级（ANT-ONLY，反编译版关闭）
```

`plan` 模式特别实用：让 AI 把整个执行计划先跑一遍（只读），返回"将要执行"的操作预览，用户确认后再切换到 `acceptEdits` 真正执行。

**规则引擎**支持路径通配符和工具前缀：

```json
{
  "permissions": {
    "allow": ["Bash(git *)", "FileEdit(/project/src/**)"],
    "deny":  ["Bash(rm -rf *)", "FileEdit(/project/.env)"],
    "ask":   ["*"]
  }
}
```

规则来源按优先级叠加（低→高）：`settings.json` → CLI 参数 → 会话级 → 单次命令。企业可在 managed 配置里锁死规则，用户无法覆盖。

**bashClassifier 静态分析**：Shell 命令执行前静态扫描危险模式：

```typescript
const DANGEROUS_PATTERNS = [
  /rm\s+-rf?\s+[\/~]/,          // 删除根/家目录
  /mkfs/,                        // 磁盘格式化
  /dd\s+if=\/dev\//,             // 磁盘操作
  /(curl|wget).*\|\s*(ba)?sh/,  // 远程脚本直接执行
  /sudo\s+rm/,                   // sudo 删除
]
// 返回：'safe' | 'suspicious' | 'dangerous'
```

不需要等用户点确认才知道要小心。这是静默安全网，正常流程不感知，真正危险时介入。

---

#### 1.3.2 bun:bundle 特性门控：构建时消除死代码

Claude Code 有大量实验性功能，通过 `feature()` 函数在构建时决定是否包含：

```typescript
// src/main.tsx（正式构建）
import { feature } from 'bun:bundle'
// bun:bundle 在编译时将 feature('FLAG') 替换为 true/false 常量
// false 分支在 tree-shaking 阶段被完全消除

// src/entrypoints/cli.tsx（反编译版 polyfill）
const feature = (_name: string) => false  // 所有特性全部关闭
```

**已识别的特性标志**（部分）：

| 特性标志 | 功能 | 状态 |
|---------|------|------|
| `COORDINATOR_MODE` | 多 Agent 协调/Swarm 模式 | ANT-ONLY |
| `BRIDGE_MODE` | IDE 远程控制桥接 | ANT-ONLY |
| `KAIROS` | 助手模式 | ANT-ONLY |
| `REACTIVE_COMPACT` | 反应式上下文压缩 | ANT-ONLY |
| `CONTEXT_COLLAPSE` | 上下文折叠（PTL 恢复）| ANT-ONLY |
| `TOKEN_BUDGET` | Token 预算控制 | ANT-ONLY |
| `VOICE_MODE` | 语音输入 | ANT-ONLY |
| `EXTRACT_MEMORIES` | 自动记忆提取 | ANT-ONLY |
| `VERIFICATION_AGENT` | 验证 Agent | ANT-ONLY |
| `DAEMON` | 后台守护进程 | ANT-ONLY |
| `BG_SESSIONS` | 后台会话任务摘要 | ANT-ONLY |
| `PROACTIVE` | 主动模式 | ANT-ONLY |
| `WORKFLOW_SCRIPTS` | 工作流脚本工具 | ANT-ONLY |
| `EXPERIMENTAL_SKILL_SEARCH` | 技能搜索 | ANT-ONLY |

反编译版里所有 `feature()` 返回 `false`——这意味着 Claude Code 真正的完整能力，比公开文档描述的要多得多。

---

#### 1.3.3 IDE 桥接层（BRIDGE_MODE）

`src/bridge/` 目录有 30+ 个文件，是一套完整的远程控制基础设施：

```
src/bridge/
├── bridgeEnabled.ts        # 特性检查（需要 Claude AI 订阅 + GrowthBook 权限）
├── bridgeMain.ts           # 远程控制主循环
├── remoteBridgeCore.ts     # 核心实现
├── replBridge.ts           # REPL 桥接
├── replBridgeTransport.ts  # 传输层
├── peerSessions.ts         # Peer 会话管理
├── bridgePermissionCallbacks.ts  # 权限回调
├── trustedDevice.ts        # 信任设备管理
├── jwtUtils.ts             # JWT 认证
└── ...（共 30+ 文件）
```

**启用条件**：

```typescript
export function isBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED('tengu_ccr_bridge', false)  // GrowthBook 权限门
    : false
}
```

必须同时满足：① `BRIDGE_MODE` 特性开启（ANT 内部构建）、② Claude AI 订阅用户、③ GrowthBook 实验门控通过。这套机制支持 claude.ai 网页端远程控制本地的 Claude Code 实例，是"在网页上操作本地代码库"的底层支撑。

---

#### 1.3.4 多 Agent 协调

多 Agent 不是单纯的并发执行，是有完整基础设施支撑的一等公民特性。

**AgentTool 三种模式**（`src/tools/AgentTool/runAgent.ts`）：

```typescript
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  isAsync,          // true = 后台异步，不阻塞主流程
  forkContextMessages,  // fork 模式继承的父上下文
  maxTurns,
  model,
  ...
}): AsyncGenerator<QueryMessage, void>
```

- **fork 模式**：继承父会话上下文，同步等待结果。适合"探索一遍再决定"
- **async 模式**：后台运行，主流程继续。适合"发出任务不等回答"
- **background 模式**：完全独立进程，和主会话隔离

每个子 Agent 有独立的 `AbortController`，某个 Agent 失败不影响其他 Agent。子 Agent 可以有自己的 MCP 服务器配置（`agentDefinition.mcpServers`），和父会话的 MCP 服务器并行存在。

**Agent 间通信**（`SendMessageTool`）：

```typescript
// 支持的通信方式
to: "agent-name"        // 点对点
to: "*"                 // 广播给所有 Agent
to: "uds:<path>"        // Unix Domain Socket（本地 peer）
to: "bridge:<session>"  // 远程控制 peer（需要 BRIDGE_MODE）

// 结构化消息类型
message: "普通文本"
message: { type: "shutdown_request" }
message: { type: "plan_approval_response", approved: true }
```

一个主 Agent 可以同时指挥多个子 Agent 并发干活，通过 `SendMessageTool` 传递结果和指令。这是构建复杂多代理工作流的代码级基础，不只是概念。

---

### 1.4 其他功能模块

#### 1.4.1 记忆系统（memdir）

`src/memdir/`（9 个文件）实现了用户级持久记忆管理，是跨会话知识保持的基础设施。

**核心职责：**

- `memdir.ts` — 自动记忆功能主入口，读写 `MEMORY.md` 及各类 memory 文件
- `findRelevantMemories.ts` — 相关性查询，GrepTool 对记忆文件做关键词匹配
- `memoryAge.ts` — 计算记忆文件年龄（用于过期判断和排序）
- `memoryScan.ts` — 扫描 `~/.claude/projects/` 下的记忆目录
- `memoryTypes.ts` — 记忆类型定义（user/feedback/project/reference）
- `paths.ts` — 记忆路径管理（`getAutoMemPath()`、`isAutoMemoryEnabled()`、`isExtractModeActive()`）
- `teamMemPaths.ts` / `teamMemPrompts.ts` — 团队成员记忆（需 `TEAMMEM` feature flag）

**约束：**

```
最大行数：200 行（MEMORY.md 索引文件超出后截断）
最大字节：25 KB（单个记忆文件上限）
```

路径结构：`~/.claude/projects/<project-hash>/memory/`，每个项目独立隔离。`isExtractModeActive()` 被 `src/query/stopHooks.ts` 引用，用于判断是否在记忆提取模式下调整 stop hook 行为。

---

#### 1.4.2 Vim 模式

`src/vim/`（5 个文件）为终端 REPL 的输入框提供完整的 Vim 按键绑定：

- `motions.ts` — 光标移动命令（hjkl、w/b/e、0/$、gg/G 等）
- `operators.ts` — Vim 操作符（d、c、y、>、< 等）
- `textObjects.ts` — 文本对象选择（iw、i"、i(、as 等）
- `transitions.ts` — 模式状态机（normal/insert/visual 切换）
- `types.ts` — Vim 状态类型定义

由 `src/keybindings/` 控制开关，在 `settings.json` 里通过 `vim: true` 启用。

---

#### 1.4.3 协调器模式（coordinator）

`src/coordinator/`（2 个文件）实现了多 Agent 协调模式的主控逻辑：

**`coordinatorMode.ts`** — 协调器主控实现：
- 维护 Worker Agent 的工具白名单（内置常量 `ASYNC_AGENT_ALLOWED_TOOLS`）
- 提供 `isScratchpadGateEnabled()` 检查 `tengu_scratch` feature gate
- 与 `QueryEngine.ts` 集成，通过依赖注入传入 `scratchpadDir`
- 需要 `COORDINATOR_MODE` feature flag 开启（反编译版关闭）

**`workerAgent.ts`** — 目前为自动生成存根，Worker Agent 的完整实现在正式版中。

该模式是 `COORDINATOR_MODE` feature flag 控制的 ANT-ONLY 功能，与 `1.3.4` 的 AgentTool 分层：AgentTool 是通用子代理，coordinator 是多 Agent 团队的主控调度层。

---

#### 1.4.4 插件系统（plugins）

`src/plugins/`（2 个文件）：

- `builtinPlugins.ts` — 内置插件注册表，管理随 Claude Code 一起分发的插件
- `bundled/` — 打包内置插件目录

插件可以提供多种组件类型（工具、UI 组件等）并支持启用/禁用控制。与 MCP 的区别在于：MCP 走协议调用外部服务，Plugin 直接修改 Claude Code 内部行为。文档原文提到"Plugins / Marketplace 已移除"——marketplace 移除了，但内置插件系统保留。

---

#### 1.4.5 服务器与远程模块

**`src/server/`**（11 个文件）实现 Claude Code 的本地服务器模式：

- `server.ts` / `serverBanner.ts` — 服务器启动与状态展示
- `createDirectConnectSession.ts` / `directConnectManager.ts` — 直连会话创建和管理（允许外部客户端通过本地接口控制 Claude Code 实例）
- `sessionManager.ts` — 会话生命周期管理
- `lockfile.ts` — 防止多实例冲突的文件锁
- `parseConnectUrl.ts` — 连接 URL 解析
- `backends/` — 后端实现

**`src/remote/`**（4 个文件）处理远程执行和权限桥接：

- `RemoteSessionManager.ts` — 远程 Agent 会话管理
- `SessionsWebSocket.ts` — WebSocket 会话通信
- `remotePermissionBridge.ts` — 跨进程权限请求桥接（远程 Agent 请求权限时转发给本地 UI）
- `sdkMessageAdapter.ts` — SDK 消息格式适配

---

#### 1.4.6 伴侣系统（buddy）

`src/buddy/`（5 个文件）是一个用户专属角色生成系统：

- `companion.ts` / `types.ts` — 基于用户 ID 的确定性角色生成（同一用户每次得到相同角色）
- `sprites.tsx` / `CompanionSprite.tsx` — 角色 UI 渲染组件
- `useBuddyNotification.tsx` — React Hook，在特定事件时显示角色通知
- `prompt.ts` — 伴侣相关提示词

角色具有物种、眼睛、帽子、属性等特征，分为 5 个稀有度：common、uncommon、rare、epic、legendary。这是面向 claude.ai 订阅用户的趣味功能，不影响核心功能。

---

#### 1.4.7 存根模块（待实现，可能是Claude Code RoadMap）

以下目录为自动生成存根，在反编译版中无完整实现：

| 目录 | 功能 | 状态 |
|------|------|------|
| `src/daemon/` | 后台守护进程（`DAEMON` feature flag）| 存根 |
| `src/proactive/` | 主动建议模式（`PROACTIVE` feature flag）| 存根 |
| `src/ssh/` | SSH 远程会话管理 | 存根 |
| `src/self-hosted-runner/` | 自托管运行器 | 存根 |
| `src/environment-runner/` | 环境运行器 | 存根 |
| `src/jobs/` | 作业分类与调度 | 存根 |
| `src/voice/` | 语音输入模式（需 GrowthBook gate + Anthropic OAuth）| 存根（入口检查完整）|

`src/voice/voiceModeEnabled.ts` 虽然只有入口检查代码，但两层条件（GrowthBook feature gate + Anthropic OAuth token，不支持 API key）完整实现，说明这是面向 claude.ai 账号的功能，未向 API 用户开放。

---

### 1.5 架构亮点与缺点

#### 1.5.1 亮点

**① 五层上下文管理：专为长任务设计的压缩体系**

这是 Claude Code 最被低估的核心设计之一。绝大多数 AI 工具的上下文管理是"超出就截断"或"超出就报错"，Claude Code 是五层叠加的系统，每一层解决不同粒度的问题：

- **CLAUDE.md 静态注入**：系统提示零 token 消耗，项目规则每次请求都在，不随压缩丢失
- **动态阈值触发**：不是硬编码 90%，而是 `contextWindow - min(maxOutputTokens, 20k) - 13k` 的动态计算，为摘要生成预留输出空间
- **双路压缩策略**：优先走 Session Memory 压缩（保留最近 10k~40k tokens 原始消息 + 对早期历史生成摘要），兜底走传统 9 段结构化摘要（`Primary Request / Key Concepts / Files / Errors / Problem Solving / User Messages / Pending Tasks / Current Work / Next Step`）
- **Microcompact 轻量清理**：不调用 AI，只清除旧工具输出内容（保留消息结构），适合"读了很多文件但内容不再重要"的场景，计数触发或时间触发
- **compact_boundary 边界标记**：每次压缩后插入系统消息记录元数据，QueryEngine 看到标记后释放压缩前消息供 GC 回收，防止进程内存无限增长

五层机制加在一起的效果：在"重构认证系统"这类跨越几百轮对话的任务里，信息损失是可控的、可预测的，而不是随机的截断。

**② 工具元数据驱动的调度架构**

工具不是函数，是带完整调度元数据的执行节点。`isConcurrencySafe`、`isReadOnly`、`isDestructive`、`maxResultSizeChars` 这些字段直接驱动三条不同的执行路径：

- **并发调度**：`partitionToolCalls` 按 `isConcurrencySafe` 分区，只读工具并行（最高 10 并发），写操作串行，某个工具失败时 `siblingAbortController` 取消同批其他任务
- **权限路由**：工具声明副作用等级，权限系统根据等级选择是否走 bashClassifier 静态分析、是否触发 Hook、是否需要用户确认
- **结果持久化**：超过 `maxResultSizeChars`（默认 50k）的结果自动写磁盘，`tool_result` 只返回摘要 + 路径 + 建议后续操作，不把完整输出压进上下文

这套设计的根本价值是：工具行为的每个决策点都是显式的、可观察的，而不是隐藏在 if-else 里的临时逻辑。

**③ 流式执行引擎：边收边跑**

LLM 输出第一个 `tool_use` block 时，工具调用就开始调度，不等 LLM 输出完毕。并发安全的工具（如多个文件读取）并行执行，有副作用的工具串行执行。`StreamingToolExecutor` 是这个机制的实现，状态机 `queued → executing → completed → yielded` 保证结果按 LLM 产出顺序归还，不打乱后续消息结构。感知延迟很大程度来自这里。

**④ 任务系统：跨 Agent 的共享协调面**

任务系统解决了两个正交的问题：

- **上下文压缩的信息丢失**：任务列表是外部存储，不受压缩影响。文件路径、架构决策、未完成步骤写进 Task 后，压缩后任何时刻都能通过 `TaskList` 找回
- **多 Agent 协调**：`CLAUDE_CODE_TASK_LIST_ID` 环境变量让同一个团队的所有 Agent 共享同一张任务白板。文件锁（proper-lockfile）保证并发认领的原子性，`blockedBy` 关系声明任务依赖，Agent 退出时未完成任务自动重置为 pending 等待接管

`DiskTaskOutput` 把异步任务输出写到临时文件（上限 5GB），增量轮询（每 100ms，每次最多读 8MB），完成后以 XML 通知格式注入 Agent 的 user 消息——这让"发出任务不等回答"的异步 Agent 模式有了可靠的完成通知机制。

**⑤ MCP 的工程级实现：不只是"支持协议"**

`src/services/mcp/client.ts`（3351 行）里有几个细节远超"接入协议"的范畴：

- **工具注解映射**：MCP 工具的 `readOnlyHint` 注解直接映射为 `isConcurrencySafe`，外部 server 声明只读后自动获得并发执行权限，和内置工具调度逻辑完全一致
- **OAuth 主动管理**：令牌过期前 5 分钟主动刷新（不等 401），step-up 认证（403 `insufficient_scope`）自动重走 OAuth 流程申请更高权限，XAA 静默令牌交换避免频繁弹窗
- **工具描述截断**：OpenAPI 生成的 MCP server 可能有 15-60KB 工具文档，超过 `MAX_MCP_DESCRIPTION_LENGTH` 自动截断，防止工具列表把 Prompt Cache 打爆
- **工具池排序**：MCP 工具和内置工具按名称排序合并，目的是让工具列表在请求间稳定，提高 Prompt Cache 命中率

**⑥ 权限是设计出发点，不是事后补丁**

`bashClassifier` 在 Shell 执行前静态分析危险模式（`rm -rf /`、`curl | bash`、`mkfs` 等），不需要等用户点确认才知道要小心。六种权限模式（`default/plan/acceptEdits/bypassPermissions/dontAsk/auto`）覆盖从"完全手动确认"到"完全自动执行"的全谱。`plan` 模式特别实用：AI 把整个执行计划先跑一遍只读，返回操作预览，用户确认后切换到 `acceptEdits` 真正执行。整个工具执行链路都围绕权限设计，而不是在末尾加一个确认弹窗。

**⑦ Async Generator 驱动的线性可读性**

整个 Agent Loop 基于 `async function*`，流式输出、工具执行、上下文压缩、错误恢复，全部 `yield` 出来，调用方统一 `for await` 消费。复杂状态机（7 种 transition.reason、6 种退出路径、3 步 max_tokens 恢复）读起来像同步代码。这不只是代码风格问题，而是让复杂控制流可审计、可调试的架构选择。

**⑧ 构建时特性隔离**

30+ 个特性标志在 `bun:bundle` 构建时变成常量，false 分支完全被 tree-shaking 消除。ANT-ONLY 功能（`COORDINATOR_MODE`、`REACTIVE_COMPACT`、`DAEMON` 等）在发布包中字面上不存在，不只是被禁用。内部构建和外部发布用同一套代码但行为不同，实验性功能不影响发布包体积。

**⑨ 四条扩展路径各司其职**

MCP（接外部服务）、Hook（挂外部工具链）、Skill（固化内部工作流）、Plugin（修改内部行为）四条路径方向不同、不互相替代，覆盖了企业接入场景的不同需求层次。`permission_request` Hook 让企业把权限决策外包给自己的合规脚本，是有安全审计要求的团队的硬需求。

---

#### 1.5.2 缺点

**绑死 Anthropic**

`utils/model/providers.ts` 里提供商判断是 if-else 硬编码。要接 GPT、Gemini、DeepSeek，得改核心代码，没有插件化路径。这是商业模式决定的，Claude Code 本身不打算支持竞争对手的模型。二次开发者只能依赖 LiteLLM 这类兼容代理绕过去。

**零测试覆盖**

`CLAUDE.md` 明确写着 "No test runner is configured"。1486 行权限系统、1732 行 Agent Loop 主循环、3351 行 MCP 客户端，一个测试都没有。在反编译代码基础上做二次开发，改一处不知道有没有破坏别处，风险被放大。

**TUI 性能天花板**

`src/screens/REPL.tsx` 是 5000+ 行的 React/Ink 组件。消息超过 1000 条时帧率下降，虚拟滚动效果不如 Web 栈。React Compiler 的 memoize 输出（满屏 `_c(N)` 调用）让代码可读性很差，调试困难。

---

### 小结

Claude Code 在架构层面解决了一个很难的问题：**让 AI 在生产环境里可预期地执行复杂任务**。Async Generator 驱动的 Agent Loop、流式工具执行、六种权限模式、五层上下文管理、多 Agent 协调基础设施，这些设计加在一起，让"重构整个认证系统"这类任务有了可靠执行的技术基础。

弱点同样是结构性的：模型提供商硬编码为 Anthropic、零测试覆盖（`CLAUDE.md` 明确写着 "No test runner is configured"）、`REPL.tsx` 在消息量大时帧率明显下降。另外，由于是反编译产物，大量 ANT-ONLY 功能（`COORDINATOR_MODE`、`REACTIVE_COMPACT`、`DAEMON` 等）在此版本中为存根或关闭状态，正式版的完整能力远超文档所见。

---