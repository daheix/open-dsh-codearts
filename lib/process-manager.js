/**
 * dsh-codearts — codearts 进程生命周期管理
 *
 * 三种托管形态：
 * 1) TUI（PTY）：`script -qefc "<wrapper>" /dev/null` 模拟终端启动官方 wrapper，
 *    detached:true 使子进程成为进程组长 → 整组按负 PID 管控（含 script 的 PTY 从属）。
 * 2) 单回合（headless）：`bin/codearts run "<prompt>" --format json`，收集 JSON 事件流，
 *    超时/非零退出显式报错，绝不静默。
 * 3) 状态查询：PID/存活/RSS/启动时间（/proc 探测）。
 *
 * 全程审计写入 <stateDir>/audit/dsh-codearts.jsonl。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AuditLogger } from './audit.js';

/**
 * node-pty（原生模块，2026-11-01 终局改造）：替换 `script -qefc` 方案。
 * Why：script 的 PTY 不支持动态 resize（无法 TIOCSWINSZ）→ 启动尺寸与码道 TUI
 * 自适应宽度错配 → 画面错乱；node-pty spawn 的会话首进程可精确设尺寸 + resize。
 * 惰性加载：缺失/未编译时 startTui 显式报错（不拖垮插件其余功能）。
 * 解析路径：插件根 node_modules/node-pty（已部署，含 node-ABI 编译产物 build/Release/pty.node，
 * 编译方式 bunx node-gyp rebuild，node 24 headers）。
 */
