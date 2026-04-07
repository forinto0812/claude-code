// 会话管理服务 - 持久化和管理聊天会话
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import type { Session, ChatMessage, ProviderType } from '../types'

/** 会话存储文件名 */
const SESSIONS_FILE = 'claude-code-sessions.json'

/** 最大保留会话数量 */
const MAX_SESSIONS = 50

/** 会话存储结构 */
interface SessionsStore {
  version: number
  sessions: Session[]
  currentSessionId: string | null
}

/**
 * 会话管理器
 * 负责创建、切换、持久化聊天会话
 */
export class SessionManager {
  // 当前活跃会话
  private currentSession: Session | null = null
  // 所有会话列表
  private sessions: Session[] = []
  // 存储目录（VSCode 扩展全局存储路径）
  private storePath: string
  // 输出日志
  private outputChannel: vscode.OutputChannel
  // 会话变化事件
  private readonly _onSessionChange = new vscode.EventEmitter<Session | null>()
  readonly onSessionChange = this._onSessionChange.event

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    // 使用 VSCode 的全局存储路径持久化会话
    this.storePath = context.globalStorageUri.fsPath
    this.outputChannel = outputChannel
    // 确保存储目录存在
    this.ensureStorageDir()
    // 从磁盘加载会话
    this.loadSessions()
  }

  // ===== 公开 API =====

  /** 当前活跃会话 */
  get current(): Session | null {
    return this.currentSession
  }

  /** 所有会话列表（按更新时间倒序） */
  get all(): Session[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 创建新会话
   */
  createSession(options: {
    workingDirectory: string
    model?: string
    provider?: ProviderType
  }): Session {
    // 生成唯一会话 ID
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()

    // 构建新会话
    const session: Session = {
      id,
      title: `对话 ${this.sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
      workingDirectory: options.workingDirectory,
      model: options.model,
      provider: options.provider,
      status: 'idle',
      totalUsage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    }

    // 限制最大会话数，超出时删除最旧的
    if (this.sessions.length >= MAX_SESSIONS) {
      const sorted = [...this.sessions].sort((a, b) => a.updatedAt - b.updatedAt)
      // 删除最旧的 10 个会话
      const toRemove = sorted.slice(0, 10).map((s) => s.id)
      this.sessions = this.sessions.filter((s) => !toRemove.includes(s.id))
    }

    // 追加到会话列表
    this.sessions.push(session)
    // 切换为当前会话
    this.currentSession = session
    // 持久化
    this.saveSessions()
    // 广播变化
    this._onSessionChange.fire(session)

    this.outputChannel.appendLine(`[SessionManager] 创建新会话: ${id}`)
    return session
  }

  /**
   * 切换到指定会话
   */
  switchSession(sessionId: string): Session | null {
    // 查找目标会话
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session) {
      this.outputChannel.appendLine(`[SessionManager] 会话不存在: ${sessionId}`)
      return null
    }
    // 切换当前会话
    this.currentSession = session
    this._onSessionChange.fire(session)
    this.outputChannel.appendLine(`[SessionManager] 切换到会话: ${sessionId}`)
    return session
  }

  /**
   * 删除指定会话
   */
  deleteSession(sessionId: string): void {
    // 从列表中移除
    this.sessions = this.sessions.filter((s) => s.id !== sessionId)
    // 如果删除的是当前会话，切换到最新的会话
    if (this.currentSession?.id === sessionId) {
      this.currentSession = this.sessions.length > 0
        ? [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
        : null
      this._onSessionChange.fire(this.currentSession)
    }
    // 持久化
    this.saveSessions()
    this.outputChannel.appendLine(`[SessionManager] 删除会话: ${sessionId}`)
  }

  /**
   * 追加消息到当前会话
   */
  appendMessage(message: ChatMessage): void {
    if (!this.currentSession) return
    // 追加消息
    this.currentSession.messages.push(message)
    // 更新时间戳
    this.currentSession.updatedAt = Date.now()
    // 根据第一条用户消息自动命名会话
    if (this.currentSession.title.startsWith('对话 ') && message.role === 'user') {
      this.currentSession.title = this.generateTitle(message.content)
    }
    // 持久化（防抖保存）
    this.debouncedSave()
  }

  /**
   * 更新消息内容（流式输出增量更新）
   */
  updateMessage(messageId: string, delta: Partial<ChatMessage>): void {
    if (!this.currentSession) return
    // 找到目标消息
    const msg = this.currentSession.messages.find((m) => m.id === messageId)
    if (!msg) return
    // 合并更新
    Object.assign(msg, delta)
    // 更新会话时间戳
    this.currentSession.updatedAt = Date.now()
    // 防抖保存
    this.debouncedSave()
  }

  /**
   * 更新会话的 CLI session ID（从 init 事件获取）
   */
  setCliSessionId(cliSessionId: string): void {
    if (!this.currentSession) return
    this.currentSession.cliSessionId = cliSessionId
  }

  /**
   * 更新会话 token 用量统计
   */
  updateUsage(inputTokens: number, outputTokens: number, costUsd: number): void {
    if (!this.currentSession?.totalUsage) return
    // 累加 token 用量
    this.currentSession.totalUsage.input_tokens += inputTokens
    this.currentSession.totalUsage.output_tokens += outputTokens
    this.currentSession.totalUsage.cost_usd += costUsd
    this.debouncedSave()
  }

  /**
   * 更新会话状态
   */
  updateStatus(status: Session['status'], error?: string): void {
    if (!this.currentSession) return
    this.currentSession.status = status
    if (error !== undefined) {
      // 如果有错误，追加一条系统错误消息
      const errMsg: ChatMessage = {
        id: `err_${Date.now()}`,
        role: 'system',
        content: `错误：${error}`,
        timestamp: Date.now(),
      }
      this.currentSession.messages.push(errMsg)
    }
    this.debouncedSave()
  }

  // ===== 私有方法 =====

  /** 确保存储目录存在 */
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true })
    }
  }

  /** 会话文件路径 */
  private get sessionsFilePath(): string {
    return path.join(this.storePath, SESSIONS_FILE)
  }

  /** 从磁盘加载会话 */
  private loadSessions(): void {
    try {
      if (!fs.existsSync(this.sessionsFilePath)) {
        this.outputChannel.appendLine('[SessionManager] 无历史会话文件，初始化为空')
        return
      }
      const raw = fs.readFileSync(this.sessionsFilePath, 'utf-8')
      const store: SessionsStore = JSON.parse(raw)
      this.sessions = store.sessions || []
      // 恢复当前会话
      if (store.currentSessionId) {
        this.currentSession = this.sessions.find((s) => s.id === store.currentSessionId) ?? null
      }
      this.outputChannel.appendLine(`[SessionManager] 加载 ${this.sessions.length} 个历史会话`)
    } catch (err) {
      this.outputChannel.appendLine(`[SessionManager] 加载会话失败: ${err}`)
      this.sessions = []
    }
  }

  /** 保存会话到磁盘 */
  private saveSessions(): void {
    try {
      const store: SessionsStore = {
        version: 1,
        sessions: this.sessions,
        currentSessionId: this.currentSession?.id ?? null,
      }
      fs.writeFileSync(this.sessionsFilePath, JSON.stringify(store, null, 2), 'utf-8')
    } catch (err) {
      this.outputChannel.appendLine(`[SessionManager] 保存会话失败: ${err}`)
    }
  }

  /** 防抖保存（避免高频写磁盘） */
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private debouncedSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveSessions()
      this.saveTimer = null
    }, 1000)
  }

  /**
   * 根据用户消息内容自动生成会话标题
   * 截取前 30 个字符
   */
  private generateTitle(content: string): string {
    const clean = content.replace(/\n/g, ' ').trim()
    return clean.length > 30 ? clean.slice(0, 30) + '…' : clean
  }

  /** 释放资源 */
  dispose(): void {
    // 立即保存待保存的会话
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveSessions()
    }
    this._onSessionChange.dispose()
  }
}
