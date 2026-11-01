/**
 * dsh-codearts — 目标监督引擎（codearts-bridge M3 语义移植）
 *
 * 状态机：active →（出现 [GOAL-DONE] 主张）→ verifying →（验收命令连续 2 次通过）→ done
 *                                          ↘ 验收失败 → active（注入失败反馈）
 * 任何时候可 pause（即时停看门狗）/ resume（重新武装 + 续跑指令）/ stop（终态）。
 *
 * 监督铁律（永不挂起）：
 * - 停滞 stagnationMs 无活动 → 注入"继续完成剩余任务"（TUI: 写入+独立 Enter；structured: --session 续接）
 * - 传输错误 → 无限重试（指数退避，60s 封顶；连续 ≥10 次拉响告警但【不】停止）
 * - TUI 进程死 → 重建 + 断点契约注入
 *
 * 持久化：<stateDir>/goals/<goalId>.json（tmp+rename 原子写）；
 * 审计：<stateDir>/audit/<goalId>.jsonl。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLogger, newGoalId } from './audit.js';
import { SessionProbe } from './activity-probe.js';

const GOAL_DONE_MARKER = '[GOAL-DONE]';

/** 目标契约注入模板（[GOAL-PLAN]/[GOAL-STEP]/[GOAL-DONE] + 验收命令双过要求）。 */
export function buildContractPrompt(objective, acceptanceCmd, opts = {}) {
  const lines = [
    '<goal_contract>',
    `${GOAL_PLAN()} 目标：${objective}`,
    '[GOAL-STEP] 每完成一步，先简述该步结果，再继续下一步；不要停下来等待确认。',
    `[GOAL-DONE] 全部完成后，运行验收命令 \`${acceptanceCmd}\`；该命令必须连续两次通过（两次均退出码 0）后，在回复中单独一行输出 ${GOAL_DONE_MARKER} 并说明结果。验收未通过就继续修复，禁止虚报完成。`,
    '</goal_contract>',
  ];
  if (opts.breakpoint) {
    lines.splice(1, 0, '[GOAL-RESET] 目标会话因进程中断而重建。请先检查已完成与未完成的部分（以工作区与会话持久状态为准），再从断点继续。');
  }
  return lines.join('\n');
}

/** 轻量停滞续跑文案（目标上下文已由首次/首次停滞的全文契约送达；全文绝不重发防队列堆积）。 */
export const STAGNATION_PROMPT = '继续完成剩余任务。若目标已全部完成，请运行验收命令验证，并在通过后单独一行输出 [GOAL-DONE]。';
function GOAL_PLAN() { return '[GOAL-PLAN]'; }

/** 验收失败反馈注入文案。 */
export function acceptanceFailPrompt(cmd, detail) {
  return `验收命令 \`${cmd}\` 未通过：${detail}。目标尚未完成，请定位失败原因并继续修复，完成后再次验证并输出 [GOAL-DONE]。`;
}
/** pause 后 resume 注入文案。 */
export const RESUME_PROMPT = '<goal_resume>\n目标已从暂停恢复。请读取当前目标与工作区状态，立即继续推进直至完成（完成判据见此前的目标契约）。\n</goal_resume>';

/** 原子写 JSON（tmp + rename，零损坏纪律）。 */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

/**
 * 目标运行时状态（内存 + 持久化同构）。
 * @typedef {object} GoalState
 * @property {string} goalId
 * @property {string} objective
 * @property {string} acceptanceCmd
 * @property {'active'|'verifying'|'paused'|'done'|'stopped'} state
 * @property {'tui'|'structured'} mode
 * @property {number} tuiPid TUI 模式下绑定的托管进程 PID
 * @property {string|undefined} sessionId structured 模式续接会话
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 * @property {string|undefined} pausedReason
 * @property {boolean} alarm 连续错误 ≥10 的告警标志（不停止）
 * @property {{injections: number, stagnationEvents: number, errors: number, consecutiveErrors: number, acceptanceRuns: number, acceptancePassStreak: number, restarts: number}} stats
 * @property {string|undefined} lastError
 */

/**
 * 传输层接口（可注入 FakeTransport 测试）：
 * - send(prompt) → Promise<{ok, sessionId?, text?, error?}> 注入一回合
 * - isAlive() → boolean 进程是否存活（structured 恒真：每回合独立进程）
 * - restart() → Promise<void> 进程死亡后重建
 */
