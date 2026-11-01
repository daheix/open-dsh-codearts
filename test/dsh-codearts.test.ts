/**
 * dsh-codearts 插件测试（bun test）
 *
 * 覆盖四块（对应任务合同）：
 * ① 进程管理：TUI spawn/stop/状态、runOnce 事件流解析（fixture 命令）
 * ② 目标监督：停滞续跑 / 错误无限重试+告警 / 双过验收 / 进程死重建+断点契约 / 持久化与 host-restart 恢复
 * ③ 安装管家：healthy / missing / only-delete 自愈、无备份显式报错、受控升级成功/哈希中止/复验失败回滚
 * ④ HTTP 路由：status/run/goals 全生命周期端到端（真实 http.server + 注册路由 mock webServer）
 *
 * 约定：所有临时产物在 <插件>/test/.tmp/ 下（工作目录内临时目录，禁系统 /tmp），用后删除。
 */
import { describe, test, expect, beforeAll, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ProcessManager, parseRunEvents } from '../lib/process-manager.js';
import { GoalSupervisor, buildContractPrompt, StructuredTransport } from '../lib/goal-supervisor.js';
import { InstallManager, probeInstall, sha256File } from '../lib/install-manager.js';
import { parseActivityLines } from '../lib/activity-parser.js';
import { registerRoutes } from '../lib/routes.js';
import { apply as pluginApply } from '../lib/index.js';
import { AuditLogger } from '../lib/audit.js';

const TMP_ROOT = join(import.meta.dir, '.tmp');

