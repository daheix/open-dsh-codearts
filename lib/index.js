/**
 * dsh-codearts — cordis 插件主入口
 *
 * 在 dsh 平台内完整集成华为云 CodeArts CLI：
 * ① CodeartsManager 初始化（进程托管 ProcessManager + 目标监督 GoalSupervisor + 安装管家 InstallManager，单例）
 * ② HTTP 管理 API 注册到 ctx.webServer（/codearts/*）
 * ③ 平台工具注册（ctx.tools 可用时：codearts_status / codearts_run / codearts_goal）
 * ④ 返回 cleanup（进程与看门狗全量收尾）
 *
 * 注入服务：webServer（必需）；tools（可选，存在即注册模型可调用工具）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ProcessManager } from './process-manager.js';
import { GoalSupervisor } from './goal-supervisor.js';
import { InstallManager, probeInstall } from './install-manager.js';
import { ModelManager } from './model-manager.js';
import { AuditLogger } from './audit.js';
import { registerRoutes } from './routes.js';

export const name = 'dsh-codearts';
export const inject = ['webServer', 'tools', 'systemPrompt'];

/**
 * 码道委托协议（注入 dsh 智能体系统提示，照 dsh-taskboard 范式）。
 *
 * 目的：让 dsh 全部智能体"天生知道"存在 codearts_* 委托通道——用户在原生会话/goal
 * 循环里发起任务时，智能体会按本协议把实际工作委托给码道 CLI（华为 MaaS 模型），
 * 自己只做轻监督。这是"按 dsh 框架控制 codearts"的核心一环。
 */
const CODEARTS_PROTOCOL = [
  '## CodeArts（码道）委托协议',
  '',
  '你可用 codearts_* 工具把实际开发工作委托给华为云码道 CLI 执行——码道进程内部使用华为 MaaS 大模型（用户登录态计费），不消耗你的 token 额度。委托后你只做轻监督（查状态/判断完成），**不要自己替码道写代码**。',
  '',
  '- `codearts_status`：码道托管总览（进程/目标/安装健康）。',
  '- `codearts_run` {prompt}：单回合委托（headless，返回结构化结果）。',
  '- `codearts_goal` {action:"start", objective, acceptanceCmd, mode:"tui"}：**持续目标（推荐）**——码道在后台循环工作，infer timeout/502/断网/进程死全部自动拉起并注入"继续完成剩余任务"，直到验收命令连续通过。acceptanceCmd 给出可执行的验收命令（如 "npm test"）。',
  '- `codearts_goal` {action:"status"|"list"} 查进度；{action:"control", goalId, control:"pause"|"resume"|"stop"} 控制。',
  '',
  '何时委托：用户点名"用码道/codearts"；或长任务、需要循环推进直到完成的开发工作。用户在 dsh goal 模式下发起的目标，循环中的实际执行优先委托码道，你负责拆解、下发、核验与最终汇报。',
].join('\n');

/** 插件配置规范化（全部显式默认，无隐式兜底：不合法直接抛错）。 */
function normalizeConfig(config = {}) {
  const codeartsHome = config.codeartsHome ?? process.env.CODEARTS_HOME ?? join(homedir(), '.codeartsdoer');
  const stateDir = config.stateDir ?? process.env.DSH_CODEARTS_STATE_DIR ?? join(homedir(), '.dsh-codearts');
  const cfg = {
    codeartsHome,
    stateDir,
    wrapperPath: config.wrapperPath ?? join(codeartsHome, 'installers', 'codearts'),
    binPath: config.binPath ?? join(codeartsHome, 'installers', 'bin', 'codearts'),
    runTimeoutMs: config.runTimeoutMs ?? 600_000,
    stagnationMs: config.stagnationMs ?? 60_000,
    checkIntervalMs: config.checkIntervalMs ?? 15_000,
    retryBaseMs: config.retryBaseMs ?? 5_000,
    retryCapMs: config.retryCapMs ?? 60_000,
    alarmThreshold: config.alarmThreshold ?? 10,
    install: config.install ?? {},
    registerTools: config.registerTools ?? true,
  };
  for (const key of ['runTimeoutMs', 'stagnationMs', 'checkIntervalMs', 'retryBaseMs', 'retryCapMs'] ) {
    if (typeof cfg[key] !== 'number' || !Number.isFinite(cfg[key]) || cfg[key] <= 0) {
      throw new Error(`配置 ${key} 必须是正数，得到 ${JSON.stringify(cfg[key])}`);
    }
  }
  return cfg;
}