export class TuiTransport {
  /** @param {import('./process-manager.js').ProcessManager} pm */
  constructor(pm, pid) {
    this.pm = pm;
    this.pid = pid;
    this.mode = 'tui';
  }
  isAlive() {
    const rec = this.pm.tuiProcs.get(this.pid);
    return rec !== undefined && rec.exitedAt === undefined;
  }
  async send(prompt) {
    // PTY 行缓冲：先写正文，再独立发送回车
    this.pm.writeTui(this.pid, prompt);
    await new Promise((r) => setTimeout(r, 50));
    this.pm.writeTuiEnter(this.pid);
    return { ok: true };
    // TUI 模式输出不可直采（渲染进 PTY），[GOAL-DONE] 主张依赖 API check 或周期验收
  }
  async restart() {
    await this.pm.stopTui(this.pid).catch(() => undefined);
    const started = this.pm.startTui();
    this.pid = started.pid;
  }
}

export class StructuredTransport {
  /** @param {import('./process-manager.js').ProcessManager} pm */
  constructor(pm, opts = {}) {
    this.pm = pm;
    this.sessionId = opts.sessionId;
    this.mode = 'structured';
  }
  isAlive() { return true; }
  async restart() { /* 无常驻进程，无需重建 */ }
  async send(prompt) {
    const result = await this.pm.runOnce(prompt, { sessionId: this.sessionId });
    if (result.ok && result.sessionId !== undefined) this.sessionId = result.sessionId;
    return { ok: result.ok, sessionId: result.sessionId, text: result.text, error: result.error };
  }
}

/** 目标监督器（单实例由 index.js 持有，可并存多个目标）。 */
export class GoalSupervisor {
  /**
   * @param {import('./process-manager.js').ProcessManager} pm
   * @param {Partial<{stateDir: string, stagnationMs: number, checkIntervalMs: number, retryBaseMs: number, retryCapMs: number, alarmThreshold: number}>} [config]
   * @param {{now?: () => number, audit?: AuditLogger, execFileFn?: typeof execFile}} [opts]
   */
  constructor(pm, config = {}, opts = {}) {
    this.pm = pm;
    this.now = opts.now ?? Date.now;
    this.cfg = {
      stateDir: pm.cfg.stateDir,
      stagnationMs: 60_000,
      // 长静默容忍（2026-11-01 用户裁决）：码道模型长思考/长命令静默几分钟 ≠ 卡死，
      // 有效停滞阈值 = max(stagnationMs, minStagnationMs)，默认静默满 300s 才开始停滞注入。
      // 测试可显式传小值关闭该容忍。
      minStagnationMs: 300_000,
      checkIntervalMs: 15_000,
      retryBaseMs: 5_000,
      retryCapMs: 60_000,
      restartDelayMs: 1_000,
      alarmThreshold: 10,
      ...config,
    };
    this.audit = opts.audit ?? new AuditLogger(join(this.cfg.stateDir, 'audit', 'dsh-codearts.jsonl'), { component: 'goal-supervisor', now: this.now });
    this.execFileFn = opts.execFileFn ?? execFile;
    // 会话状态探测器（可注入假探针测试）；无 logDir 时探针返回 unknown，监督器退回自身 lastActivityAt 判定
    this.probe = opts.probe ?? new SessionProbe({ logDir: pm.cfg.logDir, stuckAfterMs: config.stagnationMs ?? 60_000, now: this.now });
    mkdirSync(join(this.cfg.stateDir, 'goals'), { recursive: true });
    mkdirSync(join(this.cfg.stateDir, 'audit'), { recursive: true });
    /** @type {Map<string, {goal: GoalState, transport: TuiTransport|StructuredTransport, audit: AuditLogger, lastActivityAt: number, pendingPrompt: string|null, watchdog?: NodeJS.Timeout, retryTimer?: NodeJS.Timeout, busy: boolean}>} */
    this.goals = new Map();
    // 启动恢复：磁盘中 active/verifying 的目标不能凭空续跑（TUI PTY 已死），恢复为 paused 待人工 resume
    this._restorePersistedGoals();
  }

  // ---------- 持久化 ----------

  _goalPath(goalId) { return join(this.cfg.stateDir, 'goals', `${goalId}.json`); }

  _persist(record) {
    record.goal.updatedAt = new Date(this.now()).toISOString();
    atomicWriteJson(this._goalPath(record.goal.goalId), record.goal);
  }

