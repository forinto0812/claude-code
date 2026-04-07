// WebView 主脚本 - 聊天界面完整实现
// 运行在 VSCode WebView 沙箱环境中，通过 postMessage 与 Extension 通信

import type {
  WebViewMessage,
  ExtensionMessage,
  ChatMessage,
  PermissionRequest,
  Session,
  ToolCallInfo,
} from '../types'

// VSCode WebView API（由 VSCode 注入）
declare const acquireVsCodeApi: () => {
  postMessage(msg: ExtensionMessage): void
  getState(): unknown
  setState(state: unknown): void
}

// ===== 初始化 VSCode API =====
const vscode = acquireVsCodeApi()

// ===== 状态 =====
let currentSession: Session | null = null
let isRunning = false
let showThinking = false
let sessionsVisible = false

// ===== DOM 引用 =====
let messagesContainer: HTMLElement
let inputTextarea: HTMLTextAreaElement
let sendBtn: HTMLButtonElement
let sessionTitle: HTMLElement
let statusBadge: HTMLElement
let sessionsPanel: HTMLElement
let sessionsList: HTMLElement

// ===== 工具图标映射 =====
const TOOL_ICONS: Record<string, string> = {
  Bash: '⚡',
  BashTool: '⚡',
  FileReadTool: '📖',
  Read: '📖',
  FileWriteTool: '✏️',
  Write: '✏️',
  FileEditTool: '✏️',
  Edit: '✏️',
  GlobTool: '🔍',
  Glob: '🔍',
  GrepTool: '🔎',
  Grep: '🔎',
  WebFetchTool: '🌐',
  WebFetch: '🌐',
  WebSearchTool: '🔍',
  WebSearch: '🔍',
  AgentTool: '🤖',
  MCPTool: '🔌',
  NotebookEditTool: '📓',
  default: '🔧',
}

// ===== 入口 =====
document.addEventListener('DOMContentLoaded', () => {
  // 初始化 DOM 引用
  initDOM()
  // 绑定事件
  bindEvents()
  // 通知 Extension WebView 已就绪
  postMessage({ type: 'ready' })
})

// ===== DOM 初始化 =====
function initDOM(): void {
  // 创建完整 UI 结构
  const app = document.getElementById('app')!
  app.innerHTML = `
    <!-- 顶部工具栏 -->
    <div class="toolbar" id="toolbar">
      <div class="toolbar-left">
        <span class="session-title" id="session-title">Claude Code</span>
        <span class="status-badge" id="status-badge">空闲</span>
      </div>
      <div class="toolbar-right">
        <button class="icon-btn" id="btn-history" title="查看历史对话">🕐</button>
        <button class="icon-btn" id="btn-new-chat" title="新建对话">＋</button>
        <button class="icon-btn" id="btn-clear" title="清除当前对话">🗑</button>
      </div>
    </div>

    <!-- 消息列表 -->
    <div class="messages-container" id="messages-container">
      <!-- 欢迎屏幕（无消息时显示） -->
      <div class="welcome-screen" id="welcome-screen">
        <div class="welcome-icon">🤖</div>
        <div class="welcome-title">Claude Code</div>
        <div class="welcome-desc">AI 编程助手，基于 Claude 模型</div>
        <div class="welcome-tips">
          <button class="tip-item" onclick="sendQuickPrompt('解释当前工作区的项目结构')">
            📁 分析项目结构
          </button>
          <button class="tip-item" onclick="sendQuickPrompt('查看当前 git 状态和最近的修改')">
            🔀 查看 Git 状态
          </button>
          <button class="tip-item" onclick="sendQuickPrompt('检查项目中是否有潜在的安全问题')">
            🔒 安全检查
          </button>
          <button class="tip-item" onclick="sendQuickPrompt('帮我写单元测试')">
            🧪 生成测试
          </button>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="input-area" id="input-area">
      <div class="input-wrapper">
        <textarea
          class="message-input"
          id="message-input"
          placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
          rows="1"
        ></textarea>
        <button class="send-btn" id="send-btn" title="发送">▶</button>
      </div>
      <div class="input-hint" id="input-hint">Enter 发送 · Shift+Enter 换行</div>
    </div>

    <!-- 会话历史面板（覆盖层） -->
    <div class="sessions-panel" id="sessions-panel" style="display:none">
      <div class="sessions-panel-header">
        <span>历史对话</span>
        <button class="icon-btn" id="btn-close-sessions" title="关闭">✕</button>
      </div>
      <div class="sessions-list" id="sessions-list"></div>
      <div style="padding:8px;border-top:1px solid var(--claude-border)">
        <button class="btn btn-secondary" style="width:100%" id="btn-new-in-panel">＋ 新建对话</button>
      </div>
    </div>
  `

  // 获取 DOM 引用
  messagesContainer = document.getElementById('messages-container')!
  inputTextarea = document.getElementById('message-input') as HTMLTextAreaElement
  sendBtn = document.getElementById('send-btn') as HTMLButtonElement
  sessionTitle = document.getElementById('session-title')!
  statusBadge = document.getElementById('status-badge')!
  sessionsPanel = document.getElementById('sessions-panel')!
  sessionsList = document.getElementById('sessions-list')!
}

