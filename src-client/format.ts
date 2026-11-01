/**
 * 展示格式化工具（无副作用，供页面与降级面板共用）。
 */

/** 字节数 → 可读尺寸（RSS 展示用）；null/负值如实返回 '—'。 */
export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !(n >= 0)) return '—'
  if (n < 1024) return `${n} B`
  const mb = n / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** ISO/毫秒时间戳 → 简短中文时长（xx秒/xx分xx秒/xx小时xx分）；非法输入如实返回 '—'。 */
export function fmtDuration(from: string | number | undefined | null, until: number = Date.now()): string {
  if (from === undefined || from === null) return '—'
  const start = typeof from === 'number' ? from : Date.parse(from)
  if (!(start >= 0)) return '—'
  let s = Math.max(0, Math.floor((until - start) / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  s -= m * 60
  if (m < 60) return `${m}分${String(s).padStart(2, '0')}秒`
  const h = Math.floor(m / 60)
  return `${h}小时${String(m - h * 60).padStart(2, '0')}分`
}

/** 毫秒时间戳 → 本地短时间（HH:MM:SS）。 */
export function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 目标状态 → 中文徽章文案（未知状态原样展示，不吞）。 */
export function goalStateText(state: string): string {
  const map: Record<string, string> = {
    active: '运行中',
    verifying: '验收中',
    paused: '已暂停',
    done: '已完成',
    stopped: '已停止',
    failed: '失败',
  }
  return map[state] ?? state
}

/** 会话五态 → 中文文案。 */
export function sessionStateText(state: string): string {
  const map: Record<string, string> = {
    running: '推理中',
    stuck: '疑似停滞',
    errored: '出错',
    dead: '传输已死',
    idle: '空闲',
  }
  return map[state] ?? state
}

/** 目标 ID 展示：goal-1793459234201-ys75c2 → …9234201-ys75c2（保留可辨识尾段）。 */
export function shortGoalId(goalId: string): string {
  if (goalId.length <= 18) return goalId
  return `…${goalId.slice(-16)}`
}

/** 操作错误 → 用户可读文案（页面/终端共用）。 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 模型 ID 合法性（与 host model-manager.validateModelId 同口径）：
 * 非空、无空白、无引号、无控制字符。返回 null 表示合法，否则返回中文错误。
 */
export function validateModelId(providerID: string, modelID: string): string | null {
  const re = /^[A-Za-z0-9_.-]+$/
  if (!re.test(providerID)) return `providerID 非法（仅允许字母数字_.-）：${providerID || '（空）'}`
  if (!re.test(modelID)) return `modelID 非法（仅允许字母数字_.-）：${modelID || '（空）'}`
  return null
}
