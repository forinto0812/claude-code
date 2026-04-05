# Claude Code & CoStrict 深度对比：逐维度代码级分析

## 目录

1. [核心对话引擎](#一核心对话引擎)
2. [工具系统](#二工具系统)
3. [权限系统](#三权限系统)
4. [多模型支持](#四多模型支持)
5. [Agent 系统](#五-agent-系统)
6. [状态管理与持久化](#六状态管理与持久化)
7. [MCP 集成](#七-mcp-集成)
8. [代码理解能力](#八代码理解能力)
9. [配置系统](#九配置系统)
10. [扩展性：Plugin / Hook 系统](#十扩展性plugin--hook-系统)
11. [UI 与交互体验](#十一-ui-与交互体验)
12. [构建时特性门控](#十二构建时特性门控)
13. [综合评分](#十三综合评分)

---

## 一、核心对话引擎

### 1.1 主循环架构

两者架构哲学差异明显：Claude Code 用单体状态机驱动，CoStrict 用三层分离架构。

**Claude Code**（`src/query.ts`，1732 行）：

```typescript
// 查询循环状态机（query.ts:219-279）
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined  // 追踪前一次迭代的继续原因
}
// while(true) 迭代，spread 操作符不可变更新，7 条 transition 路径
```

**CoStrict** 三层分离（`packages/opencode/src/session/`）：

```
SessionPrompt.run()         ← 外层循环：会话状态机（prompt.ts ~1998行）
  ↓ 委托
SessionProcessor.create()  ← 中层：单次 LLM 调用生命周期（processor.ts 489行）
  ↓ 调用
LLM.stream()               ← 底层：跨 Provider 流式接入（llm.ts 351行）
```

外层循环从 SQLite 加载消息，根据 processor 返回的 `"continue" | "stop" | "compact"` 信号决定下一步，状态持久化在数据库而非内存。

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 主循环大小 | query.ts 1732 行（单文件） | prompt.ts 1998 行 + processor.ts 489 行 + llm.ts 351 行 |
| 架构模式 | 单体状态机 + while(true) | 三层分离：外循环 / 处理器 / 流接入 |
| 状态管理 | 不可变 spread 更新（内存） | SQLite 持久化（进程崩溃可恢复） |
| 错误恢复路径 | 7 条硬编码 transition | ContextOverflowError 触发 compact 信号 |
| 思维链 | beta 参数开启 interleaved-thinking | MessageV2.Part.reasoning 原生支持 |
| 状态可见性 | 内存，进程退出即丢失 | SQLite，任意时刻可重建对话 |

### 1.2 上下文压缩策略

**Claude Code** 的五层叠加压缩体系（`src/services/compact/` + `src/query.ts`）：

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

**CoStrict** 的三路压缩策略（`packages/opencode/src/session/compaction.ts`）：

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

### 1.3 死循环检测

**Claude Code**：连续 3 次权限拒绝触发 YOLO 提示（权限拒绝次数计数）。

**CoStrict**（`processor.ts`）：`DOOM_LOOP_THRESHOLD = 3` 检测完全相同的工具调用：

```typescript
// 工具名 + 参数完全一致，连续出现 3 次 → doom_loop 权限询问
const isDoomLoop = lastThree.every(p =>
  p.type === "tool" &&
  p.tool === cleanedToolName &&
  JSON.stringify(p.state.input) === JSON.stringify(cleanedInput)
)
// 触发后：权限系统询问用户是否继续，而非直接报错
```

CoStrict 的检测更精确——基于工具语义而非权限事件，在自动化场景下能更早识别问题。

---

## 二、工具系统

### 2.1 工具清单对比

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

**统计（现役工具）：** Claude Code 领先 5 项，CoStrict 领先 9 项，对等 5 项。

### 2.2 工具执行并发机制

**Claude Code**（`src/services/tools/StreamingToolExecutor.ts` + `toolOrchestration.ts`）：

```typescript
// 工具批分区策略（toolOrchestration.ts:91-116）
// isConcurrencySafe=true 的连续工具 → 合并为一批并行
// isConcurrencySafe=false 的工具    → 单独成批串行
// 例：[Read, Read, Write, Read] → [{Read,Read}, {Write}, {Read}]

// 最大并发数由环境变量控制
CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = 10（默认）

// 兄弟错误传播
// Bash 错误 → siblingAbortController 立即取消同批次其他工具
```

Claude Code 的并发调度完全自己实现，精细控制调度时机（LLM 输出第一个 tool_use block 就开始执行，不等完整输出）。

**CoStrict**：把多步工具执行**委托给 Vercel AI SDK 的 `streamText(maxSteps: 100)`**，工具调度时机由 SDK 控制：

```typescript
// llm.ts
return streamText({
  model: wrappedModel,
  messages,
  tools,
  maxSteps: 100,  // SDK 内部多步 tool-call 循环
  ...
})
```

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 并发实现 | 自研 StreamingToolExecutor + p-map | 委托 Vercel AI SDK streamText |
| 调度精细度 | 流式输出时即调度（最低延迟） | SDK 控制（调优空间有限） |
| 并发上限 | 环境变量配置（默认 10） | SDK 内部决定 |
| 错误传播 | sibling abort（立即中止兄弟任务） | SDK 事件通知 |
| 顺序保证 | 自动批分区保序 | SDK 保证 |

### 2.3 CoStrict 独有工具详解

#### sequential-thinking（`costrict/tool/sequential-thinking.ts`，正式启用）

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

#### file-outline（正式启用）

基于 `web-tree-sitter` 的代码结构提取，对 2000 行文件：Token 消耗约 500，耗时 <100ms，准确率 99%（AST 解析而非模型推理）。

#### checkpoint（`costrict/tool/checkpoint.ts`，experimental）

```
支持 5 种 git 操作：commit / list / show_diff / restore / revert
相比 Snapshot（自动 git diff），Checkpoint 提供显式的版本控制点
启用条件：config.experimental.checkpoint !== false
```

---

## 三、权限系统

### 3.1 架构设计

**Claude Code**（`src/utils/permissions/`，核心文件 `permissions.ts` 1486 行，整体约 6000 行）：

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

**CoStrict**（`packages/opencode/src/permission/next.ts`，297 行）：

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

**CoStrict Bash 工具的 Tree-sitter 语义分析**（`bash.ts`，原生能力）：

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
| 自动分类 | 双阶段 XML 思考（ANT 仅） | doom_loop 精确检测 |
| YOLO 模式 | bypassPermissions | yolo.ts（Toggle + 状态持久化到 kv.json） |
| Agent 隔离 | Agent 级别权限继承 | 每个 Agent 独立 PermissionRuleset |
| 规则持久化 | 会话内记忆（重启消失） | SQLite（跨会话记住） |

---

## 四、多模型支持

### 4.1 提供商数量与扩展机制

**Claude Code**（`src/utils/model/providers.ts`）：

```typescript
// 硬编码 if-else 分支
export function getAPIProvider(model: string): APIProvider {
  if (model.includes('bedrock')) return 'bedrock'
  if (model.includes('vertex'))  return 'vertex'
  if (model.includes('foundry')) return 'foundry'
  return 'anthropic'  // 所有未知模型走 Anthropic 通道
}
```

**CoStrict**（`packages/opencode/src/provider/provider.ts`，1536 行）：

```typescript
// 插件式注册表，构建时 tree-shaking 优化
BUNDLED_PROVIDERS = {
  "@ai-sdk/anthropic":           createAnthropic,
  "@ai-sdk/openai":              createOpenAI,
  "@ai-sdk/azure":               createAzure,
  "@ai-sdk/amazon-bedrock":      createAmazonBedrock,
  "@ai-sdk/google":              createGoogleGenerativeAI,
  "@ai-sdk/google-vertex":       createVertex,
  "@openrouter/ai-sdk-provider": createOpenRouter,
  "@ai-sdk/xai":                 createXai,
  "@ai-sdk/mistral":             createMistral,
  "@ai-sdk/groq":                createGroq,
  "@ai-sdk/deepinfra":           createDeepInfra,
  "@ai-sdk/cerebras":            createCerebras,
  "@ai-sdk/cohere":              createCohere,
  "@ai-sdk/togetherai":          createTogetherAI,
  "@ai-sdk/perplexity":          createPerplexity,
  "@ai-sdk/vercel":              createVercel,
  "@gitlab/gitlab-ai-provider":  createGitLab,
  // + GitHub Copilot 自定义适配 + openai-compatible 通用接入
}
```

### 4.2 ProviderTransform：跨 Provider 能力归一化

CoStrict 的 `provider/transform.ts` 把每个 provider 的格式怪癖集中消化：

```typescript
// Anthropic：拒绝空 content 消息 → 自动过滤
// Mistral：toolCallId 要求 9 位纯字母数字 → 自动规范化
// Claude：toolCallId 只能含 [a-zA-Z0-9_-] → 自动替换
// LiteLLM 代理：注入虚拟 _noop 工具绕过空工具列表兼容问题
```

Claude Code 无此层，工具 schema 直接面向 Anthropic API 格式。

### 4.3 模型专属提示词机制

```typescript
// Agent 定义支持 model_prompts（仅 CoStrict 有）
{
  name: "code-implementer",
  prompt: "通用提示词...",
  model_prompts: {
    "deepseek/deepseek-v3":         "请严格按照工具调用格式输出...",
    "meta-llama/llama-3.3-70b":     "Always use tool calls for file operations...",
    "qwen/qwen2.5-coder-32b":       "你是代码专家，擅长中文注释..."
  }
}
```

### 4.4 模型元数据管理

CoStrict 的每个模型都标注能力信息（`models.ts`）：

```typescript
{
  id: "deepseek-r1",
  reasoning: true,       // 支持推理模式
  tool_call: true,       // 支持工具调用
  attachment: false,     // 不支持图片附件
  interleaved: { field: "reasoning_content" },
  cost: { input: 0.14, output: 2.19 },   // 每百万 token 成本
  limit: { context: 128000, output: 8000 },
}
// 构建时从 models.dev API 生成快照嵌入二进制
// 运行时支持更新
```

Agent 发送请求前查询 `model.capabilities`，不向不支持工具的模型发送工具定义。Claude Code 无此机制。

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 支持提供商 | 4 个（硬编码）| 17+ 个（插件式） |
| 扩展机制 | if-else 硬编码 | npm 包 + 插件式注册表 |
| 统一接口 | 无（各 SDK 直连） | Vercel AI SDK LanguageModelV2 |
| 动态切换 | 启动时固定 | 运行时可切换 |
| 格式归一化 | 无 | ProviderTransform 集中处理格式怪癖 |
| 工具调用容错 | 严格解析（格式错误崩溃） | 宽容解析 + 工具名规范化 |
| 模型专属提示 | 无 | model_prompts 机制 |
| 模型能力标签 | 无 | capabilities（推理/工具/附件/成本） |
| 成本信息 | 无 | 每模型 cost 配置 |

---

## 五、Agent 系统

### 5.1 Claude Code 的 AgentTool

**关键文件**：`src/tools/AgentTool/`（`runAgent.ts`、`forkSubagent.ts`、`resumeAgent.ts`）

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

### 5.2 Claude Code 的任务系统（多 Agent 协调基础）

任务系统是 Claude Code 支撑多 Agent 协调的核心基础设施，`claude_code_arch.md` 1.2.6 节有完整描述：

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

### 5.3 CoStrict 的 Agent 系统

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

## 六、状态管理与持久化

### 6.1 Claude Code 的状态管理

**`src/state/store.ts`（35 行）极简 Store**：

```typescript
store = {
  getState(): AppState
  setState(updater: (prev: AppState) => AppState): void  // 强制不可变更新
  subscribe(callback: (newState, oldState) => void): () => void
}
```

AppState 包含：UI 状态 / 权限上下文 / MCP 连接 / 任务与代理 / 插件系统 / 通知队列 / Tmux 集成状态。

**持久化**：仅 JSON 文件（`~/.claude/settings.json`、任务文件系统 `~/.config/claude/tasks/`），进程级内存状态不跨进程恢复。

### 6.2 CoStrict 的 SQLite 持久化架构

**`packages/opencode/src/storage/db.ts`**：

```typescript
// WAL 模式（高并发写友好）
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA busy_timeout = 5000     // 5秒锁等待
PRAGMA cache_size = -64000     // 64MB 缓存
PRAGMA foreign_keys = ON

// 迁移系统：编译期嵌入 OPENCODE_MIGRATIONS
// 按时间戳排序（yyyyMMddHHmmss）
// 渠道隔离：opencode.db vs opencode-{channel}.db
```

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

### 6.3 Git 快照系统（CoStrict 独有）

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

## 七、MCP 集成

### 7.1 传输层支持

**Claude Code**（`src/services/mcp/client.ts`，3351 行）：

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

**CoStrict**（`packages/opencode/src/mcp/index.ts`，980 行）：

```
StreamableHTTP（优先）→ SSE（降级备选）→ Stdio（本地）
默认超时 30 秒，每个 Server 可独立覆盖
关闭时清理完整进程树（含 grandchild），避免孤立进程
```

### 7.2 OAuth 实现对比

**Claude Code**（`src/services/mcp/auth.ts`，2465 行）：

```typescript
// 令牌过期前 5 分钟主动刷新（不等 401 再补救）
// Step-up 认证：403 insufficient_scope → 强制重走完整 OAuth
// XAA（Cross-App Access）：利用缓存 IdP id_token 静默交换
// 令牌存储：系统 keychain（不写明文文件）
```

**CoStrict**（`mcp/index.ts:752-937`）：

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
| 工具名格式 | `mcp__<server>__<tool>` | `sanitizedClient_sanitizedTool` |
| URL Elicitation | 支持（-32042 弹对话框，最多 3 次） | 无 |

---

## 八、代码理解能力

### 8.1 LSP 集成（CoStrict 独有）

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

Python（PyRight/Ty）和 TypeScript/JS 的 LSP server 需用户环境已安装，CoStrict 通过配置文件指定路径，不自动下载。

| 代码理解场景 | Claude Code | CoStrict |
|------------|-------------|----------|
| "这个函数返回类型是什么？" | 模型猜测（可能幻觉） | LSP.hover 精确返回 |
| "修改这个参数影响哪里？" | GrepTool 文本搜索 | LSP.references 精确 |
| "这个接口有哪些实现？" | 模型逐文件猜测 | LSP.implementations |
| 重命名变量 | 文本替换（可能误伤） | LSP.rename 语义级 |
| 编辑后有无语法错误 | 无（运行时发现） | LSP.diagnostics 实时 |

### 8.2 Tree-sitter AST 分析（file-outline）

对 2000 行 TypeScript 文件：

| 指标 | Claude Code（FileReadTool） | CoStrict（file-outline） |
|------|--------------------------|------------------------|
| Token 消耗 | ~4000 input tokens | ~500 input tokens |
| 耗时 | 2-5s（模型推理） | <100ms（AST 解析） |
| 准确率 | 85-90%（模型理解） | 99%（AST，不是猜测） |
| 原理 | 读取全文给模型 | Tree-sitter 提取类/方法/签名/docstring |

---

## 九、配置系统

### 9.1 Claude Code 的配置层次

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

### 9.2 CoStrict 的七层配置优先级（从低到高）

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

## 十、扩展性：Plugin / Hook 系统

### 10.1 Claude Code 的 Hook 机制

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

### 10.2 CoStrict 的 Plugin 事件系统

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

## 十一、UI 与交互体验

### 11.1 Claude Code 的 REPL（`src/screens/REPL.tsx`，2800+ 行）

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

### 11.2 CoStrict 的 TUI + Desktop

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

---

## 十二、构建时特性门控

### 12.1 Claude Code 的 bun:bundle 机制

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

### 12.2 CoStrict 的 Flag 系统

CoStrict 用运行时 `Flag` 系统做特性开关，特性代码在包中存在但被禁用——理论上可被外部启用，包体积略大。这是 CoStrict 相比 Claude Code 的架构劣势之一。

| 维度 | Claude Code | CoStrict |
|------|-------------|----------|
| 门控时机 | 构建时（bun:bundle tree-shaking） | 运行时（Flag 系统） |
| ANT-ONLY 功能可见性 | 物理不存在于发布包 | 代码存在但被禁用 |
| 包体积 | 特性代码完全剔除（25MB 精简） | 包含所有特性代码 |
| 外部可激活 | 不可能（代码不存在） | 理论上可激活 |

---

## 十三、综合评分

### 13.1 各维度胜负汇总

| 维度 | Claude Code | CoStrict | 胜者 |
|------|:-----------:|:--------:|:----:|
| 核心对话引擎鲁棒性 | ★★★★★ | ★★★★☆ | ClaudeCode |
| 上下文压缩智能度 | ★★★★☆ | ★★★☆☆ | ClaudeCode |
| 死循环检测精度 | ★★★☆☆ | ★★★★★ | CoStrict |
| 工具系统广度 | ★★★★☆ | ★★★★★ | CoStrict |
| 工具执行并发精细度 | ★★★★★ | ★★★☆☆ | ClaudeCode |
| 代码理解能力（LSP+AST） | ★★☆☆☆ | ★★★★★ | CoStrict |
| 权限系统完整性 | ★★★★★ | ★★★★☆ | ClaudeCode |
| Bash 静态分析 | ★★★★★（ANT）| ★★★☆☆（原生）| ClaudeCode（外部 stub，CoStrict 原生可用） |
| 多模型支持 | ★★★☆☆ | ★★★★★ | CoStrict |
| 工具调用格式容错 | ★★★☆☆ | ★★★★★ | CoStrict |
| Agent 并发能力 | ★★★★★ | ★★★☆☆ | ClaudeCode |
| 多 Agent 协调基础设施 | ★★★★★ | ★★☆☆☆ | ClaudeCode |
| Agent 异构模型 | ★★☆☆☆ | ★★★★★ | CoStrict |
| 状态持久化 | ★★☆☆☆ | ★★★★★ | CoStrict |
| Git 快照 / Session Fork | ★☆☆☆☆ | ★★★★★ | CoStrict |
| MCP OAuth 完整性 | ★★★★☆（ANT全量）/ ★★☆☆☆（外部stub）| ★★★★☆ | 平（各有特色） |
| 配置灵活性 | ★★★☆☆ | ★★★★★ | CoStrict |
| Plugin/Hook 扩展性 | ★★★☆☆ | ★★★★★ | CoStrict |
| 构建时特性门控 | ★★★★★（bun:bundle） | ★★☆☆☆（运行时 Flag） | ClaudeCode |
| UI 性能与体验 | ★★★★★ | ★★★☆☆ | ClaudeCode |
| 推测执行 UX | ★★★★★ | ★☆☆☆☆ | ClaudeCode |
| 中文开发者支持 | ★★☆☆☆ | ★★★★★ | CoStrict |
| 企业级配置管控 | ★★★☆☆ | ★★★★★ | CoStrict |

**统计：Claude Code 领先 10 项，CoStrict 领先 12 项，平 1 项。**

### 13.2 两者的结构性定位

```
Claude Code 的结构性优势（难以被追赶）：
─────────────────────────────────────────────
1. Anthropic 官方支持，最新 beta 特性第一时间可用
   → 反编译版关闭的 ANT-ONLY 功能（COORDINATOR_MODE / REACTIVE_COMPACT /
     DAEMON / EXTRACT_MEMORIES 等）在正式版中已启用，能力远超公开文档所见

2. 推测执行架构：感知延迟最低
   → StreamingToolExecutor 在 LLM 输出第一个 tool_use block 时立即调度
   → partitionToolCalls 按 isConcurrencySafe 分区，只读工具最高 10 并发
   → 某工具失败时 siblingAbortController 立即取消同批次其他任务

3. 五层上下文压缩体系：专为长任务设计
   → 静态注入（CLAUDE.md 零 token 消耗）
   → 动态阈值（contextWindow - min(maxOutputTokens, 20k) - 13k）
   → 双路压缩执行（Session Memory 精细保留 + 传统 9 段摘要兜底）
   → Microcompact 零 LLM 轻量清理
   → compact_boundary 边界标记 + GC 集成，防止进程内存无限增长

4. 多 Agent 协调基础设施完整
   → AgentTool 三种模式（fork / async / background）
   → SendMessageTool 点对点/广播/UDS/Bridge 四种通信方式
   → 任务系统：文件锁原子认领 + blockedBy 依赖图 + DiskTaskOutput 5GB 输出
   → Agent 退出时未完成任务自动重置为 pending 等待接管

5. 权限系统深度：1486 行核心 + 6 种模式
   → plan 模式：AI 先跑只读预览，用户确认后切换 acceptEdits 真正执行
   → bashClassifier 静态分析 23 类危险模式（ANT-ONLY，外部已 stub）
   → permission_request Hook 把权限决策外包给企业合规脚本

6. bun:bundle 构建时特性门控
   → ANT-ONLY 功能在发布包中物理不存在（tree-shaking 消除）
   → 内部构建与外部发布用同一套代码，实验性功能不影响包体积
─────────────────────────────────────────────

CoStrict 的结构性优势（Claude Code 无法复制）：
─────────────────────────────────────────────
1. 真正的模型无关：20+ Provider 开箱即用
   → ProviderTransform（1042 行）集中消化所有 Provider 格式怪癖
   → Anthropic 空消息过滤 / Mistral toolCallId 9位限制 / Claude 字符集限制
   → 对比 Claude Code 的 41 行 if-else，切换模型零代码改动
   → 商业模式决定 Claude Code 永远只做 Anthropic，这条护城河不可逾越

2. 17 个工作流 Agent：软件工程方法论固化为可执行流水线
   → strict-spec 用权限白名单强制"需求→规格→设计→任务→编码→测试"六层流水线
   → strict-plan 把"凡是可以通过代码推断的问题，禁止向用户提问"编进 Agent 规范
   → TDD 工作流明确"最多 3 轮自动修复"边界，不依赖模型自律
   → 每个 Agent 可指定不同 provider + modelID，支持异构多模型工作流

3. model_prompts：针对每个开源模型的已知弱点定向优化
   → 同一 Agent，面向 DeepSeek 用适合其格式的提示词，面向 Llama 用英文指令
   → Claude Code 的系统提示词针对 Claude 优化，换模型后效果直接下降

4. LSP + Tree-sitter：工具替代模型推理，不依赖模型猜测
   → LSP client/server 完整实现，自动下载 C/C++/Java/Rust/Go 的 LSP server
   → file-outline 对 2000 行文件：500 token / <100ms / 99% 准确率（vs 4000 token / 2-5s / 85-90%）
   → LSP.diagnostics 编辑后实时反馈，弥补开源模型代码生成准确率不足

5. SQLite 持久化 + Snapshot + Checkpoint 三重状态保障
   → SQLite WAL：进程崩溃可恢复，Session.fork() 任意节点分叉，13 种 Part 精确压缩
   → Snapshot：每 step 自动 git diff 快照，磁盘低于 5GB 自动禁用，7 天清理
   → CheckpointTool：显式 commit/list/show_diff/restore/revert 五种 git 操作
   → 三者覆盖不同层次，开源模型容错率低于 Claude，这是生产环境使用的关键保障

6. Bus 事件架构 + Plugin 系统：零侵入扩展
   → 9 个生命周期钩子，tool.execute.before 可修改参数或阻断执行
   → 外部 Plugin 通过 npm 包动态安装，file:// 协议支持本地插件
   → LearningPlugin 四阶段流水线（检测→存储→LLM生成草稿→用户审批）

7. 7 层配置优先级 + .well-known/opencode 组织级默认
   → 企业托管配置覆盖三平台（Linux/macOS/Windows）
   → plugin[] 和 instructions[] 合并去重，其他字段 mergeDeep
   → 兼容 Claude Code 的 .claude/ 目录和 Skill 文件，迁移成本极低
─────────────────────────────────────────────
```

### 13.3 一句话定位

**Claude Code**：把智能集中在模型本身，工具层为 Claude 系列深度优化，五层压缩 + 流式调度 + 多 Agent 协调基础设施让复杂长任务可靠执行，适合以 Claude 为核心的高强度编程场景。

**CoStrict**：把智能分散到平台层，ProviderTransform + LSP + 工作流 Agent 补偿模型短板，模型能力越弱于 Claude，平台层的补偿效果越显著，适合多模型混用、企业合规、大型代码库场景。

---
