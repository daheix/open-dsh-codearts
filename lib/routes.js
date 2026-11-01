/**
 * dsh-codearts — HTTP 管理 API（注册到 dsh webServer）
 *
 * 路由（kind:'prefix' 统一挂 /codearts，内部按 pathname+method 分发）：
 *   GET  /codearts/status            → 总览（进程表 + 目标摘要 + 安装健康 + 审计健康）
 *   POST /codearts/run               → 单回合执行 {prompt, wait?, sessionId?, timeoutMs?}
 *   GET  /codearts/goals             → 目标列表
 *   POST /codearts/goals             → 启动目标 {objective, acceptanceCmd, mode?, tuiPid?, sessionId?}
 *   GET  /codearts/goals/:id         → 目标状态
 *   POST /codearts/goals/:id/control → {action: 'pause'|'resume'|'stop'|'check'}
 *   GET  /codearts/health            → 进程健康（存活/RSS/启动时间）
 *   POST /codearts/install/heal      → 安装自愈（autoHeal/repairInstall）
 *   GET  /codearts/activity?lines=N  → 交互流时间线 [{time,kind,text}]（解析最新 kernel-*.log 尾部）
 *
 * 认证：同源，由平台 cookie 层保证（与 dsh-goal-controls 同一约定）。
 */
import { parseActivityLines } from './activity-parser.js';

const MAX_BODY_BYTES = 64 * 1024;
const ROUTE_PREFIX = '/codearts';

/** Typed failure → 窄化 HTTP 响应。 */
export class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'RouteError';
  }
}

/** 读取有上限的 JSON 请求体。 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    let bytes = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += data.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        reject(new RouteError(413, 'BODY_TOO_LARGE', '请求体过大'));
        return;
      }
      text += data.toString('utf8');
    });
    request.on('end', () => {
      if (failed) return;
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RouteError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function respondJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/** 单回合执行路由（wait=false 时立即返回 runId 占位——MVP 单回合本就带结构化结果，wait 恒真语义）。 */
async function handleRun(ctx, request, response) {
  const body = await readJsonBody(request);
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    throw new RouteError(400, 'BAD_PROMPT', 'prompt 不能为空');
  }
  // 长任务语义如实声明：等待执行完成（调用方需设置足够 HTTP 超时）；不接受假异步
  const result = await ctx.processManager.runOnce(body.prompt, {
    sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined,
  });
  respondJson(response, result.ok ? 200 : 502, { ok: result.ok, result });
}

async function handleTuiStart(ctx, request, response) {
  const body = await readJsonBody(request).catch(() => ({}));
  const result = ctx.processManager.startTui({
    cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
    cols: typeof body.cols === 'number' ? body.cols : undefined,
    rows: typeof body.rows === 'number' ? body.rows : undefined,
  });
  // 启动即审计（tui.start 已由 processManager 记录）；此处返回托管 PID 供 goal start 的 tuiPid 使用
  respondJson(response, 201, { ok: true, pid: result.pid, startedAt: result.startedAt, command: result.command });
}

async function handleTuiStop(ctx, request, response) {
  const body = await readJsonBody(request);
  if (typeof body.pid !== 'number') {
    throw new RouteError(400, 'BAD_PID', 'pid 必须是数字');
  }
  const result = await ctx.processManager.stopTui(body.pid);
  respondJson(response, 200, { ok: true, ...result });
}

/**
 * Web 内嵌终端 SSE 流（node-pty 直通模式，2026-11-01 终局改造）：
 * 连上先发 {t:"hello", pid} 握手帧 + **全量环形缓冲重放（snap）**，之后纯增量 chunk。
 * 口径变更（2026-11-01 鼠标丢失修复）：曾一度取消 snap 重放——实测导致终端模式序列
 * （鼠标上报等，启动早期发出）丢失、xterm 退回默认模式鼠标失效。全量重放按状态机
 * 语义重建终端状态；旧"叠加"根因是多路并发连接（单例守卫已修），与重放本身无关。
 * TUI 退出推 event: exit 后结束响应。原生 node ServerResponse 直写（SSE 原生可用）；
 * 客户端断开（request close）即注销订阅 + 停心跳，防泄漏。
 */
