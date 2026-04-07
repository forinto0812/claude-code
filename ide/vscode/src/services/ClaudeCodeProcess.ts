// Claude Code CLI 进程管理服务
// 负责启动、通信和生命周期管理 Claude Code CLI 子进程
import * as vscode from 'vscode'
import * as cp from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { EventEmitter } from 'events'
import type {
  StreamEvent,
  InputMessage,
  ExtensionSettings,
} from '../types'
import { buildEnvVars } from '../config/settings'

/** 进程状态 */
export type ProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/** ClaudeCodeProcess 事件接口 */
export interface ClaudeCodeProcessEvents {
  // 收到 stream-json 事件
  event: (event: StreamEvent) => void
  // 进程状态变化
  statusChange: (status: ProcessStatus) => void
  // 进程错误
  error: (error: Error) => void
  // 进程退出
  exit: (code: number | null) => void
}

/**
 * Claude Code CLI 进程管理器
 * 通过 --input-format stream-json --output-format stream-json 与 CLI 双向通信
 */
export class ClaudeCodeProcess extends EventEmitter {
  // 当前子进程实例
  private process: cp.ChildProcess | null = null
  // 进程状态
  private _status: ProcessStatus = 'idle'
  // stdout 缓冲区（处理不完整的 JSON 行）
  private stdoutBuffer = ''
  // 输出日志通道
  private outputChannel: vscode.OutputChannel

  constructor(outputChannel: vscode.OutputChannel) {
    super()
    // 初始化输出日志通道
    this.outputChannel = outputChannel
  }

  /** 当前进程状态 */
  get status(): ProcessStatus {
    return this._status
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this._status === 'running' || this._status === 'starting'
  }

  /**
   * 启动 Claude Code CLI 进程
   * @param prompt 初始提示词
   * @param settings 插件配置
   * @param cwd 工作目录
   */
  async start(prompt: string, settings: ExtensionSettings, cwd: string): Promise<void> {
    // 如果已有进程在运行，先停止
    if (this.isRunning) {
      await this.stop()
    }

    // 解析 CLI 可执行文件和参数
    const { cmd, args, env } = await this.buildLaunchConfig(settings, cwd)

    this.outputChannel.appendLine(`[ClaudeCodeProcess] 启动: ${cmd} ${args.join(' ')}`)
    this.outputChannel.appendLine(`[ClaudeCodeProcess] 工作目录: ${cwd}`)

    // 更新状态为启动中
    this.setStatus('starting')

    // 启动子进程
    this.process = cp.spawn(cmd, args, {
      cwd,
      env,
      // 通过 pipe 进行 stdin/stdout 通信
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 监听 stdout 数据（JSON 行协议）
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString())
    })