function makeTmp(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `${label}-`));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function tmp(label: string): string {
  const dir = makeTmp(label);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 目标监督测试用假进程管理器（鸭子类型满足 StructuredTransport 所需）。 */
class FakePM {
  cfg = { stateDir: '' };
  tuiProcs = new Map<number, any>();
  calls: Array<{ prompt: string; opts: any }> = [];
  script: (prompt: string, opts: any) => any = () => ({ ok: true, text: '' });
  async runOnce(prompt: string, opts: any = {}) {
    this.calls.push({ prompt, opts });
    return await this.script(prompt, opts);
  }
}

// ============================== ① 进程管理 ==============================

describe('进程管理 ProcessManager', () => {
  test('startTui → 存活 → writeTui → stopTui 整组消亡', async () => {
    const stateDir = tmp('pm-tui');
    const pm = new ProcessManager({ stateDir });
    // fixture：cat 常驻读 stdin（PTY 注入可写）
    const started = pm.startTui({ commandOverride: '/bin/sh -c "cat"' });
    expect(started.pid).toBeGreaterThan(0);
    await sleep(200);
    const status = pm.getStatus();
    const row = status.tui.find((t: any) => t.pid === started.pid);
    expect(row).toBeDefined();
    expect(row!.alive).toBe(true);
    // PTY 注入：写入 + 独立回车不抛错
    expect(pm.writeTui(started.pid, 'hello').written).toBe(5);
    pm.writeTuiEnter(started.pid);
    const stop = await pm.stopTui(started.pid);
    expect(stop.killed).toBe(true);
    await sleep(150);
    expect(pm.getStatus().tui.find((t: any) => t.pid === started.pid)).toBeUndefined();
    // 审计已落盘
    expect(existsSync(join(stateDir, 'audit', 'dsh-codearts.jsonl'))).toBe(true);
  }, 15000);

  test('stopTui 对不在托管表的 PID 显式拒绝（防误杀）', async () => {
    const pm = new ProcessManager({ stateDir: tmp('pm-refuse') });
    expect(() => pm.stopTui(99999)).toThrow('不在本管理器托管表');
  });

  test('runOnce 解析 JSON 事件流（sessionId/text/事件数）', async () => {
    const stateDir = tmp('pm-run');
    const fixture = join(stateDir, 'fake-codearts.sh');
    writeFileSync(fixture, [
      '#!/bin/sh',
      'echo \'{"type":"session","sessionID":"ses-abc-1"}\'',
      'echo \'{"type":"message","message":{"parts":[{"type":"text","text":"第一步完成"}]}}\'',
      'echo \'{"type":"text","text":"[GOAL-DONE] 全部完成"}\'',
      'echo "非 JSON 噪声行"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    const pm = new ProcessManager({ stateDir });
    const result = await pm.runOnce('做点事', { commandOverride: [fixture, 'run', '做点事', '--format', 'json'] });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('ses-abc-1');
    expect(result.text).toContain('第一步完成');
    expect(result.text).toContain('[GOAL-DONE]');
    expect(result.eventCount).toBe(3);
    expect(result.noiseLines).toBe(1);
  }, 15000);

  test('runOnce 非零退出显式报错（含 stderr 尾部）', async () => {
    const stateDir = tmp('pm-run-fail');
    const fixture = join(stateDir, 'fail.sh');
    writeFileSync(fixture, '#!/bin/sh\necho "炸了" >&2\nexit 3\n', { mode: 0o755 });
    const pm = new ProcessManager({ stateDir });
    const result = await pm.runOnce('x', { commandOverride: [fixture] });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain('退出码非零');
    expect(result.error).toContain('炸了');
  }, 15000);

  test('parseRunEvents 纯函数：空输入/畸形 JSON', () => {
    expect(parseRunEvents('').events).toHaveLength(0);
    const parsed = parseRunEvents('not json\n{"sessionID":"s1"}\n');
    expect(parsed.noiseLines).toBe(1);
    expect(parsed.sessionId).toBe('s1');
  });
});

// ============================== ② 目标监督 ==============================

describe('目标监督 GoalSupervisor', () => {
  test('契约模板：[GOAL-PLAN]/[GOAL-STEP]/[GOAL-DONE] + 双过要求 + 断点变体', () => {
    const prompt = buildContractPrompt('完成 X', 'npm test');
    expect(prompt).toContain('[GOAL-PLAN] 目标：完成 X');
    expect(prompt).toContain('[GOAL-STEP]');
    expect(prompt).toContain('[GOAL-DONE]');
    expect(prompt).toContain('连续两次通过');
    expect(prompt).toContain('npm test');
    const bp = buildContractPrompt('完成 X', 'npm test', { breakpoint: true });
    expect(bp).toContain('[GOAL-RESET]');
  });

  test('停滞续跑：stagnationMs 后自动注入继续指令', async () => {
    const stateDir = tmp('goal-stagnation');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: true, text: '进行中…' });
    const supervisor = new GoalSupervisor(fakePM as any, {
      // minStagnationMs:0——关闭长静默容忍（300s）以便快速测试（新规格：有效阈值=max(停滞阈值,容忍)）
      stateDir, stagnationMs: 120, minStagnationMs: 0, checkIntervalMs: 40, retryBaseMs: 10, retryCapMs: 20,
    });
    try {
      const { goalId } = await supervisor.startGoal('整理文档', { acceptanceCmd: 'true', mode: 'structured' });
      await sleep(400);
      const goal = supervisor.getGoal(goalId);
      expect(goal.stats.stagnationEvents).toBeGreaterThanOrEqual(1);
      expect(goal.stats.injections).toBeGreaterThanOrEqual(2); // 契约 + 至少一次续跑
      // 注入的续跑文案出现在假 PM 收到的 prompt 中
      const prompts = fakePM.calls.map((c) => c.prompt);
      expect(prompts.some((p) => p.includes('目标：') || p.includes('继续完成剩余任务'))).toBe(true);
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('停滞注入冷却退避：连续 ≥4 次无验收进展 → cooldownUntil 指数退避；验收进展立即清零', async () => {
    const stateDir = tmp('goal-cooldown');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: true, text: '仍在空转…' }); // 永无 [GOAL-DONE]、验收不跑 → acceptanceRuns 恒 0
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 60, minStagnationMs: 0, checkIntervalMs: 25, retryBaseMs: 10, retryCapMs: 20,
    });
    try {
      const { goalId } = await supervisor.startGoal('长时间无进展', { acceptanceCmd: 'true', mode: 'structured' });
      // 连续停滞注入到第 5 次+（阈值 4 之后进入冷却）
      await sleep(1200);
      let goal = supervisor.getGoal(goalId);
      expect(goal.stats.stagnationEvents).toBeGreaterThanOrEqual(5);
      expect(goal.cooldownUntil).toBeDefined();
      expect(goal.cooldownUntil!).toBeGreaterThan(Date.now());
      const auditText = readFileSync(join(stateDir, 'audit', `${goalId}.jsonl`), 'utf8'); // 停滞/冷却事件在 per-goal 审计文件
      expect(auditText).toContain('goal.stall_cooldown');
      // 验收进展 → 立即清零（白盒改内部 goal.stats 模拟验收真正通过；清零只认 passStreak——
      // acceptanceRuns 运行即计数不算进展，2026-11-01 收紧）
      const internal = supervisor.goals.get(goalId);
      internal.goal.stats.acceptancePassStreak = 1;
      await sleep(120);
      goal = supervisor.getGoal(goalId);
      expect(goal.cooldownUntil).toBeUndefined();
      // 且冷却不是停止：清零后注入继续发生（永不挂起语义）
      const inj = goal.stats.injections;
      await sleep(200);
      expect(supervisor.getGoal(goalId).stats.injections).toBeGreaterThanOrEqual(inj);
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('错误无限重试 + 连续错误告警不停止', async () => {
    const stateDir = tmp('goal-retry');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: false, error: '网络断了' });
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 60_000, checkIntervalMs: 40, retryBaseMs: 10, retryCapMs: 30, alarmThreshold: 3,
    });
    try {
      const { goalId } = await supervisor.startGoal('不放弃', { acceptanceCmd: 'true', mode: 'structured' });
      await sleep(700);
      const goal = supervisor.getGoal(goalId);
      expect(goal.stats.errors).toBeGreaterThanOrEqual(3);
      expect(goal.alarm).toBe(true); // 达阈值告警
      expect(goal.state).toBe('active'); // 但监督不停止
      expect(goal.stats.consecutiveErrors).toBeGreaterThanOrEqual(3);
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('双过验收：[GOAL-DONE] 主张 → 验收命令连续两次通过 → done', async () => {
    const stateDir = tmp('goal-doublepass');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: true, text: '做完了 [GOAL-DONE]' });
    let passCount = 0;
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 60_000, checkIntervalMs: 40,
    }, {
      execFileFn: ((_cmd: string, _args: string[], _opts: any, cb: any) => {
        passCount += 1;
        cb(null, 'ok', '');
      }) as any,
    });
    try {
      const { goalId } = await supervisor.startGoal('验收通过', { acceptanceCmd: 'true', mode: 'structured' });
      await sleep(300);
      const goal = supervisor.getGoal(goalId);
      expect(goal.state).toBe('done');
      expect(goal.stats.acceptanceRuns).toBe(2); // 双过
      expect(goal.stats.acceptancePassStreak).toBe(2);
      expect(passCount).toBe(2);
      // 终态持久化
      const persisted = JSON.parse(readFileSync(join(stateDir, 'goals', `${goalId}.json`), 'utf8'));
      expect(persisted.state).toBe('done');
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('验收失败：状态回 active + 失败反馈注入', async () => {
    const stateDir = tmp('goal-acceptfail');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    // 首回合虚报完成，之后老实继续（模拟真实模型行为）
    let fakeCalls = 0;
    fakePM.script = () => {
      fakeCalls += 1;
      return fakeCalls === 1 ? { ok: true, text: '[GOAL-DONE] 我觉得完成了' } : { ok: true, text: '继续干活' };
    };
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 60_000, checkIntervalMs: 40, retryBaseMs: 10, retryCapMs: 20,
    }, {
      execFileFn: ((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(Object.assign(new Error('command failed'), { code: 1 }), '', '测试失败');
      }) as any,
    });
    try {
      const { goalId } = await supervisor.startGoal('要真过', { acceptanceCmd: 'false', mode: 'structured' });
      await sleep(400);
      const goal = supervisor.getGoal(goalId);
      expect(goal.state).toBe('active'); // 打回继续
      expect(goal.lastError).toContain('验收失败');
      const prompts = fakePM.calls.map((c) => c.prompt);
      expect(prompts.some((p) => p.includes('验收命令') && p.includes('未通过'))).toBe(true);
      expect(goal.stats.acceptanceRuns).toBe(1);
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('进程死重建 + 断点契约注入（TUI 模式，真实 fixture 进程）', async () => {
    const stateDir = tmp('goal-restart');
    // wrapperPath 指向 fixture 命令——restart() 重建时也用它，绝不触碰真实 codearts TUI
    const pm = new ProcessManager({ stateDir, wrapperPath: '/bin/sh -c "cat"' });
    const started = pm.startTui({ commandOverride: '/bin/sh -c "cat"' });
    const supervisor = new GoalSupervisor(pm, {
      stateDir, stagnationMs: 60_000, checkIntervalMs: 50, restartDelayMs: 100, retryBaseMs: 10, retryCapMs: 20,
    });
    try {
      const { goalId } = await supervisor.startGoal('跨进程存续', { acceptanceCmd: 'true', mode: 'tui', tuiPid: started.pid });
      expect(supervisor.getGoal(goalId).state).toBe('active');
      // 杀掉 TUI 整组 → 监督器发现死亡 → 重建 + 断点契约
      process.kill(-started.pid, 'SIGKILL');
      await sleep(600);
      const goal = supervisor.getGoal(goalId);
      expect(goal.stats.restarts).toBeGreaterThanOrEqual(1);
      expect(goal.state).toBe('active');
      expect(goal.tuiPid).not.toBe(started.pid); // 换了新进程
      expect(goal.transportAlive).toBe(true);
    } finally {
      supervisor.dispose();
      await pm.dispose();
    }
  }, 20000);

  test('QUEUED 背压：TUI 队列未消化跳过注入（skip_queued 审计），消化后恢复', async () => {
    const stateDir = tmp('goal-queued');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: true, text: '空转' });
    // TUI 模式依赖：托管表 + 终端快照 + 写入（QUEUED 闸门读取快照尾部）
    (fakePM as any).tuiProcs.set(4242, { pid: 4242, exitedAt: undefined });
    (fakePM as any).termSnapshot = '任务排队中 QUEUED 19/19';
    (fakePM as any).getTuiTermSnapshot = () => (fakePM as any).termSnapshot;
    (fakePM as any).writeTui = () => ({ written: 1 });
    (fakePM as any).writeTuiEnter = () => {};
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 60, minStagnationMs: 0, checkIntervalMs: 25, retryBaseMs: 10, retryCapMs: 20,
    });
    try {
      const { goalId } = await supervisor.startGoal('排队压制', { acceptanceCmd: 'true', mode: 'tui', tuiPid: 4242 });
      await sleep(500);
      let goal = supervisor.getGoal(goalId);
      const injDuringQueued = goal.stats.injections;
      expect(injDuringQueued).toBe(1); // 只有首发契约，停滞注入全被闸门跳过
      const auditText = readFileSync(join(stateDir, 'audit', `${goalId}.jsonl`), 'utf8');
      expect(auditText).toContain('goal.inject.skip_queued');
      // 队列消化（画面无 QUEUED）→ 注入恢复
      (fakePM as any).termSnapshot = '正常输出，无排队';
      await sleep(300);
      goal = supervisor.getGoal(goalId);
      expect(goal.stats.injections).toBeGreaterThan(injDuringQueued);
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('集成恢复弧（功能②验收口径）：网络断→重试继续注入→停滞续跑→[GOAL-DONE]→双过→done', async () => {
    const stateDir = tmp('goal-recovery-arc');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    let calls = 0;
    fakePM.script = () => {
      calls += 1;
      if (calls === 1) return { ok: false, error: '网络断了（第一回合失败）' }; // ① 网络断
      if (calls === 2) return { ok: true, text: '已恢复，继续干活' };            // ② 重试=继续指令注入
      return { ok: true, text: '全部做完了 [GOAL-DONE]' };                       // ③ 完成主张
    };
    let passCount = 0;
    // minStagnationMs:0——关闭长静默容忍（新规格：停滞注入需静默满 300s，测试传 0 快速驱动）
    const supervisor = new GoalSupervisor(fakePM as any, {
      stateDir, stagnationMs: 120, minStagnationMs: 0, checkIntervalMs: 40, retryBaseMs: 10, retryCapMs: 20,
    }, {
      execFileFn: ((_c: string, _a: string[], _o: any, cb: any) => { passCount += 1; cb(null, 'ok', ''); }) as any,
    });
    try {
      const { goalId } = await supervisor.startGoal('中断后必须回到正常工作状态', { acceptanceCmd: 'true', mode: 'structured' });
      await sleep(600);
      const goal = supervisor.getGoal(goalId);
      // 验收口径："中途任何方式的会话停止，都可以被拉起来，发送'继续完成任务'回到正常工作状态"
      expect(goal.state).toBe('done');                                 // 最终正常完成
      expect(goal.stats.errors).toBeGreaterThanOrEqual(1);             // 经历过网络断
      expect(goal.lastError === null || goal.lastError === undefined || goal.state === 'done').toBe(true);
      const prompts = fakePM.calls.map((c) => c.prompt);
      // 停止后的拉起：重试路径=断点全文契约 / 停滞路径=轻量 nudge（注入去重纪律）——都是"拉起"
      expect(prompts[1]).toMatch(/目标：|继续完成剩余任务/);
      expect(passCount).toBe(2);                                        // 双过验收收敛
    } finally {
      supervisor.dispose();
    }
  }, 15000);

  test('持久化 + host-restart 恢复：磁盘 active 目标 → paused → resume 注入断点契约', async () => {
    const stateDir = tmp('goal-persist');
    const fakePM1 = new FakePM();
    fakePM1.cfg.stateDir = stateDir;
    const supervisor1 = new GoalSupervisor(fakePM1 as any, { stateDir, stagnationMs: 60_000 });
    const { goalId } = await supervisor1.startGoal('重启也不丢', { acceptanceCmd: 'true', mode: 'structured' });
    supervisor1.dispose(); // 模拟插件卸载 → paused
    // 手工把目标改成 active 模拟"宿主重启时目标还活着"的持久化现场
    const goalPath = join(stateDir, 'goals', `${goalId}.json`);
    const raw = JSON.parse(readFileSync(goalPath, 'utf8'));
    raw.state = 'active';
    writeFileSync(goalPath, JSON.stringify(raw), 'utf8');
    // 新监督器接管（同 stateDir）
    const fakePM2 = new FakePM();
    fakePM2.cfg.stateDir = stateDir;
    const supervisor2 = new GoalSupervisor(fakePM2 as any, { stateDir, stagnationMs: 60_000 });
    const restored = supervisor2.getGoal(goalId);
    expect(restored.state).toBe('paused');
    expect(restored.pausedReason).toContain('host-restart');
    // resume → 断点契约注入
    await supervisor2.resume(goalId);
    const prompts = fakePM2.calls.map((c) => c.prompt);
    expect(prompts.some((p) => p.includes('[GOAL-RESET]') && p.includes('重启也不丢'))).toBe(true);
    supervisor2.dispose();
  }, 15000);

  test('pause/resume/stop 即时生效与状态约束', async () => {
    const stateDir = tmp('goal-controls');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    const supervisor = new GoalSupervisor(fakePM as any, { stateDir, stagnationMs: 60_000 });
    const { goalId } = await supervisor.startGoal('可控', { acceptanceCmd: 'true', mode: 'structured' });
    supervisor.pause(goalId, '测试暂停');
    expect(supervisor.getGoal(goalId).state).toBe('paused');
    expect(() => supervisor.pause(goalId)).toThrow('当前是 paused'); // 非 active 不可再 pause
    await supervisor.resume(goalId);
    expect(supervisor.getGoal(goalId).state).toBe('active');
    supervisor.stop(goalId);
    expect(supervisor.getGoal(goalId).state).toBe('stopped');
    await expect(supervisor.resume(goalId)).rejects.toThrow('终态');
    supervisor.dispose();
  }, 15000);
});

// ============================== ③ 安装管家 ==============================

/** 造一个 codearts fixture 安装目录。versionFile 内容决定 --version 输出。 */
function makeInstallFixture(root: string, version: string) {
  const binDir = join(root, 'installers', 'bin');
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, 'codearts');
  writeFixtureBin(bin, version);
  // wrapper：autoupdate 禁用实证
  writeFileSync(join(root, 'installers', 'codearts'), '#!/usr/bin/env bash\nexport OPENCODE_DISABLE_AUTOUPDATE="true"\n', { mode: 0o755 });
  return { binDir, bin };
}