/**
 * dsh 平台工具（模型可直接调用；ctx.tools 可用时注册）。
 *
 * 契约要点（照 @deepseek-ai/dsh-tool-ask-user 同款路径）：
 * - 必须经 defineTool 包装：它把简写 parameters 编译为宿主消费的标准 JSON Schema，
 *   并加装参数校验器（模型传参缺失/类型错会得到明确 violation，而非 execute 内含糊报错）。
 * - output.render 是两参契约 render(args, value)——value 才是 execute 返回值。
 */
function parametersToJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [name, p] of Object.entries(spec)) {
    const prop = { type: p.type };
    if (p.description !== undefined) prop.description = p.description;
    if (p.items !== undefined) prop.items = p.items;
    if (p.enum !== undefined) prop.enum = p.enum;
    properties[name] = prop;
    if (p.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: true };
}

/** dsh 平台工具（模型可直接调用；ctx.tools 可用时注册）。 */
function buildTools(ctx, mgr) {
  // dsh 输出渲染契约：render(args, value) 两参——value 才是 execute 的返回值。
  const renderJson = (args, value) => JSON.stringify(value, null, 2);
const lossless = (v) => JSON.parse(JSON.stringify(v ?? null));
  const outputSpec = { schema: { type: 'object', additionalProperties: true }, render: renderJson };
  return [
    defineTool({
      name: 'codearts_status',
      description: '查看 CodeArts CLI 托管状态：TUI 进程表（PID/存活/RSS）、目标列表摘要、安装健康。',
      output: outputSpec,
      parameters: {},
      execute: async () => ({
        processes: mgr.processManager.getStatus(),
        goals: mgr.goalSupervisor.listGoals(),
        install: probeInstall(mgr.installCfg),
        audit: mgr.audit.health(),
      }),
    }),
    defineTool({
      name: 'codearts_run',
      description: '向 CodeArts CLI 发送单回合指令（headless run --format json），返回结构化结果（sessionId/文本/事件数）。长任务，耗时可达数分钟。',
      output: outputSpec,
      parameters: {
        prompt: { type: 'string', description: '要发给 codearts 的指令', required: true },
        sessionId: { type: 'string', description: '可选：续接的会话 ID' },
      },
      execute: async (args) => {
        if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
          throw new Error('Error: invalid_input: prompt 不能为空');
        }
        const result = await mgr.processManager.runOnce(args.prompt, {
          sessionId: typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined,
        });
        return { ok: result.ok, sessionId: result.sessionId, text: result.text.slice(0, 8000), eventCount: result.eventCount, durationMs: result.durationMs, error: result.error };
      },
    }),
    defineTool({
      name: 'codearts_goal',
      description: '启动/查询/控制受监督目标。action=start 需 objective+acceptanceCmd（目标完成以验收命令连续两次通过为准）；action=status 需 goalId；action=control 需 goalId+control(pause|resume|stop|check)。',
      output: outputSpec,
      parameters: {
        action: { type: 'string', description: 'start | status | list | control', required: true, enum: ['start', 'status', 'list', 'control'] },
        objective: { type: 'string', description: 'action=start：目标描述' },
        acceptanceCmd: { type: 'string', description: 'action=start：验收命令（如 "npm test"）' },
        mode: { type: 'string', description: 'action=start：structured（默认）| tui', enum: ['structured', 'tui'] },
        goalId: { type: 'string', description: 'action=status/control：目标 ID' },
        control: { type: 'string', description: 'action=control：pause | resume | stop | check', enum: ['pause', 'resume', 'stop', 'check'] },
      },
      execute: async (args) => {
        if (args.action === 'list') return lossless({ goals: mgr.goalSupervisor.listGoals() });
        if (args.action === 'start') {
          const { goalId } = await mgr.goalSupervisor.startGoal(String(args.objective ?? ''), {
            acceptanceCmd: String(args.acceptanceCmd ?? ''),
            mode: args.mode === 'tui' ? 'tui' : 'structured',
          });
          return lossless({ goalId, goal: mgr.goalSupervisor.getGoal(goalId) });
        }
        if (args.action === 'status') {
          if (typeof args.goalId !== 'string') throw new Error('Error: invalid_input: status 需要 goalId');
          return lossless({ goal: mgr.goalSupervisor.getGoal(args.goalId) });
        }
        if (args.action === 'control') {
          if (typeof args.goalId !== 'string' || typeof args.control !== 'string') {
            throw new Error('Error: invalid_input: control 需要 goalId 和 control');
          }
          const g = args.control === 'pause'
            ? mgr.goalSupervisor.pause(args.goalId, 'tool-request')
            : args.control === 'resume'
              ? await mgr.goalSupervisor.resume(args.goalId)
              : args.control === 'stop'
                ? mgr.goalSupervisor.stop(args.goalId)
                : args.control === 'check'
                  ? await mgr.goalSupervisor.checkAcceptance(args.goalId)
                  : null;
          if (g === null) throw new Error('Error: invalid_input: control 必须是 pause|resume|stop|check');
          return { goal: g };
        }
        throw new Error('Error: invalid_input: action 必须是 start|status|list|control');
      },
    }),
  ];
}

