# open-dsh-codearts

**华为云 CodeArts CLI 的 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 集成插件**：在 dsh Web 侧栏里直接运行和操作 CodeArts TUI、切换 CodeArts 使用的模型，并以「目标监督」方式让 CLI 持续工作——停滞自动续跑、报错无限重试、进程死自动重建、验收双过才算完成。

> 仓库名：`open-dsh-codearts` · npm 包名 / dsh bundle id：`dsh-codearts`

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.5-5B6EF5)](https://github.com/deepseek-ai/dsh)

---

## 功能

| 能力 | 说明 |
|------|------|
| **PTY 终端托管** | 用 `node-pty` 托管 CodeArts TUI，精确 cols/rows、动态 resize、SSE 实时推流；浏览器内可键盘交互，鼠标事件完整转发 |
| **目标监督** | 下发一个目标（objective + 验收命令），监督器持续拉起会话：停滞续跑、错误无限重试、TUI 进程死亡自动重建、验收命令连续两次通过 + `[GOAL-DONE]` 双过才结束 |
| **模型配置界面** | 列出 CodeArts 最近使用 / 内置候选 / 自定义模型，一键切换默认模型；支持添加、删除自定义 provider+model |
| **交互流** | 解析 CodeArts kernel 日志为结构化时间线（用户/助手/工具/错误/系统），并与原始日志互相印证 |
| **HTTP 管理 API** | `/codearts/*` 全套接口，可被脚本、CI 或其他智能体直接调用 |
| **非托管进程可见** | 状态页只读发现系统中由其他宿主（codearts-bridge 守护、手工终端）启动的 codearts 进程，明确标注「非托管」，避免把"本插件没有托管 TUI"误读成"机器上没有 TUI 在跑" |
| **dsh 平台工具** | 自动注册 `codearts_status` / `codearts_run` / `codearts_goal`，模型可在对话中直接调度 CodeArts |
| **安装管家** | 探测 CodeArts CLI、备份自愈、受控升级（哈希校验 + 失败回滚），应对厂商自动升级缺陷 |

## 环境要求

- **dsh** ≥ `0.2.1-rc.5`（开发验证版本）
- **Node.js** ≥ 20（dsh 宿主运行时）
- **pnpm**（`dsh plugin` 使用）
- **华为云 CodeArts CLI** 已安装并已登录：默认家目录 `~/.codeartsdoer`，登录态在 `cli-data/auth.json`
- TUI 终端需要原生模块 `node-pty`；如本机没有预编译包，需要 `python3` / `make` / `g++` 构建
- 平台：Linux / macOS（Windows 未验证；插件按 POSIX 进程与信号语义实现）

## 安装

### 方式 A：一键安装（推荐）

```bash
git clone https://github.com/daheix/open-dsh-codearts.git
cd open-dsh-codearts
./install.sh              # 默认装到 web profile；其它 profile: ./install.sh tui

# 重启 dsh 生效（安装器不会自动重启，避免中断正在运行的 TUI/目标）
dsh --profile web --port 3080
```

安装器做四件事：调用 `dsh plugin add`（新 profile 自动初始化）→ 在 profile 的 `pnpm-workspace.yaml` 中允许 `node-pty` 原生构建（只改这一项，保留其他 `allowBuilds`）→ 首装被 pnpm 拦截时自动清理并重装一次 → 硬验证 bundle 注册、`node-pty` 编译产物、插件入口三者齐全，任一缺失即显式报错。

> 也可以只下载安装器：`curl -fsSL https://raw.githubusercontent.com/daheix/open-dsh-codearts/main/install.sh -o install.sh && bash install.sh`

<details>
<summary>手动安装（与安装器等价）</summary>

```bash
dsh plugin --profile web add github:daheix/open-dsh-codearts
```

pnpm 首次会拦截 node-pty 构建并报 `ERR_PNPM_IGNORED_BUILDS`，此时编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  node-pty: true
```

然后清掉半装依赖并重装（dsh 才会把 bundle 写入 `dsh.profile.bundles`）：

```bash
dsh plugin --profile web remove dsh-codearts
dsh plugin --profile web add github:daheix/open-dsh-codearts
```

</details>

> 不装 `node-pty` 时插件的 HTTP API / 模型配置仍可用，但 **TUI 终端会显式报错**（不会静默降级）。

### 方式 B：本地源码开发

```bash
git clone https://github.com/daheix/open-dsh-codearts.git
cd open-dsh-codearts
bun install                  # 安装 node-pty 与测试依赖
dsh plugin --profile web add .
dsh --profile web --port 3080
```

pnpm 链接安装时，修改源码后重启 dsh 即生效，不需要复制文件。

### 验证

```bash
curl -s http://127.0.0.1:3080/codearts/status | head -c 400
```

浏览器打开 dsh Web，左侧栏应出现 **codearts 控制** 入口。

### 卸载

```bash
dsh plugin --profile web remove dsh-codearts
```

## 界面

侧栏 **codearts 控制** 提供五个页签：

1. **TUI 终端** — CodeArts 真实界面（SSE 流式、键盘/鼠标交互、`A-`/`A+` 字号调节）；多个托管 TUI 时通过「查看目标」chips 切换查看对象（默认绑定最新存活），非托管进程显示为不可接入的灰 chip
2. **概览** — TUI 进程、运行时长、内存、目标计数；存活托管 TUI 卡片带「查看」按钮（选中并跳到终端页）；状态每 5s 自动刷新（含非托管进程发现），右上「⟳ 立即刷新」可手动重拉，头部显示上次刷新时间
3. **目标监督** — 目标列表/详情（状态、注入、停滞、验收统计、会话五态）、启动新目标、暂停/恢复/停止/立即验收
4. **模型配置** — 最近使用 / 内置候选 / 自定义模型，单选即切换
5. **日志与交互流** — 结构化时间线 + 内核原始日志

## HTTP API

统一前缀 `/codearts`，认证沿用 dsh Web 的同源 cookie 层。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/codearts/status` | 总览（托管进程表 + 非托管进程发现 + 目标摘要 + 安装健康 + 审计健康） |
| GET | `/codearts/health` | 进程健康（存活 / RSS / 启动时间） |
| GET | `/codearts/models` | 模型清单（recent / builtin / custom + 当前模型） |
| POST | `/codearts/model` | 切换默认模型 `{providerID, modelID}` |
| POST / DELETE | `/codearts/models/custom` | 添加 / 删除自定义模型 |
| POST | `/codearts/run` | 单回合无头执行（需要 AK/SK；未配置时显式报错） |
| POST | `/codearts/tui/start` | 启动 TUI `{cols?, rows?}` |
| POST | `/codearts/tui/stop` | 停止 TUI `{pid}` |
| POST | `/codearts/tui/input` | 写入终端 `{pid, data}` |
| POST | `/codearts/tui/resize` | 调整尺寸 `{pid, cols, rows}` |
| GET | `/codearts/tui/stream?pid=N` | SSE：`hello` + 全量快照 + 增量输出 |
| GET | `/codearts/goals` | 目标列表 |
| POST | `/codearts/goals` | 启动目标 `{objective, acceptanceCmd, mode?, tuiPid?, sessionId?}` |
| GET | `/codearts/goals/:id` | 目标状态（含会话五态与证据） |
| POST | `/codearts/goals/:id/control` | `pause` / `resume` / `stop` / `check` |
| GET | `/codearts/activity?lines=N` | 交互流时间线（`lines` 上限 400） |
| GET | `/codearts/logs/tail?lines=N` | 内核日志尾部 |
| POST | `/codearts/install/heal` | CodeArts 安装自愈 |

## 配置

`apply(ctx, config)` 支持以下配置键：

| 键 | 默认 | 说明 |
|----|------|------|
| `codeartsHome` | `~/.codeartsdoer`（或 `CODEARTS_HOME`） | CodeArts CLI 家目录 |
| `stateDir` | `~/.dsh-codearts`（或 `DSH_CODEARTS_STATE_DIR`） | 目标持久化与审计 |
| `runTimeoutMs` | `600000` | 单回合执行超时（超时显式报错） |
| `stagnationMs` | `60000` | 停滞判定阈值；有效值另有 `minStagnationMs=300000` 下限（避免把模型长思考误判为卡死） |
| `checkIntervalMs` | `15000` | 监督器节拍 |
| `retryBaseMs` / `retryCapMs` | `5000` / `60000` | 错误重试指数退避 |
| `restartDelayMs` | `1000` | 进程死亡重建延迟 |
| `alarmThreshold` | `10` | 连续错误告警阈值（告警但不停止） |
| `registerTools` | `true` | 是否注册 dsh 平台工具 |

### 数据与安全

- 审计：`<stateDir>/audit/*.jsonl`；目标：`<stateDir>/goals/<goalId>.json`
- 切换模型会改写 CodeArts 的 `codearts_cli.json` 与 `state/model.json`，**改写前自动备份**，且只增改顶层 `model` 键
- 插件不收集、不上传任何数据；网络请求来自 CodeArts CLI 自身与其模型服务
- 插件会在 dsh 宿主内启动子进程并读写 CodeArts 配置，请只在可信环境安装

## 开发

```bash
cd open-dsh-codearts
bun install
bun test                       # 69 用例（fixture 沙箱，不触真实 CodeArts）
./manage.sh build              # 修改 src-client 后重建 lib/client.js
./manage.sh deploy             # 复制模式部署：原子同步到 dsh profile（重启后生效）
./manage.sh status             # 查看 dsh 中 TUI / 目标 / 模型实时状态
./manage.sh logs -f            # 跟踪 dsh 日志中的插件记录
```

`manage.sh` 默认连接 `http://127.0.0.1:3080`。若 dsh 绑定的是其他地址（如 `--host 0.0.0.0`）或端口：

```bash
DSH_URL=http://<host>:<port> ./manage.sh status
DSH_PROFILE_DIR=~/.dsh/profiles/tui ./manage.sh deploy
```

> `manage.sh deploy` 面向「profile 副本」部署模式；若使用 `dsh plugin add .` 的 pnpm 链接模式，改完源码重启 dsh 即可。

测试使用沙箱 `codeartsHome`，不会读写真实的 `~/.codeartsdoer`。

## 故障排查

| 现象 | 排查 |
|------|------|
| `/codearts/status` 404 | 插件未加载：确认 `dsh.profile.bundles` 含 `dsh-codearts`，并重启 dsh；查看日志中的 `[dsh-codearts]` 行 |
| 侧栏无入口 | 确认 `lib/client.js` 存在且 profile 的 `node_modules/dsh-codearts` 完整；`dsh plugin --profile web why dsh-codearts` |
| TUI 启动报 `node-pty 原生模块不可用` | 在 profile 的 `pnpm-workspace.yaml` 添加 `allowBuilds: { node-pty: true }`，执行 `dsh plugin --profile web rebuild node-pty` |
| TUI 起不来（无 node-pty 错误） | 确认 `~/.codeartsdoer/installers/codearts` 存在且可执行，`bin/codearts --version` 正常 |
| 目标一直 active 不推进 | 查看 `<stateDir>/audit/<goalId>.jsonl` 的 `goal.stagnation` / `goal.error` 序列；TUI 模式可用 `check` 动作手动触发验收 |
| 侧栏显示 0 个托管 TUI，但系统里有 codearts 在跑 | 这通常说明那些进程由别的宿主（codearts-bridge 守护、手工终端）启动，或 dsh 重启过（托管表是内存态，重启即清空）。状态页「非托管」区块会列出这些 PID；本插件只能观察，不能输入/停止。要在侧栏操作，请先在原宿主结束它们，再点「启动 codearts」 |
| `POST /codearts/run` 返回 502 | 无头执行需要 AK/SK；未配置时按设计显式失败，请改用 TUI 目标路径 |

## 兼容性

- 开发与验证环境：dsh `0.2.1-rc.5`、CodeArts CLI `26.10.13`、Node.js 24、Linux
- 插件不修改 dsh 核心代码，只通过官方 bundle / client / webServer / tools 扩展点接入

## License

[MIT](LICENSE) © 2026 daheix