  _restorePersistedGoals() {
    const dir = join(this.cfg.stateDir, 'goals');
    let files = [];
    if (existsSync(dir)) {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    }
    for (const file of files) {
      try {
        const goal = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        if (goal.state === 'active' || goal.state === 'verifying') {
          // 宿主重启后传输层不可用：转 paused（显式状态，非静默丢弃），resume 时走断点契约
          goal.state = 'paused';
          goal.pausedReason = 'host-restart（宿主重启，需显式恢复）';
        }
        const audit = new AuditLogger(join(this.cfg.stateDir, 'audit', `${goal.goalId}.jsonl`), { component: `goal:${goal.goalId}`, now: this.now });
        const transport = this._makeTransport(goal);
        this.goals.set(goal.goalId, { goal, transport, audit, lastActivityAt: this.now(), pendingPrompt: null, busy: false });
      } catch (error) {
        throw new Error(`目标文件 ${file} 损坏，拒绝加载: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  _makeTransport(goal) {
    if (goal.mode === 'tui') {
      const pid = goal.tuiPid ?? (this.pm.tuiProcs.size > 0 ? [...this.pm.tuiProcs.keys()][0] : undefined);
      if (pid === undefined) throw new Error(`目标 ${goal.goalId} 是 TUI 模式但没有可用 TUI 进程`);
      return new TuiTransport(this.pm, pid);
    }
    return new StructuredTransport(this.pm, { sessionId: goal.sessionId });
  }

  // ---------- 生命周期 ----------

  /**
   * 启动一个受监督目标。
   * @param {string} objective 目标描述
   * @param {{acceptanceCmd: string, mode?: 'tui'|'structured', tuiPid?: number, sessionId?: string}} opts
   * @returns {{goalId: string}}
   */
  async startGoal(objective, opts) {
    if (typeof objective !== 'string' || objective.trim().length === 0) throw new Error('objective 不能为空');
    if (typeof opts.acceptanceCmd !== 'string' || opts.acceptanceCmd.trim().length === 0) throw new Error('acceptanceCmd 不能为空（目标完成以验收命令连续两次通过为准）');
    const mode = opts.mode ?? 'structured';
    if (mode === 'tui' && opts.tuiPid === undefined && this.pm.tuiProcs.size === 0) {
      throw new Error('TUI 模式需要先 startTui() 或显式传入 tuiPid');
    }
    const goalId = newGoalId(this.now);
    const createdAt = new Date(this.now()).toISOString();
    /** @type {GoalState} */
    const goal = {
      goalId,
      objective,
      acceptanceCmd: opts.acceptanceCmd,
      state: 'active',
      mode,
      tuiPid: opts.tuiPid ?? (mode === 'tui' ? [...this.pm.tuiProcs.keys()][0] : 0),
      sessionId: opts.sessionId,
      createdAt,
      updatedAt: createdAt,
      pausedReason: undefined,
      alarm: false,
      cooldownUntil: undefined,
      stats: { injections: 0, stagnationEvents: 0, errors: 0, consecutiveErrors: 0, acceptanceRuns: 0, acceptancePassStreak: 0, restarts: 0 },
      lastError: undefined,
    };
    const audit = new AuditLogger(join(this.cfg.stateDir, 'audit', `${goalId}.jsonl`), { component: `goal:${goalId}`, now: this.now });
    const transport = this._makeTransport(goal);
    /** @type {any} */
    const record = { goal, transport, audit, lastActivityAt: this.now(), pendingPrompt: null, busy: false };
    this.goals.set(goalId, record);
    this._persist(record);
    audit.append('goal.start', { objective: objective.slice(0, 200), mode, acceptanceCmd: opts.acceptanceCmd });
    this.audit.append('goal.start', { goalId, mode });
    await this._inject(record, buildContractPrompt(objective, opts.acceptanceCmd));
    record.fullContractInjected = true; // 全文契约已首发（此后停滞/重试一律轻量 nudge，防队列堆积）
    this._armWatchdog(record);
    return { goalId };
  }

  /** 暂停：即时停看门狗 + 停重试，状态转 paused（仅 active/verifying 可暂停；幂等性不做——重复暂停显式报错）。 */
  pause(goalId, reason = 'user-pause') {
    const record = this._require(goalId);
    if (record.goal.state === 'done' || record.goal.state === 'stopped') {
      throw new Error(`目标 ${goalId} 已是终态（${record.goal.state}），不能暂停`);
    }
    if (record.goal.state === 'paused') {
      throw new Error(`目标 ${goalId} 当前是 paused，无需重复暂停`);
    }
    this._disarm(record);
    record.goal.state = 'paused';
    record.goal.pausedReason = reason;
    this._persist(record);
    record.audit.append('goal.pause', { reason });
    return record.goal;
  }

  /** 恢复：重新武装看门狗 + 注入续跑指令（paused → active）。 */
  async resume(goalId) {
    const record = this._require(goalId);
    if (record.goal.state === 'done' || record.goal.state === 'stopped') {
      throw new Error(`目标 ${goalId} 已是终态（${record.goal.state}），不能恢复`);
    }
    if (record.goal.state !== 'paused') {
      throw new Error(`目标 ${goalId} 当前是 ${record.goal.state}，只有暂停(paused)才能恢复`);
    }
    const wasInterrupted = String(record.goal.pausedReason ?? '').includes('host-restart');
    record.goal.state = 'active';
    record.goal.pausedReason = undefined;
    record.goal.stats.consecutiveErrors = 0;
    this._persist(record);
    record.audit.append('goal.resume', { wasInterrupted });
    // host-restart 或 TUI 死过 → 断点契约；普通暂停 → 简短续跑指令
    const prompt = wasInterrupted
      ? buildContractPrompt(record.goal.objective, record.goal.acceptanceCmd, { breakpoint: true })
      : RESUME_PROMPT;
    await this._inject(record, prompt);
    this._armWatchdog(record);
    return record.goal;
  }

  /** 永久停止：终态，看门狗与重试全部拆除（幂等）。 */
  stop(goalId) {
    const record = this._require(goalId);
    this._disarm(record);
    record.goal.state = 'stopped';
    record.goal.pausedReason = undefined;
    this._persist(record);
    record.audit.append('goal.stop', {});
    this.audit.append('goal.stop', { goalId });
    return record.goal;
  }

  /**
   * 手动/周期触发验收检查（双过判据）。
   * @returns {Promise<GoalState>}
   */
  async checkAcceptance(goalId) {
    const record = this._require(goalId);
    if (record.goal.state === 'done' || record.goal.state === 'stopped') {
      throw new Error(`目标 ${goalId} 已是终态（${record.goal.state}），无需验收`);
    }
    await this._runAcceptance(record);
    return record.goal;
  }

  /** 目标列表快照（管理 API 用）。 */
  listGoals() {
    return [...this.goals.values()].map((r) => this._snapshot(r));
  }

  /** 单目标快照。 */
  getGoal(goalId) {
    return this._snapshot(this._require(goalId));
  }

  /** 停止一切目标（插件卸载）。所有目标转 paused 持久化，看门狗拆除。 */
  dispose() {
    const errors = [];
    for (const record of this.goals.values()) {
      try {
        this._disarm(record);
        if (record.goal.state === 'active' || record.goal.state === 'verifying') {
          record.goal.state = 'paused';
          record.goal.pausedReason = 'plugin-dispose（插件卸载）';
          this._persist(record);
        }
      } catch (error) {
        errors.push(`${record.goal.goalId}: ${String(error)}`);
      }
    }
    if (errors.length > 0) throw new Error(`dispose 有目标未干净收尾: ${errors.join('; ')}`);
  }

  // ---------- 内部机制 ----------

  _require(goalId) {
    const record = this.goals.get(goalId);
    if (record === undefined) throw new Error(`目标 ${goalId} 不存在`);
    return record;
  }

  _snapshot(record) {
    const g = record.goal;
    return {
      goalId: g.goalId,
      objective: g.objective,
      acceptanceCmd: g.acceptanceCmd,
      state: g.state,
      mode: g.mode,
      tuiPid: g.tuiPid || undefined,
      sessionId: g.sessionId,
      transportAlive: record.transport.isAlive(),
      pausedReason: g.pausedReason,
      alarm: g.alarm,
      cooldownUntil: g.cooldownUntil,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      stats: { ...g.stats },
      lastError: g.lastError,
      session: this._sessionState(record),
    };
  }

  /**
   * 会话五态（用户可见的"状态探测"）：running / stuck / errored(timeout|502|network) / dead / idle。
   * 终态目标 → idle；传输进程灭 → dead；探针 errored/stuck 优先；探针无日志时按监督器
   * 自身 lastActivityAt + stagnationMs 判定。
   */
  _sessionState(record) {
    const g = record.goal;
    const base = { lastActivity: null, lastError: g.lastError ?? null, errorKind: null, evidence: {} };
    if (g.state === 'paused' || g.state === 'stopped' || g.state === 'done') {
      return { state: 'idle', ...base, evidence: { reason: `goal-${g.state}` } };
    }
    if (!record.transport.isAlive()) {
      return { state: 'dead', ...base, evidence: { reason: 'transport-dead' } };
    }
    // 注入送达验证 needle：最近一次注入文本头 40 字符（5 分钟内有效）
    const needles = [];
    if (record.lastInjectedAt !== undefined && this.now() - record.lastInjectedAt < 300_000 && record.lastInjectedNeedle) {
      needles.push(record.lastInjectedNeedle);
    }
    let sampled;
    try {
      sampled = this.probe.sample({ pids: g.mode === 'tui' && g.tuiPid ? [g.tuiPid] : [], needles });
    } catch (error) {
      // 探针自身故障必须可见，但不得拖垮状态输出——降级为监督器自判并附故障摘要
      sampled = { state: 'unknown', lastActivity: null, lastError: null, errorKind: null, evidence: { probeError: String(error).slice(0, 200) } };
    }
    const idleBySupervisor = this.now() - record.lastActivityAt > this.cfg.stagnationMs;
    switch (sampled.state) {
      case 'errored':
        return { state: 'errored', lastActivity: sampled.lastActivity, lastError: sampled.lastError, errorKind: sampled.errorKind, evidence: sampled.evidence };
      case 'dead':
        return { state: 'dead', ...base, evidence: sampled.evidence };
      case 'stuck':
        return { state: 'stuck', lastActivity: sampled.lastActivity, lastError: g.lastError ?? null, errorKind: null, evidence: sampled.evidence };
      case 'running':
        // 探针说 running 但监督器注入通道长期无活动 → 仍判 stuck（双信号取严）
        return idleBySupervisor
          ? { state: 'stuck', lastActivity: sampled.lastActivity, lastError: g.lastError ?? null, errorKind: null, evidence: { ...sampled.evidence, note: '日志有活动但注入通道无进展' } }
          : { state: 'running', lastActivity: sampled.lastActivity, lastError: null, errorKind: null, evidence: sampled.evidence };
      default: // unknown（无日志可采）
        return idleBySupervisor
          ? { state: 'stuck', lastActivity: null, lastError: g.lastError ?? null, errorKind: null, evidence: sampled.evidence }
          : { state: 'running', lastActivity: null, lastError: null, errorKind: null, evidence: sampled.evidence };
    }
  }

  _armWatchdog(record) {
    this._disarmWatchdogOnly(record);
    record.watchdog = setInterval(() => { this._watchdogTick(record); }, this.cfg.checkIntervalMs);
    record.watchdog.unref?.();
  }

  _disarmWatchdogOnly(record) {
    if (record.watchdog !== undefined) { clearInterval(record.watchdog); record.watchdog = undefined; }
  }

  _disarm(record) {
    this._disarmWatchdogOnly(record);
    if (record.retryTimer !== undefined) { clearTimeout(record.retryTimer); record.retryTimer = undefined; }
  }

  /** 看门狗节拍：停滞 / 进程死 / verifying 期验收复查。 */
  _watchdogTick(record) {
    const goal = record.goal;
    if (goal.state === 'paused' || goal.state === 'done' || goal.state === 'stopped') {
      this._disarmWatchdogOnly(record);
      return;
    }
    // ① 进程死 → 重建 + 断点契约（仅在无待执行重试时登记，防审计刷屏与定时器饿死）
    if (!record.transport.isAlive()) {
      if (record.retryTimer === undefined) {
        record.audit.append('goal.transport_dead', {});
        this._scheduleRetry(record, new Error('传输进程已死亡'), { restart: true });
      }
      return;
    }
    // ② verifying：停滞 → 复跑验收（有效阈值含长静默容忍）
    if (goal.state === 'verifying') {
      if (this.now() - record.lastActivityAt > Math.max(this.cfg.stagnationMs, this.cfg.minStagnationMs ?? 300_000)) {
        record.lastActivityAt = this.now();
        record.audit.append('goal.verifying_recheck', {});
        void this._runAcceptance(record).catch((error) => this._onError(record, error));
      }
      return;
    }
    // 探测审计：错误样本（去重）与注入送达证据落审计；探针故障不在 watchdog 复报
    // （故障本身已通过 _sessionState 的 evidence.probeError 对外可见）
    let probeRunning = false;
    try {
      const sampled = this.probe.sample({
        pids: goal.mode === 'tui' && goal.tuiPid ? [goal.tuiPid] : [],
        needles: record.lastInjectedNeedle ? [record.lastInjectedNeedle] : [],
      });
      probeRunning = sampled.state === 'running'; // 探针实证会话在推理（冷却解除依据）
      if (sampled.state === 'errored' && sampled.lastError !== record.lastProbedError) {
        record.lastProbedError = sampled.lastError;
        record.audit.append('goal.session.errored', { errorKind: sampled.errorKind, sample: sampled.lastError });
      }
      if (sampled.evidence?.needlesFound?.length > 0 && record.injectDeliveredAudited !== true) {
        record.injectDeliveredAudited = true;
        record.audit.append('goal.inject.delivered', { needles: sampled.evidence.needlesFound });
      }
    } catch { /* 见上注释 */ }
    // ③ active 停滞 → 注入续跑（注入去重纪律，2026-11-01 实测裁决：
    //    码道 TUI 繁忙时注入会进入其输入队列排队——实测同一全文契约 QUEUED 堆到 6/6，
    //    码道会把同一目标重复执行 6 遍。因此：
    //    - 首次停滞：注入全文契约（补首契约可能被 TUI 就绪窗吞没的缺）
    //    - 后续停滞：只注入轻量短 nudge（绝不重发全文——防队列堆积同文重复执行）
    //    - 连续 ≥4 次停滞注入无任何验收进展 → 冷却指数退避（30s 起，5 分钟封顶）
    //    - 冷却清零只认验收进展（探针 running 不再作为清零依据——TUI 活着 ≠ 在处理我们的注入）
    //    冷却不是停止：到期后照常注入——"永不挂起"语义不变，只是防队列堆积。）
    // 冷却清零只认 acceptancePassStreak 变化（2026-11-01 用户裁决收紧：码道执行验收命令
    // 即使失败 acceptanceRuns 也 +1，运行即计数不算进展——原条件被绕过，冷却永不触发，
    // 实测 QUEUED 19/19 轰炸）。验收真正通过（连击增长）→ 冷却与连击清零 + 重发全文契约。
    if (goal.stats.acceptancePassStreak > (record.lastStallPassStreak ?? 0)) {
      record.stallInjections = 0;
      record.fullContractInjected = false;
      goal.cooldownUntil = undefined;
    }
    record.lastStallPassStreak = goal.stats.acceptancePassStreak;
    // 停滞判据（2026-11-01 实测修正）：以 TUI 真实输出时间（lastDataAt）为准——
    // 码道跑长命令（cmake/构建/测试，输出持续）时绝不注入；lastActivityAt 被注入
    // 自己回写，不能作为"码道卡死"的依据（实测 4 条 nudge 排队的根因）。
    const lastDataAt = (() => {
      try {
        const pid = record.transport?.pid ?? record.goal.tuiPid;
        const t = this.pm.getTuiLastDataAt(Number(pid)); // 修复：宿主字段是 this.pm（原 this.processManager 恒 undefined → 静默失效）
        return typeof t === 'number' ? t : undefined;
      } catch { return undefined; }
    })();
    const lastSignOfLife = Math.max(record.lastActivityAt, lastDataAt ?? 0);
    // 长静默容忍（2026-11-01 用户裁决）：模型 thinking/长命令静默几分钟 ≠ 卡死，
    // 有效停滞阈值 = max(stagnationMs, minStagnationMs)，默认静默满 300s 才注入。
    const idle = this.now() - lastSignOfLife > Math.max(this.cfg.stagnationMs, this.cfg.minStagnationMs ?? 300_000);
    if (idle) {
      // 冷却中：本拍跳过注入（进入冷却时已审计一次；到期后下拍自然恢复注入）
      if (goal.cooldownUntil !== undefined && this.now() < goal.cooldownUntil) return;
      // QUEUED 背压闸门（2026-11-01 用户截图实证 QUEUED 19/19 轰炸）：TUI 最近输出
      // 含 QUEUED → 队列未消化 → 跳过本拍注入，直至画面无 QUEUED（最直接的防堆积闸门）
      if (goal.mode === 'tui' && goal.tuiPid) {
        try {
          const tail = String(this.pm.getTuiTermSnapshot(goal.tuiPid)).slice(-8192);
          if (tail.includes('QUEUED')) {
            record.audit.append('goal.inject.skip_queued', { tailHead: tail.slice(0, 200) });
            return;
          }
        } catch { /* pid 不在托管表/快照不可用：照常走注入判定 */ }
      }
      record.lastActivityAt = this.now();
      goal.stats.stagnationEvents += 1;
      record.stallInjections = (record.stallInjections ?? 0) + 1;
      if (record.stallInjections > 4) {
        // 第 5 次连续停滞注入起进入冷却：30s × 2^(n-5)，5 分钟封顶
        const backoffMs = Math.min(30_000 * 2 ** (record.stallInjections - 5), 300_000);
        goal.cooldownUntil = this.now() + backoffMs;
        record.audit.append('goal.stall_cooldown', {
          stallInjections: record.stallInjections,
          cooldownMs: backoffMs,
          cooldownUntil: new Date(goal.cooldownUntil).toISOString(),
        });
      }
      record.audit.append('goal.stagnation', { idleMs: this.cfg.stagnationMs, stallInjections: record.stallInjections ?? 1 });
      // 首次停滞 → 全文契约（补送达）；之后 → 轻量 nudge（防同文排队重复执行）
      const nudge = record.fullContractInjected
        ? STAGNATION_PROMPT
        : buildContractPrompt(goal.objective, goal.acceptanceCmd);
      record.fullContractInjected = true;
      void this._inject(record, nudge).catch((error) => this._onError(record, error));
    } else if (goal.cooldownUntil !== undefined && probeRunning) {
      // 探针实证会话在推理（真实活动，而非我们自己注入回写的 lastActivityAt）→
      // 立即解除冷却并清零连击（恢复常规节奏）。注意：不能以 lastActivityAt 判活动——
      // 它被本注入流程自己回写，会把连击清零变成"永远到不了冷却阈值"。
      goal.cooldownUntil = undefined;
      record.stallInjections = 0;
      record.audit.append('goal.stall_cooldown.cleared', { evidence: 'probe-running' });
    }
  }

  /** 注入一回合（busy 互斥；structured 用 -s 续接；TUI 写 PTY）。 */
  async _inject(record, prompt) {
    if (record.busy) {
      record.pendingPrompt = prompt; // 上一回合未完：排队，绝不并发写同一会话
      return;
    }
    record.busy = true;
    record.goal.stats.injections += 1;
    // 注入针迹：供会话探针做"送达证据"匹配（日志 chat body 的 user_prompt 全文可见）
    record.lastInjectedNeedle = prompt.slice(0, 40);
    record.lastInjectedAt = this.now();
    /** [GOAL-DONE] 主张是否出现（出现则回合结束后进入验收） */
    let claimed = false;
    try {
      record.lastActivityAt = this.now();
      const result = await record.transport.send(prompt);
      record.lastActivityAt = this.now();
      if (result.ok === false) {
        // 失败先于任何计数清零判定——严禁让失败回合重置告警状态
        throw new Error(result.error ?? '传输层返回失败');
      }
      record.goal.stats.consecutiveErrors = 0;
      record.goal.alarm = false;
      record.audit.append('goal.inject.done', { promptHead: prompt.slice(0, 80) });
      claimed = typeof result.text === 'string' && result.text.includes(GOAL_DONE_MARKER);
      if (claimed) {
        // [GOAL-DONE] 主张 → 进入 verifying，回合收尾后立即跑验收（不在 try 内 await，保证排队提示仍可被消化）
        record.goal.state = 'verifying';
        this._persist(record);
        record.audit.append('goal.done_claimed', {});
      }
    } catch (error) {
      this._onError(record, error);
      return; // 错误路径自己安排重试
    } finally {
      record.busy = false;
    }
    if (claimed) {
      await this._runAcceptance(record);
      return;
    }
    // 排队中的提示继续发送
    if (record.pendingPrompt !== null && record.goal.state === 'active') {
      const next = record.pendingPrompt;
      record.pendingPrompt = null;
      await this._inject(record, next);
    }
  }

  /** 验收命令执行 + 双过判定。 */
  async _runAcceptance(record) {
    const goal = record.goal;
    goal.stats.acceptanceRuns += 1;
    record.lastActivityAt = this.now();
    const result = await new Promise((resolveExec) => {
      this.execFileFn('/bin/sh', ['-c', goal.acceptanceCmd], { timeout: 120_000 }, (error, stdout, stderr) => {
        resolveExec({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
    if (result.error === undefined || result.error === null) {
      goal.stats.acceptancePassStreak += 1;
      record.audit.append('goal.acceptance.pass', { streak: goal.stats.acceptancePassStreak });
      if (goal.stats.acceptancePassStreak >= 2) {
        goal.state = 'done';
        this._disarm(record);
        this._persist(record);
        record.audit.append('goal.done', { acceptanceRuns: goal.stats.acceptanceRuns });
        this.audit.append('goal.done', { goalId: goal.goalId });
        return;
      }
      // 第一过：再跑一次确认（双过）
      goal.state = 'verifying';
      this._persist(record);
      await this._runAcceptance(record);
      return;
    }
    // 失败：清零 + 反馈注入，回 active
    const detail = `退出码 ${result.error.code ?? '?'}，stderr: ${result.stderr.slice(-300) || '（空）'}`;
    goal.stats.acceptancePassStreak = 0;
    goal.state = 'active';
    goal.lastError = `验收失败: ${detail}`;
    this._persist(record);
    record.audit.append('goal.acceptance.fail', { detail: detail.slice(0, 400) });
    await this._inject(record, acceptanceFailPrompt(goal.acceptanceCmd, detail));
  }

  /** 错误处理：无限重试（指数退避 60s 封顶），连续 ≥alarmThreshold 拉响告警但不停。 */
  _onError(record, error) {
    const goal = record.goal;
    record.busy = false;
    goal.stats.errors += 1;
    goal.stats.consecutiveErrors += 1;
    goal.lastError = error instanceof Error ? error.message : String(error);
    if (goal.stats.consecutiveErrors >= this.cfg.alarmThreshold && !goal.alarm) {
      goal.alarm = true;
      record.audit.append('goal.alarm', { consecutiveErrors: goal.stats.consecutiveErrors, note: '连续错误达到阈值，监督不停止，继续重试' });
      console.warn(`[dsh-codearts] ⚠ 目标 ${goal.goalId} 连续错误 ${goal.stats.consecutiveErrors} 次（告警不停止，继续重试）: ${goal.lastError}`);
    }
    this._persist(record);
    record.audit.append('goal.error', { consecutiveErrors: goal.stats.consecutiveErrors, error: goal.lastError.slice(0, 300) });
    this._scheduleRetry(record, error);
  }

  _scheduleRetry(record, _cause, opts = {}) {
    if (record.goal.state !== 'active' && record.goal.state !== 'verifying') return;
    // 已有待执行的重试定时器：绝不重置（短周期看门狗反复调用会饿死退避定时器，重启将永不发生）
    if (record.retryTimer !== undefined) return;
    const backoff = Math.min(this.cfg.retryBaseMs * 2 ** Math.min(record.goal.stats.consecutiveErrors, 10), this.cfg.retryCapMs);
    record.retryTimer = setTimeout(async () => {
      record.retryTimer = undefined;
      if (record.goal.state !== 'active' && record.goal.state !== 'verifying') return;
      try {
        if (opts.restart) {
          await record.transport.restart();
          record.goal.stats.restarts += 1;
          record.goal.tuiPid = record.transport.pid ?? record.goal.tuiPid;
          this._persist(record);
          record.audit.append('goal.transport_rebuilt', { restarts: record.goal.stats.restarts });
          // 断点契约：重建后重申目标与完成判据
          await this._inject(record, buildContractPrompt(record.goal.objective, record.goal.acceptanceCmd, { breakpoint: true }));
        } else {
          // 非重启重试（网络类错误）：同样重发全文契约——模型可能从未收到首次契约（TUI 就绪窗吞没）
          await this._inject(record, buildContractPrompt(record.goal.objective, record.goal.acceptanceCmd));
        }
      } catch (error) {
        this._onError(record, error);
      }
    }, opts.restart ? this.cfg.restartDelayMs : backoff);
    record.retryTimer.unref?.();
    record.audit.append('goal.retry_scheduled', { backoffMs: opts.restart ? this.cfg.restartDelayMs : backoff, restart: opts.restart === true });
  }
}