    // 监听 stderr 数据（调试日志）
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      this.outputChannel.appendLine(`[CLI stderr] ${text}`)
    })

    // 监听进程错误
    this.process.on('error', (err) => {
      this.outputChannel.appendLine(`[ClaudeCodeProcess] 进程错误: ${err.message}`)
      this.setStatus('error')
      this.emit('error', err)
    })

    // 监听进程退出
    this.process.on('exit', (code) => {
      this.outputChannel.appendLine(`[ClaudeCodeProcess] 进程退出，code=${code}`)
      this.process = null
      this.setStatus('stopped')
      this.emit('exit', code)
    })

    // 更新状态为运行中
    this.setStatus('running')

    // 发送初始提示词
    this.sendMessage({ type: 'user', message: prompt })
  }

  /**
   * 发送消息到 CLI 进程（通过 stdin）
   * @param msg stream-json 输入消息
   */
  sendMessage(msg: InputMessage): void {
    // 检查进程是否在运行
    if (!this.process?.stdin || !this.isRunning) {
      this.outputChannel.appendLine('[ClaudeCodeProcess] 无法发送消息：进程未运行')
      return
    }
    // 序列化为 JSON 行协议
    const line = JSON.stringify(msg) + '\n'
    this.outputChannel.appendLine(`[ClaudeCodeProcess] → ${line.trim()}`)
    // 写入 stdin
    this.process.stdin.write(line)
  }

  /**
   * 停止 CLI 进程
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return
    }
    // 更新状态为停止中
    this.setStatus('stopping')
    this.outputChannel.appendLine('[ClaudeCodeProcess] 正在停止进程...')

    // 关闭 stdin 触发优雅退出
    this.process.stdin?.end()

    // 等待进程退出（最多 3 秒）
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // 超时则强制杀死进程
        this.process?.kill('SIGKILL')
        resolve()
      }, 3000)

      this.process?.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.process = null
    this.setStatus('stopped')
  }

  /**
   * 处理 stdout 数据块
   * 支持跨 chunk 的不完整 JSON 行
   */
  private handleStdoutChunk(chunk: string): void {
    // 追加到缓冲区
    this.stdoutBuffer += chunk

    // 按行分割处理完整的 JSON 行
    const lines = this.stdoutBuffer.split('\n')
    // 最后一个可能是不完整的行，保留在缓冲区
    this.stdoutBuffer = lines.pop() ?? ''

    for (const line of lines) {
      // 跳过空行
      const trimmed = line.trim()
      if (!trimmed) continue

      this.outputChannel.appendLine(`[ClaudeCodeProcess] ← ${trimmed}`)

      // 解析 JSON
      try {
        const event = JSON.parse(trimmed) as StreamEvent
        this.emit('event', event)
      } catch {
        // 非 JSON 行（如普通文本输出）记录到日志
        this.outputChannel.appendLine(`[ClaudeCodeProcess] 非 JSON 输出: ${trimmed}`)
      }
    }
  }

  /**
   * 构建 CLI 启动配置
   * 自动检测运行时（node/bun）和 CLI 路径
   */
  private async buildLaunchConfig(
    settings: ExtensionSettings,
    cwd: string,
  ): Promise<{ cmd: string; args: string[]; env: Record<string, string> }> {
    // 解析 CLI 路径
    const cliPath = await this.resolveCLIPath(settings, cwd)
    this.outputChannel.appendLine(`[ClaudeCodeProcess] CLI 路径: ${cliPath}`)

    // 解析运行时
    const runtime = await this.resolveRuntime(settings, cliPath)
    this.outputChannel.appendLine(`[ClaudeCodeProcess] 运行时: ${runtime}`)

    // 构建启动参数
    // 使用 -p 管道模式 + stream-json 双向协议
    const args = [
      cliPath,
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--max-turns', String(settings.maxTurns),
    ]

    // 添加权限模式参数
    if (settings.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions')
    } else if (settings.permissionMode === 'acceptEdits') {
      args.push('--permission-mode', 'acceptEdits')
    }

    // 添加自定义系统提示
    if (settings.systemPrompt) {
      args.push('--append-system-prompt', settings.systemPrompt)
    }

    // 构建环境变量
    const env = buildEnvVars(settings)

    return { cmd: runtime, args, env }
  }

  /**
   * 解析 CLI 路径
   * 优先级：用户配置 -> 项目 dist/cli.js -> 全局 claude 命令
   */
  private async resolveCLIPath(settings: ExtensionSettings, cwd: string): Promise<string> {
    // 用户配置的路径
    if (settings.cliPath && fs.existsSync(settings.cliPath)) {
      return settings.cliPath
    }

    // 查找项目 dist/cli.js（向上查找）
    const distCli = this.findDistCLI(cwd)
    if (distCli) {
      return distCli
    }

    // 全局 claude 命令
    const globalClaude = await this.findGlobalCommand('claude')
    if (globalClaude) {
      return globalClaude
    }

    throw new Error(
      '无法找到 Claude Code CLI。请在设置中配置 claudeCode.cliPath，或先构建项目（bun run build）。',
    )
  }

  /**
   * 向上查找 dist/cli.js
   */
  private findDistCLI(startDir: string): string | null {
    let dir = startDir
    // 最多向上查找 5 层
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'dist', 'cli.js')
      if (fs.existsSync(candidate)) {
        return candidate
      }
      const parent = path.dirname(dir)
      // 到达根目录则停止
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  /**
   * 查找全局命令路径
   */
  private findGlobalCommand(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      cp.exec(`${cmd} ${name}`, (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
        } else {
          resolve(stdout.trim().split('\n')[0])
        }
      })
    })
  }

  /**
   * 解析运行时命令
   * 优先级：用户配置 -> 检测 bun -> 使用 node
   */
  private async resolveRuntime(settings: ExtensionSettings, cliPath: string): Promise<string> {
    // 如果是全局 claude 命令（不是 .js 文件），直接运行
    if (!cliPath.endsWith('.js')) {
      return cliPath
    }

    // 用户显式配置
    if (settings.runtime === 'bun') {
      return 'bun'
    }
    if (settings.runtime === 'node') {
      return 'node'
    }

    // 自动检测：优先 bun
    const bunPath = await this.findGlobalCommand('bun')
    if (bunPath) {
      return bunPath
    }

    // 回退到 node
    return 'node'
  }

  /**
   * 更新并广播进程状态
   */
  private setStatus(status: ProcessStatus): void {
    // 状态相同时不重复广播
    if (this._status === status) return
    this._status = status
    this.emit('statusChange', status)
  }

  /** 释放资源 */
  dispose(): void {
    // 停止进程
    if (this.isRunning) {
      this.stop()
    }
    // 清理事件监听
    this.removeAllListeners()
  }
}
