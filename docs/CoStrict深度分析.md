# CoStrict：架构全景解析

> 报告日期：2026-04-01
> 代码库：`packages/opencode/src`（CoStrict 开源版 v3.0.18）

---

## 目录

1. [核心技术栈](#11-核心技术栈)
2. [核心架构设计](#12-核心架构设计)
   - [1.2.1 Agent Loop](#121-agent-loop会话驱动的执行引擎)
   - [1.2.2 工具体系](#122-工具体系标准工具--costrict-专属工具)
   - [1.2.3 Provider 层](#123-provider-层真正的模型无关)
   - [1.2.4 MCP 集成](#124-mcp-集成含-oauth-的无限扩展口)
   - [1.2.5 Skill 系统](#125-skill-系统多目录兼容的工作流固化)
   - [1.2.6 上下文管理](#126-上下文管理三路压缩机制)
   - [1.2.7 权限系统](#127-权限系统permissionnext)
   - [1.2.8 Plugin 系统](#128-plugin-系统事件驱动的扩展架构)
3. [高级特性](#13-高级特性)
   - [1.3.1 内置 Agent 矩阵：17 个专项工作流](#131-内置-agent-矩阵覆盖完整研发生命周期的工作流引擎)
   - [1.3.2 LSP 深度集成](#132-lsp-深度集成完整的语言服务层)
   - [1.3.3 Snapshot 快照系统](#133-snapshot-快照系统文件操作的安全网)
   - [1.3.4 Worktree 原生支持](#134-worktree-原生支持并行任务隔离)
   - [1.3.5 SQLite 持久化存储](#135-sqlite-持久化存储结构化会话数据)
4. [架构亮点与缺点](#14-架构亮点与缺点)

---

读完 CoStrict 的源码，最大的感受是：这是一个**以模型无关为核心约束**设计出来的系统。Provider 层、ProviderTransform、工具注册机制——每个模块都在回答同一个问题：**怎么让任意 LLM 都能可靠地驱动 AI 编程 Agent**。想理解它的强处和弱处，得从整体结构开始看。

---

### 1.1 核心技术栈

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

### 1.2 核心架构设计

#### 1.2.1 Agent Loop：会话驱动的执行引擎

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

#### 1.2.2 工具体系：标准工具 + CoStrict 专属工具

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

#### 1.2.3 Provider 层：真正的模型无关

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

#### 1.2.4 MCP 集成：含 OAuth 的无限扩展口

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

#### 1.2.5 Skill 系统：多目录兼容的工作流固化

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

#### 1.2.6 上下文管理：三路压缩机制

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

#### 1.2.7 权限系统：PermissionNext

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

#### 1.2.8 Plugin 系统：事件驱动的扩展架构

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

### 1.3 高级特性

#### 1.3.1 内置 Agent 矩阵：覆盖完整研发生命周期的工作流引擎

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

#### 1.3.2 LSP 深度集成：完整的语言服务层

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

#### 1.3.3 Snapshot 快照系统：文件操作的安全网

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

#### 1.3.4 Worktree 原生支持：并行任务隔离

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

#### 1.3.5 SQLite 持久化存储：结构化会话数据

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

### 1.4 架构亮点与缺点

#### 1.4.1 亮点

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

#### 1.4.2 缺点

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

### 小结

CoStrict 在架构层面解决了一个 Claude Code 刻意回避的问题：**怎么让任意 LLM 都能可靠地驱动 AI 编程 Agent**。

强处是结构性的：`ProviderTransform` 把 20+ Provider 的格式怪癖统一消化，Agent 切换模型不需要改一行代码；17 个专项工作流 Agent 用权限白名单把软件工程方法论强制执行，开源模型无法绕过流程；SQLite 持久化让会话状态从"进程内存"变成"可分叉、可审计、可精确压缩"的数据库；Snapshot + Checkpoint 双重安全网让生产环境使用开源模型有了兜底保障。

弱点同样是结构性的：委托给 Vercel AI SDK 的流式调度失去了 Claude Code 那样的精细控制空间；运行时特性门控让实验性代码暴露在包中；三路压缩对用户不透明；学习系统停留在实验阶段。这些是"以模型无关为优先级"这个架构决策必须承担的代价——设计得越兼容、越通用，在极端场景下的精细调优空间就越小。

---