/**
 * cordis 插件入口。
 * @param {object} ctx dsh 宿主上下文（webServer 必注入；tools 可选）
 * @param {object} [config] 插件配置
 * @returns {() => void} cleanup
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const log = (message) => console.warn(`[dsh-codearts] ${message}`);

  // ① 单例管理器
  const audit = new AuditLogger(join(cfg.stateDir, 'audit', 'dsh-codearts.jsonl'), { component: 'plugin', now: Date.now });
  const processManager = new ProcessManager({
    stateDir: cfg.stateDir,
    wrapperPath: cfg.wrapperPath,
    binPath: cfg.binPath,
    runTimeoutMs: cfg.runTimeoutMs,
  }, { audit });
  const goalSupervisor = new GoalSupervisor(processManager, {
    stateDir: cfg.stateDir,
    stagnationMs: cfg.stagnationMs,
    checkIntervalMs: cfg.checkIntervalMs,
    retryBaseMs: cfg.retryBaseMs,
    retryCapMs: cfg.retryCapMs,
    alarmThreshold: cfg.alarmThreshold,
  }, { audit });
  const installManager = new InstallManager(
    { installRoot: join(cfg.codeartsHome, 'installers'), wrapperPath: cfg.wrapperPath },
    { stateDir: cfg.stateDir, audit: new AuditLogger(join(cfg.stateDir, 'audit', 'install.jsonl'), { component: 'install-manager' }) },
  );
  const modelManager = new ModelManager(
    { codeartsHome: cfg.codeartsHome },
    { stateDir: cfg.stateDir },
  );
  const mgr = { processManager, goalSupervisor, installManager, modelManager, installCfg: { installRoot: join(cfg.codeartsHome, 'installers'), wrapperPath: cfg.wrapperPath }, audit };

  // ② HTTP 管理路由
  const registerRoute = () => registerRoutes({
    webServer: ctx.webServer,
    processManager,
    goalSupervisor,
    installManager,
    modelManager,
    audit,
    fs: { readdirSync, statSync, readFileSync },
  });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => registerRoute(), 'dsh-codearts: HTTP routes');
  } else {
    registerRoute();
  }

  // ②b 码道委托协议注入智能体系统提示（dsh-taskboard 同款范式；委托语义全局生效）
  if (typeof ctx.systemPrompt?.section === 'function') {
    const disposeProtocol = ctx.systemPrompt.section({
      name: 'codearts-delegation-protocol',
      order: 181,
      text: CODEARTS_PROTOCOL,
    });
    ctx.effect(() => disposeProtocol, 'dsh-codearts: protocol section');
    log('已注入码道委托协议到智能体系统提示');
  } else {
    log('宿主未提供 ctx.systemPrompt，跳过协议注入（HTTP API 与工具不受影响）');
  }

  // ③ 平台工具（ctx.tools 可用时）
  /** @type {Array<() => void>} */
  const toolDisposers = [];
  if (cfg.registerTools && typeof ctx.tools?.register === 'function') {
    const tools = buildTools(ctx, mgr);
    for (const tool of tools) {
      const dispose = ctx.tools.register(tool);
      if (typeof dispose === 'function') toolDisposers.push(dispose);
    }
    log(`已注册 ${tools.length} 个平台工具（codearts_status/codearts_run/codearts_goal）`);
  } else if (cfg.registerTools) {
    log('宿主未提供 ctx.tools，跳过平台工具注册（HTTP API 与文件接口不受影响）');
  }

  // 启动自愈：检测"bin 缺失/仅剩 .delete"并尝试备份还原（失败显式告警，不阻断插件加载）
  try {
    const heal = installManager.autoHeal();
    if (heal.healed) log(`安装自愈完成：已从 ${heal.restoredFrom} 还原`);
  } catch (error) {
    log(`安装自愈未执行：${error instanceof Error ? error.message : String(error)}（HTTP POST /codearts/install/heal 可手动触发）`);
  }

  log('已就绪：/codearts/status|run|goals|health|install/heal（目标监督: 停滞续跑/错误无限重试/双过验收）');

  // ④ cleanup：工具注销 + 目标收尾 + 进程清理
  return () => {
    for (const dispose of toolDisposers) {
      try { dispose(); } catch (error) {
        log(`工具注销失败（继续其余清理）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    goalSupervisor.dispose();
    // 进程清理是异步的；cleanup 同步返回，异步收尾不吞错
    void processManager.dispose().catch((error) => {
      log(`进程清理未干净: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}