// 快速提示（欢迎屏按钮调用）
;(window as unknown as Record<string, unknown>)['sendQuickPrompt'] = (text: string) => {
  inputTextarea.value = text
  sendMessage()
}

// ===== 事件绑定 =====
function bindEvents(): void {
  // 发送按钮
  sendBtn.addEventListener('click', () => {
    if (isRunning) {
      // 运行中时点击发送按钮变为停止按钮
      postMessage({ type: 'stop_generation' })
    } else {
      sendMessage()
    }
  })

  // 输入框快捷键
  inputTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter 发送消息
      e.preventDefault()
      if (!isRunning) sendMessage()
    }
  })

  // 自动调整输入框高度
  inputTextarea.addEventListener('input', () => {
    autoResizeTextarea()
    updateSendButton()
  })

  // 工具栏按钮
  document.getElementById('btn-new-chat')!.addEventListener('click', () => {
    postMessage({ type: 'new_chat' })
  })

  document.getElementById('btn-clear')!.addEventListener('click', () => {
    if (confirm('确认清除当前对话的所有消息？')) {
      clearMessages()
      postMessage({ type: 'new_chat' })
    }
  })

  document.getElementById('btn-history')!.addEventListener('click', () => {
    toggleSessionsPanel()
  })

  document.getElementById('btn-close-sessions')!.addEventListener('click', () => {
    hideSessionsPanel()
  })

  document.getElementById('btn-new-in-panel')!.addEventListener('click', () => {
    hideSessionsPanel()
    postMessage({ type: 'new_chat' })
  })

  // 监听来自 Extension 的消息
  window.addEventListener('message', (event: MessageEvent) => {
    handleExtensionMessage(event.data as WebViewMessage)
  })
}

// ===== 发送消息 =====
function sendMessage(): void {
  const content = inputTextarea.value.trim()
  if (!content) return

  // 清空输入框
  inputTextarea.value = ''
  autoResizeTextarea()
  updateSendButton()

  // 发送到 Extension
  postMessage({ type: 'send_message', content })
}

// ===== 处理 Extension 消息 =====
function handleExtensionMessage(msg: WebViewMessage): void {
  switch (msg.type) {
    case 'init':
      // 初始化会话状态
      currentSession = msg.session
      showThinking = msg.settings.showThinking ?? false
      updateSessionHeader(msg.session)
      renderAllMessages(msg.session.messages)
      break

    case 'message_append':
      // 追加新消息
      appendMessage(msg.message)
      break

    case 'message_update':
      // 更新消息内容（流式更新）
      updateMessage(msg.messageId, msg.delta)
      break

    case 'session_status':
      // 更新状态
      updateStatus(msg.status, msg.error)
      break

    case 'permission_request':
      // 显示权限审批卡片
      showPermissionCard(msg.request)
      break

    case 'permission_resolved':
      // 移除权限审批卡片
      removePermissionCard(msg.requestId, msg.decision)
      break

    case 'tool_update':
      // 更新工具调用状态
      updateToolCall(msg.messageId, msg.toolCallId, msg.update)
      break

    case 'thinking_update':
      // 更新思考内容
      updateThinking(msg.messageId, msg.thinking)
      break

    case 'sessions_list':
      // 渲染会话列表
      renderSessionsList(msg.sessions)
      break
  }
}

