/**
 * 码道 API 类型与同源 fetch 封装。
 *
 * 认证：dsh webServer 同源 cookie（浏览器自动携带），无需显式 token。
 * 纪律：任何失败显式抛错（网络/非 JSON/HTTP 非 2xx/业务 ok!==true 四类全覆盖），
 *       由 UI 层渲染为显式错误条——禁止静默吞错（商业质量门禁）。
 */

/** 统一 API 错误：携带路径与 HTTP 状态，message 面向用户中文可读。 */
export class ApiError extends Error {
  readonly path: string
  readonly status: number

  constructor(path: string, status: number, message: string) {
    super(`码道 API ${path} 失败 (HTTP ${status}): ${message}`)
    this.name = 'ApiError'
    this.path = path
    this.status = status
  }
}

/** 后端统一信封 {ok:true,...} / {ok:false,error:{code,message}}。 */
interface Envelope {
  ok?: unknown
  error?: { code?: unknown; message?: unknown }
}

/** 单次请求：JSON in/out + 全量显式报错。 */
async function requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (cause) {
    throw new Error(`码道 API ${path} 网络请求失败: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const text = await res.text().catch(() => '')
  let parsed: unknown = undefined
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`码道 API ${path} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
  }
  const envelope = (parsed ?? null) as Envelope | null
  if (!res.ok || envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
    const msg =
      envelope !== null && typeof envelope === 'object' && typeof envelope.error?.message === 'string'
        ? envelope.error.message
        : `HTTP ${res.status}${text.length === 0 ? '（空响应体）' : ''}`
    throw new ApiError(path, res.status, msg)
  }
  return parsed as T
}

// ------------------------------------------------------------ 类型（host routes.js 实证口径）

/** TUI 托管进程（GET /codearts/status → processes.tui[]）。 */
export interface TuiProc {
  pid: number
  mode: 'tui'
  command: string
  startedAt: string
  alive: boolean
  rssBytes: number | null
  procState: string | null
  exitedAt?: string
}

/** 目标统计计数器（goal-supervisor stats）。 */
export interface GoalStats {
  injections: number
  stagnationEvents: number
  errors: number
  consecutiveErrors: number
  acceptanceRuns: number
  acceptancePassStreak: number
  restarts: number
}

/** 会话五态探测（running/stuck/errored/dead/idle）。 */
export interface GoalSessionState {
  state: string
  lastActivity: string | null
  lastError: string | null
  errorKind: string | null
}

/** 目标快照（GET /codearts/status → goals[] / GET /codearts/goals）。 */
export interface GoalSnapshot {
  goalId: string
  objective: string
  acceptanceCmd: string
  state: string
  mode: 'tui' | 'structured'
  tuiPid?: number
  sessionId?: string
  transportAlive: boolean
  pausedReason?: string
  alarm?: unknown
  createdAt: number
  updatedAt: number
  stats: GoalStats
  lastError?: string | null
  session: GoalSessionState
  /** 停滞注入冷却截止（epoch ms；冷却只是拉长间隔，到期照常注入——永不挂起）。 */
  cooldownUntil?: number
}

/** GET /codearts/status 响应。 */
export interface StatusResponse {
  ok: true
  processes: { tui: TuiProc[]; runOnceActive?: number }
  goals: GoalSnapshot[]
  audit: unknown
}

/** 模型条目（recent/builtin/custom 通用）。 */
export interface ModelEntry {
  providerID: string
  modelID: string
  id: string
}

/** 当前模型（getCurrentModel：recent[0] 或全局配置 model 键）。 */
export interface CurrentModel {
  id: string
  providerID: string
  modelID: string
  source: string
}

/** GET /codearts/models 响应（清单三元视图 + 当前模型）。 */
export interface ModelsResponse {
  ok: true
  models: { recent: ModelEntry[]; builtin: ModelEntry[]; custom: ModelEntry[] }
  current?: CurrentModel | null
  currentError?: string
}

/** GET /codearts/logs/tail 响应（码道内核日志尾部）。 */
export interface LogsTailResponse {
  ok: true
  file: string | null
  rows: string[]
}

