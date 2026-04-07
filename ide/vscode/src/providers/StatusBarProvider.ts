// 状态栏提供者 - 显示当前会话状态和模型信息
import * as vscode from 'vscode'
import type { ClaudeCodeProcess } from '../services/ClaudeCodeProcess'
import type { SessionManager } from '../services/SessionManager'

/**
 * 状态栏管理器
 * 在 VSCode 底部状态栏显示 Claude Code 状态
 */
export class StatusBarProvider implements vscode.Disposable {
  // 主状态栏项（显示运行状态）
  private statusItem: vscode.StatusBarItem
  // token 用量状态栏项
  private tokenItem: vscode.StatusBarItem
  // 事件订阅列表
  private disposables: vscode.Disposable[] = []

  constructor(
    private claudeProcess: ClaudeCodeProcess,
    private sessionManager: SessionManager,
  ) {
    // 创建状态栏项（右侧对齐，优先级 100）
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    )
    // 点击时聚焦到聊天面板
    this.statusItem.command = 'claudeCode.togglePanel'
    // 创建 token 用量状态栏项
    this.tokenItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    )
    // 初始化显示
    this.updateStatusBar()
    // 显示状态栏
    this.statusItem.show()

    // 监听进程状态变化
    this.disposables.push(
      claudeProcess.on
        ? { dispose: () => {} }
        : { dispose: () => {} },
    )
    // 用 EventEmitter on 监听状态变化
    claudeProcess.on('statusChange', () => this.updateStatusBar())
    // 监听会话变化
    sessionManager.onSessionChange(() => this.updateStatusBar())
  }

  /**
   * 更新状态栏显示
   */
  private updateStatusBar(): void {
    const status = this.claudeProcess.status
    const session = this.sessionManager.current

    // 根据进程状态设置图标和文字
    switch (status) {
      case 'idle':
      case 'stopped':
        // 空闲状态：显示 Claude 图标
        this.statusItem.text = '$(hubot) Claude Code'
        this.statusItem.tooltip = '点击打开 Claude Code 对话'
        this.statusItem.backgroundColor = undefined
        break

      case 'starting':
        // 启动中：显示旋转动画
        this.statusItem.text = '$(sync~spin) Claude Code 启动中...'
        this.statusItem.tooltip = 'Claude Code 正在启动'
        break

      case 'running':
        // 运行中：显示绿色指示
        this.statusItem.text = '$(loading~spin) Claude Code 思考中...'
        this.statusItem.tooltip = '点击停止生成'
        this.statusItem.command = 'claudeCode.stopGeneration'
        break

      case 'stopping':
        // 停止中
        this.statusItem.text = '$(debug-stop) Claude Code 停止中...'
        this.statusItem.tooltip = '正在停止 Claude Code'
        break

      case 'error':
        // 错误状态：显示红色
        this.statusItem.text = '$(error) Claude Code 错误'
        this.statusItem.tooltip = '点击查看日志'
        this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        this.statusItem.command = 'claudeCode.togglePanel'
        break
    }

    // 更新 token 用量显示
    if (session?.totalUsage && (session.totalUsage.input_tokens > 0 || session.totalUsage.output_tokens > 0)) {
      const totalTokens = session.totalUsage.input_tokens + session.totalUsage.output_tokens
      const costStr = session.totalUsage.cost_usd > 0
        ? ` | $${session.totalUsage.cost_usd.toFixed(4)}`
        : ''
      this.tokenItem.text = `$(symbol-variable) ${this.formatTokens(totalTokens)}${costStr}`
      this.tokenItem.tooltip = `Token 用量：输入 ${session.totalUsage.input_tokens} | 输出 ${session.totalUsage.output_tokens}`
      this.tokenItem.show()
    } else {
      this.tokenItem.hide()
    }
  }

  /**
   * 格式化 token 数量（千/百万单位）
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K tokens`
    return `${tokens} tokens`
  }

  /** 释放资源 */
  dispose(): void {
    this.statusItem.dispose()
    this.tokenItem.dispose()
    this.disposables.forEach((d) => d.dispose())
  }
}
