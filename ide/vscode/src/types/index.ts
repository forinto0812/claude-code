// VSCode 插件类型定义 - 基于 csc 项目的核心类型
// 覆盖：消息类型、工具类型、会话类型、权限类型、Provider 类型

// ===== 消息类型 =====

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 内容块类型 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'image'

/** 文本内容块 */
export interface TextContent {
  type: 'text'
  text: string
}

/** 工具调用内容块 */
export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具结果内容块 */
export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

/** 思考内容块 */
export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

/** 内容块联合类型 */
export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | ThinkingContent

/** API 消息（发给 Claude 的标准格式） */
export interface ApiMessage {
  role: MessageRole
  content: string | ContentBlock[]
}

// ===== stream-json 协议事件 =====

/** 系统初始化事件 */
export interface StreamSystemEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  tools?: Array<{ name: string; description: string }>
  mcp_servers?: Array<{ name: string; status: string }>
  model?: string
  cwd?: string
  permissionMode?: string
}

/** 助手消息事件 */
export interface StreamAssistantEvent {
  type: 'assistant'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: ContentBlock[]
    model: string
    stop_reason: string | null
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

/** 用户消息事件（工具结果回传） */
export interface StreamUserEvent {
  type: 'user'
  message: {
    role: 'user'
    content: ContentBlock[]
  }
}

/** 结果事件（对话完成） */
export interface StreamResultEvent {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution'
  session_id: string
  result?: string
  cost_usd?: number
  duration_ms?: number
  num_turns?: number
  total_cost?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  is_error?: boolean
  error?: string
}

/** 权限请求事件 */
export interface StreamPermissionEvent {
  type: 'permission_request'
  tool_name: string
  tool_input: Record<string, unknown>
  request_id: string
  description?: string
}

/** 所有 stream-json 输出事件 */
export type StreamEvent =
  | StreamSystemEvent
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent
  | StreamPermissionEvent

// ===== 输入消息格式 =====

/** 向 CLI 发送用户消息 */
export interface InputUserMessage {
  type: 'user'
  message: string | ContentBlock[]
}

/** 权限决策消息 */
export interface InputPermissionResponse {
  type: 'permission_response'
  request_id: string
  decision: 'allow' | 'deny'
  remember?: boolean
}

/** 所有 stream-json 输入消息 */
export type InputMessage = InputUserMessage | InputPermissionResponse

// ===== 插件内部消息类型（WebView <-> Extension） =====

/** 聊天消息（插件 UI 内部） */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  // 工具调用信息
  toolCalls?: ToolCallInfo[]
  // 是否正在流式输出
  streaming?: boolean
  // token 用量
  usage?: {
    input_tokens: number
    output_tokens: number
    cost_usd?: number
  }
  // 思考过程
  thinking?: string
}

/** 工具调用信息（插件 UI 显示用） */
export interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'pending' | 'approved' | 'denied' | 'completed' | 'error'
  // 权限请求 ID（如需人工审批）
  permissionRequestId?: string
}

/** 权限请求（传给 WebView 显示） */
export interface PermissionRequest {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  description?: string
  timestamp: number
}

// ===== 会话类型 =====

/** 会话状态 */
export type SessionStatus = 'idle' | 'connecting' | 'running' | 'waiting_permission' | 'error' | 'stopped'

/** 会话信息 */
export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  workingDirectory: string
  model?: string
  provider?: ProviderType
  status: SessionStatus
  // CLI 会话 ID（从 stream-json system init 事件获取）
  cliSessionId?: string
  // 累计 token 用量
  totalUsage?: {
    input_tokens: number
    output_tokens: number
    cost_usd: number
  }
}

// ===== Provider 类型 =====

/** AI 提供商 */
export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'bedrock' | 'vertex' | 'grok'

/** Provider 配置 */
export interface ProviderConfig {
  provider: ProviderType
  apiKey?: string
  baseUrl?: string
  model?: string
  // 额外环境变量（如 AWS 凭证等）
  extraEnv?: Record<string, string>
}

// ===== 权限类型 =====

/** 权限模式 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

// ===== VSCode 插件设置 =====

/** 插件配置 */
export interface ExtensionSettings {
  // CLI 路径
  cliPath: string
  // 运行时
  runtime: 'auto' | 'node' | 'bun'
  // Provider 设置
  provider: ProviderType
  model: string
  apiKey: string
  openaiBaseUrl: string
  // 权限设置
  permissionMode: PermissionMode
  autoApproveTools: string[]
  // 对话设置
  workingDirectory: string
  maxTurns: number
  enableStreaming: boolean
  showThinking: boolean
  systemPrompt: string
}

// ===== WebView 消息协议（Extension <-> WebView） =====

/** WebView 收到的消息类型 */
export type WebViewMessage =
  | { type: 'init'; session: Session; settings: Partial<ExtensionSettings> }
  | { type: 'message_append'; message: ChatMessage }
  | { type: 'message_update'; messageId: string; delta: Partial<ChatMessage> }
  | { type: 'session_status'; status: SessionStatus; error?: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'tool_update'; messageId: string; toolCallId: string; update: Partial<ToolCallInfo> }
  | { type: 'sessions_list'; sessions: Array<Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>> }
  | { type: 'thinking_update'; messageId: string; thinking: string }

/** Extension 收到的 WebView 消息类型 */
export type ExtensionMessage =
  | { type: 'send_message'; content: string }
  | { type: 'permission_decision'; requestId: string; decision: 'allow' | 'deny'; remember?: boolean }
  | { type: 'new_chat' }
  | { type: 'load_session'; sessionId: string }
  | { type: 'delete_session'; sessionId: string }
  | { type: 'stop_generation' }
  | { type: 'get_sessions' }
  | { type: 'ready' }
