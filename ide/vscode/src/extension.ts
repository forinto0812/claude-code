// VSCode 插件入口 - 激活和注销管理
import * as vscode from 'vscode'
import { ChatViewProvider } from './providers/ChatViewProvider'
import { StatusBarProvider } from './providers/StatusBarProvider'
import { SessionManager } from './services/SessionManager'
import { PermissionManager } from './services/PermissionManager'
import { ClaudeCodeProcess } from './services/ClaudeCodeProcess'
import { registerCommands } from './commands'
import { getSettings, onSettingsChange } from './config/settings'

/** 插件输出日志通道 */
let outputChannel: vscode.OutputChannel

/**
 * 插件激活入口
 * 当 VSCode 加载插件时调用
 */
export function activate(context: vscode.ExtensionContext): void {
  // 创建输出日志通道
  outputChannel = vscode.window.createOutputChannel('Claude Code')
  outputChannel.appendLine('[Extension] Claude Code 插件激活中...')

  // 读取初始配置
  const settings = getSettings()

  // ===== 初始化核心服务 =====

  // 会话管理器（持久化会话历史）
  const sessionManager = new SessionManager(context, outputChannel)

  // 工具权限管理器
  const permissionManager = new PermissionManager(settings, outputChannel)

  // CLI 进程管理器
  const claudeProcess = new ClaudeCodeProcess(outputChannel)

  // ===== 初始化 UI 组件 =====

  // 聊天视图提供者（侧边栏 WebView）
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    sessionManager,
    permissionManager,
    claudeProcess,
    outputChannel,
  )

  // 状态栏提供者
  const statusBar = new StatusBarProvider(claudeProcess, sessionManager)

  // ===== 注册视图 =====

  // 注册侧边栏 WebView 视图
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeCode.chatView', chatProvider, {
      // 保持 WebView 上下文（切换面板时不销毁）
      webviewOptions: { retainContextWhenHidden: true },
    }),
  )

  // ===== 注册命令 =====

  registerCommands(context, chatProvider, sessionManager)

  // ===== 监听配置变化 =====

  context.subscriptions.push(
    onSettingsChange((newSettings) => {
      outputChannel.appendLine('[Extension] 配置已更新')
      // 通知权限管理器更新设置
      permissionManager.updateSettings(newSettings)
      // 通知聊天视图更新设置
      chatProvider.onSettingsChange(newSettings)
    }),
  )

  // ===== 注册 Disposables =====

  context.subscriptions.push(
    outputChannel,
    statusBar,
    chatProvider,
    claudeProcess,
    sessionManager,
    permissionManager,
  )

  outputChannel.appendLine('[Extension] Claude Code 插件激活完成 ✓')

  // 显示欢迎提示（仅首次安装）
  const isFirstInstall = !context.globalState.get('claudeCode.installed')
  if (isFirstInstall) {
    context.globalState.update('claudeCode.installed', true)
    vscode.window
      .showInformationMessage(
        'Claude Code 已成功安装！点击侧边栏的 Claude 图标开始对话。',
        '打开设置',
        '开始使用',
      )
      .then((choice) => {
        if (choice === '打开设置') {
          vscode.commands.executeCommand('claudeCode.openSettings')
        } else if (choice === '开始使用') {
          vscode.commands.executeCommand('claudeCode.chatView.focus')
        }
      })
  }
}

/**
 * 插件注销入口
 * 当 VSCode 关闭或禁用插件时调用
 */
export function deactivate(): void {
  outputChannel?.appendLine('[Extension] Claude Code 插件注销')
}