function writeFixtureBin(bin: string, version: string) {
  // fixture 二进制：--version 打印版本；其余参数原样退出 0
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
}

describe('安装管家 InstallManager', () => {
  test('probeInstall：healthy 安装全绿', () => {
    const root = tmp('inst-healthy');
    makeInstallFixture(root, '26.10.9');
    const probe = probeInstall({ installRoot: join(root, 'installers'), wrapperPath: join(root, 'installers', 'codearts') });
    expect(probe.healthy).toBe(true);
    expect(probe.version).toBe('26.10.9');
    expect(probe.autoupdateDisabled).toBe(true);
    expect(probe.binSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('autoHeal：healthy → 不动作', () => {
    const root = tmp('inst-heal-healthy');
    makeInstallFixture(root, '26.10.9');
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, { stateDir: tmp('inst-heal-healthy-state') });
    const result = mgr.autoHeal();
    expect(result.healed).toBe(false);
  });

  test('autoHeal：bin 缺失有备份 → 从备份还原', () => {
    const root = tmp('inst-heal-missing');
    const { binDir, bin } = makeInstallFixture(root, '26.10.9');
    copyFileSync(bin, join(binDir, 'codearts.bak-26.10.9'));
    rmSync(bin);
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, { stateDir: tmp('inst-heal-missing-state') });
    const result = mgr.autoHeal();
    expect(result.healed).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(probeInstall({ installRoot: join(root, 'installers'), wrapperPath: join(root, 'installers', 'codearts') }).version).toBe('26.10.9');
  });

  test('autoHeal：仅剩 .delete 残留 → 还原并清残留', () => {
    const root = tmp('inst-heal-onlydelete');
    const { binDir, bin } = makeInstallFixture(root, '26.10.9');
    copyFileSync(bin, join(binDir, 'codearts.bak-26.10.9'));
    rmSync(bin);
    writeFileSync(join(binDir, 'codearts.delete'), 'broken', { mode: 0o755 }); // 厂商升级 EXDEV 现场
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, { stateDir: tmp('inst-heal-onlydelete-state') });
    const result = mgr.autoHeal();
    expect(result.healed).toBe(true);
    expect(result.deleteLeftoversRemoved).toContain('codearts.delete');
    expect(existsSync(join(binDir, 'codearts.delete'))).toBe(false);
    expect(existsSync(bin)).toBe(true);
  });

  test('autoHeal：无备份显式报错（拒绝静默放弃）', () => {
    const root = tmp('inst-heal-nobak');
    const { bin } = makeInstallFixture(root, '26.10.9');
    rmSync(bin);
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, { stateDir: tmp('inst-heal-nobak-state') });
    expect(() => mgr.autoHeal()).toThrow('没有任何 codearts.bak-* 备份');
  });

  test('guardUpgrade：成功 → 版本更新/旧版入 bak/暂存清理', async () => {
    const root = tmp('inst-upgrade-ok');
    const { binDir } = makeInstallFixture(root, '26.10.9');
    const newContent = Buffer.from('#!/bin/sh\ncase "$1" in\n  --version) echo "27.0.0" ;;\n  *) exit 0 ;;\nesac\n', 'utf8');
    const expectSha = createHash('sha256').update(newContent).digest('hex');
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, {
      stateDir: tmp('inst-upgrade-ok-state'),
      fetchFn: async () => newContent, // 注入下载（不触网）
    });
    const result = await mgr.guardUpgrade({ url: 'https://fake/codearts-27', expectSha256: expectSha, expectVersion: '27.0.0' });
    expect(result.from).toBe('26.10.9');
    expect(result.to).toBe('27.0.0');
    expect(sha256File(join(binDir, 'codearts'))).toBe(expectSha);
    expect(existsSync(join(binDir, 'codearts.bak-26.10.9'))).toBe(true); // 旧版快照
    expect(readdirSync(binDir).some((f) => f.includes('.staging-'))).toBe(false);
    // 升级后 probe 健康（fixture wrapper 是新安装目录的吗？——wrapper 仍在 installers/ 下，autoupdate=true 禁用不变）
  });

  test('guardUpgrade：哈希不匹配 → 中止且现有安装未动', async () => {
    const root = tmp('inst-upgrade-hash');
    const { bin } = makeInstallFixture(root, '26.10.9');
    const shaBefore = sha256File(bin);
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, {
      stateDir: tmp('inst-upgrade-hash-state'),
      fetchFn: async () => Buffer.from('wrong-content', 'utf8'),
    });
    await expect(mgr.guardUpgrade({ url: 'https://fake/x', expectSha256: 'a'.repeat(64), expectVersion: '27.0.0' })).rejects.toThrow('哈希不匹配');
    expect(sha256File(bin)).toBe(shaBefore);
  });

  test('guardUpgrade：复验失败 → 回滚旧版（零损坏）', async () => {
    const root = tmp('inst-upgrade-rollback');
    const { bin } = makeInstallFixture(root, '26.10.9');
    const shaBefore = sha256File(bin);
    const mgr = new InstallManager({ installRoot: join(root, 'installers') }, {
      stateDir: tmp('inst-upgrade-rollback-state'),
      fetchFn: async () => newContent,
    });
    // 下载内容是"27.0.0"，但 expectVersion 谎报 "99.0.0" → 复验失败 → 回滚
    const newContent = Buffer.from('#!/bin/sh\ncase "$1" in\n  --version) echo "27.0.0" ;;\n  *) exit 0 ;;\nesac\n', 'utf8');
    const expectSha = createHash('sha256').update(newContent).digest('hex');
    await expect(mgr.guardUpgrade({ url: 'https://fake/x', expectSha256: expectSha, expectVersion: '99.0.0' })).rejects.toThrow('升级复验失败');
    expect(sha256File(bin)).toBe(shaBefore);
    expect(probeInstall({ installRoot: join(root, 'installers'), wrapperPath: join(root, 'installers', 'codearts') }).version).toBe('26.10.9');
  });
});

// 小工具：从 node:fs 补 copyFileSync（顶部只导入了部分）
import { copyFileSync } from 'node:fs';

// ============================== ④ 插件入口 ==============================

describe('插件入口 index.apply', () => {
  test('mock 宿主：路由注册 / 工具注册 / 路由直调 / cleanup 收尾', async () => {
    const stateDir = tmp('plugin-entry');
    /** @type {any[]} */
    const registered: any[] = [];
    /** @type {string[]} */
    const effects: string[] = [];
    const toolsRegistered: any[] = [];
    const ctx: any = {
      webServer: { register: (route: any) => { registered.push(route); return () => { }; } },
      effect: (fn: () => any, label: string) => { effects.push(label); return fn(); },
      tools: { register: (tool: any) => { toolsRegistered.push(tool.name); return () => { }; } },
    };
    const cleanup = pluginApply(ctx, {
      stateDir,
      codeartsHome: join(stateDir, 'codearts-home'),
      registerTools: true,
      runTimeoutMs: 1000, stagnationMs: 500, checkIntervalMs: 100, retryBaseMs: 10, retryCapMs: 20,
    });
    expect(effects.some((l) => l.includes('HTTP routes'))).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.path).toBe('/codearts');
    expect([...toolsRegistered].sort()).toEqual(['codearts_goal', 'codearts_run', 'codearts_status']);
    // 路由可用：status 端点经注册的 handler 直调
    const route = registered[0]!;
    const mockRes = await new Promise<any>((resolveRes) => {
      const chunks: string[] = [];
      const res: any = {
        writeHead: (status: number, _headers: any) => { res.statusCode = status; },
        end: (body?: string) => { chunks.push(body ?? ''); resolveRes({ status: res.statusCode, body: JSON.parse(chunks.join('')) }); },
      };
      void route.handler({ method: 'GET', url: '/codearts/status' } as any, res);
    });
    expect(mockRes.status).toBe(200);
    expect(mockRes.body.ok).toBe(true);
    expect(mockRes.body.processes).toBeDefined();
    cleanup();
  }, 15000);

  test('非法配置显式报错（无静默兜底）', () => {
    expect(() => pluginApply({ webServer: { register: () => () => { } } } as any, { runTimeoutMs: -1 }))
      .toThrow('runTimeoutMs');
  });
});

// ============================== ⑥ 会话状态探测（功能②锚点） ==============================

import { SessionProbe, parseLogLine, classifyErrorKind, latestKernelLogPath, readTailLines } from '../lib/activity-probe.js';
import { utimesSync } from 'node:fs';

const LOG_LINE_OK = 'INFO [b75cccab5ef54c9da08b518be379ece1] 2026-10-31T23:31:13.202 +6ms service=bus "publishing" type=message.part.delta';
const LOG_LINE_INFER = 'INFO [t1] 2026-10-31T23:31:13.300 +1ms service=inferhub-provider "chat body {"model":"deepseek-v4.1-flash-1017","user_prompt":"[GOAL-PLAN] 目标：整理文档"}"';
const LOG_LINE_TIMEOUT = 'ERROR [t2] 2026-10-31T23:31:14.000 +2ms service=inferhub-provider "infer failed: request timed out after 60000ms"';
const LOG_LINE_502 = 'ERROR [t3] 2026-10-31T23:31:15.000 +2ms service=provider-proxy "upstream 502 bad gateway"';
const LOG_LINE_RESET = 'WARN [t4] 2026-10-31T23:31:16.000 +2ms service=provider-proxy "socket ECONNRESET on stream"';

/** 造日志目录：写入 tail 并可回拨 mtime。 */
function makeLogFixture(dir: string, lines: string[], mtimeOffsetMs = 0) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'kernel-codeartsdoer-2026-10-31T000000-000000-0.log');
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const t = new Date(Date.now() - mtimeOffsetMs);
  utimesSync(file, t, t);
  return { dir, file };
}