function handleTuiStream(ctx, request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pidParam = url.searchParams.get('pid');
  let pid;
  if (pidParam !== null) {
    pid = Number(pidParam);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new RouteError(400, 'BAD_PID', `pid 非法: ${pidParam}`);
    }
    if (!ctx.processManager.getStatus().tui.some((t) => t.pid === pid)) {
      throw new RouteError(404, 'TUI_NOT_FOUND', `PID ${pid} 不在托管表中（可能已退出，请刷新进程列表重连）`);
    }
  } else {
    const alive = ctx.processManager.getStatus().tui.filter((t) => t.alive);
    if (alive.length === 0) {
      throw new RouteError(404, 'NO_TUI', '当前没有存活的托管 TUI——先启动 codearts');
    }
    pid = (alive[alive.length - 1] ?? { pid: 0 }).pid; // 最新一个存活 TUI
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 禁代理缓冲（照 taskboard 流式端点惯例）
  });
  // 握手帧（前端收到后把本端 xterm 尺寸 resize 回服务端）
  response.write(`data: ${JSON.stringify({ t: 'hello', pid })}\n\n`);
  // 全量环形缓冲重放（2026-11-01 鼠标丢失修复）：码道 TUI 的终端模式设置序列
  // （鼠标上报 ?1000h/?1002h、括号粘贴 ?2004h、焦点 ?1004h 等）在启动早期发出——
  // 若不重放，xterm 处于默认模式 → 鼠标事件不编码转发。终端模拟器按序处理转义
  // 序列是状态机语义：全量重放 = 重建正确的终端状态（含鼠标模式）+ 正确画面。
  // 单连接守卫保证 snap 只发一次不会叠加（旧叠加根因是多路并发，已修）。
  let snapshot = '';
  try { snapshot = ctx.processManager.getTuiTermSnapshot(pid); } catch { /* 快照不可用：仅实时流 */ }
  if (snapshot.length > 0) {
    response.write(`data: ${JSON.stringify({ t: 'snap', d: snapshot })}\n\n`);
  }
  // 尾部快照：从环形缓冲最后一次清屏（\x1b[2J）点起补发——xterm reset+写入即恢复最近
  // 完整画面（node-pty 直通顺序流无跨 chunk 截断；单连接守卫下 snap 只发一次不叠加）
  try {
    const snapshot = ctx.processManager.getTuiTermSnapshot(pid);
    if (snapshot.length > 0) {
      const clearIdx = snapshot.lastIndexOf('\u001b[2J');
      const tail = clearIdx >= 0 ? snapshot.slice(clearIdx) : snapshot.slice(-64 * 1024);
      if (tail.length > 0) {
        response.write(`data: ${JSON.stringify({ t: 'snap', pid, d: tail })}\n\n`);
      }
    }
  } catch { /* 快照失败不阻断实时流（前端短暂空白后由增量补齐） */ }
  // 心跳：必须是 onmessage 可见帧（注释行 ": ping" 不会触发前端事件——前端 watchdog
  // 靠本帧续命；前端对 t:"ping" 只刷新 lastFrameAt 不写终端）
  const keepAlive = setInterval(() => {
    try { response.write(`data: ${JSON.stringify({ t: 'ping' })}\n\n`); } catch { /* 断开竞态：close 回调会清理 */ }
  }, 15000);
  const unsubscribe = ctx.processManager.subscribeTui(pid, {
    onChunk: (d) => {
      try { response.write(`data: ${JSON.stringify({ t: 'chunk', d })}\n\n`); } catch { /* 同上 */ }
    },
    onExit: (code) => {
      try {
        response.write(`event: exit\ndata: ${JSON.stringify({ t: 'exit', pid, code })}\n\n`);
        response.end();
      } catch { /* 已断开 */ }
      clearInterval(keepAlive);
      unsubscribe();
    },
  });
  request.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    ctx.audit.append('tui.stream.close', { pid });
  });
  ctx.audit.append('tui.stream.open', { pid });
}

/** Web 内嵌终端输入：{pid, data} 键级透传（不自动加 \r；Enter 由前端发）。 */
async function handleTuiInput(ctx, request, response) {
  const body = await readJsonBody(request);
  if (typeof body.pid !== 'number') {
    throw new RouteError(400, 'BAD_PID', 'pid 必须是数字');
  }
  if (typeof body.data !== 'string' || body.data.length === 0) {
    throw new RouteError(400, 'BAD_INPUT', 'data 必须是非空字符串（按键/粘贴内容）');
  }
  if (body.data.length > 8192) {
    throw new RouteError(413, 'INPUT_TOO_LARGE', `单次输入过大（${body.data.length} > 8192 字符）`);
  }
  const result = ctx.processManager.writeTui(body.pid, body.data);
  respondJson(response, 200, { ok: true, ...result });
}

/** Web 内嵌终端动态尺寸：{pid, cols, rows} → node-pty resize（TIOCSWINSZ）。 */
async function handleTuiResize(ctx, request, response) {
  const body = await readJsonBody(request);
  if (typeof body.pid !== 'number') {
    throw new RouteError(400, 'BAD_PID', 'pid 必须是数字');
  }
  if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
    throw new RouteError(400, 'BAD_SIZE', 'cols 与 rows 必须是数字');
  }
  const result = ctx.processManager.resizeTui(body.pid, body.cols, body.rows);
  respondJson(response, 200, { ok: true, ...result });
}