// ===== 渲染所有消息 =====
function renderAllMessages(messages: ChatMessage[]): void {
  // 清空消息区（保留欢迎屏）
  const welcomeScreen = document.getElementById('welcome-screen')
  messagesContainer.innerHTML = ''
  if (welcomeScreen) messagesContainer.appendChild(welcomeScreen)

  if (messages.length === 0) {
    showWelcome(true)
    return
  }

  showWelcome(false)
  for (const msg of messages) {
    renderMessage(msg)
  }
  scrollToBottom()
}

// ===== 追加消息 =====
function appendMessage(msg: ChatMessage): void {
  showWelcome(false)
  renderMessage(msg)
  scrollToBottom()
}

// ===== 渲染单条消息 =====
function renderMessage(msg: ChatMessage): void {
  const el = createMessageElement(msg)
  messagesContainer.appendChild(el)
}

// ===== 创建消息元素 =====
function createMessageElement(msg: ChatMessage): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `message ${msg.role}`
  wrapper.dataset.messageId = msg.id

  // 消息头部（显示角色和时间）
  if (msg.role !== 'system') {
    const header = document.createElement('div')
    header.className = 'message-header'
    header.innerHTML = `
      <span>${msg.role === 'user' ? '你' : '🤖 Claude'}</span>
      <span>${formatTime(msg.timestamp)}</span>
    `
    wrapper.appendChild(header)
  }

  // 气泡
  const bubble = document.createElement('div')
  bubble.className = `message-bubble${msg.streaming ? ' streaming' : ''}`
  bubble.dataset.bubbleId = msg.id

  // 思考内容（如果有）
  if (msg.thinking && showThinking) {
    bubble.appendChild(createThinkingBlock(msg.thinking))
  }

  // 消息正文（Markdown 渲染）
  const contentEl = document.createElement('div')
  contentEl.className = 'message-content'
  contentEl.innerHTML = renderMarkdown(msg.content)
  bubble.appendChild(contentEl)

  // 工具调用区
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const toolCallsEl = document.createElement('div')
    toolCallsEl.className = 'tool-calls'
    for (const tc of msg.toolCalls) {
      toolCallsEl.appendChild(createToolCallElement(tc))
    }
    bubble.appendChild(toolCallsEl)
  }

  // token 用量
  if (msg.usage && (msg.usage.input_tokens > 0 || msg.usage.output_tokens > 0)) {
    const usage = document.createElement('div')
    usage.style.cssText = 'font-size:10px;opacity:0.4;text-align:right;margin-top:4px'
    usage.textContent = `↑${msg.usage.input_tokens} ↓${msg.usage.output_tokens} tokens`
    bubble.appendChild(usage)
  }

  wrapper.appendChild(bubble)
  return wrapper
}

// ===== 更新消息内容 =====
function updateMessage(messageId: string, delta: Partial<ChatMessage>): void {
  const bubble = document.querySelector(`[data-bubble-id="${messageId}"]`) as HTMLElement
  if (!bubble) {
    // 消息不存在，可能需要新建
    if (currentSession) {
      const msg = currentSession.messages.find((m) => m.id === messageId)
      if (msg) {
        Object.assign(msg, delta)
        appendMessage(msg)
      }
    }
    return
  }

  // 更新流式动画
  if (delta.streaming !== undefined) {
    bubble.classList.toggle('streaming', delta.streaming)
  }

  // 更新文本内容
  if (delta.content !== undefined) {
    const contentEl = bubble.querySelector('.message-content')
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(delta.content)
    }
  }

  // 更新工具调用
  if (delta.toolCalls) {
    let toolCallsEl = bubble.querySelector('.tool-calls') as HTMLElement
    if (!toolCallsEl) {
      toolCallsEl = document.createElement('div')
      toolCallsEl.className = 'tool-calls'
      bubble.appendChild(toolCallsEl)
    }
    // 更新或新增工具调用项
    for (const tc of delta.toolCalls) {
      const existing = toolCallsEl.querySelector(`[data-tool-id="${tc.id}"]`)
      if (existing) {
        existing.replaceWith(createToolCallElement(tc))
      } else {
        toolCallsEl.appendChild(createToolCallElement(tc))
      }
    }
  }

  scrollToBottom()
}