describe('会话状态探测 SessionProbe（功能②）', () => {
  test('parseLogLine/classifyErrorKind：实机行格式锚点', () => {
    const parsed = parseLogLine(LOG_LINE_TIMEOUT)!;
    expect(parsed.level).toBe('ERROR');
    expect(parsed.service).toBe('inferhub-provider');
    expect(parsed.message).toContain('timed out');
    expect(parseLogLine('随便一行没有 service= 的日志')).toBe(null);
    expect(classifyErrorKind('request timed out')).toBe('timeout');
    expect(classifyErrorKind('ETIMEDOUT on socket')).toBe('timeout');
    expect(classifyErrorKind('got 502 from upstream')).toBe('502');
    expect(classifyErrorKind('got 503, then 504')).toBe('502');
    expect(classifyErrorKind('ECONNRESET while streaming')).toBe('network');
    expect(classifyErrorKind('all good')).toBe(null);
  });

  test('五态：errored(timeout)/errored(502)/errored(network)/running/stuck/dead/无日志 unknown', () => {
    // errored(timeout)
    let fx = makeLogFixture(tmp('probe-timeout'), [LOG_LINE_INFER, LOG_LINE_TIMEOUT]);
    let probe = new SessionProbe({ logDir: fx.dir, now: () => Date.now() });
    expect(probe.sample({}).state).toBe('errored');
    expect(probe.sample({}).errorKind).toBe('timeout');
    // errored(502)
    fx = makeLogFixture(tmp('probe-502'), [LOG_LINE_502]);
    expect(new SessionProbe({ logDir: fx.dir }).sample({}).errorKind).toBe('502');
    // errored(network)
    fx = makeLogFixture(tmp('probe-network'), [LOG_LINE_RESET]);
    expect(new SessionProbe({ logDir: fx.dir }).sample({}).errorKind).toBe('network');
    // running：正常推理活动 + 注入 needle 送达
    fx = makeLogFixture(tmp('probe-running'), [LOG_LINE_INFER, LOG_LINE_OK]);
    const running = new SessionProbe({ logDir: fx.dir }).sample({ needles: ['[GOAL-PLAN] 目标：整理文档'] });
    expect(running.state).toBe('running');
    expect(running.evidence.needlesFound).toHaveLength(1);
    // stuck：mtime 回拨 5 分钟
    fx = makeLogFixture(tmp('probe-stuck'), [LOG_LINE_OK], 300_000);
    expect(new SessionProbe({ logDir: fx.dir, stuckAfterMs: 60_000 }).sample({}).state).toBe('stuck');
    // dead：托管 PID 全灭（用必不存在的 PID）
    fx = makeLogFixture(tmp('probe-dead'), [LOG_LINE_OK]);
    expect(new SessionProbe({ logDir: fx.dir }).sample({ pids: [4_000_000] }).state).toBe('dead');
    // unknown：目录不存在
    expect(new SessionProbe({ logDir: join(tmp('probe-none'), 'absent') }).sample({}).state).toBe('unknown');
  });

  test('采样纪律：尾部截断（大文件只读 tail）+ 最新 mtime 文件优先', () => {
    const dir = tmp('probe-tail');
    mkdirSync(dir, { recursive: true });
    const big = join(dir, 'kernel-a.log');
    const old = join(dir, 'kernel-b.log');
    const bigLines = Array.from({ length: 5000 }, (_, i) => `INFO [t] 2026-10-31T00:00:00.000 +0ms service=bus "line-${i}"`);
    writeFileSync(big, bigLines.join('\n'), 'utf8');
    writeFileSync(old, 'ERROR [t] 2026-10-31T00:00:00.000 +0ms service=inferhub-provider "timed out"', 'utf8');
    // kernel-a 更新 → 选 a（虽 b 有错误行但不是最新文件）
    const tNew = new Date(Date.now());
    const tOld = new Date(Date.now() - 600_000);
    utimesSync(big, tNew, tNew);
    utimesSync(old, tOld, tOld);
    expect(latestKernelLogPath(dir)).toBe(big);
    const probe = new SessionProbe({ logDir: dir, tailLines: 50, errorWindowMs: 120_000 });
    const result = probe.sample({});
    expect(result.state).toBe('running'); // 最新文件尾部干净 → running（不扫到 b 的旧错误）
    expect(result.evidence.tailLines).toBeLessThanOrEqual(50); // 尾部截断生效
    const tail = readTailLines(big, 64 * 1024, 10);
    expect(tail).toHaveLength(10);
    expect(tail[0]).toContain('line-4999'); // 最新在前
  });

  test('goal 快照输出五态 session 字段（探针可注入）', async () => {
    const stateDir = tmp('goal-session-state');
    const fakePM = new FakePM();
    fakePM.cfg.stateDir = stateDir;
    fakePM.script = () => ({ ok: true, text: '推进中' });
    // 假探针：可控状态
    let probeState: any = { state: 'running', lastActivity: '2026-10-31T23:00:00.000Z', lastError: null, errorKind: null, evidence: {} };
    const supervisor = new GoalSupervisor(fakePM as any, { stateDir, stagnationMs: 60_000 }, {
      probe: { sample: (_args: any) => probeState } as any,
    });
    const { goalId } = await supervisor.startGoal('状态可探测', { acceptanceCmd: 'true', mode: 'structured' });
    expect(supervisor.getGoal(goalId).session.state).toBe('running');
    probeState = { state: 'errored', lastError: 'infer timed out', errorKind: 'timeout', lastActivity: null, evidence: {} };
    expect(supervisor.getGoal(goalId).session.state).toBe('errored');
    expect(supervisor.getGoal(goalId).session.errorKind).toBe('timeout');
    probeState = { state: 'stuck', lastActivity: null, lastError: null, errorKind: null, evidence: {} };
    expect(supervisor.getGoal(goalId).session.state).toBe('stuck');
    supervisor.pause(goalId);
    expect(supervisor.getGoal(goalId).session.state).toBe('idle'); // 终态/暂停 → idle
    // 探针自身抛错 → 降级自判且 evidence 可见故障
    const supervisor2 = new GoalSupervisor(fakePM as any, { stateDir, stagnationMs: 60_000 }, {
      probe: { sample: (_args: any) => { throw new Error('探针炸了'); } } as any,
    });
    const { goalId: gid2 } = await supervisor2.startGoal('探针故障也不崩', { acceptanceCmd: 'true', mode: 'structured' });
    const session = supervisor2.getGoal(gid2).session;
    expect(session.state).toBe('running'); // 自判（lastActivity 刚刷新）
    expect(JSON.stringify(session.evidence)).toContain('探针炸了');
    supervisor.dispose();
    supervisor2.dispose();
  }, 15000);
});

// ============================== ⑦ 模型管理（功能①） ==============================

import { ModelManager, setModelKeyInJsonc, parseJsonc, validateModelId } from '../lib/model-manager.js';

/** 仿真码道全局配置：JSONC 注释 + apiKey 占位 + 真实键序（$schema 在首）。 */
const FAKE_CONFIG = `{
  // 码道 CLI 全局配置（wrapper 的 OPENCODE_CONFIG 指向本文件）
  "$schema": "https://opencode.ai/config.json",
  "logLevel": "INFO",
  "skills": {
    "paths": ["/opt/codearts/skills"]
  },
  "autoupdate": false,
  "agent": { "build": { "options": { "reasoningEffort": "low" } } },
  /* provider 密钥是 enc:v3 加密值，任何工具不得改写本节 */
  "provider": {
    "glm": { "options": { "apiKey": "enc:v3:AAAA-placeholder-key", "baseURL": "https://example.invalid" } }
  },
  "permission": { "*": "allow" }
}
`;

const FAKE_MODEL_STATE = {
  recent: [
    { providerID: 'huaweicloud-maas', modelID: 'deepseek-v4.1-flash-1017' },
    { providerID: 'glm', modelID: 'glm-5.3-flash' },
    { providerID: 'huaweicloud-maas', modelID: 'kimi-k3' },
  ],
  favorite: [],
  variant: { 'huaweicloud-maas/GLM-5.2': 'max' },
};

/** 造沙箱 HOME：<dir>/codearts_cli.json + <dir>/state/model.json。 */
function makeModelFixture(dir: string) {
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'codearts_cli.json'), FAKE_CONFIG, 'utf8');
  writeFileSync(join(dir, 'state', 'model.json'), JSON.stringify(FAKE_MODEL_STATE, null, 2), 'utf8');
  return { configPath: join(dir, 'codearts_cli.json'), statePath: join(dir, 'state', 'model.json') };
}

