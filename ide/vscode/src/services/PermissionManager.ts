// 工具权限管理服务
// 负责工具调用的权限审批：自动批准、VSCode 弹窗询问、WebView 内嵌审批
import * as vscode from 'vscode'
import type { PermissionRequest, ExtensionSettings } from '../types'

/** 权限决策结果 */
export type PermissionDecision = 'allow' | 'deny'

/** 等待决策的请求 */
interface PendingRequest {
  request: PermissionRequest
  resolve: (decision: PermissionDecision) => void
}

/**
 * 权限管理器
 * 对工具调用的权限进行三级处理：
 * 1. bypassPermissions 模式 → 全部自动允许
 * 2. autoApproveTools 列表中的工具 → 自动允许
 * 3. 其他工具 → 通过 VSCode 弹窗或 WebView 询问用户
 */
export class PermissionManager {
  // 当前等待决策的权限请求（requestId -> PendingRequest）
  private pendingRequests = new Map<string, PendingRequest>()
  // 会话级别的"记住"决策（toolName -> decision）
  private sessionMemory = new Map<string, PermissionDecision>()
  // 权限请求事件（通知 WebView 显示审批 UI）
  private readonly _onPermissionRequest = new vscode.EventEmitter<PermissionRequest>()
  readonly onPermissionRequest = this._onPermissionRequest.event
  // 权限已解决事件（通知 WebView 更新 UI）
  private readonly _onPermissionResolved = new vscode.EventEmitter<{
    requestId: string
    decision: PermissionDecision
  }>()
  readonly onPermissionResolved = this._onPermissionResolved.event

  // 当前设置
  private settings: ExtensionSettings
  // 输出日志
  private outputChannel: vscode.OutputChannel

  constructor(settings: ExtensionSettings, outputChannel: vscode.OutputChannel) {
    this.settings = settings
    this.outputChannel = outputChannel
  }