// ===== 更新工具调用状态 =====
function updateToolCall(messageId: string, toolCallId: string, update: Partial<ToolCallInfo>): void {
  const toolEl = document.querySelector(
    `[data-message-id="${messageId}"] [data-tool-id="${toolCallId}"]`,
  ) as HTMLElement
  if (!toolEl) return

  // 更新状态徽章
  if (update.status) {
    const statusEl = toolEl.querySelector('.tool-call-status')
    if (statusEl) {
      statusEl.className = `tool-call-status ${update.status}`
      statusEl.textContent = getStatusText(update.status)
    }
  }

  // 更新结果
  if (update.result !== undefined) {
    let resultEl = toolEl.querySelector('.tool-call-result') as HTMLElement
    if (!resultEl) {
      resultEl = document.createElement('div')
      resultEl.className = `tool-call-result${update.isError ? ' error' : ''}`
      toolEl.appendChild(resultEl)
    }
    resultEl.textContent = update.result.slice(0, 500)
  }
}

// ===== 更新思考内容 =====
function updateThinking(messageId: string, thinking: string): void {
  if (!showThinking) return
  const bubble = document.querySelector(`[data-bubble-id="${messageId}"]`)
  if (!bubble) return

  let thinkingEl = bubble.querySelector('.thinking-block') as HTMLElement
  if (!thinkingEl) {
    thinkingEl = createThinkingBlock(thinking)
    bubble.insertBefore(thinkingEl, bubble.firstChild)
  } else {
    const contentEl = thinkingEl.querySelector('.thinking-content')
    if (contentEl) contentEl.textContent = thinking
  }
}

// ===== 工具调用元素 =====
function createToolCallElement(tc: ToolCallInfo): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tool-call'
  el.dataset.toolId = tc.id

  const icon = TOOL_ICONS[tc.name] ?? TOOL_ICONS.default
  const inputStr = JSON.stringify(tc.input, null, 2)

  el.innerHTML = `
    <div class="tool-call-header" onclick="toggleToolCall(this)">
      <span class="tool-call-icon">${icon}</span>
      <span class="tool-call-name">${escapeHtml(tc.name)}</span>
      <span class="tool-call-status ${tc.status}">${getStatusText(tc.status)}</span>
    </div>
    <div class="tool-call-body">
      <pre style="font-size:11px;color:var(--claude-fg)">${escapeHtml(inputStr)}</pre>
    </div>
    ${tc.result ? `<div class="tool-call-result${tc.isError ? ' error' : ''}">${escapeHtml(tc.result.slice(0, 500))}</div>` : ''}
  `
  return el
}

// 切换工具调用展开
;(window as unknown as Record<string, unknown>)['toggleToolCall'] = (header: HTMLElement) => {
  header.closest('.tool-call')?.classList.toggle('expanded')
}

// ===== 思考内容块 =====
function createThinkingBlock(thinking: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'thinking-block'
  el.innerHTML = `
    <div class="thinking-header" onclick="this.closest('.thinking-block').classList.toggle('expanded')">
      <span>💭</span>
      <span>思考过程</span>
    </div>
    <div class="thinking-content">${escapeHtml(thinking)}</div>
  `
  return el
}

// ===== 权限审批卡片 =====
function showPermissionCard(request: PermissionRequest): void {
  const card = document.createElement('div')
  card.className = 'permission-card'
  card.id = `permission-${request.requestId}`

  const inputStr = formatPermissionInput(request.toolName, request.toolInput)

  card.innerHTML = `
    <div class="permission-header">
      <span>⚠️</span>
      <span>工具权限请求</span>
    </div>
    <div class="permission-body">
      <div class="permission-tool-name">${escapeHtml(request.toolName)}</div>
      ${request.description ? `<div style="font-size:12px;margin-bottom:8px;opacity:0.8">${escapeHtml(request.description)}</div>` : ''}
      <div class="permission-input">${escapeHtml(inputStr)}</div>
      <div class="permission-actions">
        <button class="btn btn-primary" onclick="resolvePermission('${request.requestId}', 'allow')">
          ✓ 允许
        </button>
        <button class="btn btn-danger" onclick="resolvePermission('${request.requestId}', 'deny')">
          ✗ 拒绝
        </button>
        <label class="permission-remember">
          <input type="checkbox" id="remember-${request.requestId}" />
          记住此决策
        </label>
      </div>
    </div>
  `

  messagesContainer.appendChild(card)
  scrollToBottom()
}