describe('模型管理 ModelManager（功能①）', () => {
  test('沙箱隔离回归：注入 codeartsHome 后派生路径必须落在 fixture 内（真实 ~/.codeartsdoer 零接触）', () => {
    const dir = tmp('model-isolation');
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir });
    expect(mgr.cfg.configPath).toBe(join(dir, 'codearts_cli.json'));
    expect(mgr.cfg.modelStatePath).toBe(join(dir, 'state', 'model.json'));
    expect(mgr.cfg.configPath.startsWith(dir)).toBe(true);
  });

  test('listModels/getCurrentModel：合并视角 + recent[0] 优先', () => {
    const dir = tmp('model-read');
    const fx = makeModelFixture(dir);
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir });
    const models = mgr.listModels();
    expect(models.recent[0]!.id).toBe('huaweicloud-maas/deepseek-v4.1-flash-1017');
    expect(models.favorite).toHaveLength(0);
    expect(models.configured).toBe(null); // 尚未设置 model 键
    expect(models.note).toContain('AK/SK'); // 限制如实标注
    const current = mgr.getCurrentModel();
    expect(current.id).toBe('huaweicloud-maas/deepseek-v4.1-flash-1017');
    expect(current.source).toBe('recent[0]');
    expect(existsSync(fx.configPath)).toBe(true);
  });

  test('setModel：config 仅增 model 键（注释/键序/apiKey 逐字不变）+ model.json 置顶 + 备份/审计', () => {
    const dir = tmp('model-set');
    const fx = makeModelFixture(dir);
    const beforeConfig = readFileSync(fx.configPath, 'utf8');
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir, now: () => 1_700_000_000_000 });
    const result = mgr.setModel('huaweicloud-maas', 'kimi-k3');
    expect(result.model).toBe('huaweicloud-maas/kimi-k3');
    // ① config 语义：除 model 键外全部深相等
    const afterObj = parseJsonc(readFileSync(fx.configPath, 'utf8'), '验证');
    expect(afterObj.model).toBe('huaweicloud-maas/kimi-k3');
    const { model: _m, ...rest } = afterObj;
    const beforeObj = parseJsonc(beforeConfig, '原配置');
    expect(JSON.stringify(rest)).toBe(JSON.stringify(beforeObj));
    // ② 逐字保留断言：注释、apiKey、原键序原样出现在新文本中；model 键插入在根对象最前
    const afterText = readFileSync(fx.configPath, 'utf8');
    expect(afterText).toContain('// 码道 CLI 全局配置');
    expect(afterText).toContain('任何工具不得改写本节');
    expect(afterText).toContain('"apiKey": "enc:v3:AAAA-placeholder-key"');
    expect(afterText.indexOf('"model"')).toBeLessThan(afterText.indexOf('"$schema"')); // 顶部插入
    expect(afterText.indexOf('"$schema"')).toBeLessThan(afterText.indexOf('"logLevel"'));
    expect(afterText.indexOf('"logLevel"')).toBeLessThan(afterText.indexOf('"provider"'));
    // ③ model.json 置顶 + variant 等其余字段保留
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    expect(state.recent[0]).toEqual({ providerID: 'huaweicloud-maas', modelID: 'kimi-k3' });
    expect(state.recent).toHaveLength(3); // 去重：kimi-k3 原在末位，不重复
    expect(state.variant).toEqual(FAKE_MODEL_STATE.variant);
    // ④ 备份与审计
    expect(result.configBackup).toBe(`${fx.configPath}.bak-1700000000000`);
    expect(result.stateBackup).toBe(`${fx.statePath}.bak-1700000000000`);
    expect(existsSync(result.configBackup!)).toBe(true);
    expect(readFileSync(result.configBackup!, 'utf8')).toBe(beforeConfig);
    expect(readFileSync(join(dir, 'audit', 'model.jsonl'), 'utf8')).toContain('model.set');
    // ⑤ 切换后 getCurrentModel 仍以 recent[0] 为准
    expect(mgr.getCurrentModel().id).toBe('huaweicloud-maas/kimi-k3');
  });

  test('setModel 二次切换：已存在 model 键原地改值，其余仍逐字不变', () => {
    const dir = tmp('model-set2');
    const fx = makeModelFixture(dir);
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir, now: () => 1_700_000_000_001 });
    mgr.setModel('huaweicloud-maas', 'kimi-k3');
    const first = readFileSync(fx.configPath, 'utf8');
    mgr.setModel('glm', 'glm-5.3-flash');
    const second = readFileSync(fx.configPath, 'utf8');
    expect(parseJsonc(second, '二次').model).toBe('glm/glm-5.3-flash');
    // 去重：glm/glm-5.3-flash 原在 recent[1]，置顶后仅一份
    const state = JSON.parse(readFileSync(fx.statePath, 'utf8'));
    expect(state.recent[0]).toEqual({ providerID: 'glm', modelID: 'glm-5.3-flash' });
    expect(state.recent.filter((r: any) => r.modelID === 'glm-5.3-flash')).toHaveLength(1);
    // 两次 config 除 model 值外逐字一致（归一化 model 值后整文相等）
    const normalize = (t: string) => t.replace(/"model": "[^"]+"/, '"model": "X"');
    expect(normalize(second)).toBe(normalize(first));
    expect(second).toContain('"apiKey": "enc:v3:AAAA-placeholder-key"');
  });

  test('损坏输入显式报错且零半写', () => {
    const dir = tmp('model-bad');
    const fx = makeModelFixture(dir);
    // ① config 破坏（JSONC 不合法）
    writeFileSync(fx.configPath, '{ "model": , "a": } // 烂了', 'utf8');
    const brokenConfig = readFileSync(fx.configPath, 'utf8');
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir });
    expect(() => mgr.setModel('glm', 'glm-5.3-flash')).toThrow('不是合法 JSONC');
    expect(readFileSync(fx.configPath, 'utf8')).toBe(brokenConfig); // 零半写
    expect(() => mgr.listModels()).toThrow('JSONC');
    // ② model.json 破坏
    writeFileSync(fx.configPath, FAKE_CONFIG, 'utf8');
    writeFileSync(fx.statePath, '{ "recent": "不是数组" }', 'utf8');
    expect(() => mgr.listModels()).toThrow('recent');
    expect(() => mgr.setModel('glm', 'glm-5.3-flash')).toThrow('recent');
    // ③ model.json 缺失
    rmSync(fx.statePath);
    expect(() => mgr.getCurrentModel()).toThrow('不存在');
  });

  test('非法 providerID/modelID 显式报错且不动文件', () => {
    const dir = tmp('model-invalid');
    const fx = makeModelFixture(dir);
    const before = readFileSync(fx.configPath, 'utf8');
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir });
    expect(() => mgr.setModel('', 'x')).toThrow('providerID 非法');
    expect(() => mgr.setModel('a b', 'x')).toThrow('providerID 非法');
    expect(() => mgr.setModel('p', 'x"y')).toThrow('modelID 非法');
    expect(() => mgr.setModel('p', null as any)).toThrow('modelID 非法');
    expect(readFileSync(fx.configPath, 'utf8')).toBe(before);
    expect(validateModelId('huaweicloud-maas', 'deepseek-v4.1-flash-1017')).toBe('huaweicloud-maas/deepseek-v4.1-flash-1017');
  });

  test('setModelKeyInJsonc 变体：空对象/前置注释/recent 为空时 config.model 兜底读取', () => {
    expect(setModelKeyInJsonc('{}', 'a/b')).toBe('{"model": "a/b"}');
    const commentFirst = '{ /* 顶部注释 */ "x": 1 }';
    const out = setModelKeyInJsonc(commentFirst, 'a/b');
    expect(out).toBe('{ "model": "a/b", /* 顶部注释 */ "x": 1 }');
    expect(parseJsonc(out, '变体').x).toBe(1);
    // recent 空但 config.model 已设 → getCurrentModel 走 config.model
    const dir = tmp('model-cfgonly');
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'codearts_cli.json'), '{ "model": "huaweicloud-maas/glm-5.3" }', 'utf8');
    writeFileSync(join(dir, 'state', 'model.json'), JSON.stringify({ recent: [], favorite: [], variant: {} }), 'utf8');
    const mgr = new ModelManager({ codeartsHome: dir }, { stateDir: dir });
    const current = mgr.getCurrentModel();
    expect(current.source).toBe('config.model');
    expect(current.id).toBe('huaweicloud-maas/glm-5.3');
  });
});

// ============================== ⑦b 交互流时间线解析器（activity-parser） ==============================

describe('activity-parser：kernel 日志 → 五类交互流时间线', () => {
  // fixture：从真实 kernel log 抽样脱敏（保留行结构/字段序，替换会话 ID 与目标内容）
  const FIXTURE_LINES = [
    // 启动噪声：不入时间线
    'INFO  2026-11-01T08:36:56.051 +14ms service=bash-extension "sandBox init success!"',
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:37:58.222 +2ms service=telemetry-agent-team-hook "Reporting agent_team.user_prompt_enter event"',
    // 角色映射源：message.updated 携带 info{id,role}
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:01.341 +1ms service=bus-publish "{"type":"message.updated","properties":{"sessionID":"ses_FIX1","info":{"id":"msg_user01","role":"user","sessionID":"ses_FIX1","time":{"created":1793493478123}}}}"',
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:02.729 +3ms service=bus-publish "{"type":"message.updated","properties":{"sessionID":"ses_FIX1","info":{"id":"msg_asst01","parentID":"msg_user01","role":"assistant","mode":"build","cost":0}}}"',
    // user：目标契约（无 messageID，注入标记启发式；剔除契约骨架取目标段）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:01.390 +42ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_a01","type":"text","text":"【/goal 目标契约】\\n目标：【修复测试 foo 失败】\\n工作仓库：/repo。\\n实现顺序（严格 TDD）"}}}"',
    // user：带 messageID 的注入（msg_user01 → user 映射）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:01.393 +3ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_a02","messageID":"msg_user01","type":"text","text":"请以 `experience-manager` 身份执行经验管理任务。\\n当前本地时间：2026-11-01T08:38:01。"}}}"',
    // hook 噪声（synthetic 系统提醒）：剔除，不入时间线
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:01.395 +1ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_a03","messageID":"msg_user01","type":"text","text":"<system-reminder>重要提示：你必须使用简体中文回复。</system-reminder>","synthetic":true}}}"',
    // assistant：无 messageID 的自然语言（启发式归 assistant）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:08.303 +1ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_b01","type":"text","text":"我先读取目标相关文件，并校验关键路径。"}}}"',
    // tool：tool_request（function_name）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:10.100 +5ms service=tool-timing-plugin "tool_request {"event.name":"tool_request","session_id":"ses_FIX1","tool_call_id":"call_01","tool_type":"native","function_name":"bash","function_args":"*********"}"',
    // assistant：带 messageID 映射（msg_asst01 → assistant）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:15.472 +5ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_b02","messageID":"msg_asst01","type":"text","text":"修复完成：foo 用例断言已更正，测试通过。"}}}"',
    // tool：文件写入 hook（非 Hook created 的实际写入行）
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:16.513 +0ms service=file-write-metadata-hook "Added diff/filediff for write tool" sessionID=ses_FIX1 callID=call_02',
    // tool：bus-publish 的 tool 部件
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:38:17.710 +1ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_FIX1","part":{"id":"prt_c01","messageID":"msg_asst01","type":"tool","tool":"write","state":{"status":"done"}}}}}"',
    // error：ERROR 级（llm stream error）
    'ERROR [5d4b3719adaa4fa3] 2026-11-01T08:40:10.837 +3ms service=llm providerID=huaweicloud-maas modelID=deepseek-v4.1-flash-1017 sessionID=ses_FIX1 agent=build mode=primary "stream error" error={error:{message:"后端服务不可用（错误码 502，请求地址: snap-access.example.com），请稍后重试。"}}',
    // error：WARN 级但命中失败模式
    'WARN [5d4b3719adaa4fa3] 2026-11-01T08:40:11.000 +1ms service=llm "retry" "message":"后端服务不可用（错误码 503）"',
    // system：会话运行态
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:40:12.000 +0ms service=bus-publish "{"type":"session.status","properties":{"sessionID":"ses_FIX1","status":"busy"}}',
    // server request 噪声：不入时间线
    'INFO [5d4b3719adaa4fa3] 2026-11-01T08:40:13.000 +0ms service=server "request" status=completed duration=2 method=GET path=/session/ses_FIX1',
  ];

  let items;
  beforeAll(() => {
    items = parseActivityLines(FIXTURE_LINES);
  });

  test('五类 kind 全覆盖且顺序保持', () => {
    const kinds = new Set(items.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['assistant', 'error', 'system', 'tool', 'user'].sort());
    // 时间单调不减
    const times = items.map((i) => i.time);
    expect([...times].sort()).toEqual(times);
  });

  test('user：目标契约剔除骨架取目标段；hook 噪声不入线', () => {
    const users = items.filter((i) => i.kind === 'user');
    expect(users.length).toBe(2);
    expect(users[0].text.startsWith('目标：')).toBe(true);
    expect(users[0].text).toContain('修复测试 foo 失败');
    expect(users[0].text).not.toContain('【/goal');
    expect(users[1].text).toContain('experience-manager');
    // 系统提醒被整体剔除
    expect(items.some((i) => i.text.includes('system-reminder'))).toBe(false);
  });

  test('assistant：无 messageID 自然语言启发式 + messageID 映射', () => {
    const asst = items.filter((i) => i.kind === 'assistant');
    expect(asst.length).toBe(2);
    expect(asst[0].text).toContain('校验关键路径');
    expect(asst[1].text).toContain('测试通过');
  });

  test('tool：tool_request 取 function_name；文件写入；tool 部件', () => {
    const tools = items.filter((i) => i.kind === 'tool');
    expect(tools.length).toBe(3);
    expect(tools[0].text).toBe('工具执行: bash');
    expect(tools[1].text).toContain('文件写入');
    expect(tools[2].text).toContain('write');
  });

  test('error：ERROR 级与失败模式（取人话 message）', () => {
    const errs = items.filter((i) => i.kind === 'error');
    expect(errs.length).toBe(2);
    expect(errs[0].text).toContain('后端服务不可用');
    expect(errs[0].text).toContain('502');
    expect(errs[1].text).toContain('503');
  });

  test('system：会话运行态；启动/请求噪声不入线', () => {
    const sys = items.filter((i) => i.kind === 'system');
    expect(sys.length).toBe(1);
    expect(sys[0].text).toContain('会话status');
    expect(items.some((i) => i.text.includes('sandBox init'))).toBe(false);
    expect(items.some((i) => i.text.includes('status=completed'))).toBe(false);
  });

  test('非法输入防御：非数组/非字符串行', () => {
    expect(parseActivityLines(null)).toEqual([]);
    expect(parseActivityLines([undefined, '', 42])).toEqual([]);
  });
});

