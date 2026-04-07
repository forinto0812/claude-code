// 插件配置管理 - 读取/写入 VSCode 设置
import * as vscode from 'vscode'
import type { ExtensionSettings, ProviderType, PermissionMode } from '../types'

// 配置节名称
const CONFIG_SECTION = 'claudeCode'

/**
 * 读取完整插件配置
 */
export function getSettings(): ExtensionSettings {
  // 从 VSCode 配置读取所有设置项
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
  return {
    // CLI 路径
    cliPath: cfg.get<string>('cliPath', ''),
    // 运行时选择
    runtime: cfg.get<'auto' | 'node' | 'bun'>('runtime', 'auto'),
    // Provider 配置
    provider: cfg.get<ProviderType>('provider', 'anthropic'),
    model: cfg.get<string>('model', ''),
    apiKey: cfg.get<string>('apiKey', ''),
    openaiBaseUrl: cfg.get<string>('openaiBaseUrl', ''),
    // 权限配置
    permissionMode: cfg.get<PermissionMode>('permissionMode', 'default'),
    autoApproveTools: cfg.get<string[]>('autoApproveTools', ['Read', 'Glob', 'Grep']),
    // 对话配置
    workingDirectory: cfg.get<string>('workingDirectory', ''),
    maxTurns: cfg.get<number>('maxTurns', 20),
    enableStreaming: cfg.get<boolean>('enableStreaming', true),
    showThinking: cfg.get<boolean>('showThinking', false),
    systemPrompt: cfg.get<string>('systemPrompt', ''),
  }
}

/**
 * 更新单项配置
 */
export async function updateSetting<K extends keyof ExtensionSettings>(
  key: K,
  value: ExtensionSettings[K],
  global = true,
): Promise<void> {
  // 写入 VSCode 设置（全局或工作区）
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION)
  await cfg.update(key, value, global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace)
}

/**
 * 获取工作目录：优先用户设置 -> 当前工作区根 -> 当前文件目录 -> 用户目录
 */
export function resolveWorkingDirectory(settings: ExtensionSettings): string {
  // 优先使用用户配置的工作目录
  if (settings.workingDirectory) {
    return settings.workingDirectory
  }
  // 使用工作区根目录
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (workspaceFolders && workspaceFolders.length > 0) {
    return workspaceFolders[0].uri.fsPath
  }
  // 使用当前活跃文件所在目录
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath
  if (activeFile) {
    const path = require('path')
    return path.dirname(activeFile)
  }
  // 最后回退到用户目录
  return process.env.HOME || process.env.USERPROFILE || '.'
}

/**
 * 构建 CLI 启动所需的环境变量
 * 根据 provider 配置对应的 env vars
 */
export function buildEnvVars(settings: ExtensionSettings): Record<string, string> {
  // 继承当前进程环境变量
  const env: Record<string, string> = { ...process.env } as Record<string, string>

  // 根据 provider 设置对应环境变量
  switch (settings.provider) {
    case 'anthropic':
      // Anthropic 直接 API
      if (settings.apiKey) {
        env['ANTHROPIC_API_KEY'] = settings.apiKey
      }
      if (settings.model) {
        env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = settings.model
      }
      break

    case 'openai':
      // OpenAI 兼容协议
      env['CLAUDE_CODE_USE_OPENAI'] = '1'
      if (settings.apiKey) {
        env['OPENAI_API_KEY'] = settings.apiKey
      }
      if (settings.openaiBaseUrl) {
        env['OPENAI_BASE_URL'] = settings.openaiBaseUrl
      }
      if (settings.model) {
        env['OPENAI_MODEL'] = settings.model
      }
      break

    case 'gemini':
      // Google Gemini
      env['CLAUDE_CODE_USE_GEMINI'] = '1'
      if (settings.apiKey) {
        env['GEMINI_API_KEY'] = settings.apiKey
      }
      if (settings.model) {
        env['GEMINI_MODEL'] = settings.model
      }
      break

    case 'bedrock':
      // AWS Bedrock
      env['CLAUDE_CODE_USE_BEDROCK'] = '1'
      if (settings.model) {
        env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = settings.model
      }
      break

    case 'vertex':
      // Google Vertex AI
      env['CLAUDE_CODE_USE_VERTEX'] = '1'
      if (settings.model) {
        env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = settings.model
      }
      break

    case 'grok':
      // Grok (xAI)
      env['CLAUDE_CODE_USE_GROK'] = '1'
      if (settings.apiKey) {
        env['GROK_API_KEY'] = settings.apiKey
      }
      if (settings.model) {
        env['GROK_MODEL'] = settings.model
      }
      break
  }

  // 禁用 telemetry 和交互式 UI（VSCode 插件模式）
  env['CLAUDE_CODE_TELEMETRY'] = '0'
  env['NO_COLOR'] = '1'
  env['TERM'] = 'dumb'

  return env
}

/**
 * 监听配置变化
 */
export function onSettingsChange(callback: (settings: ExtensionSettings) => void): vscode.Disposable {
  // 当配置更改时触发回调
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(CONFIG_SECTION)) {
      callback(getSettings())
    }
  })
}