/** 交互流时间线条目（kind: user|assistant|tool|error|system）。 */
export interface ActivityItem {
  time: string
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'system'
  text: string
}

/** GET /codearts/activity 响应（交互流时间线）。 */
export interface ActivityResponse {
  ok: true
  file: string | null
  items: ActivityItem[]
}

// ------------------------------------------------------------ API 方法

/** 总览：进程表 + 目标摘要 + 安装健康 + 审计健康。 */
export function getStatus(): Promise<StatusResponse> {
  return requestJson<StatusResponse>('GET', '/codearts/status')
}

/** 码道内核日志尾部（lines 10..400，服务端钳位）。 */
export function getLogsTail(lines: number): Promise<LogsTailResponse> {
  return requestJson<LogsTailResponse>('GET', `/codearts/logs/tail?lines=${lines}`)
}

/** 交互流时间线（kernel 日志解析为 user/assistant/tool/error/system；服务端钳位 ≤400 行）。 */
export function getActivity(): Promise<ActivityResponse> {
  return requestJson<ActivityResponse>('GET', '/codearts/activity?lines=600')
}

/** Web 内嵌终端输入：{pid, data} 键级透传（host 不自动加 \r；Enter 由前端发）。 */
export function postTuiInput(pid: number, data: string): Promise<{ ok: true; written: number }> {
  return requestJson('POST', '/codearts/tui/input', { pid, data })
}

/** 模型清单：recent 实测 + builtin 华为 MaaS 候选 + custom 自由扩展。 */
export function getModels(): Promise<ModelsResponse> {
  return requestJson<ModelsResponse>('GET', '/codearts/models')
}

/** Web 内嵌终端动态尺寸（node-pty TIOCSWINSZ）。 */
export function resizeTui(pid: number, cols: number, rows: number): Promise<{ ok: true; pid: number; cols: number; rows: number }> {
  return requestJson('POST', '/codearts/tui/resize', { pid, cols, rows })
}

/** 设为默认模型（写全局配置顶层 model 键 + recent 置顶）。 */
export function setModel(providerID: string, modelID: string): Promise<{ ok: true; current?: CurrentModel }> {
  return requestJson('POST', '/codearts/model', { providerID, modelID })
}

/** 添加自定义模型（codeartsHome 域原子持久化）。 */
export function addCustomModel(providerID: string, modelID: string): Promise<{ ok: true }> {
  return requestJson('POST', '/codearts/models/custom', { providerID, modelID })
}

/** 移除自定义模型。 */
export function removeCustomModel(providerID: string, modelID: string): Promise<{ ok: true }> {
  return requestJson('DELETE', '/codearts/models/custom', { providerID, modelID })
}

/** 启动托管 TUI（返回托管 PID；cols/rows 为 PTY 尺寸协商值，host stty 使用，缺省 320×42）。 */
export function startTui(cols?: number, rows?: number): Promise<{ ok: true; pid: number; startedAt: number; command: string }> {
  return requestJson('POST', '/codearts/tui/start', {
    ...(cols !== undefined ? { cols } : {}),
    ...(rows !== undefined ? { rows } : {}),
  })
}

/** 停止托管 TUI（进程组 SIGKILL）。 */
export function stopTui(pid: number): Promise<{ ok: true; pid: number; alreadyGone: boolean; killed: boolean }> {
  return requestJson('POST', '/codearts/tui/stop', { pid })
}

/** 目标控制：pause | resume | stop | check。 */
export type GoalAction = 'pause' | 'resume' | 'stop' | 'check'

/** 控制目标。 */
export function controlGoal(goalId: string, action: GoalAction): Promise<{ ok: true; goal: GoalSnapshot }> {
  return requestJson('POST', `/codearts/goals/${encodeURIComponent(goalId)}/control`, { action })
}

/** 启动新目标（验收命令连续两次通过方为完成）。 */
export function startGoal(
  objective: string,
  acceptanceCmd: string,
  mode: 'tui' | 'structured',
): Promise<{ ok: true; goalId: string }> {
  return requestJson('POST', '/codearts/goals', { objective, acceptanceCmd, mode })
}