  /**
   * 更新设置（当用户更改配置时调用）
   */
  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings
  }

  /**
   * 请求权限审批
   * 返回用户的决策：'allow' 或 'deny'
   */
  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const { toolName, toolInput, requestId } = request

    this.outputChannel.appendLine(`[PermissionManager] 权限请求: ${toolName} (${requestId})`)

    // 1. bypassPermissions 模式：全部允许
    if (this.settings.permissionMode === 'bypassPermissions') {
      this.outputChannel.appendLine(`[PermissionManager] bypassPermissions → 允许 ${toolName}`)
      return 'allow'
    }

    // 2. 检查会话记忆（之前选择过"记住决策"）
    const remembered = this.sessionMemory.get(toolName)
    if (remembered) {
      this.outputChannel.appendLine(`[PermissionManager] 会话记忆 → ${remembered} ${toolName}`)
      return remembered
    }

    // 3. 检查 autoApproveTools 列表
    if (this.isAutoApproved(toolName)) {
      this.outputChannel.appendLine(`[PermissionManager] 自动批准 → ${toolName}`)
      return 'allow'
    }

    // 4. acceptEdits 模式：只允许文件编辑类工具，其他询问
    if (this.settings.permissionMode === 'acceptEdits' && this.isEditTool(toolName)) {
      this.outputChannel.appendLine(`[PermissionManager] acceptEdits → 允许 ${toolName}`)
      return 'allow'
    }

    // 5. 发送到 WebView 内嵌审批（先通知 WebView 显示审批 UI）
    this._onPermissionRequest.fire(request)

    // 返回 Promise，等待用户在 WebView 中决策
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingRequests.set(requestId, { request, resolve })
      this.outputChannel.appendLine(`[PermissionManager] 等待用户决策: ${toolName} (${requestId})`)

      // 如果 WebView 不可用，回退到 VSCode 弹窗
      this.showVSCodePermissionDialog(request).then((decision) => {
        // 只有还未决策时才使用弹窗结果
        if (this.pendingRequests.has(requestId)) {
          this.resolvePending(requestId, decision, false)
        }
      })
    })
  }

  /**
   * 由 WebView 调用 - 用户在内嵌 UI 中做出决策
   */
  resolveFromWebView(requestId: string, decision: PermissionDecision, remember: boolean): void {
    this.resolvePending(requestId, decision, remember)
  }

  /**
   * 清除会话级别的记忆（新对话时调用）
   */
  clearSessionMemory(): void {
    this.sessionMemory.clear()
    this.outputChannel.appendLine('[PermissionManager] 清除会话记忆')
  }

  /**
   * 取消所有待决策的请求（停止生成时调用）
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.outputChannel.appendLine(`[PermissionManager] 取消请求: ${requestId}`)
      pending.resolve('deny')
    }
    this.pendingRequests.clear()
  }

  // ===== 私有方法 =====

  /**
   * 解析等待中的权限请求
   */
  private resolvePending(requestId: string, decision: PermissionDecision, remember: boolean): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return

    this.outputChannel.appendLine(
      `[PermissionManager] 决策: ${pending.request.toolName} → ${decision}${remember ? ' (记住)' : ''}`,
    )

    // 如果选择记住，写入会话记忆
    if (remember) {
      this.sessionMemory.set(pending.request.toolName, decision)
    }

    // 移除等待列表
    this.pendingRequests.delete(requestId)
    // 广播已解决事件（通知 WebView 更新 UI）
    this._onPermissionResolved.fire({ requestId, decision })
    // 解析 Promise
    pending.resolve(decision)
  }

  /**
   * 检查工具是否在自动批准列表中
   */
  private isAutoApproved(toolName: string): boolean {
    return this.settings.autoApproveTools.some(
      (name) => name.toLowerCase() === toolName.toLowerCase(),
    )
  }

  /**
   * 判断是否为文件编辑类工具（acceptEdits 模式使用）
   */
  private isEditTool(toolName: string): boolean {
    const editTools = ['Write', 'Edit', 'FileWrite', 'FileEdit', 'NotebookEdit']
    return editTools.some((t) => t.toLowerCase() === toolName.toLowerCase())
  }

  /**
   * 显示 VSCode 信息弹窗进行权限审批（WebView 不可用时的回退）
   */
  private async showVSCodePermissionDialog(request: PermissionRequest): Promise<PermissionDecision> {
    const { toolName, toolInput } = request

    // 构建工具调用摘要
    const summary = this.formatToolSummary(toolName, toolInput)

    // 显示信息弹窗，提供 允许/拒绝 按钮
    const choice = await vscode.window.showInformationMessage(
      `Claude 想要使用工具 **${toolName}**\n${summary}`,
      { modal: true },
      '允许',
      '拒绝',
    )

    return choice === '允许' ? 'allow' : 'deny'
  }

  /**
   * 格式化工具调用摘要（用于弹窗显示）
   */
  private formatToolSummary(toolName: string, input: Record<string, unknown>): string {
    // 针对常见工具提供友好的摘要格式
    switch (toolName) {
      case 'Bash':
        return `命令：${String(input.command ?? '').slice(0, 100)}`
      case 'Write':
      case 'FileWrite':
        return `文件：${String(input.file_path ?? input.path ?? '')}`
      case 'Edit':
      case 'FileEdit':
        return `文件：${String(input.file_path ?? input.path ?? '')}`
      case 'WebFetch':
        return `URL：${String(input.url ?? '').slice(0, 80)}`
      default: {
        // 通用格式：显示前几个参数
        const parts = Object.entries(input)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
          .join(', ')
        return parts || '（无参数）'
      }
    }
  }

  /** 释放资源 */
  dispose(): void {
    // 取消所有待决策请求
    this.cancelAll()
    this._onPermissionRequest.dispose()
    this._onPermissionResolved.dispose()
  }
}
