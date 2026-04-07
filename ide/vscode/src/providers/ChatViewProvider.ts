// 聊天视图提供者 - WebView 侧边栏核心实现
// 处理 Extension <-> WebView 双向消息通信，以及 CLI 进程事件路由
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import type {
  ChatMessage,
  PermissionRequest,
  StreamEvent,
  ExtensionSettings,
  WebViewMessage,
  ExtensionMessage,
  ToolCallInfo,
} from '../types'
import type { SessionManager } from '../services/SessionManager'
import type { PermissionManager } from '../services/PermissionManager'
import type { ClaudeCodeProcess } from '../services/ClaudeCodeProcess'
import { getSettings, resolveWorkingDirectory } from '../config/settings'

/**
 * 聊天视图提供者
 * 实现 VSCode WebviewViewProvider 接口，管理侧边栏聊天面板
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  // 当前 WebView 视图实例
  private webviewView: vscode.WebviewView | null = null
  // 当前设置
  private settings: ExtensionSettings
  // 事件订阅列表
  private disposables: vscode.Disposable[] = []
  // 当前正在流式输出的助手消息 ID
  private currentAssistantMessageId: string | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly permissionManager: PermissionManager,
    private readonly claudeProcess: ClaudeCodeProcess,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    // 读取初始设置
    this.settings = getSettings()
    // 绑定 CLI 进程事件
    this.bindProcessEvents()
    // 绑定权限事件
    this.bindPermissionEvents()
  }

  // ===== WebviewViewProvider 接口实现 =====

  /**
   * 当 WebView 视图被解析（首次显示）时调用
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView

    // 配置 WebView 权限
    webviewView.webview.options = {
      // 启用 JavaScript
      enableScripts: true,
      // 允许加载的本地资源根目录
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'assets'),
      ],
    }

    // 设置 WebView HTML 内容
    webviewView.webview.html = this.getWebviewHtml(webviewView.webview)

    // 监听来自 WebView 的消息
    webviewView.webview.onDidReceiveMessage(
      (msg: ExtensionMessage) => this.handleWebviewMessage(msg),
      null,
      this.disposables,
    )

    // 监听视图显示/隐藏
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // 视图重新可见时，同步当前会话状态
        this.syncSessionToWebview()
      }
    }, null, this.disposables)

    this.outputChannel.appendLine('[ChatViewProvider] WebView 已初始化')
  }

  // ===== 公开 API =====

  /**
   * 新建对话
   */
  newChat(): void {
    // 停止当前进程
    if (this.claudeProcess.isRunning) {
      this.claudeProcess.stop()
    }
    // 清除权限会话记忆
    this.permissionManager.clearSessionMemory()
    // 创建新会话
    const cwd = resolveWorkingDirectory(this.settings)
    this.sessionManager.createSession({
      workingDirectory: cwd,
      provider: this.settings.provider,
      model: this.settings.model || undefined,
    })
    // 同步到 WebView
    this.syncSessionToWebview()
  }

  /**
   * 清除当前对话消息
   */
  clearChat(): void {
    if (this.claudeProcess.isRunning) {
      this.claudeProcess.stop()
    }
    const session = this.sessionManager.current
    if (!session) return
    // 清空消息列表（保留会话元数据）
    session.messages.length = 0
    this.syncSessionToWebview()
  }

  /**
   * 发送消息（由命令调用，如发送选中代码）
   */
  sendMessage(content: string): void {
    if (!this.sessionManager.current) {
      // 自动创建会话
      const cwd = resolveWorkingDirectory(this.settings)
      this.sessionManager.createSession({ workingDirectory: cwd })
    }
    this.handleSendMessage(content)
  }

  /**
   * 停止生成
   */
  stopGeneration(): void {
    this.outputChannel.appendLine('[ChatViewProvider] 停止生成')
    this.claudeProcess.stop()
    this.permissionManager.cancelAll()
    this.sessionManager.updateStatus('stopped')
    this.sendToWebview({ type: 'session_status', status: 'stopped' })
  }

  /**
   * 加载历史会话
   */
  loadSession(sessionId: string): void {
    // 停止当前进程
    if (this.claudeProcess.isRunning) {
      this.claudeProcess.stop()
    }
    // 切换会话
    const session = this.sessionManager.switchSession(sessionId)
    if (!session) return
    // 同步到 WebView
    this.syncSessionToWebview()
  }

  /**
   * 设置更新回调
   */
  onSettingsChange(newSettings: ExtensionSettings): void {
    this.settings = newSettings
  }

  // ===== WebView 消息处理 =====

  /**
   * 处理来自 WebView 的消息
   */
  private handleWebviewMessage(msg: ExtensionMessage): void {
    this.outputChannel.appendLine(`[ChatViewProvider] WebView → Extension: ${msg.type}`)

    switch (msg.type) {
      case 'ready':
        // WebView 就绪，同步当前会话状态
        this.syncSessionToWebview()
        break

      case 'send_message':
        // 用户发送消息
        this.handleSendMessage(msg.content)
        break

      case 'permission_decision':
        // 用户在 WebView 内做出权限决策
        this.permissionManager.resolveFromWebView(
          msg.requestId,
          msg.decision,
          msg.remember ?? false,
        )
        break

      case 'new_chat':
        // 新建对话
        this.newChat()
        break

      case 'load_session':
        // 加载历史会话
        this.loadSession(msg.sessionId)
        break

      case 'delete_session':
        // 删除会话
        this.sessionManager.deleteSession(msg.sessionId)
        // 刷新会话列表
        this.sendSessionsList()
        break

      case 'stop_generation':
        // 停止生成
        this.stopGeneration()
        break

      case 'get_sessions':
        // 获取会话列表
        this.sendSessionsList()
        break
    }
  }

  /**
   * 处理发送消息
   */
  private async handleSendMessage(content: string): Promise<void> {
    // 确保有当前会话
    if (!this.sessionManager.current) {
      const cwd = resolveWorkingDirectory(this.settings)
      this.sessionManager.createSession({
        workingDirectory: cwd,
        provider: this.settings.provider,
      })
    }

    const session = this.sessionManager.current!

    // 构建用户消息
    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    // 追加到会话
    this.sessionManager.appendMessage(userMessage)
    // 发送到 WebView 显示
    this.sendToWebview({ type: 'message_append', message: userMessage })
    // 更新状态为运行中
    this.sessionManager.updateStatus('running')
    this.sendToWebview({ type: 'session_status', status: 'running' })

    // 如果进程已运行（多轮对话），直接发送消息
    if (this.claudeProcess.isRunning) {
      this.claudeProcess.sendMessage({ type: 'user', message: content })
    } else {
      // 否则启动新进程
      const cwd = resolveWorkingDirectory(this.settings)
      try {
        await this.claudeProcess.start(content, this.settings, cwd)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        this.outputChannel.appendLine(`[ChatViewProvider] 启动失败: ${errMsg}`)
        vscode.window.showErrorMessage(`Claude Code 启动失败：${errMsg}`)
        this.sessionManager.updateStatus('error', errMsg)
        this.sendToWebview({ type: 'session_status', status: 'error', error: errMsg })
      }
    }
  }

  // ===== CLI 进程事件绑定 =====

  /**
   * 绑定 CLI 进程事件处理器
   */
  private bindProcessEvents(): void {
    // 处理 stream-json 事件
    this.claudeProcess.on('event', (event: StreamEvent) => {
      this.handleStreamEvent(event)
    })

    // 进程状态变化
    this.claudeProcess.on('statusChange', () => {
      const status = this.claudeProcess.status
      // 将进程状态映射到会话状态
      const sessionStatus = status === 'running' ? 'running'
        : status === 'starting' ? 'connecting'
        : status === 'error' ? 'error'
        : 'idle'
      this.sendToWebview({ type: 'session_status', status: sessionStatus })
    })

    // 进程错误
    this.claudeProcess.on('error', (err: Error) => {
      this.outputChannel.appendLine(`[ChatViewProvider] 进程错误: ${err.message}`)
      this.sessionManager.updateStatus('error', err.message)
      this.sendToWebview({ type: 'session_status', status: 'error', error: err.message })
    })

    // 进程退出
    this.claudeProcess.on('exit', (code: number | null) => {
      this.outputChannel.appendLine(`[ChatViewProvider] 进程退出，code=${code}`)
      if (this.sessionManager.current?.status === 'running') {
        this.sessionManager.updateStatus('idle')
        this.sendToWebview({ type: 'session_status', status: 'idle' })
      }
    })
  }

  /**
   * 处理 CLI stream-json 事件
   */
  private handleStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'system':
        // 系统初始化事件
        if (event.subtype === 'init') {
          this.sessionManager.setCliSessionId(event.session_id)
          this.outputChannel.appendLine(`[ChatViewProvider] CLI 会话 ID: ${event.session_id}`)
        }
        break

      case 'assistant':
        // 助手消息事件 - 处理内容块
        this.handleAssistantEvent(event)
        break

      case 'user':
        // 用户消息（工具结果回传）- 通常不需要显示
        break

      case 'result':
        // 对话完成事件
        this.handleResultEvent(event)
        break

      case 'permission_request':
        // 工具权限请求
        this.handlePermissionRequestEvent(event)
        break
    }
  }

  /**
   * 处理助手消息事件
   */
  private handleAssistantEvent(event: Extract<StreamEvent, { type: 'assistant' }>): void {
    const { message } = event
    const messageId = message.id

    // 从内容块提取文本和工具调用
    let textContent = ''
    const toolCalls: ToolCallInfo[] = []
    let thinkingContent = ''

    for (const block of message.content) {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
          status: 'pending',
        })
      } else if (block.type === 'thinking') {
        thinkingContent = block.thinking
      }
    }

    // 检查是否为已有消息的更新（流式输出）
    const existingMsg = this.sessionManager.current?.messages.find((m) => m.id === messageId)

    if (existingMsg) {
      // 更新已有消息（流式追加）
      const update: Partial<ChatMessage> = {
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : existingMsg.toolCalls,
        streaming: message.stop_reason === null,
        usage: message.usage
          ? {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
              cost_usd: 0,
            }
          : existingMsg.usage,
        thinking: thinkingContent || existingMsg.thinking,
      }
      this.sessionManager.updateMessage(messageId, update)
      this.sendToWebview({ type: 'message_update', messageId, delta: update })
    } else {
      // 新的助手消息
      const assistantMsg: ChatMessage = {
        id: messageId,
        role: 'assistant',
        content: textContent,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        streaming: message.stop_reason === null,
        usage: message.usage
          ? {
              input_tokens: message.usage.input_tokens,
              output_tokens: message.usage.output_tokens,
              cost_usd: 0,
            }
          : undefined,
        thinking: thinkingContent || undefined,
      }
      this.sessionManager.appendMessage(assistantMsg)
      this.sendToWebview({ type: 'message_append', message: assistantMsg })
      this.currentAssistantMessageId = messageId

      // 如果有思考内容，单独发送
      if (thinkingContent && this.settings.showThinking) {
        this.sendToWebview({ type: 'thinking_update', messageId, thinking: thinkingContent })
      }
    }
  }

  /**
   * 处理对话完成事件
   */
  private handleResultEvent(event: Extract<StreamEvent, { type: 'result' }>): void {
    this.outputChannel.appendLine(
      `[ChatViewProvider] 对话完成: ${event.subtype}, turns=${event.num_turns}, cost=$${event.cost_usd}`,
    )

    // 更新 token 用量统计
    if (event.usage && event.cost_usd !== undefined) {
      this.sessionManager.updateUsage(
        event.usage.input_tokens,
        event.usage.output_tokens,
        event.cost_usd,
      )
    }

    // 更新状态
    const isError = event.subtype !== 'success'
    this.sessionManager.updateStatus(isError ? 'error' : 'idle')
    this.sendToWebview({
      type: 'session_status',
      status: isError ? 'error' : 'idle',
      error: isError ? `对话终止：${event.subtype}` : undefined,
    })

    // 重置流式输出状态
    if (this.currentAssistantMessageId) {
      this.sessionManager.updateMessage(this.currentAssistantMessageId, { streaming: false })
      this.sendToWebview({
        type: 'message_update',
        messageId: this.currentAssistantMessageId,
        delta: { streaming: false },
      })
      this.currentAssistantMessageId = null
    }
  }

  /**
   * 处理工具权限请求事件
   */
  private async handlePermissionRequestEvent(
    event: Extract<StreamEvent, { type: 'permission_request' }>,
  ): Promise<void> {
    const request: PermissionRequest = {
      requestId: event.request_id,
      toolName: event.tool_name,
      toolInput: event.tool_input,
      description: event.description,
      timestamp: Date.now(),
    }

    this.outputChannel.appendLine(`[ChatViewProvider] 权限请求: ${event.tool_name}`)

    // 更新会话状态为等待权限
    this.sessionManager.updateStatus('waiting_permission')
    this.sendToWebview({ type: 'session_status', status: 'waiting_permission' })

    // 请求权限审批
    const decision = await this.permissionManager.requestPermission(request)

    // 发送权限响应给 CLI
    this.claudeProcess.sendMessage({
      type: 'permission_response',
      request_id: event.request_id,
      decision,
    })

    // 恢复运行状态
    this.sessionManager.updateStatus('running')
    this.sendToWebview({ type: 'session_status', status: 'running' })
  }

  // ===== 权限事件绑定 =====

  /**
   * 绑定权限管理器事件
   */
  private bindPermissionEvents(): void {
    // 权限请求事件 → 通知 WebView 显示审批 UI
    this.permissionManager.onPermissionRequest((request) => {
      this.sendToWebview({ type: 'permission_request', request })
    })

    // 权限已解决事件 → 通知 WebView 更新 UI
    this.permissionManager.onPermissionResolved(({ requestId, decision }) => {
      this.sendToWebview({ type: 'permission_resolved', requestId, decision })
    })
  }

  // ===== WebView 通信 =====

  /**
   * 向 WebView 发送消息
   */
  private sendToWebview(msg: WebViewMessage): void {
    if (!this.webviewView?.visible) return
    this.webviewView.webview.postMessage(msg)
  }

  /**
   * 同步当前会话状态到 WebView
   */
  private syncSessionToWebview(): void {
    const session = this.sessionManager.current
    if (!session) return
    this.sendToWebview({
      type: 'init',
      session,
      settings: {
        showThinking: this.settings.showThinking,
        provider: this.settings.provider,
        model: this.settings.model,
      },
    })
  }

  /**
   * 发送会话列表到 WebView
   */
  private sendSessionsList(): void {
    const sessions = this.sessionManager.all.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
    this.sendToWebview({ type: 'sessions_list', sessions })
  }

  // ===== HTML 生成 =====

  /**
   * 生成 WebView HTML 内容
   */
  private getWebviewHtml(webview: vscode.Webview): string {
    // 转换本地资源 URI（受 CSP 保护）
    const distPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')

    // 脚本 URI
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, 'main.js'))
    // 样式 URI
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distPath, 'style.css'))

    // 生成随机 nonce（防止 XSS）
    const nonce = this.generateNonce()

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource};
    img-src ${webview.cspSource} data:;
  " />
  <title>Claude Code</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }

  /**
   * 生成随机 nonce 字符串
   */
  private generateNonce(): string {
    let text = ''
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return text
  }

  /** 释放资源 */
  dispose(): void {
    this.disposables.forEach((d) => d.dispose())
  }
}
