/**
 * dsh-codearts — 会话活动探测器（功能②"状态探测"锚点，全部来自实机日志侦察）
 *
 * 信号源：~/.codeartsdoer/cli-data/log/kernel-*.log（结构化，逐行
 *   `LEVEL [trace] ISO-TIMESTAMP +Nms service=<名> 消息`；trace 可选）。
 * service 分布（实测）：inferhub-provider(推理网关)、tool、bus、server、
 *   permission、provider-proxy、proxy-fetch、cron-scheduler 等。
 *
 * 四信号 → 五态分类（running / stuck / errored / dead / idle）：
 * ① 进程存活：托管 PID 是否活着（/proc 探测）
 * ② 日志活动：最新 kernel-*.log 的 mtime —— stuckAfterMs 无新增 = stuck
 * ③ 错误识别：service=inferhub-provider|provider-proxy 且匹配
 *    /timeout|timed out|502|50[3-4]|ECONNRESET|ETIMEDOUT/i → transient error
 *    （可重试），kind ∈ timeout|502|network，样本进审计
 * ④ 注入验证：注入文本（如 [GOAL-PLAN] 契约）出现在日志尾部（chat body 的
 *    user_prompt 字段）= 注入送达证据
 *
 * 采样纪律：日志可能很大且多文件——只取 mtime 最新一个文件、只读尾部
 * （tailBytes/tailLines 截断），禁止全量扫描。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 瞬时错误判别（实机锚点：infer timeout / 502 / 网络重置）。 */
export const ERROR_PATTERN = /timeout|timed out|502|50[3-4]|ECONNRESET|ETIMEDOUT/i;
/** 错误识别只看这两个推理链路 service（实测分布）。 */
export const PROBE_SERVICES = new Set(['inferhub-provider', 'provider-proxy']);

/** 结构化行解析（trace 可选；失败返回 null——非结构化行跳过，不算错误）。 */
export function parseLogLine(line) {
  const m = /^(\w+)\s+(?:\[([^\]]*)\]\s+)?(\S+)\s+(?:\+\d+m?s\s+)?service=([\w-]+)\s*(.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1], timestamp: m[3], service: m[4], message: m[5] };
}

/** 错误种类归类：timeout | 502 | network | null。 */
export function classifyErrorKind(message) {
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout';
  if (/502|50[3-4]/.test(message)) return '502';
  if (/ECONNRESET|ECONNREFUSED|ECONNABORTED|network/i.test(message)) return 'network';
  return ERROR_PATTERN.test(message) ? 'network' : null;
}

/** mtime 最新的 kernel 日志；目录缺失/无匹配返回 null（探测手段，非兜底）。 */
export function latestKernelLogPath(logDir) {
  if (typeof logDir !== 'string' || logDir.length === 0) return null;
  let files;
  try {
    files = readdirSync(logDir).filter((f) => f.startsWith('kernel-') && f.endsWith('.log'));
  } catch {
    return null;
  }
  let best = null;
  let bestM = -1;
  for (const f of files) {
    try {
      const m = statSync(join(logDir, f)).mtimeMs;
      if (m > bestM) { bestM = m; best = join(logDir, f); }
    } catch { /* 文件刚好轮转消失，跳过 */ }
  }
  return best;
}

/** 只读尾部：末尾 tailBytes 字节内、最后 tailLines 行（逆序数组——最新在前）。 */
export function readTailLines(filePath, tailBytes = 64 * 1024, tailLines = 200) {
  const stat = statSync(filePath);
  const start = Math.max(0, stat.size - tailBytes);
  const buf = readFileSync(filePath);
  const text = buf.subarray(start).toString('utf8');
  const lines = text.split('\n');
  if (start > 0 && lines.length > 0) lines.shift(); // 掐掉被截断的首行
  const alive = lines.filter((l) => l.trim().length > 0);
  return alive.slice(-tailLines).reverse();
}

/**
 * 会话探测器。
 * @param {{logDir: string, stuckAfterMs?: number, errorWindowMs?: number, tailBytes?: number, tailLines?: number, now?: () => number}} opts
 */
export class SessionProbe {
  constructor(opts = {}) {
    this.logDir = opts.logDir;
    this.stuckAfterMs = opts.stuckAfterMs ?? 60_000;
    this.errorWindowMs = opts.errorWindowMs ?? 120_000;
    this.tailBytes = opts.tailBytes ?? 64 * 1024;
    this.tailLines = opts.tailLines ?? 200;
    this.now = opts.now ?? Date.now;
    /** /proc 存活探测 */
    this._alive = (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
  }

  /**
   * 采样一次。@param {{pids?: number[], needles?: string[]}} args
   *  pids：托管进程 PID（全灭 → dead）；needles：期望出现在日志尾部的注入文本（送达证据）。
   * @returns {{state: 'running'|'stuck'|'errored'|'dead'|'idle'|'unknown', lastActivity: (string|null),
   *            lastError: (string|null), errorKind: (string|null), evidence: object}}
   */
  sample(args = {}) {
    const pids = args.pids ?? [];
    const needles = args.needles ?? [];
    // ① 进程存活（优先级最高：进程没了，日志再新也是死会话）
    if (pids.length > 0 && pids.every((p) => !this._alive(p))) {
      return { state: 'dead', lastActivity: null, lastError: null, errorKind: null, evidence: { pids } };
    }
    const logFile = latestKernelLogPath(this.logDir);
    if (logFile === null) {
      // 无日志可采（logDir 未配置/为空）：不猜，交给监督器用自身 lastActivityAt 判定
      return { state: 'unknown', lastActivity: null, lastError: null, errorKind: null, evidence: { reason: 'no-kernel-log' } };
    }
    const mtimeMs = statSync(logFile).mtimeMs;
    const lastActivity = new Date(mtimeMs).toISOString();
    const lines = readTailLines(logFile, this.tailBytes, this.tailLines);
    const evidence = { logFile, tailLines: lines.length, lastActivity, needlesFound: [] };
    // ④ 注入送达证据：needle 原文出现在尾部（chat body 的 user_prompt 全文在日志中）
    for (const needle of needles) {
      if (typeof needle === 'string' && needle.length > 0 && lines.some((l) => l.includes(needle))) {
        evidence.needlesFound.push(needle.slice(0, 60));
      }
    }
    // ③ 错误识别（尾部逆序找最新一条；只认推理链路 service）
    for (const line of lines) {
      const parsed = parseLogLine(line);
      if (parsed === null) continue;
      if (!PROBE_SERVICES.has(parsed.service)) continue;
      if (!ERROR_PATTERN.test(parsed.message)) continue;
      const kind = classifyErrorKind(parsed.message);
      if (kind === null) continue;
      evidence.matchedLine = line.slice(0, 300);
      if (this.now() - mtimeMs <= this.errorWindowMs) {
        return { state: 'errored', lastActivity, lastError: line.slice(0, 300), errorKind: kind, evidence };
      }
      break; // 错误样本太旧（超出 errorWindow）：记录 evidence 但不作当前态
    }
    // ② 日志活动：stuckAfterMs 无新增 = stuck
    if (this.now() - mtimeMs > this.stuckAfterMs) {
      return { state: 'stuck', lastActivity, lastError: null, errorKind: null, evidence };
    }
    return { state: 'running', lastActivity, lastError: null, errorKind: null, evidence };
  }
}
