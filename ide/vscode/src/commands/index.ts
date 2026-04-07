// 命令注册模块 - 注册所有 VSCode 命令
import * as vscode from 'vscode'
import type { ChatViewProvider } from '../providers/ChatViewProvider'
import type { SessionManager } from '../services/SessionManager'

/**
 * 注册插件所有命令
 * @param context 插件上下文
 * @param chatProvider 聊天视图提供者
 * @param sessionManager 会话管理器
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  chatProvider: ChatViewProvider,
  sessionManager: SessionManager,
): void {
  // 新建对话
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.newChat', () => {
      // 新建会话并聚焦到聊天面板
      chatProvider.newChat()
      // 聚焦到 Claude Code 侧边栏
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )

  // 清除当前对话
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.clearChat', () => {
      // 确认后清除当前会话消息
      vscode.window
        .showWarningMessage('确认清除当前对话的所有消息？', '确认', '取消')
        .then((choice) => {
          if (choice === '确认') {
            chatProvider.clearChat()
          }
        })
    }),
  )

  // 发送选中代码
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.sendSelection', () => {
      // 获取当前编辑器的选中文本
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showWarningMessage('没有活跃的编辑器')
        return
      }
      const selection = editor.selection
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('没有选中任何代码')
        return
      }
      // 获取选中内容和文件信息
      const selectedText = editor.document.getText(selection)
      const fileName = editor.document.fileName
      const languageId = editor.document.languageId
      // 构建带上下文的消息
      const message = `请分析以下 ${languageId} 代码（文件：${fileName}）：\n\`\`\`${languageId}\n${selectedText}\n\`\`\``
      // 发送到聊天
      chatProvider.sendMessage(message)
      // 聚焦到聊天面板
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )

  // 解释选中代码
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.explainSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor?.selection || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('没有选中任何代码')
        return
      }
      const selectedText = editor.document.getText(editor.selection)
      const languageId = editor.document.languageId
      // 构建解释请求
      const message = `请详细解释以下 ${languageId} 代码的功能和逻辑：\n\`\`\`${languageId}\n${selectedText}\n\`\`\``
      chatProvider.sendMessage(message)
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )

  // 重构选中代码
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.refactorSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor?.selection || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('没有选中任何代码')
        return
      }
      const selectedText = editor.document.getText(editor.selection)
      const languageId = editor.document.languageId
      const fileName = editor.document.fileName
      // 构建重构请求
      const message = `请重构以下 ${languageId} 代码，提高可读性、性能和可维护性（文件：${fileName}）：\n\`\`\`${languageId}\n${selectedText}\n\`\`\``
      chatProvider.sendMessage(message)
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )

  // 修复选中代码问题
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.fixSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor?.selection || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('没有选中任何代码')
        return
      }
      const selectedText = editor.document.getText(editor.selection)
      const languageId = editor.document.languageId
      // 获取诊断错误
      const diagnostics = vscode.languages
        .getDiagnostics(editor.document.uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .slice(0, 5)
        .map((d) => `${d.message} (第 ${d.range.start.line + 1} 行)`)
        .join('\n')
      // 构建修复请求
      const errInfo = diagnostics ? `\n\n已知错误：\n${diagnostics}` : ''
      const message = `请修复以下 ${languageId} 代码中的问题：${errInfo}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``
      chatProvider.sendMessage(message)
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )

  // 打开设置
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.openSettings', () => {
      // 打开 VSCode 设置页面并过滤到 Claude Code 配置
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCode')
    }),
  )

  // 停止生成
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.stopGeneration', () => {
      chatProvider.stopGeneration()
    }),
  )

  // 查看会话历史
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.showSessionHistory', async () => {
      // 获取所有会话列表
      const sessions = sessionManager.all
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('没有历史对话')
        return
      }
      // 使用 QuickPick 显示会话列表
      const items = sessions.map((s) => ({
        label: s.title,
        description: new Date(s.updatedAt).toLocaleString('zh-CN'),
        detail: `${s.messages.length} 条消息 | ${s.workingDirectory}`,
        sessionId: s.id,
      }))
      const selected = await vscode.window.showQuickPick(items, {
        title: '选择历史对话',
        placeHolder: '搜索对话...',
      })
      if (selected) {
        // 切换到选中的会话
        chatProvider.loadSession(selected.sessionId)
        vscode.commands.executeCommand('claudeCode.chatView.focus')
      }
    }),
  )

  // 切换面板
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCode.togglePanel', () => {
      vscode.commands.executeCommand('claudeCode.chatView.focus')
    }),
  )
}