async function handleGoalStart(ctx, request, response) {
  const body = await readJsonBody(request);
  const { goalId } = await ctx.goalSupervisor.startGoal(String(body.objective ?? ''), {
    acceptanceCmd: String(body.acceptanceCmd ?? ''),
    mode: body.mode === 'tui' ? 'tui' : 'structured',
    tuiPid: typeof body.tuiPid === 'number' ? body.tuiPid : undefined,
    sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
  });
  respondJson(response, 201, { ok: true, goalId, goal: ctx.goalSupervisor.getGoal(goalId) });
}

const GOAL_ID_RE = /^goal-\d+-[a-z0-9]+$/;

async function handleGoalControl(ctx, request, response, goalId) {
  const body = await readJsonBody(request);
  const action = body?.action;
  let goal;
  if (action === 'pause') goal = ctx.goalSupervisor.pause(goalId, typeof body.reason === 'string' ? body.reason : 'user-pause');
  else if (action === 'resume') goal = await ctx.goalSupervisor.resume(goalId);
  else if (action === 'stop') goal = ctx.goalSupervisor.stop(goalId);
  else if (action === 'check') goal = await ctx.goalSupervisor.checkAcceptance(goalId);
  else throw new RouteError(400, 'BAD_ACTION', "action 必须是 'pause' | 'resume' | 'stop' | 'check'");
  respondJson(response, 200, { ok: true, goal });
}