// 解析权限（WebView 按钮调用）
;(window as unknown as Record<string, unknown>)['resolvePermission'] = (
  requestId: string,
  decision: 'allow' | 'deny',
) => {
  const rememberEl = document.getElementById(`remember-${requestId}`) as HTMLInputElement
  const remember = rememberEl?.checked ?? false

  postMessage({ type: 'permission_decision', requestId, decision, remember })
}

function removePermissionCard(requestId: string, decision: 'allow' | 'deny'): void {
  const card = document.getElementById(`permission-${requestId}`)
  if (!card) return
  // 显示决策结果后移除
  card.style.opacity = '0.6'
  card.style.transition = 'opacity 0.3s'
  const body = card.querySelector('.permission-body')
  if (body) {
    body.innerHTML = `<div style="padding:8px;font-size:12px;color:${decision === 'allow' ? 'var(--claude-success)' : 'var(--claude-error)'}">
      ${decision === 'allow' ? '✓ 已允许' : '✗ 已拒绝'}
    </div>`
  }
  setTimeout(() => card.remove(), 1000)
}

// ===== 状态更新 =====
function updateStatus(status: string, error?: string): void {
  isRunning = status === 'running' || status === 'connecting' || status === 'waiting_permission'

  // 更新状态徽章
  statusBadge.className = 'status-badge'
  switch (status) {
    case 'running':
    case 'connecting':
      statusBadge.className += ' running'
      statusBadge.textContent = status === 'connecting' ? '🔄 连接中' : '⚡ 生成中'
      break
    case 'waiting_permission':
      statusBadge.className += ' waiting'
      statusBadge.textContent = '⚠️ 等待授权'
      break
    case 'error':
      statusBadge.className += ' error'
      statusBadge.textContent = '❌ 错误'
      if (error) {
        appendErrorMessage(error)
      }
      break
    default:
      statusBadge.textContent = '空闲'
  }

  // 更新发送按钮样式
  updateSendButton()
}

function appendErrorMessage(error: string): void {
  const errEl = document.createElement('div')
  errEl.className = 'message system'
  errEl.innerHTML = `<div class="message-bubble" style="color:var(--claude-error)">⚠️ ${escapeHtml(error)}</div>`
  messagesContainer.appendChild(errEl)
  scrollToBottom()
}

// ===== 会话头部更新 =====
function updateSessionHeader(session: Session): void {
  sessionTitle.textContent = session.title || 'Claude Code'
  sessionTitle.title = `工作目录：${session.workingDirectory}`
}

// ===== 会话历史面板 =====
function toggleSessionsPanel(): void {
  if (sessionsVisible) {
    hideSessionsPanel()
  } else {
    sessionsPanel.style.display = 'flex'
    sessionsVisible = true
    postMessage({ type: 'get_sessions' })
  }
}

function hideSessionsPanel(): void {
  sessionsPanel.style.display = 'none'
  sessionsVisible = false
}

function renderSessionsList(
  sessions: Array<Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>>,
): void {
  if (sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty-sessions">暂无历史对话</div>'
    return
  }

  sessionsList.innerHTML = ''
  for (const s of sessions) {
    const item = document.createElement('div')
    const isActive = currentSession?.id === s.id
    item.className = `session-item${isActive ? ' active' : ''}`
    item.innerHTML = `
      <div class="session-item-content" onclick="loadSession('${s.id}')">
        <div class="session-item-title">${escapeHtml(s.title)}</div>
        <div class="session-item-meta">${formatTime(s.updatedAt)}</div>
      </div>
      <button class="session-delete-btn" onclick="deleteSession(event, '${s.id}')" title="删除">✕</button>
    `
    sessionsList.appendChild(item)
  }
}

;(window as unknown as Record<string, unknown>)['loadSession'] = (sessionId: string) => {
  postMessage({ type: 'load_session', sessionId })
  hideSessionsPanel()
}

;(window as unknown as Record<string, unknown>)['deleteSession'] = (
  event: MouseEvent,
  sessionId: string,
) => {
  event.stopPropagation()
  if (confirm('确认删除此对话？')) {
    postMessage({ type: 'delete_session', sessionId })
  }
}