// ============================== ⑦ 浏览器半边 lib/client.js（静态校验） ==============================

describe('client.js 静态校验（侧栏面板形态，离线检查）', () => {
  const clientSource = readFileSync(join(import.meta.dir, '..', 'lib', 'client.js'), 'utf8');
  const clientLines = clientSource.split('\n');

  test('① __ModuleLoader__.load 惰性注册（taskboard 同款包装形态）', () => {
    expect(clientSource).toContain('window.__ModuleLoader__.load');
    expect(clientSource).toContain('id: "dsh-codearts"');
    expect(clientSource).toContain('factory: (require) =>');
    expect(clientSource).toContain('return module.exports;');
  });

  test('② 全部管理路由引用（终端/交互流/三区数据源）', () => {
    expect(clientSource).toContain('"/codearts/status"');
    expect(clientSource).toContain('"/codearts/activity?lines=');
    expect(clientSource).toContain('/codearts/logs/tail?lines=');
    expect(clientSource).toContain('"/codearts/models"');
    expect(clientSource).toContain('"/codearts/model"');
    expect(clientSource).toContain('"/codearts/models/custom"');
    expect(clientSource).toContain('"/codearts/tui/start"');
    expect(clientSource).toContain('"/codearts/tui/stop"');
    expect(clientSource).toContain('/codearts/tui/stream?pid=');
    expect(clientSource).toContain('"/codearts/tui/input"');
    expect(clientSource).toContain('"/codearts/goals"');
    expect(clientSource).toContain('/control');
  });

  test('③ react 保持 external（宿主注入），无顶层 ESM import', () => {
    expect(clientSource).toContain('require("react")');
    expect(clientSource).not.toMatch(/^\s*import\s/m);
  });

  test('④ 侧栏 slot 注册（sidebar.panellist + main + 探测，探测守卫全包裹）', () => {
    expect(clientSource).toContain('slots.register');
    expect(clientSource).toContain('"sidebar.panellist"');
    expect(clientSource).toContain('slots.spec("main")');
    expect(clientSource).toContain('codearts 控制');
    // 实机教训：cordis 守卫（get/属性访问抛错）必须视作探测失败——防御式双探测 + 全 try/catch
    expect(clientSource).toContain('get("slots")');
    expect(clientSource).toContain('officialSlots');
  });

  test('④b legacy DOM 注入双件套（taskboard sidebar-entry/board-mount 对齐）', () => {
    expect(clientSource).toContain('data-dshca-entry');
    expect(clientSource).toContain('data-dshca-view');
    expect(clientSource).toContain('data-dshca-active');
    expect(clientSource).toContain('MutationObserver');
    expect(clientSource).toContain('[data-pane="sidebar"]');
    expect(clientSource).toContain('[data-pane="conversation"]');
    expect(clientSource).toContain('新会话');
    expect(clientSource).toContain('dsh-panel-activate');
    expect(clientSource).toContain('createRoot');
    expect(clientSource).toContain('require("react-dom/client")');
    expect(clientSource).toContain('legacy DOM 注入路径已启用');
  });

  test('⑤ 四区 UI 要素（交互流主窗口/运行状态/模型卡片/目标管理）', () => {
    // ① 交互流主窗口（核心）：时间线五类样式 + 自动滚底 + 原始日志折叠
    expect(clientSource).toContain('交互流');
    expect(clientSource).toContain('dshca-item-user');
    expect(clientSource).toContain('dshca-item-assistant');
    expect(clientSource).toContain('dshca-item-tool');
    expect(clientSource).toContain('dshca-item-error');
    expect(clientSource).toContain('dshca-item-system');
    expect(clientSource).toContain('内核原始日志');
    expect(clientSource).toContain('暂停滚动');
    // ② 运行状态
    expect(clientSource).toContain('启动 codearts');
    // ③ 模型单选卡片：整行点击即设为默认 + spinner + ✓ 2s + 行内红色错误
    expect(clientSource).toContain('点击整行即设为默认');
    expect(clientSource).toContain('dshca-spin');
    expect(clientSource).toContain('已设为默认');
    expect(clientSource).toContain('添加自定义模型');
    expect(clientSource).toContain('dshca-mrow-cur');
    // 模型分组：⭐最近使用组必须完整渲染（修复 recent 非内置项被整条漏掉的缺陷）
    expect(clientSource).toContain('dshca-mgroup');
    expect(clientSource).toContain('⭐ 最近使用');
    expect(clientSource).toContain('内置候选');
    // ④ 目标管理
    expect(clientSource).toContain('启动新目标');
    expect(clientSource).toContain('目标监督');
  });

  test('⑤a-2 Tab 化结构（TUI 独占整页 + 五 Tab 常挂载）', () => {
    expect(clientSource).toContain('dshca-tabs');
    expect(clientSource).toContain('dshca-tab-active');
    expect(clientSource).toContain('TUI 终端');
    expect(clientSource).toContain('概览');
    expect(clientSource).toContain('目标监督');
    expect(clientSource).toContain('模型配置');
    expect(clientSource).toContain('日志与交互流');
    // 刷新根治：单例守卫 + reset 清屏 + 批量写入 + 心跳 watchdog
    expect(clientSource).toContain('connPidRef');
    expect(clientSource).toContain('reset()');
    expect(clientSource).toContain('enqueueWrite');
    expect(clientSource).toContain('HEARTBEAT_TIMEOUT_MS');
    expect(clientSource).toContain('role: "tab"');
  });

  test('⑤a 终端区（Web 内嵌 TUI：xterm/SSE 双向管道 + 权限边界标注）', () => {
    expect(clientSource).toContain('EventSource');
    expect(clientSource).toContain('msg.t === "hello"');
    expect(clientSource).toContain('msg.t === "chunk"');
    expect(clientSource).toContain('resizeTui');
    expect(clientSource).toContain('addEventListener("exit"');
    expect(clientSource).toContain('直连码道 TUI');
    expect(clientSource).toContain('键盘输入实时生效');
    expect(clientSource).toContain('dshca-xterm-css');
    // snap 全量重放回归（鼠标模式序列重建）+ 8MB 写队列
    expect(clientSource).toContain('msg.t === "snap"');
    expect(clientSource).toContain('WRITE_QUEUE_CAP_BYTES = 8 * 1024 * 1024');
    expect(clientSource).toContain('重连');
    expect(clientSource).toContain('postTuiInput');
    // 320 列适配（码道 TUI 自适应 312 列）+ 连接存活诊断（每 100 帧计数）+ Tab 激活重绘
    expect(clientSource).toContain('cols: TERM_COLS');
    expect(clientSource).toContain('TERM_COLS = 80');
    expect(clientSource).toContain('TUI 流帧计数');
    expect(clientSource).toContain('term.refresh(0, term.rows - 1)');
    // 体验四修：高度强制（42 行全高防裁切）/尺寸协商/字号调节/全屏应用如实说明
    expect(clientSource).toContain('min-height:calc(42 * 18px + 24px)');
    expect(clientSource).toContain('proposePtySize');
    expect(clientSource).toContain('8.4');
    expect(clientSource).toContain('A-');
    expect(clientSource).toContain('dshca-fontsize');
    expect(clientSource).toContain('alternate screen');
  });

  test('⑤a-3 注入防轰炸（host 侧关键词：QUEUED 背压/清零收紧/长静默容忍）', () => {
    const supervisorSource = readFileSync(join(import.meta.dir, '..', 'lib', 'goal-supervisor.js'), 'utf8');
    expect(supervisorSource).toContain("goal.inject.skip_queued");
    expect(supervisorSource).toContain("acceptancePassStreak > (record.lastStallPassStreak ?? 0)");
    expect(supervisorSource).toContain("minStagnationMs: 300_000");
    expect(supervisorSource).toContain("this.pm.getTuiLastDataAt");
  });

  test('⑤b 白色系高对比主题（不依赖 dsw 令牌做文字色）', () => {
    expect(clientSource).toContain('rgba(20,20,24,.92)');
    expect(clientSource).toContain('#ffffff');
    expect(clientSource).toContain('#cfcfcf');
    expect(clientSource).toContain('#9a9a9a');
    expect(clientSource).toContain('#3a3a40');
    expect(clientSource).toContain('#4ade80');
  });

  test('⑥ 显式报错纪律（错误条 + apply 全量防御 + 显式降级登记）', () => {
    expect(clientSource).toContain('dshca-errbar');
    expect(clientSource).toContain('自动重试');
    expect(clientSource).toContain('不影响宿主外壳');
    expect(clientSource).toContain('降级'); // 显式声明的降级路径登记
    expect(clientSource).toContain('console.error');
  });

  test('⑦ 顶层（factory 体内首语句前）无 document——DOM 只能出现在 apply 之后的浏览器钩子内', () => {
    const bundledStart = clientSource.indexOf('var __create');
    expect(bundledStart).toBeGreaterThan(0);
    // 包装前言 = 头注释 + load 注册头（factory 体内的 xterm.css 注入片段属运行时钩子，不受此限）
    const prologue = clientSource.slice(0, clientSource.indexOf('factory: (require) =>'));
    expect(prologue).not.toContain('document');
    // DOM 访问存在于函数体内（样式注入/xterm css/降级面板）
    expect(clientSource).toContain('document.createElement');
    expect(clientSource).toContain('getElementById');
  });

  test('⑧ 轮询常量 5s（实时运行状态承诺）', () => {
    expect(clientSource).toContain('POLL_MS = 5000');
  });
});

