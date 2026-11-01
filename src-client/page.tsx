/**
 * codearts 控制台侧栏主页面 —— 终端直连 + 交互流主窗口 + 三辅助区（React 函数组件）。
 *
 * 布局（2026-11-01 Tab 化裁决）：五 Tab 面板常挂载、display 切换（后台不断流）：
 *   Tab1 TUI 终端（默认激活，独占整页）；Tab2 概览（进程卡 + 目标摘要）；
 *   Tab3 目标监督（完整详情 + 控制 + 启动新目标）；Tab4 模型配置（单选卡片）；
 *   Tab5 日志与交互流（activity 时间线 + 内核原始日志，各自暂停开关）
 *
 * 纪律：status/models/activity 全部 5s 轮询；fetch 失败显式错误条（禁静默）；
 * 文案统一「codearts」。
 */
import * as React from 'react'
import * as api from './api'
import type { ActivityItem, GoalSnapshot, ModelsResponse, StatusResponse, TuiProc } from './api'
import { TerminalZone, proposePtySize } from './terminal'
import { fmtBytes, fmtDuration, fmtTime, goalStateText, sessionStateText, shortGoalId, validateModelId } from './format'

/** 全局轮询间隔（status / models / activity 统一 5s）。 */
const POLL_MS = 5000
/** 内核原始日志尾部行数（服务端钳位 10..400）。 */
const LOG_LINES = 60

// ---------------------------------------------------------------- 轮询 hook

interface PollResult<T> {
  data: T | null
  error: string | null
  refresh: () => void
  /** 最近一次成功拉取的本地时间（ms）；尚未成功为 null。 */
  lastUpdated: number | null
}

/**
 * 轮询 hook：立即拉取一次，之后每 ms 周期拉取；失败保留最近一次好数据并暴露
 * error（显式错误条数据源）。in-flight 防重入，卸载后不再 setState。
 * fetcher 必须由调用方 useCallback 固定（作为订阅标识）。
 */
function usePoll<T>(fetcher: () => Promise<T>, ms: number): PollResult<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = React.useState<number | null>(null)
  const inFlight = React.useRef(false)
  const alive = React.useRef(true)
  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const refresh = React.useCallback((): void => {
    if (inFlight.current) return
    inFlight.current = true
    fetcher()
      .then((d) => {
        if (alive.current) {
          setData(d)
          setError(null)
          setLastUpdated(Date.now())
        }
      })
      .catch((e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [fetcher])
  React.useEffect(() => {
    refresh()
    const timer = setInterval(refresh, ms)
    return () => clearInterval(timer)
  }, [refresh, ms])
  return { data, error, refresh, lastUpdated }
}

/** 显式错误条：fetch 失败必现，禁静默。 */
function ErrorBar(props: { message: string }): React.ReactNode {
  return (
    <div className="dshca-errbar" role="alert">
      <span>⚠️</span>
      <span>
        {props.message}
        <br />
        <span style={{ opacity: 0.8 }}>（每 5 秒自动重试；若持续失败请检查 codearts 插件 host 半边是否就绪）</span>
      </span>
    </div>
  )
}

/** 操作结果提示行（成功绿 / 失败红；失败同样显式展示，不静默）。 */
function OpNote(props: { text: string | null; isError: boolean }): React.ReactNode {
  if (props.text === null) return null
  return <div className={`dshca-note${props.isError ? '' : ' dshca-note-ok'}`}>{props.text}</div>
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------- ① 交互流主窗口

/** 单条时间线条目（user 蓝边 / assistant 深灰气泡 / tool 等宽灰字 / error 红 / system 弱化）。 */
function ActivityItemView(props: { item: ActivityItem; index: number }): React.ReactNode {
  const it = props.item
  const time = it.time !== '' ? fmtTime(Date.parse(it.time)) : '--:--:--'
  const cls =
    it.kind === 'user'
      ? 'dshca-item-user'
      : it.kind === 'assistant'
        ? 'dshca-item-assistant'
        : it.kind === 'tool'
          ? 'dshca-item-tool'
          : it.kind === 'error'
            ? 'dshca-item-error'
            : 'dshca-item-system'
  const tag =
    it.kind === 'user' ? '任务' : it.kind === 'assistant' ? '回复' : it.kind === 'tool' ? '工具' : it.kind === 'error' ? '错误' : '状态'
  return (
    <div className={`dshca-item ${cls}`}>
      <span className="dshca-itemtime">
        {time} {tag}
      </span>
      {it.text}
    </div>
  )
}

/** 内核原始日志（可折叠次级区块；展开才轮询）。 */
function RawLogCollapsible(): React.ReactNode {
  const [open, setOpen] = React.useState(false)
  return (
    <details
      className="dshca-logwrap"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{ marginTop: 8, flex: 'none' }}
    >
      <summary className="dshca-btn-ghost" style={{ display: 'inline-block', cursor: 'pointer' }}>
        内核原始日志（logs/tail，辅助排查用）
      </summary>
      {open ? <RawLog /> : null}
    </details>
  )
}

/** 内核原始日志主体：5s 轮询 + 自动滚底 + 暂停滚动开关。 */
function RawLog(): React.ReactNode {
  const [autoScroll, setAutoScroll] = React.useState(true)
  const fetcher = React.useCallback(() => api.getLogsTail(LOG_LINES), [])
  const { data, error } = usePoll(fetcher, POLL_MS)
  const preRef = React.useRef<HTMLPreElement | null>(null)
  const text =
    data === null ? '' : data.rows.length > 0 ? data.rows.join('\n') : '（日志文件暂为空或尚无 kernel-*.log）'
  React.useEffect(() => {
    const el = preRef.current
    if (el !== null && autoScroll) el.scrollTop = el.scrollHeight
  }, [text, autoScroll])
  return (
    <div style={{ marginTop: 8 }}>
      <div className="dshca-loghead">
        <button
          type="button"
          className="dshca-btn-ghost"
          onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll ? '暂停自动滚动（手动查看历史时用）' : '恢复自动滚底'}
        >
          {autoScroll ? '⏸ 暂停滚动' : '▶ 自动滚底'}
        </button>
        {data?.file !== undefined && data.file !== null && data.file !== '' ? (
          <span title={data.file} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.file.split('/').slice(-1)[0]}
          </span>
        ) : null}
      </div>
      {error !== null ? <ErrorBar message={error} /> : null}
      <pre className="dshca-log" ref={preRef}>
        {text}
      </pre>
    </div>
  )
}