// ===== 清空消息 =====
function clearMessages(): void {
  const welcomeScreen = document.getElementById('welcome-screen')
  messagesContainer.innerHTML = ''
  if (welcomeScreen) messagesContainer.appendChild(welcomeScreen)
  showWelcome(true)
}

// ===== 欢迎屏控制 =====
function showWelcome(show: boolean): void {
  const ws = document.getElementById('welcome-screen')
  if (ws) ws.style.display = show ? 'flex' : 'none'
}

// ===== 辅助函数 =====

/** 发消息给 Extension */
function postMessage(msg: ExtensionMessage): void {
  vscode.postMessage(msg)
}

/** 自动调整输入框高度 */
function autoResizeTextarea(): void {
  inputTextarea.style.height = 'auto'
  const maxHeight = 200
  const scrollHeight = Math.min(inputTextarea.scrollHeight, maxHeight)
  inputTextarea.style.height = `${scrollHeight}px`
}

/** 更新发送按钮状态 */
function updateSendButton(): void {
  const hasContent = inputTextarea.value.trim().length > 0
  if (isRunning) {
    sendBtn.className = 'send-btn stop'
    sendBtn.textContent = '■'
    sendBtn.title = '停止生成'
    sendBtn.disabled = false
  } else {
    sendBtn.className = 'send-btn'
    sendBtn.textContent = '▶'
    sendBtn.title = '发送'
    sendBtn.disabled = !hasContent
  }
}

/** 滚动到底部 */
function scrollToBottom(): void {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight
  })
}

/** 格式化时间戳 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** HTML 转义 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 格式化权限请求输入 */
function formatPermissionInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'BashTool':
      return `$ ${String(input.command ?? '')}`
    case 'Write':
    case 'FileWriteTool':
      return `文件：${String(input.file_path ?? input.path ?? '')}`
    case 'Edit':
    case 'FileEditTool':
      return `文件：${String(input.file_path ?? input.path ?? '')}`
    default:
      return JSON.stringify(input, null, 2).slice(0, 300)
  }
}

/** 获取状态文本 */
function getStatusText(status: string): string {
  const map: Record<string, string> = {
    pending: '等待',
    approved: '已允许',
    denied: '已拒绝',
    completed: '完成',
    error: '错误',
    running: '执行中',
  }
  return map[status] ?? status
}

/**
 * 简易 Markdown 渲染器
 * 支持：代码块、内联代码、粗体、斜体、链接、有序/无序列表、标题、分隔线
 */
function renderMarkdown(text: string): string {
  if (!text) return ''

  // 处理代码块（```lang ... ```）
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const escaped = escapeHtml(code.trim())
    const langLabel = lang || 'code'
    return `<pre><div class="code-block-header"><span>${langLabel}</span><button class="copy-btn" onclick="copyCode(this)">复制</button></div><code>${escaped}</code></pre>`
  })

  // 处理内联代码
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')

  // 处理标题
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // 处理粗体
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>')

  // 处理斜体
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
  text = text.replace(/_(.+?)_/g, '<em>$1</em>')

  // 处理链接
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')

  // 处理无序列表
  text = text.replace(/^[*-] (.+)$/gm, '<li>$1</li>')
  text = text.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

  // 处理有序列表
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

  // 处理分隔线
  text = text.replace(/^---$/gm, '<hr>')

  // 处理引用块
  text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')

  // 处理段落（双换行）
  const paragraphs = text.split(/\n\n+/)
  text = paragraphs
    .map((p) => {
      const trimmed = p.trim()
      // 已经是块级元素则不包装
      if (/^<(h[1-6]|pre|ul|ol|blockquote|hr)/.test(trimmed)) return trimmed
      // 将单换行转为 <br>
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')

  return text
}

// 代码复制功能
;(window as unknown as Record<string, unknown>)['copyCode'] = (btn: HTMLButtonElement) => {
  const pre = btn.closest('pre')
  const code = pre?.querySelector('code')?.textContent ?? ''
  navigator.clipboard.writeText(code).then(() => {
    const orig = btn.textContent
    btn.textContent = '已复制!'
    setTimeout(() => { btn.textContent = orig }, 2000)
  })
}