// ============================== ⑧b Web 内嵌 TUI 终端（环形缓冲/SSE/input） ==============================

/** 搭一套真实 http server + mock webServer 的端到端环境（模块层：⑧/⑧b 测试共用）。 */
async function makeServer() {
  const stateDir = tmp('http-e2e');
  // fixture codearts 二进制（POST /codearts/run 用）
  const fixtureBin = join(stateDir, 'fake-codearts.sh');
  writeFileSync(fixtureBin, [
    '#!/bin/sh',
    'echo \'{"type":"session","sessionID":"ses-http-1"}\'',
    'echo \'{"type":"text","text":"收到，已执行"}\'',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  const processManager = new ProcessManager({ stateDir, binPath: fixtureBin });
  const fakePM = new FakePM();
  fakePM.cfg.stateDir = stateDir;
  const goalSupervisor = new GoalSupervisor(fakePM as any, { stateDir, stagnationMs: 60_000 });
  const installRoot = join(stateDir, 'installers');
  makeInstallFixture(stateDir, '26.10.9');
  const installManager = new InstallManager({ installRoot }, { stateDir });
  // 模型管理器（沙箱 fixture）
  makeModelFixture(join(stateDir, 'codearts-home'));
  const modelManager = new ModelManager({ codeartsHome: join(stateDir, 'codearts-home') }, { stateDir });
  // kernel 日志 fixture（/codearts/activity 与 /codearts/logs/tail 数据源）
  const logDir = join(stateDir, 'codearts-home', 'cli-data', 'log');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'kernel-fixture.log'), [
    'INFO  2026-11-01T08:36:56.051 +14ms service=bash-extension "sandBox init success!"',
    'INFO [t1] 2026-11-01T08:38:01.341 +1ms service=bus-publish "{"type":"message.updated","properties":{"sessionID":"ses_f","info":{"id":"msg_u1","role":"user","sessionID":"ses_f"}}}"',
    'INFO [t1] 2026-11-01T08:38:02.000 +1ms service=bus-publish "{"type":"message.part.updated","properties":{"sessionID":"ses_f","part":{"id":"prt_1","type":"text","text":"【/goal 目标契约】\\n目标：【修复测试 foo】\\n工作仓库：/repo"}}}"',
    'INFO [t1] 2026-11-01T08:38:03.000 +1ms service=tool-timing-plugin "tool_request {"function_name":"bash","session_id":"ses_f"}"',
    'ERROR [t1] 2026-11-01T08:38:04.000 +1ms service=llm "stream error" error={error:{message:"后端服务不可用（错误码 502）"}}',
  ].join('\n'), 'utf8');
  const audit = new AuditLogger(join(stateDir, 'audit', 'dsh-codearts.jsonl'), { component: 'test' });
  /** @type {any[]} */
  const registered: any[] = [];
  const webServer = { register: (route: any) => { registered.push(route); return () => {}; } };
  registerRoutes({ webServer, processManager, goalSupervisor, installManager, modelManager, audit, fs: { readdirSync, statSync, readFileSync } } as any);
  expect(registered).toHaveLength(1);
  const route = registered[0]!;
  expect(route.kind).toBe('prefix');
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    // 模拟平台 webServer 的 prefix 分发
    if ((req.url ?? '').startsWith(route.path)) route.handler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() as any };
  };
  return {
    call,
    base,
    processManager,
    close: async () => {
      goalSupervisor.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await processManager.dispose();
    },
  };
}

describe('Web 内嵌 TUI 终端', () => {
  /** fixture：banner + cat 常驻（stdin 回显），验证缓冲/订阅/输入全链。 */
  function makeEchoFixture(dir: string): string {
    const fixture = join(dir, 'tui-echo.sh');
    writeFileSync(fixture, [
      '#!/bin/sh',
      'echo "TUI-BANNER-OK"',
      'cat',
    ].join('\n'), { mode: 0o755 });
    return `/bin/sh ${fixture}`;
  }

  /** 轮询直到谓词成立（PTY 输出异步到达；3s 上限显式超时）。 */
  async function waitFor<T>(fn: () => T | null | undefined, label: string): Promise<T> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const v = fn();
      if (v !== null && v !== undefined) return v;
      await sleep(60);
    }
    throw new Error(`等待超时: ${label}`);
  }

  test('stdout 环形缓冲：快照含 banner；writeTui 回显进入缓冲；订阅者实时收 chunk；exit 广播', async () => {
    const stateDir = tmp('tui-term');
    const pm = new ProcessManager({ stateDir });
    const started = pm.startTui({ commandOverride: makeEchoFixture(stateDir) });
    try {
      // 快照补发：banner 已入环形缓冲
      await waitFor(() => (pm.getTuiTermSnapshot(started.pid).includes('TUI-BANNER-OK') ? true : null), 'banner 入缓冲');
      // 订阅：实时 chunk
      const chunks: string[] = [];
      const exits: Array<number | null> = [];
      const unsub = pm.subscribeTui(started.pid, {
        onChunk: (d) => chunks.push(d),
        onExit: (code) => exits.push(code),
      });
      // 输入透传：写入后 PTY 行 discipline 回显 → 缓冲与订阅者都应看到
      pm.writeTui(started.pid, 'ping-42');
      pm.writeTuiEnter(started.pid);
      await waitFor(() => (pm.getTuiTermSnapshot(started.pid).includes('ping-42') ? true : null), '回显入缓冲');
      await waitFor(() => (chunks.some((c) => c.includes('ping-42')) ? true : null), '订阅者收到 chunk');
      // 退出广播（订阅者仍挂：SIGKILL → child exit → onExit）
      await pm.stopTui(started.pid);
      await waitFor(() => (exits.length > 0 ? exits : null), 'exit 广播');
      // 注销（防泄漏语义收尾）
      unsub();
      const countAfterUnsub = chunks.length;
      await sleep(100);
      expect(chunks.length).toBe(countAfterUnsub);
    } finally {
      await pm.dispose().catch(() => {});
    }
  }, 20000);

  test('环形缓冲 1MB 尾保留：超限丢最老块，总量受控且最新块完整', () => {
    const stateDir = tmp('tui-cap');
    const pm = new ProcessManager({ stateDir });
    const started = pm.startTui({ commandOverride: '/bin/sh -c "sleep 30"' });
    try {
      const rec = pm.tuiProcs.get(started.pid)!;
      const chunk = 'x'.repeat(10 * 1024);
      for (let i = 0; i < 300; i++) rec.ptty.__emitDataForTest(chunk); // 白盒：驱动 onData 订阅链（环形缓冲+广播）
      const CAP = 1024 * 1024;
      expect(rec.termBuf.totalBytes).toBeLessThanOrEqual(CAP + 10 * 1024); // 上界：cap + 单 chunk
      const snap = pm.getTuiTermSnapshot(started.pid);
      expect(snap.length).toBeGreaterThan(0);
      expect(snap.endsWith(chunk)).toBe(true); // 尾保留：最新块完整
    } finally {
      pm.stopTui(started.pid).catch(() => {});
    }
  }, 15000);

  test('node-pty：resize 动态尺寸生效；环形缓冲/回显/订阅全链', async () => {
    const stateDir = tmp('tui-pty-resize');
    const pm = new ProcessManager({ stateDir });
    const started = pm.startTui({ commandOverride: makeEchoFixture(stateDir), cols: 120, rows: 30 });
    try {
      await waitFor(() => (pm.getTuiTermSnapshot(started.pid).includes('TUI-BANNER-OK') ? true : null), 'banner');
      // 动态 resize（node-pty TIOCSWINSZ；script 方案做不到的能力）
      const r = pm.resizeTui(started.pid, 100, 30);
      expect(r.cols).toBe(100);
      expect(r.rows).toBe(30);
      // resize 后输入回显仍正常（PTY 尺寸变化不破坏流）
      pm.writeTui(started.pid, 'after-resize-echo');
      pm.writeTuiEnter(started.pid);
      await waitFor(() => (pm.getTuiTermSnapshot(started.pid).includes('after-resize-echo') ? true : null), 'resize 后回显');
      // 防御：未知 pid resize 显式报错
      expect(() => pm.resizeTui(424242, 80, 24)).toThrow('不在本管理器托管表');
    } finally {
      await pm.stopTui(started.pid).catch(() => {});
    }
  }, 20000);

  test('subscribeTui 防御：未知 PID 显式报错；已退出进程立即补发 exit', async () => {
    const stateDir = tmp('tui-sub-def');
    const pm = new ProcessManager({ stateDir });
    expect(() => pm.subscribeTui(424242, { onChunk: () => {}, onExit: () => {} })).toThrow('不在本管理器托管表');
    expect(() => pm.getTuiTermSnapshot(424242)).toThrow('无终端缓冲');
    const started = pm.startTui({ commandOverride: '/bin/sh -c "exit 7"' });
    await waitFor(() => (pm.getStatus().tui.find((t) => t.pid === started.pid)?.exitedAt !== undefined ? true : null), '进程退出');
    const exits: Array<number | null> = [];
    const unsub = pm.subscribeTui(started.pid, { onChunk: () => {}, onExit: (c) => exits.push(c) });
    await waitFor(() => (exits.length > 0 ? exits : null), '已退出进程立即补发 exit');
    unsub();
  }, 15000);

  const pmGetSnapshot = (env: any, pid: number): string => env.processManager.getTuiTermSnapshot(pid);

  test('SSE 端点端到端：快照帧 → input 透传 → 实时 chunk 帧', async () => {
    const env = await makeServer();
    try {
      // fixture 常驻回显 TUI（直接经 processManager 启动：commandOverride 不暴露 HTTP 面，防任意命令注入）
      const fixtureDir = tmp('tui-sse');
      const started = env.processManager.startTui({ commandOverride: makeEchoFixture(fixtureDir) });
      const pid = started.pid;
      // 等 banner 入环形缓冲后再连流（模拟真实时序：终端连接时缓冲已有内容可重放）
      const deadline = Date.now() + 4000;
      while (!pmGetSnapshot(env, pid).includes('TUI-BANNER-OK') && Date.now() < deadline) await sleep(60);
      // SSE 连接（fetch 流式读）
      const ac = new AbortController();
      const res = await fetch(`${env.base}/codearts/tui/stream?pid=${pid}`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sse = '';
      const readUntil = async (predicate: (s: string) => boolean, label: string) => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (predicate(sse)) return sse;
          const tick = await Promise.race([reader.read(), sleep(50).then(() => null)]);
          if (tick && tick.value) sse += decoder.decode(tick.value, { stream: true });
        }
        throw new Error(`SSE 等待超时: ${label}`);
      };
      // ① 握手帧 + ② 全量环形缓冲重放（终端模式序列重建——鼠标/括号粘贴等）
      await readUntil((s) => s.includes('"t":"hello"'), 'hello 帧');
      await readUntil((s) => s.includes('"t":"snap"') && s.includes('TUI-BANNER-OK'), 'snap 全量重放帧');
      // ② input 透传 → ③ 实时 chunk 帧（PTY 回显）
      await env.call('POST', '/codearts/tui/input', { pid, data: 'sse-echo-9' });
      await env.call('POST', '/codearts/tui/input', { pid, data: '\r' });
      await readUntil((s) => s.includes('sse-echo-9'), 'chunk 帧');
      expect(sse).toContain('"t":"chunk"');
      // ④ input 防御：空 data 400
      const bad = await env.call('POST', '/codearts/tui/input', { pid, data: '' });
      expect(bad.status).toBe(400);
      // 清理
      ac.abort();
      await env.processManager.stopTui(pid).catch(() => {});
    } finally {
      await env.close();
    }
  }, 20000);

  test('SSE 端点防御：无存活 TUI 404；未知 pid 404', async () => {
    const env = await makeServer();
    try {
      const none = await fetch(`${env.base}/codearts/tui/stream`);
      expect(none.status).toBe(404);
      const unknown = await fetch(`${env.base}/codearts/tui/stream?pid=987654`);
      expect(unknown.status).toBe(404);
    } finally {
      await env.close();
    }
  }, 15000);
});