/** Tab 5「日志与交互流」：交互流时间线（/codearts/activity，5s 轮询，自动滚底 + 暂停开关）。 */
function ActivityZone(): React.ReactNode {
  const fetcher = React.useCallback(() => api.getActivity(), [])
  const { data, error } = usePoll(fetcher, POLL_MS)
  const [autoScroll, setAutoScroll] = React.useState(true)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const items = data?.items ?? []
  // 数据更新即滚底（未暂停时）
  React.useEffect(() => {
    const el = scrollRef.current
    if (el !== null && autoScroll) el.scrollTop = el.scrollHeight
  }, [data, autoScroll])
  return (
    <section className="dshca-timeline" style={{ flex: '1 1 auto' }}>
      <div className="dshca-tlhead">
        <span className="dshca-tltitle">交互流</span>
        <span>codearts 实际运行对话（注入任务 / 回复 / 工具执行 / 错误），每 5s 刷新</span>
        <span style={{ marginLeft: 'auto' }}>
          {items.length > 0 ? `${items.length} 条` : ''}
        </span>
        <button
          type="button"
          className="dshca-btn-ghost"
          onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll ? '暂停自动滚动（回看历史时用）' : '恢复自动滚底'}
        >
          {autoScroll ? '⏸ 暂停滚动' : '▶ 自动滚底'}
        </button>
      </div>
      {error !== null ? (
        <div style={{ padding: '0 12px' }}>
          <ErrorBar message={error} />
        </div>
      ) : null}
      <div className="dshca-tlscroll" ref={scrollRef}>
        {items.length === 0 && error === null ? (
          <div className="dshca-empty">
            暂无交互记录——启动 codearts 或等待当前会话产生对话（user/assistant/tool/error 五类信号都会出现在这里）。
          </div>
        ) : null}
        {items.map((it, i) => (
          <ActivityItemView key={`${it.time}-${it.kind}-${i}`} item={it} index={i} />
        ))}
        {items.length > 0 ? <div className="dshca-tlend">— 以上为最新 kernel 日志解析结果 —</div> : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- ② 运行状态条

/** 单个 TUI 进程卡。 */
function ProcCard(props: { proc: TuiProc }): React.ReactNode {
  const p = props.proc
  return (
    <div className="dshca-proc" title={p.command}>
      <b>
        {p.alive ? '🟢' : '⚪'} TUI · PID {p.pid}
      </b>{' '}
      <span className={`dshca-badge${p.alive ? ' dshca-badge-ok' : ''}`}>{p.alive ? '存活' : '已退出'}</span>
      <div className="dshca-dim">
        RSS {fmtBytes(p.rssBytes)} · 运行 {fmtDuration(p.startedAt)}
        {p.alive === false && p.exitedAt !== undefined ? ` · 退出于 ${fmtTime(Date.parse(p.exitedAt))}` : ''}
        {p.procState !== null ? ` · proc ${p.procState}` : ''}
      </div>
      <div className="dshca-dim">{p.command}</div>
    </div>
  )
}

interface StatusFace {
  data: StatusResponse | null
  error: string | null
  refresh: () => void
  lastUpdated: number | null
}

/** Tab 2「概览」：运行状态卡 + 受监督目标摘要（计数 + 每目标状态行）。 */
function StatusZone(props: { status: StatusFace }): React.ReactNode {
  const { data, error, refresh, lastUpdated } = props.status
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const [noteErr, setNoteErr] = React.useState(false)

  const act = (fn: () => Promise<string>, action: string): void => {
    if (busy) return // 防双击
    setBusy(true)
    setNote(`正在${action}…`)
    setNoteErr(false)
    fn()
      .then((msg) => {
        setNote(`✅ ${msg}`)
        refresh()
      })
      .catch((e: unknown) => {
        setNote(`❌ ${action}失败: ${errMsg(e)}`)
        setNoteErr(true)
      })
      .finally(() => setBusy(false))
  }

  const startTui = (): void => {
    // ② PTY 尺寸协商：启动前按视口换算 cols/rows 随 tui/start 下发（已有 TUI 不受影响）
    const size = proposePtySize()
    act(
      () =>
        api.startTui(size.cols, size.rows).then(
          (r) => `已启动 codearts TUI，托管 PID ${r.pid}（PTY ${size.cols}×${size.rows}，运行情况见「TUI 终端」页）`,
        ),
      '启动 codearts',
    )
  }
  const stopTui = (pid: number): void =>
    act(() => api.stopTui(pid).then((r) => `已停止 PID ${r.pid}${r.alreadyGone ? '（进程此前已退出）' : ''}`), '停止 codearts')

  const tuis = data?.processes.tui ?? []
  const external = data?.processes.external ?? null
  const externals = external?.procs ?? []
  const aliveCount = tuis.filter((p) => p.alive).length
  const goalCount = data?.goals.length ?? 0

  return (
    <section className="dshca-section">
      <h2 className="dshca-h2">
        运行状态
        <span className="dshca-h2note">
          托管 TUI {aliveCount} 存活 / {tuis.length} 总数 · 非托管 {externals.length} · 受监督目标 {goalCount} · 每 5s
          自动刷新 · 上次 {lastUpdated === null ? '—' : fmtTime(lastUpdated)}
        </span>
        <button
          type="button"
          className="dshca-btn-ghost"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={refresh}
          title="立即重新拉取：托管进程表 + 非托管进程发现 + 目标摘要（平时每 5s 自动刷新，刚在外部启停过进程时点它免等）"
        >
          ⟳ 立即刷新
        </button>
      </h2>
      {error !== null ? <ErrorBar message={error} /> : null}
      {external?.error != null ? (
        <div className="dshca-errbar">
          <b>非托管进程发现失败</b>
          <span>{external.error}</span>
        </div>
      ) : null}
      <div className="dshca-row">
        {tuis.length === 0 && error === null ? (
          <div className="dshca-empty">
            {externals.length === 0
              ? '当前没有托管 TUI 进程——点「启动 codearts」拉起一个交互式会话。'
              : '本插件托管表为空（0 个托管 TUI）——下方进程由其他宿主启动，不受本面板管理。'}
          </div>
        ) : null}
        {tuis.map((p) => (
          <ProcCard key={p.pid} proc={p} />
        ))}
      </div>
      {externals.length > 0 ? (
        <div className="dshca-ext">
          <div className="dshca-ext-title">
            ⚠ 检测到 {externals.length} 个非本插件托管的 codearts 进程
          </div>
          <div className="dshca-ext-note">
            这些进程由其他宿主（如 codearts-bridge 守护、手工终端）启动：本插件只能观察它们存在，
            <b>无法查看画面、无法输入、无法停止</b>。如需在本面板操作，请先在原宿主结束它们，再用「启动 codearts」重新拉起。
          </div>
          <div className="dshca-ext-list">
            {externals.map((p) => (
              <div key={p.pid} className="dshca-ext-item">
                <span className="dshca-badge dshca-badge-warn">非托管</span> PID {p.pid}
                <div className="dshca-dim">
                  RSS {fmtBytes(p.rssBytes)} · 状态 {p.procState ?? '—'} · {p.command}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="dshca-row" style={{ marginTop: 8 }}>
        <button type="button" className="dshca-btn" disabled={busy} onClick={startTui}>
          启动 codearts
        </button>
        {tuis
          .filter((p) => p.alive)
          .map((p) => (
            <button key={p.pid} type="button" className="dshca-btn-danger" disabled={busy} onClick={() => stopTui(p.pid)}>
              停止 codearts（PID {p.pid}）
            </button>
          ))}
      </div>
      <OpNote text={note} isError={noteErr} />
    </section>
  )
}

/** Tab 2「概览」的受监督目标摘要：计数 + 每目标一行（状态徽章 + 目标截断 + 验收连过数）。 */
function GoalsSummary(props: { goals: GoalSnapshot[] }): React.ReactNode {
  const goals = props.goals
  if (goals.length === 0) return <div className="dshca-empty">当前没有受监督目标——到「目标监督」页启动。</div>
  const running = goals.filter((g) => g.state === 'active' || g.state === 'verifying').length
  const paused = goals.filter((g) => g.state === 'paused').length
  const done = goals.filter((g) => g.state === 'done').length
  const stopped = goals.filter((g) => g.state === 'stopped').length
  return (
    <div>
      <div className="dshca-row" style={{ marginBottom: 8 }}>
        <span className="dshca-badge dshca-badge-ok">运行中 {running}</span>
        <span className="dshca-badge dshca-badge-warn">已暂停 {paused}</span>
        <span className="dshca-badge">已完成 {done}</span>
        <span className="dshca-badge dshca-badge-err">已停止 {stopped}</span>
      </div>
      {goals.map((g) => (
        <div key={g.goalId} className="dshca-mrow" style={{ cursor: 'default' }} title={g.objective}>
          <span className={`dshca-badge${g.state === 'active' || g.state === 'verifying' ? ' dshca-badge-ok' : g.state === 'paused' ? ' dshca-badge-warn' : g.state === 'done' ? '' : ' dshca-badge-err'}`}>
            {goalStateText(g.state)}
          </span>
          <span className="dshca-gobj">{g.objective}</span>
          <span className="dshca-gmeta">
            {shortGoalId(g.goalId)} · 连过 {g.stats.acceptancePassStreak} · 注入 {g.stats.injections}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- ③ 模型配置（单选卡片列表）

/** 单行模型卡片：点击整行即设为默认；⭐recent；当前默认绿边+对勾；行内 spinner/✓/错误反馈。 */
function ModelCard(props: {
  id: string
  source: '最近使用' | '内置' | '自定义'
  removable: boolean
  used: boolean
  current: boolean
  busy: boolean
  okFlash: boolean
  rowError: string | null
  onPick: () => void
  onRemove: () => void
}): React.ReactNode {
  return (
    <div
      className={`dshca-mrow${props.current ? ' dshca-mrow-cur' : ''}${props.okFlash ? ' dshca-mrow-ok' : ''}${props.busy ? ' dshca-mrow-busy' : ''}`}
      role="button"
      tabIndex={0}
      onClick={props.onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') props.onPick()
      }}
      title={props.current ? '当前默认模型' : '点击设为默认模型'}
    >
      <span className="dshca-mid">
        {props.used ? '⭐ ' : ''}
        {props.id}
      </span>
      {props.busy ? (
        <span className="dshca-spin" style={{ color: '#60a5fa' }}>
          ◌
        </span>
      ) : null}
      {props.current || props.okFlash ? (
        <span className="dshca-mcheck">{props.okFlash ? '✓ 已设为默认' : '✓'}</span>
      ) : null}
      <span className="dshca-msrc">{props.source}</span>
      {props.removable ? (
        <button
          type="button"
          className="dshca-btn-danger"
          disabled={props.busy}
          onClick={(e) => {
            e.stopPropagation()
            props.onRemove()
          }}
          title="从自定义清单移除（不影响内置候选）"
        >
          ×
        </button>
      ) : null}
      {props.rowError !== null ? <span className="dshca-merr">❌ {props.rowError}</span> : null}
    </div>
  )
}

/** ③ 模型配置区。 */
function ModelsZone(): React.ReactNode {
  const fetcher = React.useCallback(() => api.getModels(), [])
  const { data, error, refresh } = usePoll(fetcher, POLL_MS)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [okId, setOkId] = React.useState<string | null>(null)
  const [rowErr, setRowErr] = React.useState<{ id: string; msg: string } | null>(null)
  const [prov, setProv] = React.useState('')
  const [mid, setMid] = React.useState('')
  const [note, setNote] = React.useState<string | null>(null)
  const [noteErr, setNoteErr] = React.useState(false)
  const okTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (okTimer.current !== null) clearTimeout(okTimer.current)
    },
    [],
  )

  /** 整行点击 = 设为默认：spinner → ✓ 高亮 2s / 红色错误文本（禁静默）。 */
  const pickModel = (providerID: string, modelID: string): void => {
    if (busyId !== null) return // 防双击
    const id = `${providerID}/${modelID}`
    setBusyId(id)
    setRowErr(null)
    api.setModel(providerID, modelID)
      .then(() => {
        setBusyId(null)
        setOkId(id)
        if (okTimer.current !== null) clearTimeout(okTimer.current)
        okTimer.current = setTimeout(() => setOkId(null), 2000)
        refresh()
      })
      .catch((e: unknown) => {
        setBusyId(null)
        setRowErr({ id, msg: errMsg(e) })
      })
  }

  const addCustom = (): void => {
    if (busyId !== null) return
    const invalid = validateModelId(prov, mid)
    if (invalid !== null) {
      setNote(`❌ ${invalid}`)
      setNoteErr(true)
      return
    }
    const id = `${prov}/${mid}`
    setBusyId('__add__')
    setNote(`正在添加自定义模型 ${id} …`)
    setNoteErr(false)
    api.addCustomModel(prov, mid)
      .then(() => {
        setProv('')
        setMid('')
        setNote(`✅ 已添加自定义模型: ${id}`)
        refresh()
      })
      .catch((e: unknown) => {
        setNote(`❌ 添加失败: ${errMsg(e)}`)
        setNoteErr(true)
      })
      .finally(() => setBusyId(null))
  }

  const removeCustom = (providerID: string, modelID: string): void => {
    if (busyId !== null) return
    const id = `${providerID}/${modelID}`
    setBusyId(id)
    setNote(`正在移除自定义模型 ${id} …`)
    setNoteErr(false)
    api.removeCustomModel(providerID, modelID)
      .then(() => {
        setNote(`✅ 已移除自定义模型: ${id}`)
        refresh()
      })
      .catch((e: unknown) => {
        setNote(`❌ 移除失败: ${errMsg(e)}`)
        setNoteErr(true)
      })
      .finally(() => setBusyId(null))
  }

  const models: ModelsResponse | null = data
  const recentIds = new Set((models?.models.recent ?? []).map((m) => m.id))
  const customIds = new Set((models?.models.custom ?? []).map((m) => m.id))
  const currentId = models?.current?.id ?? null
  // 分组渲染（2026-11-01 修复：recent 全部项必须显示——此前只渲染 builtin/custom，
  // recent 中不在 builtin 清单里的型号（如 glm/glm-5.3-flash）被整条漏掉）。
  // 三组互斥去重：⭐最近使用（host 顺序=新→旧）→ 内置候选 → 自定义；每 id 恰好出现一次。
  const recentList = models?.models.recent ?? []
  const builtinList = (models?.models.builtin ?? []).filter((m) => !recentIds.has(m.id))
  const customList = (models?.models.custom ?? []).filter((m) => !recentIds.has(m.id))
  const allCount = recentList.length + builtinList.length + customList.length

  /** 单组渲染（组标题 + 行卡列表）。 */
  const renderGroup = (label: string, list: ModelsResponse['models']['recent'], tag: '最近使用' | '内置' | '自定义'): React.ReactNode => {
    if (list.length === 0) return null
    return (
      <div style={{ marginBottom: 8 }}>
        <div className="dshca-mgroup">{label}</div>
        {list.map((m) => {
          const slash = m.id.indexOf('/')
          const providerID = slash > 0 ? m.id.slice(0, slash) : m.id
          const modelID = slash > 0 ? m.id.slice(slash + 1) : ''
          const removable = tag !== '内置' && customIds.has(m.id)
          return (
            <ModelCard
              key={m.id}
              id={m.id}
              source={tag}
              removable={removable}
              used={tag === '最近使用'}
              current={m.id === currentId}
              busy={busyId === m.id}
              okFlash={okId === m.id}
              rowError={rowErr !== null && rowErr.id === m.id ? rowErr.msg : null}
              onPick={() => pickModel(providerID, modelID)}
              onRemove={() => removeCustom(providerID, modelID)}
            />
          )
        })}
      </div>
    )
  }

  return (
    <section className="dshca-section">
      <h2 className="dshca-h2">
        模型配置
        <span className="dshca-h2note">点击整行即设为默认 · 绿边 = 当前默认 · 分组：⭐最近使用/内置候选/自定义 · 每 5s 刷新</span>
      </h2>
      {error !== null ? <ErrorBar message={error} /> : null}
      <div className="dshca-row" style={{ marginBottom: 8 }}>
        <span style={{ color: '#cfcfcf' }}>当前默认：</span>
        {models?.current !== undefined && models.current !== null ? (
          <span className="dshca-badge dshca-badge-cur" title={`来源: ${models.current.source}`}>
            {models.current.id}
          </span>
        ) : (
          <span className="dshca-badge dshca-badge-warn" title={models?.currentError ?? '尚未选择任何模型'}>
            {models?.currentError ?? '未设置（点击下方任一模型行即设为默认）'}
          </span>
        )}
      </div>
      {models !== null && allCount === 0 && error === null ? <div className="dshca-empty">模型清单为空。</div> : null}
      <div>
        {renderGroup('⭐ 最近使用（TUI 实测，含全部手动配置过的型号）', recentList, '最近使用')}
        {renderGroup('内置候选（华为 MaaS）', builtinList, '内置')}
        {renderGroup('自定义', customList, '自定义')}
      </div>
      <div className="dshca-form">
        <input
          className="dshca-input"
          placeholder="providerID（如 huaweicloud-maas）"
          value={prov}
          onChange={(e) => setProv(e.target.value)}
          style={{ flex: '1 1 180px' }}
        />
        <input
          className="dshca-input"
          placeholder="modelID（如 glm-5.3）"
          value={mid}
          onChange={(e) => setMid(e.target.value)}
          style={{ flex: '1 1 160px' }}
        />
        <button
          type="button"
          className="dshca-btn"
          disabled={busyId !== null}
          onClick={addCustom}
          title="加入自定义清单（内置清单覆盖不到的型号由此补充，host 侧原子持久化）"
        >
          添加自定义模型
        </button>
      </div>
      <OpNote text={note} isError={noteErr} />
    </section>
  )
}

// ---------------------------------------------------------------- ④ 目标管理区

/** 单目标卡：头部行 + 展开详情 + 控制按钮。 */
function GoalCard(props: {
  goal: GoalSnapshot
  busy: boolean
  onControl: (goal: GoalSnapshot, action: api.GoalAction) => void
}): React.ReactNode {
  const g = props.goal
  const [open, setOpen] = React.useState(false)
  const stateCls =
    g.state === 'active' || g.state === 'verifying'
      ? ' dshca-badge-ok'
      : g.state === 'paused'
        ? ' dshca-badge-warn'
        : g.state === 'done'
          ? ''
          : ' dshca-badge-err'
  const canPause = g.state === 'active' || g.state === 'verifying'
  const canResume = g.state === 'paused'
  const canStop = canPause || canResume
  const sessionBad = g.session.state === 'stuck' || g.session.state === 'errored' || g.session.state === 'dead'
  return (
    <div className="dshca-gcard">
      <div
        className="dshca-ghead"
        onClick={() => setOpen((v) => !v)}
        title="点击展开/收起详情（stats、会话探测、控制按钮）"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span className={`dshca-badge${stateCls}`}>{goalStateText(g.state)}</span>
        <span className="dshca-gobj" title={g.objective}>
          {g.objective}
        </span>
        <span className="dshca-gmeta">
          {shortGoalId(g.goalId)} · 注入 {g.stats.injections} · 验收 {g.stats.acceptanceRuns}次(连过{' '}
          {g.stats.acceptancePassStreak})
        </span>
      </div>
      {open ? (
        <div className="dshca-gdetail">
          <dl>
            <dt>目标全文</dt>
            <dd style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12 }}>{g.objective}</dd>
            <dt>验收命令</dt>
            <dd>{g.acceptanceCmd}</dd>
            <dt>模式</dt>
            <dd>{g.mode === 'tui' ? `tui（TUI PID ${g.tuiPid ?? '—'}）` : 'structured'}</dd>
            <dt>会话探测</dt>
            <dd>
              <span
                className={`dshca-badge${sessionBad ? ' dshca-badge-err' : g.session.state === 'running' ? ' dshca-badge-ok' : ''}`}
              >
                {sessionStateText(g.session.state)}
              </span>{' '}
              最近活动 {g.session.lastActivity !== null ? fmtTime(Date.parse(g.session.lastActivity)) : '—'} · 传输{' '}
              {g.transportAlive ? '存活' : '已死'}
            </dd>
            <dt>更新时间</dt>
            <dd>{fmtTime(g.updatedAt)}</dd>
            {g.pausedReason !== undefined && g.pausedReason !== '' ? (
              <>
                <dt>暂停原因</dt>
                <dd>{g.pausedReason}</dd>
              </>
            ) : null}
            {g.cooldownUntil !== undefined && g.cooldownUntil > Date.now() ? (
              <>
                <dt>注入冷却</dt>
                <dd>
                  <span className="dshca-badge dshca-badge-warn" title="连续停滞注入无验收进展触发的退避：到期后照常注入，永不挂起">
                    注入冷却中（等待码道响应，至 {fmtTime(g.cooldownUntil)}）
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
          <div className="dshca-stats">
            <span className="dshca-stat">
              注入 <b>{g.stats.injections}</b>
            </span>
            <span className="dshca-stat">
              停滞 <b>{g.stats.stagnationEvents}</b>
            </span>
            <span className="dshca-stat">
              错误 <b>{g.stats.errors}</b>(连续 <b>{g.stats.consecutiveErrors}</b>)
            </span>
            <span className="dshca-stat">
              验收运行 <b>{g.stats.acceptanceRuns}</b>
            </span>
            <span className="dshca-stat">
              连过 <b>{g.stats.acceptancePassStreak}</b>
            </span>
            <span className="dshca-stat">
              重启 <b>{g.stats.restarts}</b>
            </span>
          </div>
          {g.session.lastError !== null && g.session.lastError !== '' ? (
            <div className="dshca-gerr">会话错误: {g.session.lastError}</div>
          ) : null}
          {g.lastError !== null && g.lastError !== undefined && g.lastError !== g.session.lastError ? (
            <div className="dshca-gerr">监督器错误: {g.lastError}</div>
          ) : null}
          <div className="dshca-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="dshca-btn-ghost"
              disabled={props.busy || !canPause}
              onClick={() => props.onControl(g, 'pause')}
            >
              ⏸ 暂停
            </button>
            <button
              type="button"
              className="dshca-btn"
              disabled={props.busy || !canResume}
              onClick={() => props.onControl(g, 'resume')}
            >
              ▶ 恢复
            </button>
            <button
              type="button"
              className="dshca-btn-danger"
              disabled={props.busy || !canStop}
              onClick={() => props.onControl(g, 'stop')}
            >
              ⏹ 停止
            </button>
            <button
              type="button"
              className="dshca-btn-ghost"
              disabled={props.busy}
              onClick={() => props.onControl(g, 'check')}
              title="立即运行一次验收命令（control action=check）"
            >
              🔍 立即验收
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Tab 3「目标监督」（goals 来自页面根共享的 status 轮询）。 */
function GoalsZone(props: { status: StatusFace }): React.ReactNode {
  const { data, error, refresh } = props.status
  const [busy, setBusy] = React.useState(false)
  const [objective, setObjective] = React.useState('')
  const [acceptance, setAcceptance] = React.useState('')
  const [mode, setMode] = React.useState<'structured' | 'tui'>('tui')
  const [note, setNote] = React.useState<string | null>(null)
  const [noteErr, setNoteErr] = React.useState(false)

  const control = (goal: GoalSnapshot, action: api.GoalAction): void => {
    if (busy) return
    setBusy(true)
    setNote(`正在对目标 ${shortGoalId(goal.goalId)} 执行 ${action} …`)
    setNoteErr(false)
    api.controlGoal(goal.goalId, action)
      .then((r) => {
        setNote(`✅ ${shortGoalId(goal.goalId)} ${action} 完成，当前状态: ${goalStateText(r.goal.state)}`)
        refresh()
      })
      .catch((e: unknown) => {
        setNote(`❌ ${action} 失败: ${errMsg(e)}`)
        setNoteErr(true)
      })
      .finally(() => setBusy(false))
  }

  const submitGoal = (): void => {
    if (busy) return
    if (objective.trim().length === 0) {
      setNote('❌ 目标描述（objective）不能为空')
      setNoteErr(true)
      return
    }
    if (acceptance.trim().length === 0) {
      setNote('❌ 验收命令（acceptanceCmd）不能为空——目标完成以验收命令连续两次通过为准')
      setNoteErr(true)
      return
    }
    setBusy(true)
    setNote('正在启动新目标 …')
    setNoteErr(false)
    api.startGoal(objective.trim(), acceptance.trim(), mode)
      .then((r) => {
        setNote(`✅ 已启动目标 ${r.goalId}（验收: ${acceptance.trim()}）`)
        setObjective('')
        setAcceptance('')
        refresh()
      })
      .catch((e: unknown) => {
        setNote(`❌ 启动目标失败: ${errMsg(e)}`)
        setNoteErr(true)
      })
      .finally(() => setBusy(false))
  }

  const goals = data?.goals ?? []

  return (
    <section className="dshca-section">
      <h2 className="dshca-h2">
        目标监督
        <span className="dshca-h2note">验收命令连续两次通过 = 完成 · 停滞自动注入续跑 · 每 5s 刷新</span>
      </h2>
      {error !== null ? <ErrorBar message={error} /> : null}
      {goals.length === 0 && error === null ? (
        <div className="dshca-empty">当前没有受监督目标——用下方表单启动一个。</div>
      ) : null}
      {goals.map((g) => (
        <GoalCard key={g.goalId} goal={g} busy={busy} onControl={control} />
      ))}
      <div className="dshca-form">
        <input
          className="dshca-input"
          placeholder="目标描述（objective，如：修复测试 foo 失败）"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          style={{ flex: '1 1 260px' }}
        />
        <input
          className="dshca-input"
          placeholder="验收命令（acceptanceCmd，如：bun test）"
          value={acceptance}
          onChange={(e) => setAcceptance(e.target.value)}
          style={{ flex: '1 1 200px' }}
        />
        <select
          className="dshca-input"
          value={mode}
          onChange={(e) => setMode(e.target.value === 'structured' ? 'structured' : 'tui')}
          title="运行模式：tui=交互式持续目标（推荐）；structured=单回合"
        >
          <option value="tui">tui（交互式，推荐）</option>
          <option value="structured">structured（单回合）</option>
        </select>
        <button type="button" className="dshca-btn" disabled={busy} onClick={submitGoal}>
          启动新目标
        </button>
      </div>
      <OpNote text={note} isError={noteErr} />
    </section>
  )
}

// ---------------------------------------------------------------- 页面根

/** codearts 控制台主页面：status 全局单份轮询（5s），交互流主窗口 + 三辅助区。 */
/** Tab 标识与标题（顺序即展示顺序；TUI 终端默认激活）。 */
type TabId = 'terminal' | 'overview' | 'goals' | 'models' | 'logs'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'terminal', label: 'TUI 终端' },
  { id: 'overview', label: '概览' },
  { id: 'goals', label: '目标监督' },
  { id: 'models', label: '模型配置' },
  { id: 'logs', label: '日志与交互流' },
]

/**
 * codearts 控制台主页面 —— Tab 化（2026-11-01 用户裁决）：
 *   Tab1 TUI 终端（默认，独占整页高度）；Tab2 概览；Tab3 目标监督（完整详情）；
 *   Tab4 模型配置；Tab5 日志与交互流。
 *
 * 刷新纪律：所有 Tab 面板**常挂载**（display 切换，不卸载）——SSE/轮询在后台持续
 * 运行，切回即见最新；终端连接单例化由 terminal.tsx 守卫（切 Tab 不产生第二路数据）。
 */
export function CodeArtsPanel(): React.ReactNode {
  const statusFetcher = React.useCallback(() => api.getStatus(), [])
  const status = usePoll(statusFetcher, POLL_MS)
  const [tab, setTab] = React.useState<TabId>('terminal')
  const goals = status.data?.goals ?? []
  const panelStyle = (active: boolean, scroll = true): React.CSSProperties =>
    active
      ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', ...(scroll ? { overflow: 'auto' } : {}) }
      : { display: 'none' }
  return (
    <div className="dshca-page">
      <h1>🤖 codearts 控制</h1>
      <p className="dshca-sub">
        CodeArts CLI 进程托管 · 交互流 · 模型配置 · 目标监督 —— 数据来自 codearts 插件 host 半边（/codearts/*），每 5 秒自动刷新
      </p>
      <div className="dshca-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`dshca-tab${tab === t.id ? ' dshca-tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* 面板全部常挂载（display 切换）：终端 SSE 不因切 Tab 断流，切回即最新 */}
      <div style={panelStyle(tab === 'terminal', false)}>
        <TerminalZone tuis={status.data?.processes.tui ?? []} active={tab === 'terminal'} />
      </div>
      <div style={panelStyle(tab === 'overview')}>
        <StatusZone status={status} />
        <section className="dshca-section">
          <h2 className="dshca-h2">受监督目标摘要</h2>
          <GoalsSummary goals={goals} />
        </section>
      </div>
      <div style={panelStyle(tab === 'goals')}>
        <GoalsZone status={status} />
      </div>
      <div style={panelStyle(tab === 'models')}>
        <ModelsZone />
      </div>
      <div style={panelStyle(tab === 'logs')}>
        <ActivityZone />
        <RawLogCollapsible />
      </div>
    </div>
  )
}