const require = createRequire(import.meta.url);
let ptyModule;
function loadPty() {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('node-pty');
    } catch (error) {
      throw new Error(
        `node-pty 原生模块不可用（需在插件 node_modules/ 预置 node-pty，含 build/Release/pty.node；` +
          `编译：cd node_modules/node-pty && bunx node-gyp rebuild）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return ptyModule;
}

/**
 * bun 运行时检测：bun 的 libuv 兼容层对 node-pty 的 uv_spawn PTY 特性支持不完整，
 * 原生 addon 在 bun 下 PTY 子进程不稳定（spawn 后秒退/无输出，已实证）——bun（仅
 * 测试场景）经 tui-pty-relay.cjs 桥接（真实 node 子进程持有 PTY）；生产 dsh 是
 * node 运行时，直接进程内 node-pty。
 */
function isBunRuntime() {
  return typeof Bun !== 'undefined';
}

/**
 * 中继 PTY 门面：以 node 子进程为宿主持有真实 node-pty，对外暴露与 node-pty
 * 一致的窄接口（pid/write/resize/kill/onData/onExit），ProcessManager 上层逻辑
 * 零感知。协议 v2 纯管道（bun 的 detached+ipc 通道不工作，实证）：命令走 stdin
 * 逐行 JSON，数据走 fd3 逐行 JSON。onExit 回调签名对齐 node-pty（{exitCode}）。
 */
function makeRelayFacade(child) {
  const dataSubs = [];
  const exitSubs = [];
  let exited = false;
  // fd3 数据通道：逐行 JSON（部分行缓冲）
  let lineBuf = '';
  child.stdio?.[3]?.setEncoding('utf8');
  child.stdio?.[3]?.on('data', (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (line.length === 0) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'data' && typeof m.d === 'string') {
        for (const f of dataSubs) { try { f(m.d); } catch { /* 订阅者异常不互染 */ } }
      } else if (m.t === 'exit' && !exited) {
        exited = true;
        for (const f of exitSubs) { try { f({ exitCode: m.code ?? null }); } catch { /* 同上 */ } }
      }
    }
  });
  child.on('exit', (code) => {
    // 进程退出兜底（fd3 exit 行竞态去重）
    if (!exited) {
      exited = true;
      for (const f of exitSubs) { try { f({ exitCode: code ?? null }); } catch { /* 同上 */ } }
    }
  });
  /** stdin 逐行命令。 */
  const sendCmd = (obj) => {
    if (!child.stdin || child.stdin.destroyed) throw new Error('中继 stdin 已关闭');
    child.stdin.write(JSON.stringify(obj) + '\n');
  };
  return {
    pid: child.pid,
    write: (d) => sendCmd({ t: 'write', d }),
    resize: (c, r) => sendCmd({ t: 'resize', cols: c, rows: r }),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } },
    onData: (f) => { dataSubs.push(f); },
    onExit: (f) => { exitSubs.push(f); },
    /** 仅测试用：直接驱动 onData 订阅链（环形缓冲/广播白盒注入点）。 */
    __emitDataForTest: (text) => { for (const f of dataSubs) { try { f(text); } catch { /* 同上 */ } } },
  };
}

/** 经 node 子进程中继启动 PTY（bun 专用；中继进程 detached 独立成组便于整组管控）。 */
function spawnRelayPty(inner, cols, rows, cwd) {
  const relayPath = fileURLToPath(new URL('./tui-pty-relay.cjs', import.meta.url));
  const nodeBin = process.env.NODE_BIN ?? 'node';
  const child = spawn(nodeBin, [relayPath, String(cols), String(rows), cwd, '--', '/bin/bash', '-c', inner], {
    cwd,
    env: { ...process.env },
    detached: true, // 中继独立成组 → 负 PID 整组管控与生产直连路径语义一致
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], // fd3 = relay→parent 数据通道（协议 v2 纯管道）
  });
  if (typeof child.pid !== 'number' || child.pid <= 0) {
    throw new Error(`中继进程 spawn 失败（node=${nodeBin}）`);
  }
  child.unref?.();
  return makeRelayFacade(child);
}

/** 默认配置（codearts CLI 全实证路径，见 README「路径事实」）。 */
export function defaultConfig() {
  const home = process.env.CODEARTS_HOME ?? join(homedir(), '.codeartsdoer');
  return {
    /** 官方 wrapper（设置全量 KERNEL_ENV/OPENCODE_ENV 后 exec bin/codearts，PTY 启动必须走它） */
    wrapperPath: join(home, 'installers', 'codearts'),
    /** 真实二进制（headless run 直接用它，省一层 bash） */
    binPath: join(home, 'installers', 'bin', 'codearts'),
    /** 内核结构化日志目录（活动/错误信号源） */
    logDir: join(home, 'cli-data', 'log'),
    /** 登录态文件（存在性探测，TUI 免 AK/SK 的前提） */
    authFile: join(home, 'cli-data', 'auth.json'),
    /** 状态目录（目标持久化 + 审计） */
    stateDir: process.env.DSH_CODEARTS_STATE_DIR ?? join(homedir(), '.dsh-codearts'),
    /** 单回合默认超时（10 分钟；超时强杀并显式报错） */
    runTimeoutMs: 600_000,
  };
}

/** 从 /proc 探测进程：{alive, rssBytes, state}；探测不到即视为已死（这是探测手段，不是兜底）。 */
function probePid(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    const state = /^State:\s+(\S)/m.exec(status);
    return {
      alive: true,
      rssBytes: rss ? Number(rss[1]) * 1024 : null,
      procState: state ? state[1] : null,
    };
  } catch {
    return { alive: false, rssBytes: null, procState: null };
  }
}

/** PTY 尺寸钳位（整数 20..500，非法输入回默认值并保持显式语义——尺寸是展示参数非安全边界）。 */
function clampPtySize(value, fallback) {
  const n = Number(value);
  if (!(n >= 20 && n <= 500)) return fallback;
  return Math.floor(n);
}

/** 解析 codearts run --format json 的事件流（CLI 26.10.9，逐行 JSON 事件）。 *  事件字段按实证 heuristics 提取：sessionID/sessionId、text 片段；非 JSON 行计入 noise。
 *  @returns {{events: Array, sessionId: (string|undefined), text: string, noiseLines: number}}
 */
export function parseRunEvents(stdout) {
  const events = [];
  const textParts = [];
  let sessionId;
  let noiseLines = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      noiseLines += 1;
      continue;
    }
    events.push(obj);
    const sid = obj.sessionID ?? obj.sessionId ?? obj.session_id;
    if (typeof sid === 'string' && sid.length > 0 && sessionId === undefined) sessionId = sid;
    // 文本片段：message.parts[{type:'text',text}] 或 {type:'text',text} 两种形态都收
    const parts = obj.message?.parts ?? obj.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          textParts.push(part.text);
        }
      }
    }
    if (obj.type === 'text' && typeof obj.text === 'string' && obj.text.length > 0) {
      textParts.push(obj.text);
    }
  }
  return { events, sessionId, text: textParts.join('\n'), noiseLines };
}

/** TUI 终端环形缓冲上限（1MB，尾保留——超限丢最老 chunk，保证最新画面完整）。 */
const TUI_TERM_CAP_BYTES = 1024 * 1024;
/** TUI 默认 PTY 尺寸（浏览器 xterm 按此渲染；tui/start 可覆盖）。
 *  320 列：实测码道 TUI 按内容自适应扩宽（流内光标定位到 312 列），160 会列溢出渲染错乱。 */
export const TUI_DEFAULT_COLS = 320;
export const TUI_DEFAULT_ROWS = 42;

/**
 * codearts 进程管理器（单实例由 index.js 持有）。
 */
export class ProcessManager {
  /**
   * @param {Partial<ReturnType<typeof defaultConfig>>} [config]
   * @param {{audit?: AuditLogger, now?: () => number}} [opts]
   */
  constructor(config = {}, opts = {}) {
    this.cfg = { ...defaultConfig(), ...config };
    if (typeof this.cfg.binPath !== 'string' || this.cfg.binPath.length === 0) {
      throw new Error('binPath 不能为空');
    }
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit ?? new AuditLogger(join(this.cfg.stateDir, 'audit', 'dsh-codearts.jsonl'), { component: 'process-manager', now: this.now });
    /** @type {Map<number, {pid: number, startedAt: number, command: string, mode: 'tui', ptty: import('node-pty').IPty, termBuf: {chunks: string[], totalBytes: number}, termSubs: Set<{onChunk: (s: string) => void, onExit: (code: number|null) => void}>, exitedAt?: number}>} 托管 TUI 进程表 */
    this.tuiProcs = new Map();
    /** @type {Map<string, {child: import('node:child_process').ChildProcess, startedAt: number, timer?: NodeJS.Timeout}>} 运行中的单回合 */
    this.runOnceJobs = new Map();
  }

  /**
   * 启动 TUI（node-pty 真实 PTY，2026-11-01 终局改造）。
   * 直接以 /bin/bash -c 跑 wrapper（bash 设环境后 exec 内核），PTY 尺寸精确可控：
   * pty.spawn(name:'xterm-256color', cols, rows) 支持后续 resizeTui 动态改尺寸。
   * stdout/stderr 经 PTY 合流 → onData 全量写环形缓冲（1MB 尾保留）+ 订阅广播——
   * 不再有"无消费者积压阻塞"风险。
   * @param {{cwd?: string, env?: Record<string, string>, commandOverride?: string, cols?: number, rows?: number}} [opts]
   *   commandOverride 仅测试用：替换被 PTY 包裹的命令（fixture）。
   * @returns {{pid: number, startedAt: number, command: string}}
   */
  startTui(opts = {}) {
    if (opts.commandOverride === undefined && typeof this.cfg.wrapperPath !== 'string') {
      throw new Error('wrapperPath 未配置，无法启动 TUI');
    }
    const inner = opts.commandOverride ?? this.cfg.wrapperPath;
    const cols = clampPtySize(opts.cols, TUI_DEFAULT_COLS);
    const rows = clampPtySize(opts.rows, TUI_DEFAULT_ROWS);
    let ptty;
    try {
      if (isBunRuntime()) {
        // bun（测试场景）：node-pty addon 在 bun 下 PTY 子进程不稳定 → node 子进程中继
        ptty = spawnRelayPty(inner, cols, rows, opts.cwd ?? process.cwd());
      } else {
        // 生产 dsh（node 运行时）：进程内 node-pty 直连
        ptty = loadPty().spawn('/bin/bash', ['-c', inner], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: opts.cwd ?? process.cwd(),
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      }
    } catch (error) {
      // spawn 失败（bash 不存在/node-pty 缺失等）：显式报错，绝不静默
      this.audit.append('tui.start.failed', { detail: String(error) });
      throw new Error(`TUI PTY spawn 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const startedAt = this.now();
    const pid = ptty.pid;
    if (typeof pid !== 'number' || pid <= 0) {
      const detail = `TUI PTY spawn 未返回有效 PID（命令: bash -c ${inner}）`;
      this.audit.append('tui.start.failed', { detail });
      throw new Error(detail);
    }
    // child 引用保留在托管表内（stdin 供监督器/Web 终端注入；不进 getStatus 序列化输出）
    /** @type {{chunks: string[], totalBytes: number}} 输出环形缓冲（1MB 尾保留） */
    const termBuf = { chunks: [], totalBytes: 0 };
    /** @type {Set<{onChunk: (s: string) => void, onExit: (code: number|null) => void}>} 实时订阅者（SSE 广播） */
    const termSubs = new Set();
    this.tuiProcs.set(pid, { pid, startedAt, command: inner, mode: 'tui', ptty, termBuf, termSubs, lastDataAt: startedAt });
    ptty.onExit(({ exitCode }) => {
      // 进程自然退出只更新标记，不做任何自动重启决策（决策权在 goal-supervisor / 用户）；
      // 退出事件广播给终端订阅者（SSE 推 event:exit 后清空，防泄漏）
      const rec = this.tuiProcs.get(pid);
      if (rec) rec.exitedAt = this.now();
      for (const sub of termSubs) {
        try { sub.onExit(exitCode ?? null); } catch { /* 订阅者写失败不阻断其他订阅者 */ }
      }
      termSubs.clear();
    });
    // stdout 直通：PTY 合流输出 → 环形缓冲 + 广播（node-pty 下没有积压风险：onData 即消费）
    let outputTail = '';
    ptty.onData((chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      termBuf.chunks.push(text);
      termBuf.totalBytes += Buffer.byteLength(text, 'utf8');
      while (termBuf.totalBytes > TUI_TERM_CAP_BYTES && termBuf.chunks.length > 1) {
        const dropped = termBuf.chunks.shift();
        termBuf.totalBytes -= Buffer.byteLength(dropped ?? '', 'utf8');
      }
      outputTail = (outputTail + text).slice(-2000);
      // TUI 真实输出时间（goal-supervisor 停滞判据的真相源：有输出=码道在干活，不该注入）。
      // 修复：rec 需从托管表现取——处理器闭包早于 rec 声明，直接引用会 ReferenceError
      // 且被订阅 try/catch 吞掉，导致环形缓冲与订阅广播全断（2026-11-01 实证修复）。
      const recNow = this.tuiProcs.get(pid);
      if (recNow) recNow.lastDataAt = Date.now();
      for (const sub of termSubs) {
        try { sub.onChunk(text); } catch { /* 同上 */ }
      }
    });
    this.audit.append('tui.start', { pid, command: inner, cwd: opts.cwd ?? process.cwd(), cols, rows, pty: 'node-pty' });
    return { pid, startedAt, command: inner };
  }

  /**
   * 动态调整 TUI PTY 尺寸（node-pty TIOCSWINSZ——script 方案做不到的能力，
   * 尺寸错配错乱的终局解）。前端 fit 算出 cols/rows 后经 /codearts/tui/resize 调用。
   * @returns {{pid: number, cols: number, rows: number}}
   */
  resizeTui(pid, cols, rows) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) throw new Error(`PID ${pid} 不在本管理器托管表中，无法 resize`);
    if (rec.exitedAt !== undefined) throw new Error(`TUI ${pid} 已退出，无法 resize`);
    const c = clampPtySize(cols, TUI_DEFAULT_COLS);
    const r = clampPtySize(rows, TUI_DEFAULT_ROWS);
    try {
      rec.ptty.resize(c, r);
    } catch (error) {
      throw new Error(`TUI ${pid} resize 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.audit.append('tui.resize', { pid, cols: c, rows: r });
    return { pid, cols: c, rows: r };
  }

  /**
   * TUI 终端环形缓冲快照（诊断用途；SSE 已改为无重放直通模式，不再消费快照）。
   * 注：chunk 边界截断可能破坏多字节字符（概率极低）；仅日志诊断用。
   * @returns {string}
   */
  /** TUI 最近真实输出时间（onData 时间戳；无该进程返回 undefined）。 */
  getTuiLastDataAt(pid) {
    const rec = this.tuiProcs.get(pid);
    return rec?.lastDataAt;
  }

    getTuiTermSnapshot(pid) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) throw new Error(`PID ${pid} 不在本管理器托管表中，无终端缓冲`);
    return rec.termBuf.chunks.join('');
  }

  /**
   * 订阅 TUI 终端输出（实时 chunk）与退出事件；返回注销函数（SSE 断开必须调用，防泄漏）。
   * 进程已退出时立即触发 onExit（订阅照常登记语义，便于前端统一处理）。
   */
  subscribeTui(pid, handlers) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) throw new Error(`PID ${pid} 不在本管理器托管表中，无法订阅终端`);
    const sub = { onChunk: handlers.onChunk, onExit: handlers.onExit };
    rec.termSubs.add(sub);
    if (rec.exitedAt !== undefined) {
      // 已退出：异步补发 exit（保持「订阅后必然收到 exit」的契约）
      queueMicrotask(() => {
        if (rec.termSubs.has(sub)) {
          try { sub.onExit(null); } catch { /* 忽略 */ }
          rec.termSubs.delete(sub);
        }
      });
    }
    return () => {
      rec.termSubs.delete(sub);
    };
  }

  /**
   * 停止 TUI：进程组 SIGKILL → 等待退出 → 残余清理。
   * @returns {Promise<{pid: number, alreadyGone: boolean, killed: boolean}>}
   */
  async stopTui(pid) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) {
      throw new Error(`PID ${pid} 不在本管理器托管表中，拒绝误杀`);
    }
    let alreadyGone = false;
    let killed = false;
    try {
      process.kill(-pid, 'SIGKILL'); // 负 PID = 进程组（node-pty 会话首进程 + 内核子树）
      killed = true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */(error).code === 'ESRCH') {
        alreadyGone = true;
      } else {
        this.audit.append('tui.stop.error', { pid, error: String(error) });
        throw new Error(`进程组 ${-pid} 终止失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 等待真正的退出（上限 3s），防止僵尸残留
    await new Promise((resolveWait) => {
      const deadline = this.now() + 3000;
      const tick = () => {
        if (!probePid(pid).alive || this.now() > deadline) resolveWait(undefined);
        else setTimeout(tick, 100);
      };
      tick();
    });
    // 残余清理：组内仍有存活成员再补一刀；node-pty 句柄收尾
    try {
      process.kill(-pid, 0);
      try {
        process.kill(-pid, 'SIGKILL');
        this.audit.append('tui.stop.residual_kill', { pid });
      } catch { /* ESRCH 竞态：组刚好消亡 */ }
    } catch { /* 组已不存在，清理完成 */ }
    try { rec.ptty.kill(); } catch { /* 已退出 */ }
    this.tuiProcs.delete(pid);
    this.audit.append('tui.stop', { pid, killed, alreadyGone });
    return { pid, alreadyGone, killed };
  }

  /**
   * 向 TUI PTY 注入文本（pty.write；Enter 由调用方单独发送——PTY 行缓冲语义要求文本与回车分离）。
   * @returns {{written: number}}
   */
  writeTui(pid, text) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) throw new Error(`PID ${pid} 不在本管理器托管表中，拒绝注入`);
    if (rec.exitedAt !== undefined) {
      throw new Error(`TUI ${pid} stdin 不可写（进程可能已退出）`);
    }
    try {
      rec.ptty.write(text);
    } catch (error) {
      throw new Error(`TUI ${pid} 写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.audit.append('tui.write', { pid, bytes: Buffer.byteLength(text, 'utf8') });
    return { written: Buffer.byteLength(text, 'utf8') };
  }

  /** 向 TUI PTY 单独发送回车（\r）。 */
  writeTuiEnter(pid) {
    const rec = this.tuiProcs.get(pid);
    if (rec === undefined) throw new Error(`PID ${pid} 不在本管理器托管表中，拒绝注入`);
    if (rec.exitedAt !== undefined) {
      throw new Error(`TUI ${pid} stdin 不可写（进程可能已退出）`);
    }
    try {
      rec.ptty.write('\r');
    } catch (error) {
      throw new Error(`TUI ${pid} 写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 所有托管进程状态（PID/存活/RSS/启动时间）。 */
  getStatus() {
    const tui = [];
    for (const rec of this.tuiProcs.values()) {
      const probe = probePid(rec.pid);
      tui.push({
        pid: rec.pid,
        mode: 'tui',
        command: rec.command,
        startedAt: new Date(rec.startedAt).toISOString(),
        alive: probe.alive,
        rssBytes: probe.rssBytes,
        procState: probe.procState,
        exitedAt: rec.exitedAt !== undefined ? new Date(rec.exitedAt).toISOString() : undefined,
      });
    }
    return {
      tui,
      runOnceActive: this.runOnceJobs.size,
      config: {
        wrapperPath: this.cfg.wrapperPath,
        binPath: this.cfg.binPath,
        stateDir: this.cfg.stateDir,
        runTimeoutMs: this.cfg.runTimeoutMs,
      },
    };
  }

  /**
   * 单回合执行：`bin/codearts run "<prompt>" --format json`（无头）。
   * 非 JSON 事件流按 parseRunEvents 规则解析；超时强杀 + 显式报错。
   * @param {string} prompt
   * @param {{timeoutMs?: number, sessionId?: string, cwd?: string, commandOverride?: string[]}} [opts]
   *   commandOverride 仅测试用：完整 argv 替换（fixture 模拟 codearts）。
   * @returns {Promise<{ok: boolean, exitCode: (number|null), sessionId: (string|undefined), text: string, eventCount: number, noiseLines: number, durationMs: number, error?: string}>}
   */
  async runOnce(prompt, opts = {}) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new Error('prompt 不能为空');
    }
    const timeoutMs = opts.timeoutMs ?? this.cfg.runTimeoutMs;
    const argv = opts.commandOverride ?? [
      this.cfg.binPath,
      'run',
      ...(opts.sessionId !== undefined ? ['-s', opts.sessionId] : []),
      prompt,
      '--format',
      'json',
    ];
    const startedAt = this.now();
    const runId = `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    this.audit.append('run.start', { runId, promptLen: prompt.length, sessionId: opts.sessionId, timeoutMs });

    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.runOnceJobs.set(runId, { child, startedAt });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
        this.runOnceJobs.delete(runId);
        const detail = `单回合执行超时（${timeoutMs}ms），已强杀。runId=${runId}`;
        this.audit.append('run.timeout', { runId, timeoutMs });
        rejectRun(new Error(detail));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.runOnceJobs.delete(runId);
        rejectRun(new Error(`单回合进程启动失败: ${error.message}`));
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.runOnceJobs.delete(runId);
        resolveRun({ exitCode: code, stdout, stderr });
      });
    });

    const durationMs = this.now() - startedAt;
    const parsed = parseRunEvents(result.stdout);
    if (result.exitCode !== 0) {
      const detail = `单回合退出码非零（${result.exitCode}）。stderr 尾部: ${result.stderr.slice(-800) || '（空）'}`;
      this.audit.append('run.failed', { runId, exitCode: result.exitCode, durationMs, detail });
      return { ok: false, exitCode: result.exitCode, sessionId: parsed.sessionId, text: parsed.text, eventCount: parsed.events.length, noiseLines: parsed.noiseLines, durationMs, error: detail };
    }
    this.audit.append('run.done', { runId, durationMs, eventCount: parsed.events.length, sessionId: parsed.sessionId });
    return { ok: true, exitCode: 0, sessionId: parsed.sessionId, text: parsed.text, eventCount: parsed.events.length, noiseLines: parsed.noiseLines, durationMs };
  }

  /** 停止一切托管进程（插件卸载时调用）。 */
  async dispose() {
    const errors = [];
    for (const pid of [...this.tuiProcs.keys()]) {
      try {
        await this.stopTui(pid);
      } catch (error) {
        errors.push(`TUI ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const job of this.runOnceJobs.values()) {
      try { job.child.kill('SIGKILL'); } catch (error) {
        errors.push(`runOnce: ${String(error)}`);
      }
    }
    this.runOnceJobs.clear();
    if (errors.length > 0) throw new Error(`dispose 存在未清理干净的进程: ${errors.join('; ')}`);
  }
}