/** 注册全部路由；返回注销函数。 */
export function registerRoutes(ctx) {
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname === `${ROUTE_PREFIX}/status` && request.method === 'GET') {
        respondJson(response, 200, {
          ok: true,
          processes: ctx.processManager.getStatus(),
          goals: ctx.goalSupervisor.listGoals(),
          audit: ctx.audit.health(),
        });
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/health` && request.method === 'GET') {
        respondJson(response, 200, { ok: true, processes: ctx.processManager.getStatus() });
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/run` && request.method === 'POST') {
        await handleRun(ctx, request, response);
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/tui/start` && request.method === 'POST') {
        await handleTuiStart(ctx, request, response);
        return;
      }
      // ---- Web 内嵌终端：SSE 实时流（快照补发 + 增量广播 + exit 事件） ----
      if (pathname === `${ROUTE_PREFIX}/tui/stream` && request.method === 'GET') {
        handleTuiStream(ctx, request, response);
        return;
      }
      // ---- Web 内嵌终端：键级输入透传（Enter 由前端发 \r，不自动补） ----
      if (pathname === `${ROUTE_PREFIX}/tui/input` && request.method === 'POST') {
        await handleTuiInput(ctx, request, response);
        return;
      }
      // ---- Web 内嵌终端：动态 resize（node-pty TIOCSWINSZ——前端 fit 算出尺寸后调用） ----
      if (pathname === `${ROUTE_PREFIX}/tui/resize` && request.method === 'POST') {
        await handleTuiResize(ctx, request, response);
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/tui/stop` && request.method === 'POST') {
        await handleTuiStop(ctx, request, response);
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/goals` && request.method === 'GET') {
        respondJson(response, 200, { ok: true, goals: ctx.goalSupervisor.listGoals() });
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/goals` && request.method === 'POST') {
        await handleGoalStart(ctx, request, response);
        return;
      }
      const goalMatch = /^\/codearts\/goals\/([^/]+)(\/control)?$/.exec(pathname);
      if (goalMatch) {
        const goalId = decodeURIComponent(goalMatch[1]);
        if (!GOAL_ID_RE.test(goalId)) throw new RouteError(400, 'BAD_GOAL_ID', `非法目标 ID: ${goalId}`);
        if (request.method === 'GET' && goalMatch[2] === undefined) {
          respondJson(response, 200, { ok: true, goal: ctx.goalSupervisor.getGoal(goalId) });
          return;
        }
        if (request.method === 'POST' && goalMatch[2] === '/control') {
          await handleGoalControl(ctx, request, response, goalId);
          return;
        }
        throw new RouteError(405, 'METHOD_NOT_ALLOWED', `${request.method} ${pathname} 不支持`);
      }
      if (pathname === `${ROUTE_PREFIX}/install/heal` && request.method === 'POST') {
        const result = ctx.installManager.autoHeal();
        respondJson(response, 200, { ok: true, result });
        return;
      }
      // ---- 模型配置（dsh 界面码道模型选择的后端） ----
      if (pathname === `${ROUTE_PREFIX}/models` && request.method === 'GET') {
        const models = ctx.modelManager.listModels();
        let current;
        let currentError;
        try {
          current = ctx.modelManager.getCurrentModel();
        } catch (error) {
          // 尚无任何已选模型（recent 空且无 model 键）：如实返回，不阻塞清单
          currentError = error instanceof Error ? error.message : String(error);
        }
        respondJson(response, 200, { ok: true, models, current, ...(currentError !== undefined ? { currentError } : {}) });
        return;
      }
      if (pathname === `${ROUTE_PREFIX}/model` && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (typeof body.providerID !== 'string' || typeof body.modelID !== 'string') {
          throw new RouteError(400, 'BAD_MODEL', '需要 providerID 与 modelID 两个字符串');
        }
        const result = ctx.modelManager.setModel(body.providerID, body.modelID);
        respondJson(response, 200, { ok: true, ...result, current: ctx.modelManager.getCurrentModel() });
        return;
      }
      // ---- 自定义模型（完整模型列表的自由扩展：内置候选 + recent 覆盖不到的型号） ----
      if (pathname === `${ROUTE_PREFIX}/models/custom` && (request.method === 'POST' || request.method === 'DELETE')) {
        const body = await readJsonBody(request);
        if (typeof body.providerID !== 'string' || typeof body.modelID !== 'string') {
          throw new RouteError(400, 'BAD_MODEL', '需要 providerID 与 modelID 两个字符串');
        }
        const result = request.method === 'POST'
          ? ctx.modelManager.addCustom(body.providerID, body.modelID)
          : ctx.modelManager.removeCustom(body.providerID, body.modelID);
        respondJson(response, 200, { ok: true, ...result });
        return;
      }
      // ---- 码道内核日志尾部（"看到 CLI 运行情况"的数据源：实时推理/工具/错误流） ----
      if (pathname === `${ROUTE_PREFIX}/logs/tail` && request.method === 'GET') {
        const lines = Math.min(Math.max(Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('lines') ?? '80'), 10), 400);
        const logDir = `${ctx.modelManager.cfg.codeartsHome}/cli-data/log`;
        let latest = null;
        try {
          const candidates = ctx.fs.readdirSync(logDir).filter((f) => f.startsWith('kernel-') && f.endsWith('.log'));
          let newestMtime = -1;
          for (const f of candidates) {
            const st = ctx.fs.statSync(`${logDir}/${f}`);
            if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; latest = `${logDir}/${f}`; }
          }
        } catch { /* log 目录不存在：如实返回空 */ }
        const rows = latest === null ? [] : ctx.fs.readFileSync(latest, 'utf8').split('\n').slice(-lines).filter((r) => r.length > 0);
        respondJson(response, 200, { ok: true, file: latest, rows });
        return;
      }
      // ---- 交互流时间线（主窗口数据源：解析 kernel 日志为 user/assistant/tool/error/system） ----
      if (pathname === `${ROUTE_PREFIX}/activity` && request.method === 'GET') {
        const lines = Math.min(Math.max(Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('lines') ?? '600'), 10), 400);
        const logDir = `${ctx.modelManager.cfg.codeartsHome}/cli-data/log`;
        let latest = null;
        try {
          const candidates = ctx.fs.readdirSync(logDir).filter((f) => f.startsWith('kernel-') && f.endsWith('.log'));
          let newestMtime = -1;
          for (const f of candidates) {
            const st = ctx.fs.statSync(`${logDir}/${f}`);
            if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; latest = `${logDir}/${f}`; }
          }
        } catch { /* log 目录不存在：如实返回空 */ }
        const rows = latest === null ? [] : ctx.fs.readFileSync(latest, 'utf8').split('\n').slice(-lines);
        respondJson(response, 200, { ok: true, file: latest, items: parseActivityLines(rows) });
        return;
      }
      throw new RouteError(404, 'NOT_FOUND', `未知路由: ${request.method} ${pathname}`);
    } catch (error) {
      if (error instanceof RouteError) {
        respondJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
        return;
      }
      // 业务错误（监督器/进程层抛出的 Error）→ 400/502 按语义映射；未知 → 500
      const message = error instanceof Error ? error.message : String(error);
      if (/不存在/.test(message)) {
        respondJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message } });
      } else if (/当前是|已是终态|不能为空|需要|拒绝|非法/.test(message)) {
        respondJson(response, 400, { ok: false, error: { code: 'BAD_REQUEST', message } });
      } else {
        respondJson(response, 500, { ok: false, error: { code: 'INTERNAL', message } });
      }
    }
  };
  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => void handler(req, res) });
}
