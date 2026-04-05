# Claude Code vs CoStrict 深度对比分析

> 报告日期：2026-04-02
> 代码依据：Claude Code 反编译版 + CoStrict CLI v3.0.18

---

## 目录

1. [Claude Code 深度分析以及优缺点](#一claude-code-深度分析以及优缺点)
2. [CoStrict 深度分析以及优缺点](#二costrict-深度分析以及优缺点)
3. [Claude Code & CoStrict 深入各个维度的对比](#三claude-code--costrict-深入各个维度的对比)
4. [CoStrict+开源模型 比 claude code+开源模型 更强？](#四costrict开源模型-比-claude-code开源模型-更强)
5. [Claude Code 源码泄漏事件后，CoStrict 应该怎么做](#五claude-code-源码泄漏事件后costrict-应该怎么做)

---

## 一、Claude Code 深度分析以及优缺点

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

##### 查询引擎子模块（src/query/）

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

### 1.6 小结

Claude Code 在架构层面解决了一个很难的问题：**让 AI 在生产环境里可预期地执行复杂任务**。Async Generator 驱动的 Agent Loop、流式工具执行、六种权限模式、五层上下文管理、多 Agent 协调基础设施，这些设计加在一起，让"重构整个认证系统"这类任务有了可靠执行的技术基础。

弱点同样是结构性的：模型提供商硬编码为 Anthropic、零测试覆盖（`CLAUDE.md` 明确写着 "No test runner is configured"）、`REPL.tsx` 在消息量大时帧率明显下降。另外，由于是反编译产物，大量 ANT-ONLY 功能（`COORDINATOR_MODE`、`REACTIVE_COMPACT`、`DAEMON` 等）在此版本中为存根或关闭状态，正式版的完整能力远超文档所见。

---


## 二、CoStrict 深度分析以及优缺点

这是一个**以模型无关为核心约束**设计出来的系统。Provider 层、ProviderTransform、工具注册机制——每个模块都在回答同一个问题：**怎么让任意 LLM 都能可靠地驱动 AI 编程 Agent**。想理解它的强处和弱处，得从整体结构开始看。

---

### 2.1 核心技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| **运行时** | Bun | 原生 TypeScript，bun:sqlite 内置驱动 |
| **语言** | TypeScript（strict 模式）| 完整类型覆盖，Zod v4 验证全链路 |
| **LLM 接入** | Vercel AI SDK（`ai` 包）| 统一 `streamText` / `LanguageModelV2` 适配层 |
| **Provider 数量** | 20+ | Anthropic/OpenAI/Azure/Bedrock/Vertex/OpenRouter/Groq/Mistral/Cohere/DeepInfra/Cerebras/Together/Perplexity/Vercel/xAI/GitLab/GitHub Copilot 等 |
| **终端 UI** | React 19 + Ink | TUI 层，与 Agent 核心共享 Provider 层 |
| **桌面端** | Electron（`packages/desktop-electron`）| 原生桌面应用 |
| **存储** | SQLite（bun:sqlite）+ Drizzle ORM | 结构化持久化会话/项目/权限数据 |
| **事件总线** | Bus 模块（`src/bus/`）| 全局事件解耦，TypeScript 泛型强类型 |
| **Schema 验证** | Zod v4 | 工具参数、配置、API 响应统一验证 |
| **扩展协议** | `@modelcontextprotocol/sdk ^1.25.2` | MCP 标准 SDK |
| **树语法分析** | `web-tree-sitter` | FileOutlineTool 代码结构提取 |
| **Agent 通信** | `@agentclientprotocol/sdk ^0.14.1` | ACP 跨 Agent 通信协议 |

```bash
# 开发运行
bun run build:builtin-agents  # 生成内置 Agent 提示词
bun run --conditions=browser ./src/index.ts

# 构建
bun run script/build.ts

# 数据库管理
bun drizzle-kit
```

---

### 2.2 核心架构设计

#### 2.2.1 Agent Loop：会话驱动的执行引擎

CoStrict 的 Agent Loop 不是单一函数，而是三层职责分离的架构，核心入口在 `src/session/prompt.ts`（1998 行）。

---

##### 三层架构分工

```
SessionPrompt.run()          ← 外层循环：会话状态机（session/prompt.ts, ~1998行）
  ↓ 委托给
SessionProcessor.create()   ← 中层：单次 LLM 调用的生命周期（session/processor.ts, 489行）
  ↓ 调用
LLM.stream()                ← 底层：跨 Provider 流式接入（session/llm.ts, 351行）
```

**外层循环**（`prompt.ts`）是整个系统的心跳：

```typescript
// src/session/prompt.ts
let step = 0
while (true) {
  SessionStatus.set(sessionID, { type: "busy" })

  // 1. 从 SQLite 加载当前会话所有消息（含压缩过滤）
  let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

  // 2. 扫描最后一条 user/assistant 消息，判断当前状态
  let lastUser, lastAssistant, lastFinished, tasks

  // 3. 分支处理
  if (task?.type === "subtask")   → 执行子任务后 continue
  if (task?.type === "compaction") → 运行压缩后 continue
  if (isOverflow(lastFinished))   → 创建压缩标记后 continue

  // 4. 正常处理：创建 processor，执行单轮 LLM 调用
  const processor = SessionProcessor.create({ assistantMessage, model, abort })
  const result = await processor.process({ user, agent, messages, tools })

  // 5. 根据 result 决定下一步
  if (result === "stop")    → break（结束）
  if (result === "compact") → 创建压缩任务后 continue
  continue  // result === "continue"
}
```

**`processor.process()` 的返回值**是外层循环的控制信号：

| 返回值 | 含义 | 外层响应 |
|--------|------|---------|
| `"continue"` | 工具调用完成，继续对话 | `continue`（下一轮） |
| `"stop"` | 权限拒绝 / 模型完成 / 错误 | `break`（退出循环）|
| `"compact"` | context 触发压缩阈值 | 创建 compaction 标记后 `continue` |

---

##### ReAct 模式的具体实现

**Reason**：LLM 流式输出

```typescript
// processor.ts：监听 AI SDK 的 fullStream 事件流
const stream = await LLM.stream({ ...streamInput, messages: state.messages })

for await (const value of stream.fullStream) {
  switch (value.type) {
    case "reasoning-start":  // 推理开始（DeepSeek/Claude 扩展思考）
    case "reasoning-delta":  // 推理增量
    case "tool-input-start": // 工具调用开始，即时写入 DB
    case "tool-call":        // 工具参数完整，触发 doom_loop 检测
    case "tool-result":      // 工具执行结果
    case "text-start":       // 文本输出开始
    case "text-delta":       // 文本增量
    case "finish-step":      // 单步完成，记录 token/cost/snapshot
  }
}
```

**Act**：工具执行（由 AI SDK 的 `streamText` 内部并发调度）

CoStrict 不自己实现工具并发调度，而是委托给 Vercel AI SDK 的 `streamText` 多步工具执行：

```typescript
// llm.ts
return streamText({
  model: wrappedModel,
  messages: normalizedMessages,
  tools,               // Record<string, Tool>
  maxSteps: 100,       // AI SDK 内部多步 tool-call 循环
  toolChoice,
  temperature,
  // ...
})
```

**Observe**：工具结果注入

每个 `tool-result` 事件触发 DB 写入，下一轮 `MessageV2.stream()` 从 SQLite 读取完整消息历史，包含所有工具结果——这是 CoStrict 与 Claude Code 的关键区别：**状态持久化在 SQLite，不在内存**。

---

##### Doom Loop 保护

`processor.ts` 内置无限循环检测：

```typescript
const DOOM_LOOP_THRESHOLD = 3

// 检查最近 3 个 part 是否为完全相同的工具调用
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
if (
  lastThree.length === DOOM_LOOP_THRESHOLD &&
  lastThree.every(
    (p) =>
      p.type === "tool" &&
      p.tool === cleanedToolName &&
      JSON.stringify(p.state.input) === JSON.stringify(cleanedInput)
  )
) {
  // 触发权限询问，让用户决定是否继续
  await PermissionNext.ask({ permission: "doom_loop", ... })
}
```

三次完全相同的工具调用（工具名 + 参数完全一致）会触发 doom_loop 权限询问，阻断无限循环，而不是直接报错退出。

---

##### 错误恢复与重试

`SessionRetry` 模块提供完整的重试策略（`retry.ts`）：

```typescript
export const MAX_RETRY_ATTEMPTS = 10
export const RETRY_INITIAL_DELAY = 2000      // 2s 起步
export const RETRY_BACKOFF_FACTOR = 2         // 指数退避
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000  // 无头部时最大 30s

// 优先读取响应头的 retry-after / retry-after-ms
// 兜底使用指数退避
```

特殊错误处理：
- `ReasoningOnlyError`：响应仅含推理内容无工具/文本 → 禁用 thinking 后重试
- `ContextOverflowError`：上下文溢出 → 不重试，触发压缩
- `connection error`：连接错误 → 总是重试（不受 isRetryable 限制）
- CoStrict provider 有独立的 `CostrictError.retryable()` 判断逻辑

---

#### 2.2.2 工具体系：标准工具 + CoStrict 专属工具

工具注册在 `src/tool/registry.ts`，分三类来源：

```
内置标准工具（tool/ 目录）
  文件操作：ReadTool / WriteTool / EditTool / GlobTool / GrepTool / LsTool
  多文件编辑：MultiEditTool / BatchTool / ApplyPatchTool
  Shell执行：BashTool（含危险命令分析）
  Web能力：WebFetchTool / WebSearchTool / CodeSearchTool
  LSP集成：LspTool
  工作规划：PlanEnterTool / PlanExitTool
  任务管理：TaskTool / TodoWriteTool / TodoReadTool
  Agent协调：QuestionTool
  技能调用：SkillTool
  截断保护：Truncate（工具输出防止上下文爆炸）

CoStrict 专属工具（costrict/tool/ 目录）
  SequentialThinkingTool  ← 结构化思考（支持修订/分支）
  FileOutlineTool          ← tree-sitter 代码结构提取
  CheckpointTool           ← git checkpoint commit/restore/revert
  WorkflowTool             ← 三种工作模式提示词注入
  SpecManageTool           ← 规格管理

用户自定义工具（动态加载）
  Config.directories() → 扫描 {tool,tools}/*.{js,ts}
  Plugin 注册 → plugin.tool 字段
```

**CoStrict 专属工具详解**

| 工具 | 功能 | 设计意图 | 状态 |
|------|------|---------|------|
| `SequentialThinkingTool` | 分步思考，支持修订(revision)和分支(branch) | 弥补开源模型推理能力不足 | 正式启用 |
| `FileOutlineTool` | 用 tree-sitter 提取类/函数/方法签名和 docstring | 大文件场景下替代 FileRead | 正式启用 |
| `CheckpointTool` | `commit/list/show_diff/restore/revert` 五种 git 操作 | 比 Snapshot 更细粒度的版本控制 | experimental（`config.experimental.checkpoint !== false` 时启用） |
| `WorkflowTool` | `build/plan/spec` 三种模式的提示词注入 | 标准化工作流，降低开源模型的理解负担 | 正式启用 |
| `SpecManageTool` | 规格管理 | 驱动 spec 工作流的规格文档操作 | experimental（`config.experimental.spec_manage !== false` 时启用） |
| `FileImportanceTool` | 分析文件在项目中的重要性和关联度 | 辅助 Agent 优先读取关键文件，减少无效上下文 | **已弃用**（代码保留，未注册） |
| `CallGraphTool` | 提取函数调用图和依赖关系 | 大型代码库中快速理解模块调用链，辅助影响面分析 | **已弃用**（代码保留，未注册） |

**SequentialThinkingTool 的结构化思考**：

```typescript
interface ThoughtData {
  thought: string
  thoughtNumber: number
  totalThoughts: number
  nextThoughtNeeded: boolean
  isRevision?: boolean       // 是否修订之前的思考
  revisesThought?: number    // 修订的是第几步思考
  branchFromThought?: number // 从第几步思考分叉
  branchId?: string          // 分支 ID
}
// 💭 Thought / 🔄 Revision / 🌿 Branch 三种渲染格式
```

**工具名称规范化**：CoStrict 在 `processor.ts` 中对工具名进行特殊处理：

```typescript
import { toolInputFormatter, toolNameFormatter } from "@/costrict/utils/tool-transform-v2"

// 处理模型可能输出的 namespaced 工具名（如 mcp__tool__name → 查找实际工具）
const cleanedToolName = toolNameFormatter(value.toolName, availableTools)
const cleanedInput = toolInputFormatter(value.input, value.toolCallId)
```

这是为了兼容不同 LLM 对工具名格式的不同输出习惯，是模型无关设计的体现。

---

#### 2.2.3 Provider 层：真正的模型无关

Provider 层是 CoStrict 最核心的差异化设计，位于 `src/provider/`。

**已集成 Provider（`provider.ts`，1536 行）**：

```typescript
// 直接 import，构建时 tree-shaking 优化
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab } from "@gitlab/gitlab-ai-provider"
// + GitHub Copilot 自定义适配，openai-compatible 通用接入
```

任意符合 OpenAI 兼容协议的 Endpoint（Ollama / vLLM / LMStudio）都能通过 `openai-compatible` 接入。

**LiteLLM 代理兼容层**：

`llm.ts` 中对 LiteLLM 和 Anthropic 代理有专门处理：当检测到代理环境时，自动注入虚拟工具以规避部分代理层对空工具列表的兼容问题，保证工具调用正常透传。

**`ProviderTransform`：跨 Provider 能力归一化**

```typescript
// Anthropic 拒绝空 content 消息 → 自动过滤
if (model.api.npm === "@ai-sdk/anthropic") {
  msgs = msgs.filter(msg => msg.content !== "")
}

// Mistral 要求 toolCallId 9位纯字母数字 → 自动规范化
if (model.providerID === "mistral") {
  const normalizedId = part.toolCallId
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 9).padEnd(9, "0")
}

// Claude toolCallId 只能含 [a-zA-Z0-9_-] → 自动替换
if (model.api.id.includes("claude")) {
  toolCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_")
}
```

每个 Provider 的格式怪癖都在这一层消化，上层 Agent Loop 感知不到差异。

**Model 元数据管理**：

`models.ts` + `models-macro.ts` 实现了构建时快照 + 运行时更新的双轨模型管理：

```typescript
// 构建时：从 models.dev API 生成快照嵌入二进制
const filepath = path.join(Global.Path.cache, "models.json")

// 模型能力声明（每个模型都标注）
{
  id: "deepseek-r1",
  reasoning: true,       // 支持推理模式
  tool_call: true,       // 支持工具调用
  temperature: true,     // 支持 temperature 参数
  attachment: false,     // 不支持图片附件
  interleaved: { field: "reasoning_content" },  // 推理内容字段名
  cost: { input: 0.14, output: 2.19 },           // 每百万 token 成本
  limit: { context: 128000, output: 8000 },
}
```

Agent 在选择工具、设置参数前，会查询 `model.capabilities`，确保不发送模型不支持的能力（如向不支持 tool_call 的模型发送工具定义）。

---

#### 2.2.4 MCP 集成：含 OAuth 的无限扩展口

MCP 集成基于 `@modelcontextprotocol/sdk ^1.25.2`，位于 `src/mcp/`。

##### 传输层与连接方式

CoStrict 的 MCP 支持三种传输协议，按优先级自动降级：

```
StreamableHTTP  → 远程服务，优先尝试（HTTP 长连接）
SSE             → 远程服务，HTTP 降级备选
Stdio           → 本地服务，进程子进程模式
```

配置格式：

```jsonc
// opencode.json / .costrict/config.json
{
  "mcp": {
    "my-local-server": {
      "type": "local",
      "command": ["node", "/path/to/server.js"],
      "environment": { "API_KEY": "${SOME_VAR}" },
      "timeout": 30000
    },
    "my-remote-server": {
      "type": "remote",
      "url": "https://api.example.com/mcp",
      "oauth": { "clientId": "my-client-id", "scope": "read write" },
      "timeout": 30000
    }
  }
}
```

默认超时 `DEFAULT_TIMEOUT = 30_000`，每个 Server 可独立覆盖。`experimental.mcp_timeout` 可设置全局默认值。

##### 生命周期管理

`MCP.state()` 使用单例模式，每个已命名的 Server 只维护一个客户端实例：

```
状态机：
  "connected"                  ← 正常工作
  "disabled"                   ← 配置中 enabled: false
  "failed"                     ← 连接失败
  "needs_auth"                 ← 需要 OAuth 授权
  "needs_client_registration"  ← OAuth 动态注册失败
```

关闭时会清理完整进程树，包括 grandchild 进程，避免孤立进程残留。

##### 工具注册流程

MCP 工具在连接建立后动态注入 `ToolRegistry`，和内置工具对 Agent 完全透明：

```
MCP.tools()
  → 过滤 status === "connected" 的客户端
  → client.listTools()
  → 工具名规范化：sanitizedClientName_sanitizedToolName
  → convertMcpTool() 转为 AI SDK dynamicTool 格式
  → 返回 Record<string, Tool>
```

除工具外，还支持 **Resources**（`client.listResources()` / `client.readResource(uri)`）和 **Prompts**（`client.listPrompts()` / `client.getPrompt(name, args)`），以及 `ToolListChangedNotification` 热更新通知。

##### OAuth 2.0 鉴权扩展

这是 CoStrict 相比 Claude Code 最显著的 MCP 扩展点，支持需要 OAuth 2.0 的企业内部 MCP Server。

**认证存储**（`auth.ts`）：令牌持久化到 `~/.config/opencode/mcp-auth.json`（权限 0o600），存储结构：

```typescript
{
  tokens: { accessToken, refreshToken, expiresAt },
  clientInfo: ClientInfo,   // OAuth 动态注册结果
  codeVerifier: string,     // PKCE code_verifier
  oauthState: string,       // CSRF 防护 state 参数
  serverUrl: string,        // 防止 URL 变更后凭证错误复用
}
```

**PKCE 流程**（`oauth-provider.ts`）：

```
回调地址：http://127.0.0.1:19876/mcp/oauth/callback（固定端口，单实例共享）

客户端元数据：
  grant_types: ["authorization_code", "refresh_token"]
  token_endpoint_auth_method: 有 clientSecret 时用 "client_secret_post"，否则 "none"

客户端 ID 三层优先级：
  1. 配置文件指定的 clientId（预注册客户端）
  2. 动态注册的客户端信息（RFC 7591，缓存到 auth.json）
  3. 未定义 → 触发新的动态注册
```

**完整认证流程**：

```
MCP.authenticate(name)
  → 启动回调服务器（:19876）
  → 生成 state 参数（CSRF 防护），写入 auth.json
  → 返回 authorizationUrl，打开浏览器
  → 等待 /mcp/oauth/callback 回调（超时 5 分钟）
  → 验证 state，提取 authorization code
  → transport.finishAuth(code)
  → 令牌持久化，重新连接 MCP Server
```

---

#### 2.2.5 Skill 系统：多目录兼容的工作流固化

Skill 系统设计上兼容生态，位于 `src/skill/`。

##### Skill 文件格式

每个 Skill 是一个带 frontmatter 的 Markdown 文件，文件名固定为 `SKILL.md`：

```yaml
---
name: review-pr          # 必需，唯一名称
description: 审查 PR 代码质量  # 必需，一句话描述
---

# Skill 正文（Markdown）
...
```

##### 搜索路径与加载优先级

Skill 在初始化时按以下顺序扫描，**后发现的不覆盖先发现的**（同名技能保留高优先级路径）：

```
① 内置缓存技能   ~/.config/costrict/skills/        ← 最低优先级
② 用户全局技能   ~/.costrict/skills/
                ~/.claude/skills/                  ← Claude Code 技能直接兼容
                ~/.agents/skills/
③ 项目级技能     {project}/**/.costrict/skills/     ← 最高优先级
                {project}/**/.claude/skills/
④ 自定义路径     config.skills.paths 指定目录
⑤ URL 技能       config.skills.urls 远程拉取，缓存到本地
⑥ 学习候选       .learnings/CANDIDATES/ 中已批准的规则
```

扫描模式：

```typescript
const EXTERNAL_DIRS = [".costrict", ".claude", ".agents"]  // 三种约定目录
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
```

`.claude` 目录下的 Claude Code 技能无需迁移即可直接使用。同名技能不覆盖，产生警告日志。

##### 内置 Skill 的自动初始化与版本管理

内置技能通过 `CoStrictSkill.Extension.initializeBuiltinSkills()` 在启动时自动维护，以 commit SHA 作为版本标识：

```typescript
// builtin.ts 由 script/generate-skills.ts 自动生成
// 每次启动检查 .version 文件 vs 嵌入的 commit SHA
// 版本不匹配 → 删除旧目录 → 解压新版本 → 写入新 .version 文件
```

存储结构：
```
~/.config/costrict/skills/
  security-review/
    SKILL.md         ← 技能内容
    reference.md     ← 附属文档（可选）
    .version         ← commit SHA（与 SKILL.md 分离，单独管理）
```

##### Skill 访问控制与 Agent 绑定

Skill 的可见性通过 `PermissionNext.evaluate()` 集中管理，Agent 配置中可细粒度声明哪些 Skill 允许使用：

```typescript
// Agent 权限配置（agent.permission 字段）
{
  skill: {
    "*": "allow",              // 默认放行所有技能
    "internal-only": "deny"    // 屏蔽特定技能
  }
}
```

`Skill.available(agent)` 在返回列表前应用权限过滤，被 deny 的技能不出现在 LLM 可调用的列表中。

##### SkillTool 的执行机制

Agent 通过 `SkillTool` 按名称调用 Skill，执行时读取 SKILL.md 完整内容，以 XML 标签格式注入上下文：

```xml
<skill_content name="review-pr">
# Skill: review-pr
...（SKILL.md 完整内容）...
<skill_files>
<!-- 最多列出 10 个相关文件 -->
</skill_files>
</skill_content>
```

调用前经过 `PermissionNext` 权限校验，返回 metadata 包含技能名称和所在目录。

---

#### 2.2.6 上下文管理：三路压缩机制

CoStrict 的上下文管理以 SQLite 为中心，分三路处理溢出。

**配置层**（`config.ts` + 多级配置文件）：

```
/etc/opencode/config.json           ← 企业托管（最高优先级，admin 控制）
~/.config/opencode/config.json      ← 用户全局
{project}/opencode.json             ← 项目级
{project}/.costrict/config.json     ← 旧约定（向下兼容）
{project}/.claude/config.json       ← Claude Code 兼容
```

指令文件（instructions）也类似多层叠加，类比 Claude Code 的 CLAUDE.md。

**溢出检测**（`compaction.ts`）：

```typescript
export async function isOverflow({ tokens, model }) {
  // 可配置：compaction.auto = false 禁用自动压缩
  // 计算可用 token 数
  const reserved = config.compaction?.reserved
    ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model))  // 默认 20k
  const usable = model.limit.input
    ? model.limit.input - reserved
    : context - maxOutputTokens(model)

  return tokens.total >= usable
}
```

**三路压缩策略**：

```
策略一：Tool Output Prune（最轻量，零 LLM 调用）
  位置：prompt.ts 主循环结束时
  逻辑：去除旧工具调用的输出（保留最近 40k token 的工具调用输出）
        常量：PRUNE_MINIMUM = 20,000（最小保留量）/ PRUNE_PROTECT = 40,000（保护范围）
  效果：减少上下文体积，不损失对话结构
  触发：每次循环结束自动调用 SessionCompaction.prune()

策略二：Session Compaction（中量，一次 LLM 调用）
  触发：isOverflow() 返回 true
  执行：
    1. 创建 compaction 标记消息写入 DB
    2. 下轮循环检测到标记 → 调用 SessionCompaction.process()
    3. 用专用 compaction agent（可独立配置模型）生成结构化摘要
    4. 摘要写入新 assistant 消息（summary: true 标记）
    5. 如果是 overflow 场景，尝试 replay 上一条用户消息

  摘要模板（五段式）：
    ## Goal           ← 用户目标
    ## Instructions   ← 重要指令和计划
    ## Discoveries    ← 过程发现
    ## Accomplished   ← 已完成/进行中/待完成
    ## Relevant files ← 相关文件目录结构

策略三：Overflow Compaction（极端场景）
  触发：processor.process() 返回 "compact"（即使是压缩任务本身也 overflow）
  执行：
    - 去除媒体附件（stripMedia: true）
    - 重置到更早的消息点
    - 通知用户媒体过大
```

---

#### 2.2.7 权限系统：PermissionNext

权限系统位于 `src/permission/`（`next.ts` 297 行 + `yolo.ts` + `schema.ts`），相比 Claude Code 的 6000 行权限系统，CoStrict 采用更简洁的设计：

**三级动作 + Glob 规则**：

```typescript
// 三种 action
export const Action = z.enum(["allow", "deny", "ask"])

// 规则结构
export const Rule = z.object({
  permission: z.string(),  // 权限类型，如 "read" / "write" / "bash" / "doom_loop"
  pattern: z.string(),     // glob 通配符
  action: Action,
})
```

**默认规则（来自 `agent.ts`）**：

```typescript
PermissionNext.fromConfig({
  "*": "allow",              // 默认放行
  doom_loop: "ask",          // 无限循环检测必须询问
  external_directory: {
    "*": "ask",              // 外部目录默认询问
    [skillDirs]: "allow",    // skill 目录放行
  },
  question: "deny",          // 子 agent 不能发起问题（防滥用）
  plan_enter: "deny",        // 子 agent 不能进入计划模式
  read: {
    "*": "allow",
    "*.env": "ask",          // .env 文件询问
    "*.env.*": "ask",
    "*.env.example": "allow",// example 文件放行
  },
})
```

**Session 级别权限持久化**：

```typescript
// 用户选择 "always allow" 时，规则写入 SQLite PermissionTable
// 下次同一 project 相同操作直接放行，无需再次询问
const row = Database.use((db) =>
  db.select().from(PermissionTable).where(eq(PermissionTable.project_id, projectID)).get()
)
const stored = row?.data ?? []  // 已批准的规则集
```

**YoloMode**（全自动放行）：

```typescript
// permission/yolo.ts
export namespace YoloMode {
  export function isEnabled(): boolean { ... }
  // 对应 Claude Code 的 bypassPermissions 模式
}
```

---

#### 2.2.8 Plugin 系统：事件驱动的扩展架构

Plugin 系统位于 `src/plugin/`，采用 Hook 事件机制，位于 `src/plugin/index.ts`。

**内置 Plugin 列表**：

```typescript
const INTERNAL_PLUGINS = [
  CodexAuthPlugin,    // OpenAI Codex OAuth 鉴权（src/plugin/codex.ts）
  CopilotAuthPlugin,  // GitHub Copilot 鉴权（src/plugin/copilot.ts）
  CoStrictAuthPlugin, // CoStrict 平台鉴权（src/costrict/plugin）
  TDDPlugin,          // TDD 工作流增强（src/plugin/tdd）
  GitlabAuthPlugin,   // GitLab 鉴权（外部包：@gitlab/opencode-gitlab-auth）
  LearningPlugin,     // 学习系统（自动规则提炼）（src/learning/plugin）
]
```

**Hook 事件点**：

```typescript
// 可插入的生命周期钩子
"chat.params"                          // LLM 调用参数（temperature/topP/options）
"chat.headers"                         // HTTP 请求头定制
"experimental.chat.system.transform"   // 系统提示词变换
"experimental.chat.messages.transform" // 消息列表变换（发送前）
"experimental.text.complete"           // 文本输出完成后处理
"experimental.session.compacting"      // 压缩提示词注入/替换
"experimental.shell.env"               // Shell 环境变量定制
"tool.execute.before"                  // 工具执行前干预（可修改参数或阻断）
"event"                                // 全局 Bus 事件监听
```

**外部 Plugin 动态安装**：

```typescript
// config.json
{ "plugin": ["my-custom-plugin@1.0.0", "file://./local-plugin"] }

// Plugin.list() 自动通过 BunProc.install() 安装 npm 包
// 支持 file:// 协议的本地插件
```

---

### 2.3 高级特性

#### 2.3.1 内置 Agent 矩阵：覆盖完整研发生命周期的工作流引擎

这是 CoStrict 最核心的差异化能力，也是与 Claude Code 最本质的区别所在。Claude Code 给你一个强大的单 Agent，让模型自己决定怎么走；CoStrict 给你 17 个专项 Agent 组成的协作网络，每个 Agent 只负责一件事，通过 `task` 工具串联成可复现的工作流。

---

##### 工作流矩阵全景

```
Strict 严格工作流（顶层编排，2 个）
  strict-spec   ← 规格驱动模式：需求→设计→任务拆分→执行 四阶段严格编排
  strict-plan   ← 计划驱动模式：探索→澄清→提案→实施 完整生命周期

Spec 规格驱动子工作流（5 个）
  spec-requirement  ← 需求分析（Requirement Agent）
  spec-design       ← 架构设计（DesignAgent，C4 Model 方法论）
  spec-task         ← 任务拆分（TaskPlan Agent）
  spec-plan         ← 规格计划（SpecPlan Agent）
  spec-plan-manager ← 计划执行协调（PlanManager Agent）

Plan 规划执行子工作流（5 个）
  plan-quick-explore ← 快速探索（QuickExplore Agent）
  plan-apply         ← 任务执行协调（CodingAgent）
  plan-sub-coding    ← 代码实现（SubCodingAgent）
  plan-task-check    ← 任务验收（TaskCheck Agent）
  plan-fix-agent     ← 修复（ReviewAndFix Agent）

TDD 测试驱动工作流（4 个，通过 plugin/tdd 实现）
  tdd              ← TestDrivenDevelopment 编排 Agent
  run-and-fix      ← 可运行性验证 + 自动修复
  test-design      ← 测试用例设计
  test-and-fix     ← 测试执行 + 失败自动修复

Wiki 文档生成工作流（4 个）
  01-wiki-project-analyze   ← 项目分析
  02-wiki-catalogue-design  ← 目录设计
  03-wiki-document-generate ← 文档生成
  04-wiki-index-generation  ← 索引生成
```

每个 Agent 有 `zh-CN` 和 `en` 双语版本（`locales/` 目录），构建时通过 `script/generate-agents.ts` 自动生成 `builtin.ts`。

---

##### StrictSpec：规格驱动的顶层编排器

`strict-spec` 是 CoStrict 工作流体系的入口——用户只需要描述需求，它负责按顺序编排所有后续 Agent：

```
用户输入需求
    ↓
StrictSpec（工作流编排专家）
    ↓ task 工具启动
┌──────────────────────────────────────────────────────────┐
│ 阶段 1：需求明确  → Requirement Agent → .cospec/spec/{功能名}/spec.md   │
│ 阶段 2：架构设计  → DesignAgent      → .cospec/spec/{功能名}/tech.md   │
│ 阶段 3：任务拆分  → TaskPlan Agent   → .cospec/plan/changes/{id}/task.md│
│ 阶段 4：方案执行  → PlanManager      → 按任务清单分发 SubCodingAgent    │
└──────────────────────────────────────────────────────────┘
```

**核心设计约束**（来自 `strict-spec.txt`）：

```yaml
# StrictSpec 的权限配置——除了 4 个协作 Agent，其他全部禁止
permission:
  task:
    general: deny
    explore: deny
    QuickExplore: deny      # 禁止绕过标准流程
    PlanApply: deny         # 禁止直接跳到执行
    SubCodingAgent: deny    # 禁止直接写代码
    Requirement: allow      # 允许：需求分析
    DesignAgent: allow      # 允许：架构设计
    TaskPlan: allow         # 允许：任务拆分
    PlanManager: allow      # 允许：执行协调
```

自动阶段检测——通过检查 `.cospec/` 目录文件状态判断从哪个阶段继续：

| 文件状态 | 进入阶段 |
|---------|---------|
| 无文件 | 需求明确阶段 |
| 有 spec.md | 架构设计阶段 |
| 有 tech.md | 任务拆分阶段 |
| 有 task.md | 方案执行阶段 |
| 用户输入"继续" | 调用 `spec-manage` 工具检测断点后续 |

---

##### StrictPlan：探索驱动的计划制定专家

`strict-plan` 面向更灵活的场景——需求未必完整，必须先探索项目才能制定有效计划：

```
用户输入（可能只是一句话）
    ↓
StrictPlan
    ↓ 并行启动 1-3 个 QuickExplore
┌──────────────────────────────────────────┐
│ QuickExplore ①：分析现有认证模块实现      │
│ QuickExplore ②：分析会话管理调用链路      │
│ QuickExplore ③：分析权限校验中间件        │
└──────────────────────────────────────────┘
    ↓ 汇总探索结果，通过 question 工具澄清需求
    ↓ 创建提案 → .cospec/plan/changes/{change-id}/
    ├── proposal.md  （原因 + 变更内容 + 影响分析）
    └── task.md      （有序的可验证工作项清单）
    ↓ task 工具启动 PlanApply 执行
    ↓ task 工具启动 TestDrivenDevelopment 测试
```

**需求澄清的核心原则**（来自 `strict-plan.txt`）——这段逻辑是 CoStrict 的精华之一：

> - **项目信息优先**：凡是可以通过项目探索获得的信息，都不得向用户提问
> - **代码可答则不问**：问题可通过阅读代码得到答案则禁止提问
> - **需求已明确则不重复**：用户已明确说明的细节不重复提问
> - **高价值问题优先**：只提问会显著影响实现方案、且无法从代码推断的问题

提案的文件结构规范（任务清单格式）：

```markdown
# .cospec/plan/changes/add-two-factor-auth/task.md

## 实施
- [ ] 1.1 在 CCR 流式响应中集成 ES 记录
     【目标对象】`src/services/ccrRelayService.js`
     【修改目的】在 CCR 流式响应完成回调中记录数据
     【修改方式】在 relayStreamRequestWithUsageCapture 方法的 usageData 回调中
     【相关依赖】`lib/VTP/Cron/elasticsearchService.js` 的 `indexRequest()`
     【修改内容】
        - 导入 elasticsearchService
        - 在 usageData 回调中提取完整请求体和响应体
        - 调用 elasticsearchService.indexRequest() 异步记录
        - 添加错误处理
- [ ] 1.2 ...
```

每个子任务都明确了"改哪里"、"改什么"、"为什么改"、"依赖什么"——SubCodingAgent 拿到这份清单就能精确执行，不需要任何猜测。

---

##### TDD 测试驱动工作流：4 个专项 Agent 的完整测试链路

Claude Code 没有专门的测试 Agent，测试完全依赖模型自行判断。CoStrict 的 TDD 工作流把测试拆成 4 个专项步骤，每步有专门的 Agent 负责：

```
TestDrivenDevelopment（编排层）
    │
    ├─ 步骤 1：RunAndFix（可运行性验证）
    │     - 自动检测项目类型（Go/Rust/TypeScript/Python 等）
    │     - 找到并执行验证命令（编译 → 构建 → 测试）
    │     - 修复编码问题（语法错误、类型错误、逻辑 bug）
    │     - 区分"编码问题（自动修复）"vs"环境问题（退出报告）"
    │
    ├─ 步骤 2：用户需求确认（question 工具）
    │     - 展示测试范围，等待用户确认后再继续
    │
    ├─ 步骤 3：TestDesign（测试用例设计）
    │     - 设计正常场景、边界条件、异常处理的完整测试点
    │     - 输出 → .cospec/test-plans/test-plan-*.md
    │
    └─ 步骤 4：TestAndFix（测试执行 + 自动修复）
          - 执行测试，系统诊断失败
          - 优先修复业务代码（而非降低测试标准）
          - 最多 3 轮自动修复循环
          - 输出含修复详情的执行报告
```

RunAndFix 的语言覆盖范围（来自 `plugin/tdd/agents/prompts/run_and_fix.txt`）：

| 语言类型 | 支持的验证命令 |
|---------|-------------|
| C/C++ | gcc, g++, clang, cmake, make |
| Go | go build, go test |
| Rust | cargo build, cargo test |
| Java | javac, maven, gradle |
| JS/TS | npm, bun, yarn, pnpm |
| Python | pytest, unittest, pip |

**与 Claude Code 的关键差异**：Claude Code 在测试失败时依赖模型自行诊断，可能循环尝试。TestAndFix 有明确的"最多 3 轮"边界，诊断逻辑结构化，测试计划先保存到文件再执行，整个过程可审查、可重现。

---

##### SpecRequirement：8 阶段结构化需求分析

`spec-requirement` 不只是"整理需求"，它是严格的 8 阶段需求工程流程：

```
阶段 1：工作目录创建 → .cospec/spec/{功能名}/
阶段 2：需求理解（5W2H 分析法，识别表层/中层/深层目标）
阶段 3：需求澄清（基于现有代码，识别用户未提及的技术约束）
阶段 4：用户故事（角色 + 行动 + 价值三要素格式）
阶段 5：系统需求（功能性需求 + 非功能性需求）
阶段 6：核心实体（业务实体定义和关系）
阶段 7：成功标准（可测试验证的验收条件）
阶段 8：质量审查（信息无损、可测试验证检查）
```

输出文件 `.cospec/spec/{功能名}/spec.md` 是后续 DesignAgent 和 TaskPlan 的唯一输入，结构固定：

```markdown
# 功能规格说明：[功能名称]

## 用户故事
## 系统需求
### 功能性需求
### 核心实体（可选）
## 用户指定实现要求（可选）
## 成功标准
```

---

##### DesignAgent：C4 Model 方法论架构设计

`spec-design` 用 C4 Model 四层建模做架构设计，不允许跳跃：

```
Layer 1：System Context（系统上下文图）
  → 识别主系统、用户(Actors)、外部系统(External Systems)
  → 输出 Mermaid C4Context 图

Layer 2：Container（容器图）
  → 分解内部技术单元：Web App、API、数据库、消息队列
  → 明确每个容器的职责、技术选型、对外接口

Layer 3：Component（组件图）
  → 容器内部的主要组件和交互

Layer 4：Code（代码级设计）
  → 关键接口定义、数据模型、ADR 决策记录
```

输出文件：`.cospec/spec/{功能名}/tech.md`，是 TaskPlan 的输入。

---

##### PlanApply（CodingAgent）：任务分发协调器

`plan-apply` 是执行层的协调者，它本身不写代码，只负责：

```
1. 读取 task.md，理解全局任务结构
2. 分发任务给 SubCodingAgent（每次最多 5 个并行）
3. 审查完成情况（checkpoint list + show_diff 验证）
4. 更新 task.md 状态（- [ ] → - [x]）
5. 所有任务完成后启动 ReviewAndFix 进行最终代码审查
6. 用 question 工具向用户确认完成
```

关键约束：CodingAgent 禁止使用 `edit` 修改项目代码文件，所有代码变更必须通过 SubCodingAgent 执行。这保证了任务分发记录的完整性和可审查性。

---

##### 与 Claude Code 的本质差异

| 维度 | Claude Code | CoStrict Agent 矩阵 |
|------|-------------|-------------------|
| 工作流结构 | 单 Agent，模型自决策 | 17 个专项 Agent，流程固化 |
| 需求→代码路径 | 模型直接分析需求写代码 | 需求→规格→设计→任务→编码→测试，6 层流水线 |
| 可重现性 | 每次执行结果不同 | 标准化目录结构 + 结构化文档，过程可审查 |
| 失败恢复 | 重新开始或手动引导 | 断点续跑（检测 .cospec/ 目录状态自动恢复）|
| 测试策略 | 依赖模型自判断 | 4 步测试流水线，最多 3 轮自动修复 |
| 任务粒度 | 模型自行拆分 | TaskPlan 强制拆分为"单文件级别"可验证任务 |
| 代码审查 | 无专用机制 | ReviewAndFix Agent 最终验收 |
| 多模型支持 | 所有 Agent 同一提供商 | 每个 Agent 可指定不同模型 + model_prompts |

一句话：Claude Code 依赖模型智能，CoStrict 把软件工程方法论固化到了 Agent 设计里。

---

#### 2.3.2 LSP 深度集成：完整的语言服务层

LSP 集成位于 `src/lsp/`，是 CoStrict 相比 Claude Code 最显著的能力差异之一。

**完整的 client/server 架构**（`client.ts` 251 行 + `server.ts` 486 行）：

```typescript
// 两端都实现，CoStrict 既能作为 LSP 客户端（连接外部 LSP server）
// 也能作为 LSP 服务端（为其他工具提供诊断）
```

**自动下载 LSP Server**（`lsp/server.ts`）：

CoStrict 会在需要时自动下载并管理语言对应的 LSP server：

```typescript
// 四种预配置的 LSP server（自动下载）
CLANGD_OFFLINE_SERVER_FOR_LSP   // C/C++
JDTLS_OFFLINE_SERVER_FOR_LSP    // Java
RUST_ANALYZER_OFFLINE_SERVER_FOR_LSP  // Rust
GOPLS_OFFLINE_SERVER_FOR_LSP    // Go

// 用户还可以通过 config.json 配置自定义 LSP server
```

**语言→LSP 自动映射**（`language.ts`）：根据文件扩展名自动选择 LSP server，无需手动配置。

**`LspTool` 的实际能力**：

```
诊断（Diagnostics）：实时错误/警告反馈给 Agent
跳转定义（GoToDefinition）：理解代码符号关系
查找引用（FindReferences）：理解代码影响范围
代码补全（Completion）：上下文感知的补全
符号搜索（DocumentSymbol）：FileOutlineTool 的备用实现
```

这让 Agent 在编辑文件后能立刻获得 LSP 诊断结果，不需要等用户运行编译器——弥补了开源模型代码生成准确率不足的问题。

---

#### 2.3.3 Snapshot 快照系统：文件操作的安全网

Snapshot 系统位于 `src/snapshot/`，与 Session 深度集成。

**自动快照时机**（与 `processor.ts` 集成）：

```typescript
// processor.ts
case "start-step":
  snapshot = await Snapshot.track()  // 每个 LLM step 开始前创建快照
  break

case "finish-step":
  const patch = await Snapshot.patch(snapshot)  // 收集文件变化 diff
  if (patch.files.length) {
    await Session.updatePart({
      type: "patch",          // 写入 DB：哪些文件被改了
      hash: patch.hash,
      files: patch.files,
    })
  }
```

快照不是全量文件复制，而是 **git-backed diff**，极低的存储开销。

**磁盘空间保护**（`snapshot/index.ts`）：

```typescript
const DEFAULT_MIN_FREE_SPACE = "5GB"      // 磁盘剩余低于此值时禁用快照
const DEFAULT_CHECK_INTERVAL = 60          // 每 60 秒检查一次
const prune = "7.days"                     // 快照保留 7 天
const hour = 60 * 60 * 1000               // 每小时定期清理

// 可通过 config 调整：
// snapshot: false          → 关闭快照
// snapshot.minFreeSpace    → 自定义最小磁盘空间
// snapshot.checkInterval   → 自定义检查间隔
```

**Revert 能力**：

Session 表中记录 `revert` 字段，用户可将当前会话的文件状态恢复到任意历史 snapshot，`CheckpointTool` 则在 git 层面提供更细粒度的 commit/restore 操作。

---

#### 2.3.4 Worktree 原生支持：并行任务隔离

Worktree 位于 `src/worktree/`，是一等公民特性。

```typescript
// worktree/index.ts
export namespace Worktree {
  export const Event = {
    Ready: BusEvent.define("worktree.ready", z.object({
      name: z.string(),
      branch: z.string(),
    })),
    Failed: BusEvent.define("worktree.failed", z.object({
      message: z.string(),
    })),
  }
}
```

Worktree 与 Project 系统深度集成，每个 worktree 可以独立关联一个 Session，实现：

```
主仓库 Session A  ←→  主工作区
Worktree B Session  ←→  feature/auth 分支
Worktree C Session  ←→  fix/bug-123 分支
```

多个 AI 会话可以同时在不同分支上并行工作，互不干扰。

---

#### 2.3.5 SQLite 持久化存储：结构化会话数据

存储层位于 `src/storage/`，使用 **Drizzle ORM**（`drizzle-orm ^1.0.0-beta`）+ `bun:sqlite`。

**核心表结构**：

```sql
-- 项目表
ProjectTable  (id, directory, title, ...)

-- 会话表
SessionTable  (id, project_id, parent_id, slug, title,
              summary_additions, summary_deletions, summary_files,
              revert, permission, time_compacting, time_archived)

-- 消息表（轻量 header）
MessageTable  (id, session_id, time_created, data: JSON)

-- Part 表（消息内容，细粒度分片）
PartTable     (id, message_id, session_id, data: JSON)
-- Part 类型：text / reasoning / tool / step-start / step-finish /
--            patch / compaction / subtask / file / agent /
--            snapshot / retry

-- Todo 表（跨会话任务追踪）
TodoTable

-- 权限表（已批准的规则持久化）
PermissionTable (project_id, data: Ruleset JSON)
```

**Part 分片设计的优势**：

每个 LLM 输出被拆成细粒度 Part（文本 delta、工具调用、推理步骤），写入 DB。这使得：
- UI 可以实时渲染增量更新（通过 `Bus.publish(Event.PartDelta)`）
- 任意时刻可以从 DB 重建完整对话
- 压缩时精确标记哪些 Part 已被压缩（`time.compacted` 字段）
- Session fork（`Session.fork()`）可以在任意消息节点分叉出新会话

---

### 2.4 架构亮点与缺点

#### 2.4.1 亮点

**① 17 个工作流 Agent：软件工程方法论固化为可执行流水线**

这是 CoStrict 最被低估的核心设计，也是与 Claude Code 最本质的区别。大多数 AI 编程工具的工作流是"让模型自己决定怎么走"，CoStrict 把软件工程的方法论刻进了 Agent 定义里。

`strict-spec`（`costrict/agent/locales/zh-CN/strict-spec.txt`）的权限配置直接体现了这套设计哲学。

StrictSpec 用权限白名单强制执行"需求→规格→设计→任务→编码→测试"的六层流水线，开源模型不能绕过任何一步——即使它"觉得"可以直接写代码。StrictPlan 有"凡是可以通过代码推断的问题，禁止向用户提问"的明确约束，把"不问废话"编进了 Agent 行为规范。TDD 工作流明确了"最多 3 轮自动修复"的边界，而不是让模型无限循环尝试。

Claude Code 把智慧放在模型里，CoStrict 把方法论放在 Agent 设计里——后者对开源模型的价值更大，因为它不依赖模型的自律能力。

---

**② ProviderTransform：一个 1042 行文件解决所有 Provider 格式怪癖**

CoStrict 的模型无关不是口号，而是有具体实现的。`src/provider/transform.ts`（1042 行）统一处理所有 Provider 的格式差异。

对比 Claude Code 的 `src/utils/model/providers.ts`（41 行，只做 if-else provider 分流），`ProviderTransform` 在同一个文件里覆盖了 15+ Provider 的消息格式规范化、参数过滤、推理内容字段映射。切换模型时，上层 Agent Loop 感知不到任何差异——这才是"模型无关"的工程含义。

---

**③ SQLite 持久化：Agent Loop 状态不在内存里**

Claude Code 的会话状态在进程内存里，CoStrict 把一切都落到 SQLite（`bun:sqlite` + Drizzle ORM）。这不只是"数据持久化"，而是带来了三个在内存状态下无法实现的能力：

**Session fork**（`Session.fork()`）：任意消息节点分叉出新会话，主线做一个方案，分叉线探索另一个，两条线的消息历史完全独立。内存状态下要做这件事，等于复制整个进程。

**Part 分片设计**：每个 LLM 输出被拆成细粒度 Part 写入 DB（`text / reasoning / tool / step-start / step-finish / patch / snapshot / retry` 等 12 种），UI 通过 `Bus.publish(Event.PartDelta)` 实时渲染增量更新，而不是等整条消息完成再刷新。

**压缩精度**：`time.compacted` 字段精确标记哪些 Part 已被处理，压缩不是"删掉 N 条消息"，而是"标记特定 Part 已摘要"，数据粒度更细，信息损失更可控。

---

**④ Snapshot + Checkpoint 双重安全网**

这是为开源模型定制的保险机制，Claude Code 只有 Snapshot，没有 Checkpoint。

**Snapshot**（`src/snapshot/`）在每个 LLM step 开始前自动创建 git diff 快照（不是全量复制），磁盘剩余低于 5GB 时自动禁用，7 天自动清理。即使模型连续犯错，任何历史节点都可以回退。

**CheckpointTool**（`costrict/tool/checkpoint.ts`，`experimental.checkpoint` 控制）提供显式的 `commit / list / show_diff / restore / revert` 五种操作，相当于在 Agent 执行层面暴露了完整的 git 版本控制接口。

二者覆盖不同层次：Snapshot 是无声的自动安全网，Checkpoint 是模型可主动调用的版本管理工具。用 DeepSeek 做跨文件重构时，这两个机制之间的任何状态都是可恢复的。

---

**⑤ LSP Client + Server 完整实现：代码诊断不依赖模型推断**

Claude Code 的 LSP 是单向 client（`src/tools/LSPTool/LSPTool.ts`，425 行），CoStrict 实现了完整的 client/server 双端（`lsp/client.ts` 251 行 + `lsp/server.ts` 486 行），并支持自动下载语言对应的 LSP server：

```typescript
// 四种预配置语言的 LSP server 自动下载
CLANGD_OFFLINE_SERVER_FOR_LSP    // C/C++
JDTLS_OFFLINE_SERVER_FOR_LSP     // Java
RUST_ANALYZER_OFFLINE_SERVER_FOR_LSP  // Rust
GOPLS_OFFLINE_SERVER_FOR_LSP     // Go
```

这对开源模型的实际意义是：编辑文件后立即拿到 LSP 诊断（错误/警告/类型问题），而不是等到用户运行编译器才发现问题。

---

**⑥ MCP OAuth 2.0 完整实现：企业内部 MCP Server 的接入能力**

这是 CoStrict 相比 Claude Code 最显著的 MCP 扩展点。CoStrict 的 OAuth 实现支持 PKCE 流程、动态客户端注册（RFC 7591）、令牌持久化（`~/.config/opencode/mcp-auth.json`，权限 0o600）：

```typescript
// 客户端 ID 三层优先级
// 1. 配置文件指定的预注册 clientId
// 2. 动态注册结果（RFC 7591，缓存复用）
// 3. 未定义 → 触发新注册
```

回调端口固定在 19876，单实例共享，CSRF 防护通过 state 参数实现，整个授权流程在 5 分钟内超时。Claude Code 的 OAuth 实现（`src/services/mcp/auth.ts`，2465 行）更复杂，支持 XAA 静默令牌交换和 step-up 认证，但 CoStrict 的实现覆盖了企业内部 MCP 场景的核心需求。

---

**⑦ Bus 事件架构：零侵入的插件扩展**

所有模块通过强类型 Bus 事件通信，`src/bus/` 定义了完整的事件类型系统。这个设计的价值不在于"解耦"这个词，而在于具体能做什么：

```typescript
// Plugin 可插入的 9 个生命周期钩子
"chat.params"                          // 修改 temperature/topP
"experimental.chat.system.transform"   // 改写系统提示词
"experimental.chat.messages.transform" // 发送前修改消息列表
"tool.execute.before"                  // 拦截工具执行（可修改参数或阻断）
"experimental.session.compacting"      // 注入或替换压缩提示词
"experimental.shell.env"               // 定制 Shell 环境变量
```

`tool.execute.before` 这个钩子是最强力的：Plugin 可以在工具执行前修改参数，或直接返回阻断决策。GitLab Auth Plugin、CoStrict Auth Plugin、TDD Plugin、Learning Plugin 都是这套机制的产物，没有一个修改了 Agent Loop 核心代码。

---

#### 2.4.2 缺点

**① 流式工具调度失去精细控制**

这是"委托给 AI SDK"这个架构选择的代价，也是 CoStrict 相比 Claude Code 在工具调度层面最明显的短板。

Claude Code 的 `StreamingToolExecutor`（`src/services/tools/toolOrchestration.ts`）在 LLM 输出第一个 `tool_use` block 时就立即调度，`partitionToolCalls` 按 `isConcurrencySafe` 分区，只读工具并行（最高 10 并发），写操作串行，某个工具失败时 `siblingAbortController` 取消同批次内其他任务——整个调度逻辑完全在 CoStrict 的控制之下。

CoStrict 把这件事委托给 Vercel AI SDK 的 `streamText(maxSteps: 100)`，工具调度时机由 SDK 内部状态机控制，外部无法干预。好处是代码量极少、升级 SDK 自动获益；坏处是遇到 SDK 不支持的调度场景（如"并发读 + 串行写的精细分区"），没有插手空间。

---

**② Provider 长尾适配质量不均**

`ProviderTransform` 里的 workaround 主要覆盖了 Anthropic / OpenAI / Mistral / Claude / Groq 五个主流 Provider，但 20+ Provider 里的长尾（Cerebras、DeepInfra、Together AI、Venice AI）只有基础的参数过滤，edge case 覆盖不足。

使用 Ollama 本地模型时（通过 `openai-compatible` 接入），`normalizeMessages` 里的模型特定分支不会命中，消息格式兼容性完全依赖 Ollama 的 OpenAI 兼容层。主流 Provider 运行稳定；使用不常见 Provider 时可能遇到未记录的格式问题。

---

**③ 运行时特性门控：代码暴露在包中**

Claude Code 用 `bun:bundle` 构建时宏实现特性隔离——`feature('COORDINATOR_MODE')` 在发布包里直接被替换为 `false`，对应的代码分支被 tree-shaking 完全消除，正式发布版字面上不包含 ANT-ONLY 代码。

CoStrict 用 `Flag` 系统做运行时开关：

```typescript
// 实验性特性通过 config.experimental.* 字段控制
const checkpointEnabled = config.experimental?.checkpoint !== false
const specManageEnabled = config.experimental?.spec_manage !== false
```

特性代码在包中完整存在，只是通过配置禁用。包体积无法通过特性门控优化，且高级用户可以通过直接修改配置文件启用未正式发布的功能——对商业版来说，这是一个潜在的功能滥用风险。

---

**④ 三路压缩策略对用户不透明**

CoStrict 的压缩系统分三路（Tool Output Prune / Session Compaction / Overflow Compaction），但这三路的触发条件和执行效果都不在 UI 层面可见。

对比 Claude Code 的 `compact_boundary` 系统消息（每次压缩后插入，记录触发方式、token 数量、保留段范围、已发现工具列表），CoStrict 压缩时用户看到的只是上下文窗口的使用量变化，无法知道"这次压缩丢掉了什么"、"现在哪些信息是从摘要里恢复的"。

在使用上下文窗口较小的开源模型（如 8k 或 32k 的本地模型）时，压缩频率高，不透明性带来的信任问题会被放大。

---

**⑤ TUI 与 Desktop 能力差距**

CoStrict 的 Desktop（`packages/desktop-electron`）和 TUI（React 19 + Ink）共享 Agent 核心，但 UI 能力差距明显：

文件树、模型选择 GUI、Provider 配置向导、可视化的 Session fork 界面——这些功能只在 Desktop 可用。纯终端用户的体验依赖对 CLI 参数和配置文件的熟悉程度，Provider 切换、权限配置、工作流选择都需要手动编辑 JSON 配置文件。

这对面向开发者的工具影响有限，但对希望在服务器环境（无桌面）下使用 CoStrict 高级功能的用户来说，TUI 的功能覆盖是个实际障碍。

---

### 2.5 小结

CoStrict 在架构层面解决了一个 Claude Code 刻意回避的问题：**怎么让任意 LLM 都能可靠地驱动 AI 编程 Agent**。

强处是结构性的：`ProviderTransform` 把 20+ Provider 的格式怪癖统一消化，Agent 切换模型不需要改一行代码；17 个专项工作流 Agent 用权限白名单把软件工程方法论强制执行，开源模型无法绕过流程；SQLite 持久化让会话状态从"进程内存"变成"可分叉、可审计、可精确压缩"的数据库；Snapshot + Checkpoint 双重安全网让生产环境使用开源模型有了兜底保障。

弱点同样是结构性的：委托给 Vercel AI SDK 的流式调度失去了 Claude Code 那样的精细控制空间；运行时特性门控让实验性代码暴露在包中；三路压缩对用户不透明；学习系统停留在实验阶段。这些是"以模型无关为优先级"这个架构决策必须承担的代价——设计得越兼容、越通用，在极端场景下的精细调优空间就越小。

---

## 三、Claude Code & CoStrict 深入各个维度的对比

### 3.1 核心对话引擎
两者架构哲学差异明显：Claude Code 用单体状态机驱动，CoStrict 用三层分离架构。

**CoStrict** 三层分离：

```
SessionPrompt.run()         ← 外层循环：会话状态机（prompt.ts ~1998行）
  ↓ 委托
SessionProcessor.create()  ← 中层：单次 LLM 调用生命周期（processor.ts 489行）
  ↓ 调用
LLM.stream()               ← 底层：跨 Provider 流式接入（llm.ts 351行）
```

外层循环从 SQLite 加载消息，根据 processor 返回的 `"continue" | "stop" | "compact"` 信号决定下一步，状态持久化在数据库而非内存。

### 3.2 上下文压缩策略

**Claude Code** 的五层叠加压缩体系：

```
层一：静态记忆（CLAUDE.md）
  会话开始前注入系统提示，零 token 消耗，每次请求都在，不随压缩丢失
  优先级：企业托管 < 用户全局 < 项目根 < 规则文件集 < CLAUDE.local.md

层二：触发机制（autoCompact 动态阈值）
  有效窗口 = contextWindow - min(maxOutputTokens, 20_000)
  触发阈值 = 有效窗口 - 13,000
  例：Claude 3.5（200k 上下文）→ 阈值 ≈ 167k
  电路断路器：连续失败 3 次停止重试

层三：压缩执行（两路策略，优先走 Session Memory）
  Session Memory 压缩（精细）：
    保留最近 10k~40k tokens 的原始消息
    对早期历史生成 AI 摘要
    → 当前工作上下文保真度高
  传统压缩（兜底，9 段结构化摘要）：
    Primary Request / Key Concepts / Files / Errors /
    Problem Solving / User Messages / Pending Tasks /
    Current Work / Next Step

层四：Microcompact（零 LLM 调用，轻量清理）
  清除旧工具输出内容（保留消息结构）
  计数触发 或 时间触发（距上次操作超过 N 分钟）
  适合"读了很多文件但内容不再重要"的场景

层五：压缩边界标记（compact_boundary）
  每次压缩后插入系统消息，记录压缩元数据：
    触发方式 / token 数量 / 保留段范围 / 已发现工具列表
  QueryEngine 看到边界后释放压缩前消息供 GC 回收
  防止进程内存随对话长度无限增长

PTL 恢复链（遭遇 Prompt Too Long 时的 State 机器路径）：
  collapse_drain_retry（一次）→ 尝试释放 CONTEXT_COLLAPSE 标记之前消息
  reactive_compact_retry → 执行 Reactive Compact（需要 REACTIVE_COMPACT flag，ANT-ONLY）
  两步均失败 → return { reason: 'prompt_too_long' }

max_tokens 恢复链（LLM 输出 token 不足时）：
  max_output_tokens_escalate（一次）→ 8k 升级到 64k
  max_output_tokens_recovery（最多 3 次）→ 注入"Resume from where you left off"恢复消息
  超出限制 → yield 错误消息后 return { reason: 'completed' }
```

**CoStrict** 的三路压缩策略：

```
策略一：Tool Output Prune（零 LLM 调用，每轮自动）
  PRUNE_PROTECT = 40,000   // 保护最近 40K tokens 的工具调用输出
  PRUNE_MINIMUM = 20,000   // 最小修剪目标
  保护列表：["skill"] — skill 工具调用永不清除

策略二：Session Compaction（一次 LLM 调用）
  触发：isOverflow() → true
  摘要五段式：Goal / Instructions / Discoveries / Accomplished / Relevant files
  replay 机制：压缩后尝试重放最后一条用户消息

策略三：Overflow Compaction（极端场景）
  去除媒体附件（stripMedia: true）
  重置到更早消息点，通知用户
```

各维度明细：

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 压缩层次 | 五层叠加（静态注入 / 触发 / 执行 / 轻量清理 / 边界标记） | 三路策略（Prune / Compaction / Overflow） |
| 触发阈值计算 | `contextWindow - min(maxOutputTokens, 20k) - 13k`（动态公式） | `model.limit.input - config.compaction.reserved`（可配置） |
| 保护逻辑 | 无工具级保护（Session Memory 保留最近 10k~40k 原始消息） | skill 工具调用永久保护，不被 Prune 清除 |
| 轻量清理 | Microcompact：零 LLM，清除旧工具输出内容，计数/时间触发 | Tool Output Prune：同类功能，每轮自动执行 |
| 压缩策略精细度 | Session Memory（精细）优先，传统 9 段摘要（兜底） | 统一五段式摘要（Goal/Instructions/Discoveries/Accomplished/Files） |
| 回放机制 | 无 | 压缩后自动重放最后用户消息 |
| 断路器 | 连续 3 次失败后禁用 autocompact | 无 |
| 压缩可见性 | compact_boundary 标记（记录触发方式、token 量、保留段范围、工具列表） | 无等效可见性机制 |
| GC 集成 | compact_boundary 触发 QueryEngine 释放旧消息内存 | SQLite 持久化，无内存 GC 需求 |
| PTL 恢复 | collapse_drain → reactive_compact（ANT-ONLY） → prompt_too_long | ContextOverflowError → compact 信号 → processor 重启 |
| 摘要模型 | 使用当前会话模型 | 可独立配置专用 compaction agent（不同模型/provider） |

### 3.3 工具系统

#### 3.3.1 工具清单对比

| 工具类别 | Claude Code | CoStrict | 谁更强 |
|----------|-------------|----------|--------|
| 文件读写 | FileRead / FileWrite / FileEdit | read / write / edit / multiedit | CoStrict（批量编辑） |
| 文件搜索 | GlobTool / GrepTool | glob / grep / codesearch | CoStrict（语义搜索） |
| Shell 执行 | BashTool（沙箱+权限） | bash（Tree-sitter 路径语义分析） | Claude Code 有沙箱，CoStrict 有语义分析 |
| Web 能力 | WebFetch / WebSearch | webfetch / websearch | 对等 |
| 代码结构提取 | 无 | file-outline（Tree-sitter AST） | CoStrict |
| 思维工具 | 无（依赖模型原生推理） | sequential-thinking（结构化分支） | CoStrict |
| MCP 集成 | MCPTool（动态生成） | mcp（3种传输，OAuth） | CoStrict（更完整） |
| 多智能体 | AgentTool（fork/async/background） | task（子任务） | Claude Code 更成熟 |
| 任务管理 | TaskCreate/Get/Update/List/Output/Stop | task / todo | Claude Code 更完整 |
| Git 集成 | 无专用（通过 Bash） | checkpoint（experimental）+ snapshot | CoStrict |
| Worktree | EnterWorktree / ExitWorktree | src/worktree/（Session 深度集成） | 对等（实现方式不同） |
| Jupyter | NotebookEdit | 无 | Claude Code |
| 计划模式 | EnterPlanMode / ExitPlanMode | plan | 对等 |
| 技能系统 | SkillTool（斜杠命令） | skill | 对等 |
| LSP 集成 | 无 | lsp（完整语言服务层） | CoStrict |
| 用户问答 | AskUserQuestion（多问题） | question | Claude Code（更丰富选项） |
| 补丁应用 | 无 | apply_patch | CoStrict |
| 批量操作 | 无 | batch | CoStrict |
| 工作流注入 | 无 | workflow（build/plan/spec 三模式） | CoStrict |


#### 3.3.2 工具执行并发机制

Claude Code 的并发调度完全自己实现，精细控制调度时机（LLM 输出第一个 tool_use block 就开始执行，不等完整输出）。

**CoStrict**：把多步工具执行**委托给 Vercel AI SDK 的 `streamText(maxSteps: 100)`**，工具调度时机由 SDK 控制

#### 3.3.3 CoStrict 独有工具详解

**sequential-thinking**

```typescript
interface ThoughtData {
  thought: string
  thoughtNumber: number
  totalThoughts: number       // 可动态增加
  nextThoughtNeeded: boolean
  isRevision?: boolean        // 🔄 修订之前的步骤
  revisesThought?: number
  branchFromThought?: number  // 🌿 从某步分叉
  branchId?: string
}
// 全局思考历史（会话级 thoughtHistory[]）
// 三种渲染格式：💭 Thought / 🔄 Revision / 🌿 Branch
```

**file-outline** 

基于 `web-tree-sitter` 的代码结构提取，AST 解析而非模型推理。

**checkpoint** 

```
支持 5 种 git 操作：commit / list / show_diff / restore / revert
相比 Snapshot（自动 git diff），Checkpoint 提供显式的版本控制点
启用条件：config.experimental.checkpoint !== false
```

---

### 3.4 权限系统

**Claude Code**：

```
规则解析（PermissionRule.ts）
  ↓ 来源分级：settings / CLI / session / command（5 个来源）
规则匹配（路径通配符 + 工具前缀前置过滤）
  ↓ 异步分类器检查（bashClassifier AST 静态分析，ANT-ONLY）
Hook 触发（executePermissionRequestHooks）
  ↓
模式路由（6 种模式）
  ↓
拒绝追踪（连续 3 次拒绝 → 触发 YOLO 提示）
```

**Claude Code 6 种权限模式**：

```typescript
'default'           // 标准提示（大多数情况）
'acceptEdits'       // 文件修改自动通过，Shell 仍需确认
'bypassPermissions' // 全自动，不问任何问题（YOLO 模式）
'dontAsk'           // 全部自动拒绝（只读模式）
'plan'              // 计划模式：写操作返回预览而非执行
'auto'              // AI 自动分类危险等级（ANT 实验性）
```

**CoStrict**：

```typescript
// 三种 action + Glob 规则
export const Action = z.enum(["allow", "deny", "ask"])

// 默认规则（agent.ts）
PermissionNext.fromConfig({
  "*":                 "allow",
  doom_loop:           "ask",
  external_directory:  { "*": "ask", [skillDirs]: "allow" },
  question:            "deny",   // 子 agent 不能发起问题
  plan_enter:          "deny",   // 子 agent 不能进入计划模式
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask" },
})

// Session 级规则持久化到 SQLite PermissionTable
// 用户选择 "always allow" 后下次同项目直接放行
```

**CoStrict Bash 工具的 Tree-sitter 语义分析**：

```typescript
// Tree-sitter 解析命令行 → 抽取实际访问的目录路径
// cd /external/path && rm file → 触发 external_directory 权限请求
ctx.ask({
  permission: "external_directory",
  patterns: [resolvedPath],
  always: [resolvedPath],
})
```



| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 模式数量 | 6 种（含语义丰富的 plan/acceptEdits） | 3 种（allow/ask/deny，更简洁） |
| 规则来源 | 5 个来源，分级覆盖 | 多层配置聚合 + SQLite 持久化 |
| Shell 静态分析 | bashClassifier（强，ANT-ONLY，外部已 stub） | Tree-sitter 路径分析（原生开放） |
| YOLO 模式 | bypassPermissions | Toggle + 状态持久化到 kv.json |
| Agent 隔离 | Agent 级别权限继承 | 每个 Agent 独立 PermissionRuleset |
| 规则持久化 | 会话内记忆（重启消失） | SQLite（跨会话记住） |

### 3.5 多模型支持

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| Provider 数量 | 4 个（Anthropic + 云厂商托管）| 20+ |
| 格式转换层 | 无格式转换，直接透传 | 统一归一化层，消化各 Provider 格式差异 |
| 模型能力元数据 | 无 | 每模型标注工具调用/推理/附件/成本/限制 |
| 不支持工具的模型 | 无保护，可能发送无效调用 | 按能力动态决策，不发送工具定义 |
| 子 Agent 模型 | 限定 Claude 系列 | 任意 Provider + 模型自由组合 |
| 模型专属 prompt | 无 | 支持按模型定制 system prompt |

### 3.6 Agent 系统

#### 3.6.1 Claude Code 的 AgentTool

**关键文件**：`src/tools/AgentTool/`

```typescript
// 三种执行模式
// 1. fork 模式：继承父上下文，同步等待结果，独立对话历史
// 2. async 模式：后台运行，主流程继续
// 3. background 模式：完全独立，任务队列驱动

// 每个子 Agent 有：
// - 独立 AbortController（某个失败不影响其他）
// - 独立 MCP 服务器配置（agentDefinition.mcpServers）
// - 独立 turn 限制
// - 侧链存储（recordSidechainTranscript）
// - 嵌套深度追踪（queryTracking.depth）
```

**Agent 间通信**（`SendMessageTool`）：
```typescript
to: "agent-name"        // 点对点
to: "*"                 // 广播给所有 Agent
to: "uds:<path>"        // Unix Domain Socket（本地 peer）
to: "bridge:<session>"  // 远程控制 peer（BRIDGE_MODE）
```

#### 3.6.2 Claude Code 的任务系统（多 Agent 协调基础）

任务系统是 Claude Code 支撑多 Agent 协调的核心基础设施：

```typescript
// 6 个工具：TaskCreate / TaskGet / TaskUpdate / TaskList / TaskOutput / TaskStop

// 任务认领（原子操作，文件锁保护）
claimTask(taskListId, taskId, claimantAgentId) {
  // 检查 blockedBy 依赖 → 写入 owner 字段
}

// Agent 退出时任务移交
unassignTeammateTasks(teamName, teammateId, reason) {
  // 重置 in_progress 任务为 pending，等待其他 Agent 认领
}

// DiskTaskOutput：异步任务输出写临时文件
// MAX_TASK_OUTPUT_BYTES = 5GB
// 增量轮询（每 100ms），读新增部分

// 完成通知以 XML 注入 Agent 的 user 消息
<task-notification>
  <task-id>...</task-id>
  <status>completed</status>
  <output-file>...</output-file>
</task-notification>
```

#### 3.6.3 CoStrict 的 Agent 系统

**关键文件**：`packages/opencode/src/agent/`

```typescript
Agent.Info = {
  name: string
  mode: "subagent" | "primary" | "all"
  permission: PermissionNext.Ruleset  // 每个 Agent 独立权限规则集
  model?: { modelID, providerID }     // 可用不同提供商的不同模型
  prompt?: string
  model_prompts?: Record<providerID, string>  // 提供商专属提示词
  steps?: number                       // 最大步数限制
  tools?: Record<string, boolean>      // 工具启用/禁用白名单
  temperature?: number
  topP?: number
}
```

**17 个内置 Agent**（双语 zh-CN + en）：

```
Wiki 文档系列（4个）：project-analyze / catalogue-design / document-generate / index-generation
Plan 执行系列（5个）：plan-apply / plan-fix-agent / plan-quick-explore / plan-sub-coding / plan-task-check
Spec 规格系列（5个）：spec-design / spec-plan-manager / spec-plan / spec-requirement / spec-task
Strict 严格系列（2个）：strict-plan / strict-spec
TDD 系列（1个）：tdd
```

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 执行模式 | fork / async / background 三种 | subagent / primary |
| 上下文隔离 | fork 完全隔离 + 侧链存储 | 独立 Session + SQLite 持久化 |
| 模型统一性 | **所有子代理必须同一提供商** | **每个 Agent 可用不同提供商+模型** |
| Agent 间通信 | SendMessageTool（点对点/广播） | 无专用通信工具 |
| 多 Agent 协调 | 任务系统（文件锁 + 依赖图 + 认领） | 无等效机制 |
| 内置 Agent | 无（动态创建） | 17 个预定义（覆盖研发全流程） |
| 双语支持 | 无 | zh-CN + en |
| 嵌套支持 | queryTracking.depth 追踪 | 支持 |

---

### 3.7 状态管理与持久化
#### 3.7.1 Claude Code 的状态管理

**`src/state/store.ts` 极简 Store**：

```typescript
store = {
  getState(): AppState
  setState(updater: (prev: AppState) => AppState): void  // 强制不可变更新
  subscribe(callback: (newState, oldState) => void): () => void
}
```

AppState 包含：UI 状态 / 权限上下文 / MCP 连接 / 任务与代理 / 插件系统 / 通知队列 / Tmux 集成状态。

**持久化**：仅 JSON 文件（`~/.claude/settings.json`、任务文件系统 `~/.config/claude/tasks/`），进程级内存状态不跨进程恢复。

#### 3.7.2 CoStrict 的 SQLite 持久化架构

**核心表结构**（Drizzle ORM 类型安全）：

```sql
ProjectTable  (id, directory, title)
SessionTable  (id, project_id, parent_id, slug, title, revert, permission,
              time_compacting, time_archived, summary_additions/deletions/files)
MessageTable  (id, session_id, time_created, data: JSON)
PartTable     (id, message_id, session_id, data: JSON)
  -- Part 类型 13 种：text / reasoning / tool / step-start/finish /
  --   patch / compaction / subtask / file / agent / snapshot / retry
TodoTable
PermissionTable (project_id, data: Ruleset JSON)  -- 持久化已批准的权限规则
```

**Session Fork 能力**（Claude Code 无）：

```typescript
// Part 分片设计 → Session.fork() 可在任意消息节点分叉新会话
// UI 实时渲染通过 Bus.publish(Event.PartDelta) 增量推送
// 压缩精确标记哪些 Part 已被压缩（time.compacted 字段）
```

#### 3.7.3 Git 快照系统（CoStrict 独有）

**`packages/opencode/src/snapshot/index.ts`**：

```typescript
// 每个 LLM step 开始前自动创建快照（processor.ts 集成）
track()   → git write-tree → 返回树对象哈希
patch()   → git diff --name-only {hash}  → 收集文件变化
restore() → git read-tree + git checkout-index -a -f

// 磁盘空间保护
DEFAULT_MIN_FREE_SPACE = "5GB"   // 低于此值禁用快照
DEFAULT_CHECK_INTERVAL = 60 秒
// 定时清理：git gc --prune=7.days（每小时）
```

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 状态存储 | 内存 + JSON 文件（进程退出即丢） | SQLite WAL（持久，可恢复） |
| 会话历史 | 仅当前进程可见 | SQLite，任意时刻可重建 |
| Session Fork | 无 | 任意消息节点分叉新会话 |
| Git 快照 | 无 | 每 step 自动创建（git diff 低开销） |
| 迁移系统 | 配置迁移脚本（`src/migrations/`，9个文件） | 编译期嵌入，时间戳排序自动执行 |
| Part 粒度 | 消息级别 | 13 种 Part 类型，细粒度分片 |
| 权限持久化 | 会话内记忆（重启消失） | PermissionTable（跨会话记住） |

---

### 3.8 MCP 集成

#### 3.8.1 传输层支持

**Claude Code**（`src/services/mcp/client.ts`）：

```
StdIO（本地子进程）
  → 不自动重连（子进程崩溃意味着更大问题）
SSE（单向流）
  → 长连接，不受 60 秒超时约束
  → 指数退避重连（1s→2s→4s→8s→16s，上限 30s，最多 5 次）
HTTP（Streamable HTTP）
  → 会话 404 + -32001 → 清除 memoize 缓存，强制重建连接
WebSocket（双向）
  → Bun 原生 / Node.js fallback，支持 mTLS
SDK Control Channel（进程内嵌入）
  → 通过控制请求/响应对通信，无网络开销
```

**CoStrict**（`packages/opencode/src/mcp/index.ts`）：

```
StreamableHTTP（优先）→ SSE（降级备选）→ Stdio（本地）
默认超时 30 秒，每个 Server 可独立覆盖
关闭时清理完整进程树（含 grandchild），避免孤立进程
```

#### 3.8.2 OAuth 实现对比

**Claude Code**（`src/services/mcp/auth.ts`）：

```typescript
// 令牌过期前 5 分钟主动刷新（不等 401 再补救）
// Step-up 认证：403 insufficient_scope → 强制重走完整 OAuth
// XAA（Cross-App Access）：利用缓存 IdP id_token 静默交换
// 令牌存储：系统 keychain（不写明文文件）
```

**CoStrict**（`mcp/index.ts`）：

```typescript
// 回调地址固定：http://127.0.0.1:19876/mcp/oauth/callback
// CSRF 保护：crypto.getRandomValues(32字节) state 参数
// PKCE 流程：grant_types = ["authorization_code", "refresh_token"]
// 客户端 ID 三层优先级：配置指定 > 动态注册 > 新注册
// 令牌存储：~/.config/opencode/mcp-auth.json（权限 0o600）
```

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 传输协议 | 5 种（StdIO/SSE/HTTP/WS/SDK-内嵌） | 3 种（StdIO/SSE/HTTP）|
| 重连策略 | 分协议差异化（StdIO 不重连，HTTP 有会话恢复） | 统一超时管理 |
| OAuth 支持 | 完整（2465 行，含 XAA 静默交换） | 完整 PKCE + CSRF 保护 |
| 令牌存储 | 系统 keychain | 文件（0o600 权限） |
| Step-up 认证 | 支持（insufficient_scope 自动升级） | 无 |
| 工具转换 | MCPTool 适配 + readOnlyHint→isConcurrencySafe | convertMcpTool + schema 强制 |
| URL Elicitation | 支持（-32042 弹对话框，最多 3 次） | 无 |

---

### 3.9 LSP 集成（CoStrict 独有）

CoStrict 实现了完整的 LSP client/server 双端（`src/lsp/`）：

```typescript
// LSP 客户端能力
LSP.diagnostics    → 实时错误/警告反馈给 Agent
LSP.hover          → 精确类型信息（无幻觉）
LSP.definition     → 精确定义位置
LSP.references     → 所有引用
LSP.implementations → 接口的全部实现
LSP.rename         → 语义级重命名（不是文本替换）
LSP.completion     → 上下文感知补全
LSP.documentSymbol → 文件内符号（配合 file-outline 使用）
```

**自动下载管理的 LSP Server**（4 种）：

```
clangd      → C/C++
JDTLS       → Java
rust-analyzer → Rust
gopls       → Go
```

---

### 3.10 配置系统
#### 3.10.1 Claude Code 的配置层次

```
/etc/claude-code/CLAUDE.md     ← 企业托管（最高优先级，不可覆盖）
~/.claude/CLAUDE.md             ← 用户全局
~/.claude/settings.json         ← 全局设置
{project}/CLAUDE.md             ← 项目根
{project}/.claude/rules/*.md   ← 规则文件集
{project}/.claude/settings.json ← 项目设置
{project}/CLAUDE.local.md      ← 本地私有（不提交 git）

managed-mcp.json（企业托管 MCP 配置）
```

Claude Code 还有 `src/migrations/`（9 个迁移文件），启动时自动执行版本升级（如 Sonnet 4.5→4.6 别名迁移）。

#### 3.10.2 CoStrict 的七层配置优先级（从低到高）

```
1. 远程 .well-known/opencode     ← 组织级默认（最低）
2. 全局用户配置                  ← ~/.config/opencode/opencode.json
3. OPENCODE_CONFIG 环境变量       ← 自定义配置路径
4. 项目配置                      ← opencode.json / costrict.json
5. .opencode / .costrict 目录    ← agents/ commands/ plugins/ tools/
6. OPENCODE_CONFIG_CONTENT        ← 内联配置
7. 企业托管配置                  ← /etc/opencode（最高）
                                     /Library/Application Support/opencode（macOS）
                                     %ProgramData%/opencode（Windows）
```

配置聚合策略（`mergeConfigConcatArrays`）：plugin[] 和 instructions[] 合并去重，其他字段 mergeDeep。

目录配置支持动态依赖安装（`needsInstall + installDependencies`）。兼容 OpenCode 配置格式（`Flag.COSTRICT_ENABLE_OPENCODE_CONFIG`）。

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 配置层数 | 约 5 层 | 7 层 |
| 企业托管 | `/etc/claude-code/CLAUDE.md` | `/etc/opencode`（完整 JSON 配置） |
| 组织默认 | 无 | `.well-known/opencode` |
| 格式兼容 | CLAUDE.md + JSON | OpenCode + CoStrict 双格式 |
| 动态依赖 | 无 | needsInstall 检测 + 自动安装 |
| 版本迁移 | 9 个迁移脚本（启动自动执行） | 数据库迁移（编译期嵌入） |

---

### 3.11 扩展性：Plugin / Hook 系统
#### 3.11.1 Claude Code 的 Hook 机制

5 种 Hook 时机（`src/hooks/`）：

```
pre_tool_use         ← 工具执行前（可修改输入或拦截）
post_tool_use        ← 工具执行后（格式化、检查）
permission_request   ← 权限决策前（外包给合规脚本）
post_compact         ← 压缩完成后（通知 Slack 等）
stop                 ← 会话结束时
```

```json
// 配置示例
{
  "hooks": {
    "post_tool_use": {
      "prettier": "prettier --write {FILE}",
      "tsc": "tsc --noEmit"
    },
    "permission_request": "scripts/approve-policy.sh {TOOL} {INPUT}"
  }
}
```

Hook 脚本退出码 2 = 阻塞（BlockingError），0 = 通过。

#### 3.11.2 CoStrict 的 Plugin 事件系统

8 个 Hook 事件点（`src/plugin/index.ts`）：

```typescript
"chat.params"                            // LLM 调用参数（temperature/topP）
"chat.headers"                           // HTTP 请求头定制
"experimental.chat.system.transform"     // 系统提示词变换
"experimental.chat.messages.transform"   // 消息列表变换（发送前）
"experimental.text.complete"             // 文本输出完成后处理
"experimental.session.compacting"        // 压缩提示词注入/替换
"experimental.shell.env"                 // Shell 环境变量定制
"tool.execute.before"                    // 工具执行前干预（可修改参数或阻断）
```

**内置 Plugin 列表**：

```typescript
const INTERNAL_PLUGINS = [
  CodexAuthPlugin,    // OpenAI Codex OAuth（src/plugin/codex.ts）
  CopilotAuthPlugin,  // GitHub Copilot 鉴权
  CoStrictAuthPlugin, // CoStrict 平台鉴权（含动态 token 刷新）
  TDDPlugin,          // TDD 工作流增强
  GitlabAuthPlugin,   // GitLab 鉴权（@gitlab/opencode-gitlab-auth）
  LearningPlugin,     // 学习系统（自动规则提炼）
]
```

**外部 Plugin 动态安装**：

```typescript
// config.json
{ "plugin": ["my-custom-plugin@1.0.0", "file://./local-plugin"] }
// Plugin.list() 通过 BunProc.install() 自动安装 npm 包
// 支持 file:// 协议的本地插件
```

---

### 3.12 UI 与交互体验

#### 3.12.1 Claude Code 的 REPL（`src/screens/REPL.tsx`）

```
VirtualMessageList     → 虚拟化滚动（大量消息不卡顿）
推测执行架构          → overlay 预测下一步工具调用（隐藏延迟）
多模式支持            → bash / plan / normal
权限对话              → PermissionRequest + ElicitationDialog + PromptDialog
后台任务面板          → LocalShellTask + InProcessTeammateTask 导航
Tmux 集成             → Tungsten 原生桥接
浏览器工具            → Bagel 集成
远程会话              → Bridge（BRIDGE_MODE，ANT-ONLY）
Swarm 团队协作        → ANT-ONLY
FPS 指标收集
成本追踪与警告
Vim 模式              → src/vim/（motions/operators/textObjects/transitions）
伴侣系统（Buddy）     → 面向 claude.ai 订阅用户的趣味角色
```

#### 3.12.2 CoStrict 的 TUI + Desktop

```
TUI（Ink）：多 session 管理，基础任务面板
Desktop（Electron，packages/desktop-electron）：
  - 文件树 GUI
  - 模型选择界面
  - Provider 配置向导
  - 与 Agent 核心共享同一 Provider 层
Web App（SaaS 版）：多人协作，与 TUI 同步
```

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 消息渲染 | 虚拟化列表（高性能） | 标准渲染（TUI） |
| 推测执行 | 有（overlay 预测） | 无 |
| Tmux 集成 | Tungsten（ANT-ONLY） | 无 |
| Vim 模式 | 完整（5 个文件，全操作符） | 无 |
| 桌面应用 | 无（纯 CLI） | Electron 桌面端 |
| Web 协作 | Bridge（ANT-ONLY） | Web App（SaaS，多人） |
| 多端一致性 | 单一 CLI | CLI / Desktop / Web 共享 Agent 核心 |
| 趣味功能 | Buddy 角色系统 | 无 |

### 3.13 构建时特性门控
#### 3.13.1 Claude Code 的 bun:bundle 机制

```typescript
// src/main.tsx（正式构建）
import { feature } from 'bun:bundle'
// 编译时将 feature('FLAG') 替换为 true/false 常量
// false 分支在 tree-shaking 阶段完全消除，不进入产物

// src/entrypoints/cli.tsx（反编译版 polyfill）
const feature = (_name: string) => false  // 所有特性关闭
```

**已识别的 ANT-ONLY 特性标志（部分）**：

| 特性标志 | 功能 |
|---------|------|
| `COORDINATOR_MODE` | 多 Agent 协调/Swarm |
| `BRIDGE_MODE` | IDE 远程控制桥接 |
| `REACTIVE_COMPACT` | 反应式上下文压缩 |
| `CONTEXT_COLLAPSE` | 上下文折叠（PTL 恢复）|
| `TOKEN_BUDGET` | Token 预算控制 |
| `VOICE_MODE` | 语音输入 |
| `EXTRACT_MEMORIES` | 自动记忆提取 |
| `DAEMON` | 后台守护进程 |
| `PROACTIVE` | 主动建议模式 |
| `WORKFLOW_SCRIPTS` | 工作流脚本工具 |

**效果**：ANT-ONLY 功能在发布包中物理不存在（tree-shaking 消除），反编译版与正式版行为差异来源于此。

#### 3.13.2 CoStrict 的 Flag 系统

CoStrict 用运行时 `Flag` 系统做特性开关，特性代码在包中存在但被禁用——理论上可被外部启用，包体积略大。这是 CoStrict 相比 Claude Code 的架构劣势之一。

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 门控时机 | 构建时（bun:bundle tree-shaking） | 运行时（Flag 系统） |
| ANT-ONLY 功能可见性 | 物理不存在于发布包 | 代码存在但被禁用 |
| 包体积 | 特性代码完全剔除（25MB 精简） | 包含所有特性代码 |
| 外部可激活 | 不可能（代码不存在） | 理论上可激活 |

---

### 3.14 综合分析

#### 3.14.1 两者的结构性定位

**Claude Code 的结构性优势（难以被追赶）**：
1. Anthropic 官方支持，内部版功能在正式版中已启用，能力远超公开版所见
2. 推测执行架构：感知延迟最低，流式输出第一个工具调用即调度
3. 五层上下文压缩体系：专为长任务设计，GC 集成防内存泄漏
4. 多 Agent 协调基础设施完整：原子认领 + 依赖图 + 多种通信方式 + 任务移交
5. 权限系统深度：6 种模式，预览模式先预览后执行，23 类危险模式静态检测
6. 构建时特性门控：内部功能代码物理不存在于发布包

**CoStrict 的结构性优势（Claude Code 无法复制）**：
1. 真正的模型无关：20+ Provider 开箱即用，商业模式决定 Claude Code 永远只做 Anthropic
2. 17 个工作流 Agent：软件工程方法论固化为可执行流水线
3. 针对每个开源模型的已知弱点定向优化（模型专属 system prompt）
4. LSP + Tree-sitter：工具替代模型推理，不依赖模型猜测
5. 数据库 + 快照 + Checkpoint 三重状态保障：开源模型生产环境使用的关键
6. 事件总线 + 插件系统：零侵入扩展，9 个生命周期钩子

---

#### 3.14.2 一句话定位

**Claude Code**：把智能集中在模型本身，工具层为 Claude 系列深度优化，五层压缩 + 流式调度 + 多 Agent 协调基础设施让复杂长任务可靠执行，适合以 Claude 为核心的高强度编程场景。

**CoStrict**：把智能分散到平台层，ProviderTransform + LSP + 工作流 Agent 补偿模型短板，模型能力越弱于 Claude，平台层的补偿效果越显著，适合多模型混用、企业合规、大型代码库场景。

---

## 四、CoStrict+开源模型 比 claude code+开源模型 更强？

内部测评数据，这里以GLM-4.7为例，后续会补充更多模型：

![image-20260402175452183](C:\Users\SXF-Admin\AppData\Roaming\Typora\typora-user-images\image-20260402175452183.png)

### 4.1 源码层面：客观能力对比

> **结论先行**：基础架构层面，Claude Code 具有明显的工程积累优势，CoStrict 整体偏弱。CoStrict 的核心竞争力不在这一层——在第二部分的工程方法论固化。

#### Claude Code 的结构性优势（基础能力层）

以下 6 个维度 Claude Code 有明显优势，CoStrict 短期内难以追赶：

**① 工具并发执行：自研调度器 vs 委托 SDK**

Claude Code 在收到第一个工具调用指令时立即开始执行，无需等待完整输出；并发安全的连续工具合并为一批并行执行（上限 10 个）；某工具失败时立即取消同批次其他任务。

CoStrict 把多步工具执行委托给第三方 AI SDK，调度时机由 SDK 内部控制，无法精细调优。

**CoStrict 劣势**：延迟更高、并发精度弱、错误传播路径不透明。

---

**② 上下文压缩体系：五层 vs 三路**

Claude Code 五层叠加（静态记忆 + 动态阈值 + 双路压缩执行 + 零 LLM 清理 + GC 集成）。CoStrict 只有三路（工具输出裁剪 / 会话压缩 / 溢出压缩），无零 LLM 清理，无 GC 集成，无断路器。

**CoStrict 劣势**：压缩层次少、触发精度低、长对话内存压力缺乏针对性处理。

---

**③ 多 Agent 协调基础设施**

Claude Code 提供完整的任务工具集、原子任务认领、依赖图调度、多种通信方式、大容量输出支持以及 Agent 退出时任务自动移交。

CoStrict **没有等效的任务认领/依赖图/Agent 间通信基础设施**。

**CoStrict 劣势**：无法构建多 Agent 真正并行协作的工作流。

---

**④ 权限系统深度：6 种模式 vs 3 种**

Claude Code 含预览模式（写操作先返回预览，用户确认后再执行）和自动接受文件修改模式（Shell 命令仍需确认）。CoStrict 只有三种动作（允许/询问/拒绝），无预览模式语义）。

---

**⑤ Bash 安全检查深度**

Claude Code 静态检测 23 类提示注入模式。CoStrict 进行路径分析，防路径遍历和符号链接攻击，不含提示注入静态检测。

---

**⑥ UI 工程完整度**

| 特性 | Claude Code | CoStrict |
|------|-------------|----------|
| Vim 模式 | 完整支持 | 无 |
| 推测执行 | 预测下一步工具调用 | 无 |
| 消息渲染 | 虚拟化列表，大量消息不卡顿 | 标准渲染 |
| Jupyter 支持 | 支持 | 无 |

---

#### CoStrict 的局部优势（仅接入非 Anthropic 模型时显现）

以下优势**仅在接入 DeepSeek、Qwen、Llama 等非 Anthropic 模型时才体现**：

**① Provider 适配层**：开源模型接入开箱可用，Claude Code 格式直接透传可能不兼容。

**② 模型能力感知**：不向不支持工具调用的模型发送工具定义，避免无效调用。

**③ 代码智能工具**：AST 结构提取、结构化推理等工具，Claude Code 均不具备。

**④ Agent 异构模型支持**：每个子 Agent 可指定不同 Provider + 模型，构建多模型混合工作流。

**⑤ 数据库持久化**：开源模型推理慢，长任务崩溃代价更高，持久化价值更明显。

---

#### 结论：基础架构 CoStrict 整体弱于 Claude Code

**直接说**：CoStrict 的基础架构稍微差点。工具并发调度、上下文压缩体系、多 Agent 协调基础设施、权限系统深度——Claude Code 在这几个维度是明显领先的。

CoStrict 在 Provider 适配、AST 代码工具、异构模型支持上有局部优势，但这些优势**在使用 Claude 模型时几乎不体现**，只在接入开源模型时才显现。

**CoStrict 的核心竞争力不在基础架构层，在第二部分——把工程方法论固化进可执行的工作流流水线。**

---

### 4.2 内置工作流增强（CoStrict 核心竞争力）

> CoStrict 相比 Claude Code 最不可替代的差异在这里——将软件工程方法论固化为可执行的工作流流水线，覆盖项目初始化、代码探索、需求澄清、代码审查、测试校验五个环节，不依赖模型能力，用流程弥补推理短板。

#### 4.2.1 /init 增强：enhanced-initialize → AGENTS.md

**Claude Code 的 /init**：
- 旧版：单段提示词，模型自由发挥，无结构约束
- 新版：8 阶段流程，但属于内部功能，外部用户需手动开启环境变量
- 产物：CLAUDE.md，针对 Claude 指令格式优化，无 Git 历史分析，无质量门禁

**CoStrict 的 /init**：
产物是 `AGENTS.md`——供**任意 AI Coding Agent** 使用的标准化项目文档，分 5 个串行子任务：

- **子任务 2**（差异最大）：分析近 6 个月 Git 提交历史，按目录层级聚合修改记录，统计目录修改次数，8 级优先级展示目录树，总行数 ≤150 行，标准树形符号，每条描述 ≤30 字
- **子任务 3**：分析近 3 个月 Git 提交历史提炼编码规范，总条数 ≤50 条，单条 ≤50 字，必须使用「必须/禁止/应」等强约束词
- **子任务 5**：5 维度审查门禁（文档完整性 + 格式合规性 + 内容准确性 + 指导性 + 篇幅合规）→ 最小改动修正 → 二次复核

| 维度 | Claude Code /init | CoStrict /init |
|------|------------------|----------------|
| 产物 | CLAUDE.md（供 Claude 读）| AGENTS.md（供任意 AI Agent 读）|
| 执行结构 | 单段提示词，模型自由发挥 | 5 个串行子任务，每任务委派子 Agent |
| Git 历史分析 | 无 | 近 6 个月目录修改频率 + 近 3 个月规范提取 |
| 质量门禁 | 无 | 5 维度审查 + 最小改动修正 + 二次复核 |
| 外部可用状态 | 旧版（无结构）/ 新版需环境变量 | 全用户开放 |

---

#### 4.2.2 Explore 能力增强：QuickExplore Agent

Claude Code 没有独立的探索 Agent，主模型直接在主会话中探索，消耗主会话 token，无结构化约束。

QuickExplore 是专用只读探索 Agent，在**独立上下文**中运行：

**漏斗式收敛策略**（宏观 → 微观四级）：

- 目录（限定到 2-3 级）→ 文件（按类型过滤）→ 骨架（AST 查看结构）→ 代码片段（只读必要行号范围，超 500 行必须指定范围）
- 禁止大范围全局检索

**Git 历史挖掘**（Claude Code 无）：搜索相关功能提交历史，查看变更差异提取可复用方案；搜索缺陷修复提交，提取已踩过的坑；追踪依赖历史变更，识别兼容性风险。

**执行约束**：控制在 30 轮内，连续 3 轮无进展立即调整策略，禁止修改任何代码。

**输出证据要求**：代码定位必须提供文件路径 + 行号 + 代码片段，Git 历史必须提供提交哈希 + 日期 + 变更摘要。

---

#### 4.2.3 需求澄清工具体系

Claude Code 没有独立的需求澄清机制，是否提问完全由模型自主判断。

**StrictPlan 三条铁律**：探索驱动澄清 + 项目信息优先 + 代码可答则不问

**需求复杂度感知**：
- 需求详尽（用户提供文档/长段说明）→ 大幅减少提问
- 需求简短（一句话）→ 适度增加提问
- 需求已明确的细节 → 禁止重复提问

**Requirement Agent** 9 阶段流程：5W2H 分析法（三层目标挖掘）→ 需求澄清（最多 3 轮，总计 ≤15 个问题）→ INVEST 原则用户故事 → 格式化系统需求 → 成功标准定义 → SMART 检验法质量审查。

---

#### 4.2.4 ReviewAndFix Agent

**定位**：执行完成后的代码审查与修复环节。不直接修改代码——只修改任务计划文档，代码修改必须委托子编码 Agent 执行。

**工作流程（4 阶段）**：
1. 读取任务文档 + 查看已完成进度快照，了解当前状态
2. 分析反馈 → 在任务文档末尾插入新修复任务 → 用户确认
3. 并行/串行分发给子编码 Agent，四维度审查（最小变更 / 风格一致 / 架构尊重 / 任务完整）
4. 所有任务完成后向用户确认

| 维度 | Claude Code | CoStrict ReviewAndFix |
|------|-------------|----------------------|
| 代码修改方式 | 主模型直接修改 | 任务文档驱动，代码由子 Agent 执行 |
| 代码审查 | 无 | 快照差异 + 4 维度审查标准 |
| 架构保护 | 依赖模型判断 | 明确约束：遵循项目既有目录结构和设计模式 |

---

#### 4.2.5 测试校验：逐级校验流水线

Claude Code 没有内置测试工作流 Agent，无结构化阶段划分，无自动修复机制。

**CoStrict 四级校验流水线**：

- **Level 0：TestPrepare**  → 只做命令定位，不执行任何命令，填充测试指南文档
- **Level 1：RunAndFix**    → 编译/构建/类型检查验证（不涉及业务逻辑测试）
- **Level 2：TestDesign**   → 测试用例设计（正常/边界/异常三类场景）
- **Level 3：TestAndFix**   → 测试执行 + 自动修复（最多 3 轮）

**RunAndFix 关键约束**：
- ✅ 可修复：语法错误、类型错误、缺失导入、编译错误
- ❌ 不修复：测试失败、缺失依赖、环境问题
- ❌ 严禁：运行测试命令、git 历史回滚操作
- 文件修改权限区分：最近修改的文件自动修复，非最近修改文件需用户授权

| 维度 | Claude Code | CoStrict 测试流水线 |
|------|-------------|-------------------|
| 测试工作流 | 无内置工作流 | 4 级协调 |
| 规范文档 | 无 | 测试指南文档 |
| 编译与测试分离 | 不区分 | 编译问题与测试问题分层处理 |
| 文件修改权限 | 无区分 | 最近修改文件自动修复，非最近文件需用户授权 |
| 自动修复 | 无 | 最多 3 轮 |
| 用户代码保护 | 无 | 明确禁止 git 回滚操作 |

---

### 4.3 小结

**基础架构层的结构性对比，Claude Code 的结构性优势（难以被追赶）**：

1. Anthropic 官方支持，内部版功能在正式版中已启用，能力远超公开版所见
2. 推测执行架构：感知延迟最低，流式输出第一个工具调用即调度
3. 五层上下文压缩体系：专为长任务设计，GC 集成防内存泄漏
4. 多 Agent 协调基础设施完整：原子认领 + 依赖图 + 多种通信方式 + 任务移交
5. 权限系统深度：6 种模式，预览模式先预览后执行，23 类危险模式静态检测
6. 构建时特性门控：内部功能代码物理不存在于发布包

**工作流层的核心结论**：以上五个工作流增强（/init → AGENTS.md、QuickExplore 漏斗收敛、探索驱动需求澄清、ReviewAndFix task.md 驱动、四级测试流水线）的共同特征是——**不依赖模型能力，用结构化流程弥补推理短板**。Claude Code 把质量寄托在模型上，模型强它就强；CoStrict 把方法论固化进平台层，任何模型都能得到结构化保障。

---

## 五、Claude Code 源码泄漏事件后，CoStrict 应该怎么做


### 5.1 CoStrict差距分析

**1. 长任务内存控制**：CC 的 compact_boundary 机制在每次压缩后插入边界标记，QueryEngine 看到后释放旧消息内存，防止进程内存随对话长度无限增长。Microcompact 零 LLM 调用清除旧工具输出。CoStrict 无此层，长对话内存消耗不可控。

**2. 工具调度延迟**：CC 的 StreamingToolExecutor 在 LLM 输出第一个 tool_use block 时立即调度工具，不等完整响应。CoStrict 委托 Vercel AI SDK 的 `streamText`，调度时机由 SDK 控制，用户每次调用工具都能感知额外延迟。

**3. Agent 并发与协调**：CC 有 fork/async/background 三种执行模式、6 个任务管理工具（文件锁原子认领、blockedBy 依赖图、5GB 任务输出）、SendMessage 广播通信。CoStrict 的 task 工具无真正并发，Agent 间无通信机制，无法做大规模并行任务分配。

**4. 权限 plan 模式**：CC 的 plan 模式让 AI 先在只读模式下执行预览、用户确认后再切换 acceptEdits 真正执行。CoStrict 无等价实现，用户只能事前审批权限，无法看到 AI 完整执行计划后再决策。

**5. 工具生态缺口**：Jupyter Notebook 工具（CoStrict 无）——数据科学场景的硬需求。Worktree 工具（CoStrict 模块已实现但未暴露为 AI 工具）——隔离执行的基础能力。

**6. CLI 交互体验**：CC 的虚拟化消息列表、完整 Vim 模式（5 文件全操作符）、推测执行 overlay（预测并隐藏下一步延迟）是纯 CLI 深度优化的结果，CoStrict TUI 无等价实现。

**7. 上下文管理机制**：CC 构建了完整的上下文优先级体系——CLAUDE.md 按路径层级（企业托管 > 用户全局 > 项目根 > 规则文件集 > 本地私有）注入系统提示，零 token 消耗且不随压缩丢失；`autoCompact` 动态阈值公式,随模型自动调整；双路压缩执行：Session Memory 保留最近 10k~40k tokens 原始消息保真当前工作上下文，传统 9 段结构化摘要（Primary Request / Key Concepts / Files / Errors / Problem Solving / User Messages / Pending Tasks / Current Work / Next Step）兜底。CoStrict 的 compaction 仅有统一五段式摘要，无"保留最近原始消息"的精细保留策略，长任务中当前工作上下文的保真度低于 CC。

---

### 5.2 战略约束：为什么不能全面追赶

#### 5.2.1 fork 策略的代价

CoStrict fork 自 OpenCode，这是一个长期战略选择。这意味着：

- **上游同步是生命线**：OpenCode 当前处于架构重构阶段，每次上游合并都需要解决冲突
- **架构层改动 = 合并地狱**：权限系统从 3 种扩展到 6 种、多代理并发从无到有、Worktree 工具化——这些都涉及核心模块的大规模改动
- **改动量与合并难度的关系不是线性的**：改 100 行合并可能 1 小时，改 1000 行可能 1 天，改 5000 行可能 1 周还合不完

#### 5.2.2 差距分类决策

对 1.2 中 7 项差距按 fork 约束分类，决定是追、等还是放弃。

| 决策           | 差距项                                                       | 理由                                                         |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **等待观望**   | 工具调度延迟<br> Agent 并发与协调 <br> 上下文管理（压缩保真度） | 需要绕过 Vercel AI SDK 封装，涉及 llm.ts / agent / session 多层联动，上下文策略贯穿了所有设计，自行实现后合并上游代价极高。 等OpenCode 2-4 周 |
| **可纳入计划** | Worktree 工具化                                              | 应用层改动，改动范围可控Worktree 模块已有直接暴露即可,不影响整体架构 |
| **长期跟进**   | 长任务内存控制<br> CLI 交互体验                              | 的 compact_boundary + GC 联动需要 processor / storage 协同改造，优先级低于其他项；也可看看OpenCode是否有优化计划，观望时间可加长 |
| **不追赶**     | Jupyter Notebook <br> 权限系统完整性 <br> CLI 交互体验       | 需求场景与 CoStrict 主要用户群（后端/全栈开发者/企业用户）重合度低，投入产出比不高  <br> 目前权限不是瓶颈 <br> 推测执行和 Vim 模式是 CLI 深度优化，与多端战略方向不同，不作为追赶目标 |

#### 5.2.3 为什么"等 OpenCode"是合理的

OpenCode 团队当前处于架构重构阶段。Claude Code 源码泄漏对整个 AI Coding 开源社区都是重大事件，OpenCode 作为活跃的开源项目，大概率会响应：

- 如果 OpenCode 主动改进了权限系统、多代理并发等能力 → CoStrict 直接合并上游，省去大量工作
- 如果 OpenCode 不响应 → 再评估自行实现的优先级，那时架构重构可能已稳定，合并风险更小
- 时间窗口：**观察 2-4 周**，看 OpenCode 社区的讨论和 PR 动向

#### 5.2.4 真正巨大的差距（vscode/jetbrains）

目前已知我们的客户习惯性上偏向于UI友好的插件端，这块的基础能力没有在以上对比中，但已知差距是巨大的：

- cli/web端是面向未来的设计，也是我们当前选定主战场，后续的能力更多会基于CLI构建
- vscode/jetbrains端更像是当下还未完全转变过来的部分企业现状，目前选择的策略是挑选问题TOP 10就行处理

---

### 5.3 CoStrict 的差异化

CoStrict 的 Agent 基础架构确实不如 Claude Code 扎实，但通过差异化能力，在实际使用体验上已经弥补了差距，甚至小有优势。

#### 5.3.1 已建立的差异化能力 （这里特指CLI）

| 能力                                                       | 说明                                                         | 对标 Claude Code                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| **StrictPlan（SpecPlan / TaskPlan）**                      | 结构化任务规划，将复杂需求拆解为可执行步骤                   | CC 无等价物，依赖模型自行规划                     |
| **QuickExploreAgent**                                      | 快速代码理解，专为探索场景优化的轻量级代理                   | CC 的 AgentTool 是通用代理，无专门探索模式        |
| **FixAgent 体系（RunAndFix / TestAndFix / ReviewAndFix）** | 自动诊断-修复闭环，覆盖运行、测试、审查三个场景              | CC 无等价物，修复靠用户手动指导                   |
| **sequential-thinking**                                    | 结构化推理工具，支持分支思考和修订                           | CC 依赖模型原生 extended thinking，无外部工具辅助 |
| **file-outline + LSP**                                     | 语义级代码理解，Tree-sitter AST + LSP 双端                   | CC 完全没有，100% 依赖模型理解代码结构            |
| **多模型 + 模型专属 Prompt**                               | 24+ 提供商 + 12 个专属 prompt                                | CC 锁定 Anthropic，商业模式决定无法改变           |
| **开源最佳实践内置**                                       | 比如：superpowers skills 等社区工具后续会挑选合适的作为开箱即用 | CC 生态依赖用户自行安装配置                       |

#### 5.3.2 这些优势面临的风险

**Claude Code 的生态正在快速补齐短板：**

- **skill 市场**：用户可以安装社区 skill，获得类似 StrictPlan 的规划能力
- **claude-mem**：外部记忆管理工具，弥补 CC 原生记忆能力不足
- **everything-claude-code**：社区资源聚合，降低 CC 的使用门槛
- **superpowers**：我们自己也在用的 skill 框架，同样可以被 CC 用户使用

- **等等**

核心判断：**CoStrict 内置的差异化能力，可能被 Claude Code 生态中的第三方工具抹平**。但"内置开箱即用" vs "自行安装配置"之间仍有体验差距，这个差距就是我们的窗口期。

---

### 5.4 生态竞争

#### 5.4.1 Claude Code 生态现状

Claude Code 虽然基础架构扎实，但真正让它强大的是**生态完整性**：

```
Claude Code 生态圈
├── 官方能力
│   ├── 权限系统（6 种模式）
│   ├── AgentTool（子代理系统）
│   ├── Worktree（隔离执行）
│   └── NotebookEdit（Jupyter 支持）
├── 社区工具
│   ├── superpowers（skill 框架 + 20+ 预置 skill）
│   ├── claude-mem（外部记忆管理）
│   ├── everything-claude-code（资源聚合）
│   └── 各种 MCP server
│   └── OMC
│   └── skills hub
└── 商业模式
    ├── 与 Anthropic 模型深度绑定
    └── Pro/Max 订阅用户基数
```

#### 5.4.2 CoStrict 的应对策略

**核心原则：借用开源最佳实践，内置到 CoStrict 开箱即用，打开工具上限。**

这不是简单的"拿来主义"，而是：

1. **筛选**：从社区工具中识别真正有价值的实践
2. **内置**：将其深度集成到 CoStrict 中，而不是让用户自行安装
3. **优化**：根据 CoStrict 的多模型优势做适配，发挥"内置"的体验优势
4. **持续**：跟踪社区动态，保持内置实践的更新

具体而言：

| 社区最佳实践          | 内置方式                                              | 体验优势                  |
| --------------------- | ----------------------------------------------------- | ------------------------- |
| superpowers skills 等 | 已内置核心 skill（TDD、debugging、brainstorming 等）  | 零配置可用，无需用户安装  |
| 结构化规划模式        | StrictPlan 已原生实现                                 | 比 skill 更深度的集成     |
| 代码审查工作流        | ReviewAndFix 自动闭环                                 | 不仅审查，还自动修复      |
| 调试方法论            | systematic-debugging skill + sequential-thinking 工具 | 工具层 + 方法论层双重支撑 |

---

### 5.5 核心判断

- **不盲目追赶 Claude Code 的架构优势**。fork 策略决定了架构层改动必须谨慎，等 OpenCode 上游响应是当前最优选择。涉及的架构差距，贸然自行实现意味着持续合并地狱。

- **上下文压缩是被低估的差距**。完整矩阵显示 CC 的五层叠加压缩（vs CoStrict 的三路策略）不只是数量差异：compact_boundary GC 集成、Microcompact 零 LLM 清理、断路器保护是长任务可靠性的关键。CoStrict 的 compaction replay 机制是一个独特优势，应继续保留。

- **推测执行 UX 差距是用户能感知的体验鸿沟**。CC 的 StreamingToolExecutor 在流式输出第一个 tool_use block 就开始调度，sibling abort 机制可以立即中止失败任务的兄弟工具。这种"感知延迟"优化在实际使用中非常明显，是 CoStrict 当前最大的 UX 短板。

- **CoStrict 的差异化能力（StrictPlan、QuickExplore、FixAgent、sequential-thinking）是真正的竞争力**。这些能力弥补了基础架构差距，并在某些场景下优于 Claude Code。要持续深化，而不是把精力分散到追赶架构差距上。

- **国产 AI Coding 工具的基本能力即将被磨平**。Claude Code 源码泄漏会加速这个过程。竞争焦点将转移到开箱即用体验、企业级特性——这些正是 CoStrict 的布局方向。

---