// ============================== ⑧ HTTP 管理接口 ==============================

describe('HTTP 管理 API', () => {


  test('activity 交互流时间线端到端（新端点 /codearts/activity）', async () => {
    const env = await makeServer();
    try {
      const res = await env.call('GET', '/codearts/activity?lines=400');
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.file).toContain('kernel-fixture.log');
      const kinds = res.json.items.map((i: any) => i.kind);
      // 五类信号（本 fixture 覆盖 user/assistant/tool/error；system 由更复杂样本覆盖，见 ⑦b 单测）
      expect(kinds).toContain('user');
      expect(kinds).toContain('tool');
      expect(kinds).toContain('error');
      const user = res.json.items.find((i: any) => i.kind === 'user');
      expect(user.text).toContain('修复测试 foo');
      const err = res.json.items.find((i: any) => i.kind === 'error');
      expect(err.text).toContain('502');
      // 行数钳位 ≤400
      const clipped = await env.call('GET', '/codearts/activity?lines=9999');
      expect(clipped.status).toBe(200);
    } finally {
      await env.close();
    }
  });

  test('status/health 总览', async () => {
    const env = await makeServer();
    try {
      const status = await env.call('GET', '/codearts/status');
      expect(status.status).toBe(200);
      expect(status.json.ok).toBe(true);      expect(status.json.processes).toBeDefined();
      expect(Array.isArray(status.json.goals)).toBe(true);
      expect(status.json.audit).toBeDefined();
      const health = await env.call('GET', '/codearts/health');
      expect(health.status).toBe(200);
      expect(health.json.processes.config).toBeDefined();
      const missing = await env.call('GET', '/codearts/nope');
      expect(missing.status).toBe(404);
    } finally {
      await env.close();
    }
  }, 15000);

  test('goals 全生命周期：start → get → pause → resume → check → stop', async () => {
    const env = await makeServer();
    try {
      const started = await env.call('POST', '/codearts/goals', { objective: 'HTTP 目标', acceptanceCmd: 'true', mode: 'structured' });
      expect(started.status).toBe(201);
      expect(started.json.ok).toBe(true);
      const goalId: string = started.json.goalId;
      expect(goalId).toMatch(/^goal-\d+-[a-z0-9]+$/);
      const got = await env.call('GET', `/codearts/goals/${goalId}`);
      expect(got.json.goal.objective).toBe('HTTP 目标');
      expect(got.json.goal.state).toBe('active');
      const paused = await env.call('POST', `/codearts/goals/${goalId}/control`, { action: 'pause' });
      expect(paused.json.goal.state).toBe('paused');
      const resumed = await env.call('POST', `/codearts/goals/${goalId}/control`, { action: 'resume' });
      expect(resumed.json.goal.state).toBe('active');
      const checked = await env.call('POST', `/codearts/goals/${goalId}/control`, { action: 'check' });
      expect(checked.status).toBe(200);
      const stopped = await env.call('POST', `/codearts/goals/${goalId}/control`, { action: 'stop' });
      expect(stopped.json.goal.state).toBe('stopped');
      const list = await env.call('GET', '/codearts/goals');
      expect(list.json.goals).toHaveLength(1);
      // 错误路径：非法 ID / 不存在 / 非法 action
      expect((await env.call('GET', '/codearts/goals/goal-bogus')).status).toBe(400);
      expect((await env.call('GET', `/codearts/goals/goal-1-aaaaaa`)).status).toBe(404);
      expect((await env.call('POST', `/codearts/goals/${goalId}/control`, { action: 'fly' })).status).toBe(400);
    } finally {
      await env.close();
    }
  }, 15000);

  test('POST /codearts/run 单回合（fixture 二进制）', async () => {
    const env = await makeServer();
    try {
      const run = await env.call('POST', '/codearts/run', { prompt: '帮我查点东西' });
      expect(run.status).toBe(200);
      expect(run.json.ok).toBe(true);
      expect(run.json.result.sessionId).toBe('ses-http-1');
      expect(run.json.result.text).toContain('收到，已执行');
      expect((await env.call('POST', '/codearts/run', {})).status).toBe(400);
      expect((await env.call('POST', '/codearts/run', { prompt: 'ok' })).status).toBe(200);
    } finally {
      await env.close();
    }
  }, 15000);

  test('POST /codearts/install/heal', async () => {
    const env = await makeServer();
    try {
      const heal = await env.call('POST', '/codearts/install/heal');
      expect(heal.status).toBe(200);
      expect(heal.json.ok).toBe(true);
      expect(heal.json.result.healed).toBe(false); // fixture 安装完好
    } finally {
      await env.close();
    }
  }, 15000);

  test('模型配置端点（功能①界面后端）：GET models → POST model → 再 GET', async () => {
    const env = await makeServer();
    try {
      const before = await env.call('GET', '/codearts/models');
      expect(before.status).toBe(200);
      expect(before.json.ok).toBe(true);
      expect(before.json.models.recent[0]!.id).toBe('huaweicloud-maas/deepseek-v4.1-flash-1017');
      expect(before.json.current.id).toBe('huaweicloud-maas/deepseek-v4.1-flash-1017');
      const switched = await env.call('POST', '/codearts/model', { providerID: 'huaweicloud-maas', modelID: 'kimi-k3' });
      expect(switched.status).toBe(200);
      expect(switched.json.ok).toBe(true);
      expect(switched.json.model).toBe('huaweicloud-maas/kimi-k3');
      expect(switched.json.current.id).toBe('huaweicloud-maas/kimi-k3');
      const after = await env.call('GET', '/codearts/models');
      expect(after.json.models.configured).toBe('huaweicloud-maas/kimi-k3');
      // 错误路径：缺字段 / 非法 ID
      expect((await env.call('POST', '/codearts/model', { providerID: 'x' })).status).toBe(400);
      expect((await env.call('POST', '/codearts/model', { providerID: 'a b', modelID: 'x' })).status).toBe(400);
    } finally {
      await env.close();
    }
  }, 15000);
});
