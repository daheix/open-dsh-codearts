/**
 * dsh-codearts — codearts-bridge 守护客户端（只读画面转发数据源）。
 *
 * 背景（2026-11-01 用户裁决）：非托管 TUI 的 PTY master 在 codearts-bridge 守护
 * 手里，插件无法接管——唯一非破坏性路径是守护暴露只读快照端点（GET /tuis、
 * GET /tui/view?ref=），本模块经 HTTP 拉取并代理给侧栏终端（只读，无注入通道）。
 *
 * 错误纪律：守护不可达/token 缺失/HTTP 非零码全部显式返回 {ok:false, code}，
 * 绝不返回伪数据；调用方（status 路由）把不可用状态如实下发 UI。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 守护连接配置（env 可覆盖；与生产守护装配 127.0.0.1:4577 对齐）。 */
export function defaultBridgeConfig() {
  return {
    url: process.env.DSH_CODEARTS_BRIDGE_URL ?? 'http://127.0.0.1:4577',
    tokenFile: process.env.DSH_CODEARTS_BRIDGE_TOKEN_FILE ?? join(homedir(), '.codearts-bridge', 'daemon-token'),
    timeoutMs: 3000,
  };
}

/** 读守护 token；文件缺失/不可读显式报错（token 是守护的鉴权前提，不猜路径）。 */
export function readBridgeToken(cfg) {
  try {
    const t = readFileSync(cfg.tokenFile, 'utf8').trim();
    if (t.length === 0) return { ok: false, code: 'BRIDGE_TOKEN_MISSING', message: `守护 token 文件为空：${cfg.tokenFile}` };
    return { ok: true, token: t };
  } catch (error) {
    return { ok: false, code: 'BRIDGE_TOKEN_MISSING', message: `守护 token 不可读（${cfg.tokenFile}）：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 带超时与显式错误归一的守护 GET。 */
async function bridgeGet(cfg, path) {
  const token = readBridgeToken(cfg);
  if (!token.ok) return token;
  let res;
  try {
    res = await fetch(new URL(path, cfg.url), {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      ok: false,
      code: isTimeout ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNAVAILABLE',
      message: `守护请求失败（${cfg.url}${path}）：${msg}`,
    };
  }
  if (!res.ok) {
    return { ok: false, code: `BRIDGE_HTTP_${res.status}`, message: `守护 HTTP ${res.status}：${cfg.url}${path}` };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch (error) {
    return { ok: false, code: 'BRIDGE_BODY_INVALID', message: `守护响应非 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** GET /tuis：在册目标的会话清单（refId/scriptPid/alive/goalId/phase）。 */
export async function bridgeListTuis(cfg) {
  const r = await bridgeGet(cfg, '/tuis');
  if (!r.ok) return r;
  const tuis = (r.json ?? {}).tuis;
  if (!Array.isArray(tuis)) {
    return { ok: false, code: 'BRIDGE_BODY_INVALID', message: '守护 /tuis 响应缺少 tuis 数组' };
  }
  return { ok: true, tuis };
}

/** GET /tui/view?ref=：会话画面**网格行帧**（守护侧 xterm-headless 维护屏幕状态，随取随序列化）。 */
export async function bridgeViewSnapshot(cfg, refId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(refId ?? '')) {
    return { ok: false, code: 'BAD_REF', message: `非法会话引用：${JSON.stringify(String(refId).slice(0, 64))}` };
  }
  const r = await bridgeGet(cfg, `/tui/view?ref=${encodeURIComponent(refId)}`);
  if (!r.ok) return r;
  const body = r.json ?? {};
  if (!Array.isArray(body.rows)) {
    return { ok: false, code: 'BRIDGE_BODY_INVALID', message: '守护 /tui/view 响应缺少 rows 数组' };
  }
  return { ok: true, rev: typeof body.rev === 'number' ? body.rev : 0, rows: body.rows, meta: body.meta ?? {} };
}

/**
 * 关联（纯函数）：把守护会话按 "codearts 进程的 PPid == script pid" 挂到
 * /proc 发现的外部进程上。未匹配的守护会话原样进 unmatched（其 codearts 子进程
 * 可能暂时未被 /proc 扫到——不伪造关联，UI 以 refId 兜底展示）。
 * @param {Array<{pid: number, ppid?: number|null, bridge?: unknown}>} procs
 * @param {Array<{refId: string, pid: number|null, alive: boolean, goalId: string, phase: string}>} bridgeTuis
 */
export function correlateBridge(procs, bridgeTuis) {
  const unmatched = [];
  const byScriptPid = new Map();
  for (const t of bridgeTuis) {
    if (typeof t.pid === 'number' && t.pid > 0) byScriptPid.set(t.pid, t);
    else unmatched.push(t);
  }
  for (const p of procs) {
    const hit = typeof p.ppid === 'number' ? byScriptPid.get(p.ppid) : undefined;
    if (hit !== undefined) {
      p.bridge = { goalId: hit.goalId, phase: hit.phase, refId: hit.refId };
    }
  }
  const matchedRefs = new Set(procs.map((p) => p.bridge?.refId).filter(Boolean));
  for (const t of bridgeTuis) {
    if (!matchedRefs.has(t.refId) && !unmatched.includes(t)) unmatched.push(t);
  }
  return { procs, unmatched };
}
