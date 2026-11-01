/**
 * Tab 1「TUI 终端」—— xterm.js 直连码道 TUI（Web 内嵌终端）。
 *
 * 管道：TUI stdout（script PTY）→ host 环形缓冲 → SSE /codearts/tui/stream
 * （快照补发 + 增量 chunk + event:exit + ping 心跳）→ xterm 渲染；键盘 xterm onData →
 * POST /codearts/tui/input（16ms 合帧）→ writeTui 键级透传（Enter 由前端发 \r）。
 *
 * ⚠ 权限边界（区域标题显式标注）：终端输入=直接操控码道，键盘实时生效。
 *
 * 刷新机制（2026-11-01 两轮实测裁决）：
 *   - 单例连接：connKeyRef 守卫，同一查看目标只建一条 SSE；Tab 面板常挂载，切 Tab 不断流。
 *   - （重）连一律 term.reset() 清屏后只写本连接 snap——杜绝 snap+旧 chunk 叠加。
 *   - 批量写入：writeQueue 50ms 合帧；**队列上限 4MB，超限丢最老**（终端是显示流不是
 *     业务数据，超限丢老块等同终端 scrollback 淘汰；丢时 console.info 留痕一次）。
 *   - 心跳 watchdog：>30s 无帧自动 reset+重连（服务端 15s 一帧 data:{"t":"ping"}）。
 *
 * 320 列适配（2026-11-01 实测第二裁决）：码道 TUI 忽略 stty 按内容自适应扩宽，流内
 * 光标定位到 312 列——xterm 160 列会列溢出渲染错乱（"完全乱麻"主因）。xterm cols=320
 * （host spawn stty 同步 320），容器横向滚动兜底。
 * 连接存活诊断：每累计 100 帧 console.info 一次帧计数（排查"什么都没显示"时先看它——
 * 计数在涨=连接活着是渲染问题；计数为 0=连接/路由问题）。
 * 显示恢复：Tab 激活时 term.refresh(0, rows-1) 全屏重绘 + fit——修 display:none 期间
 * 初始化/写入后不重绘导致的"切回来一片空白"。
 */
import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import * as api from './api'
import type { TuiProc } from './api'
import { errMsg } from './format'

/** 输入合帧窗口（ms）：击键突发合并为一次 POST，交互延迟无感。 */
const INPUT_FLUSH_MS = 16
/** 终端写入合帧窗口（ms）：高频 chunk 批量 term.write。 */
const WRITE_FLUSH_MS = 50
/** 写队列上限（字节）：超限丢最老块（终端显示流语义，等同 scrollback 淘汰）。 */
const WRITE_QUEUE_CAP_BYTES = 8 * 1024 * 1024 // 8MB：需容纳 1MB 全量 snap + 增量积压
/** 心跳超时（ms）：超过此值无任何 SSE 帧 → 判死重连（服务端 15s/帧）。 */
const HEARTBEAT_TIMEOUT_MS = 30_000
/** 心跳检查周期（ms）。 */
const HEARTBEAT_CHECK_MS = 5_000
/** xterm 初始占位尺寸（open 后立即 fit 成容器真实尺寸；真实 cols/rows 以 fit 为准）。 */
export const TERM_COLS = 80
export const TERM_ROWS = 24

/**
 * ② PTY 尺寸协商：按当前视口换算 spawn 用 cols/rows（cell 8.4×18px 近似），
 * 「启动 codearts」时随 tui/start 传给 host 的 stty——已有 TUI 不受影响（码道重启
 * 才生效，注释登记）；容器隐藏时退化为视口估算。
 */
export function proposePtySize(): { cols: number; rows: number } {
  const w = typeof window !== 'undefined' ? Math.max(360, window.innerWidth - 48) : 1280
  const h = typeof window !== 'undefined' ? Math.max(300, window.innerHeight - 210) : 720
  return {
    cols: Math.min(500, Math.max(80, Math.floor(w / 8.4))),
    rows: Math.min(200, Math.max(24, Math.floor(h / 18))),
  }
}

/** 终端字号（localStorage 记忆，范围 10..24px）。 */
function loadFontSize(): number {
  try {
    const v = Number(localStorage.getItem('dshca-fontsize'))
    if (v >= 10 && v <= 24) return Math.floor(v)
  } catch { /* 隐私模式等：回默认 */ }
  return 12
}

function saveFontSize(v: number): void {
  try {
    localStorage.setItem('dshca-fontsize', String(v))
  } catch { /* 同上 */ }
}

type ConnState = 'idle' | 'connecting' | 'connected' | 'exited' | 'error'

const CONN_LABEL: Record<ConnState, string> = {
  idle: '无进程',
  connecting: '连接中…',
  connected: '已连接',
  exited: 'TUI 已退出',
  error: '连接错误',
}

function connBadgeCls(s: ConnState): string {
  if (s === 'connected') return 'dshca-badge dshca-badge-ok'
  if (s === 'exited' || s === 'error') return 'dshca-badge dshca-badge-err'
  if (s === 'connecting') return 'dshca-badge dshca-badge-warn'
  return 'dshca-badge'
}

/** 终端查看目标选择：自动(最新存活托管) / 指定托管 PID / 指定守护会话（只读）。 */
export type ViewSelection = { kind: 'auto' } | { kind: 'managed'; pid: number } | { kind: 'bridge'; refId: string }

/** 终端 Tab（独占整页）：xterm + 连接状态徽章 + 重连 + 键入直通。 */
export function TerminalZone(props: {
  tuis: TuiProc[]
  /** 守护会话（codearts-bridge 监督驱动）：只读画面查看（SSE 代理快照，无输入通道）。 */
  bridges: Array<{ refId: string; pid: number | null; goalId: string; phase: string; alive: boolean }>
  /** 非托管且非守护的 codearts 进程：仅展示为不可接入的灰 chip，绝不伪装成可查看。 */
  externals: Array<{ pid: number }>
  active: boolean
  /** 用户显式选择的查看目标。 */
  selected: ViewSelection
  onSelect: (s: ViewSelection) => void
}): React.ReactNode {
  const alive = props.tuis.filter((p) => p.alive)
  /** 选择快照（局部常量保住判别联合收窄）。 */
  const sel = props.selected
  const selectedManaged = sel.kind === 'managed' ? (props.tuis.find((p) => p.pid === sel.pid) ?? null) : null
  const selectedBridge = sel.kind === 'bridge' ? (props.bridges.find((b) => b.refId === sel.refId) ?? null) : null
  // 绑定优先级：显式选择（托管存活 / 守护会话）> 默认最新存活托管。显式选择的托管
  // TUI 已死 → 不自动改绑其他进程（防"画面看起来还连着"的错觉），显式报"已退出"。
  const managedConn: { pid: number } | null =
    props.selected.kind === 'managed'
      ? (selectedManaged !== null && selectedManaged.alive ? { pid: selectedManaged.pid } : null)
      : (alive.length > 0 ? { pid: (alive[alive.length - 1] ?? null)!.pid } : null)
  const bridgeConn: { refId: string; pid: number | null } | null =
    props.selected.kind === 'bridge' && selectedBridge !== null
      ? { refId: selectedBridge.refId, pid: selectedBridge.pid }
      : null
  /** 连接描述（互斥：选择只有一种 kind）。守护会话走只读代理流。 */
  const target: { key: string; url: string; managed: boolean; pid: number | null } | null =
    bridgeConn !== null
      ? {
          key: `bridge:${bridgeConn.refId}`,
          url: `/codearts/tui/ext/view?ref=${encodeURIComponent(bridgeConn.refId)}`,
          managed: false,
          pid: bridgeConn.pid,
        }
      : managedConn !== null
        ? { key: `managed:${managedConn.pid}`, url: `/codearts/tui/stream?pid=${managedConn.pid}`, managed: true, pid: managedConn.pid }
        : null
  const selectedDead = props.selected.kind === 'managed' && selectedManaged !== null && !selectedManaged.alive
  const targetKey = target?.key ?? null
  /** 供非重连 effect 读取的最新连接描述（避免 target 对象身份进依赖数组）。 */
  const targetRef = React.useRef(target)
  targetRef.current = target
  const [nonce, setNonce] = React.useState(0) // 重连信号（手动重连/心跳超时共用）
  const [conn, setConn] = React.useState<ConnState>(target === null ? 'idle' : 'connecting')
  const [err, setErr] = React.useState<string | null>(null)
  const [frames, setFrames] = React.useState(0) // 帧计数（连接存活可视化）
  const [fontSize, setFontSize] = React.useState(loadFontSize)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const esRef = React.useRef<EventSource | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  /** 连接单例守卫：当前 SSE 绑定的目标 key（与 esRef 联动，防重复建连）。 */
  const connKeyRef = React.useRef<string | null>(null)
  /** 写队列 + 合帧定时器 + 队列字节数（超限丢老）。 */
  const writeQueueRef = React.useRef<string[]>([])
  const writeBytesRef = React.useRef(0)
  const writeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeDroppedRef = React.useRef(false)
  const inputBufRef = React.useRef('')
  const inputTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFrameAtRef = React.useRef(0)
  const frameCountRef = React.useRef(0)
  /** 生命周期终点标记：卸载后 effect 内异步回调不再触碰状态/连接。 */
  const disposedRef = React.useRef(false)

  const setConnSafe = (s: ConnState): void => {
    if (!disposedRef.current) setConn(s)
  }
  const setErrSafe = (m: string | null): void => {
    if (!disposedRef.current) setErr(m)
  }

  // 目标或重连信号变化 → 断旧（reset 语义）建新；同一目标且连接健在则跳过（单例守卫）
  React.useEffect(() => {
    disposedRef.current = false
    if (target === null) {
      connKeyRef.current = null
      setConnSafe('idle')
      setErrSafe(null)
      return
    }
    // 单例守卫：同一目标的活跃连接不重建（重渲染/Tab 切换不再产生第二路数据源）
    if (esRef.current !== null && connKeyRef.current === targetKey) return
    setConnSafe('connecting')
    setErrSafe(null)
    setFrames(0)
    frameCountRef.current = 0
    const host = hostRef.current
    if (host === null) return

    // ---- xterm 实例（同一 pid 只建一次；重连复用 term，仅 reset 清屏） ----
    let term = termRef.current
    if (term === null) {
      term = new Terminal({
        cols: TERM_COLS,
        rows: TERM_ROWS,
        fontSize: 12,
        fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace",
        theme: { background: '#101014', foreground: '#e8e8e8', cursor: '#e8e8e8', selectionBackground: 'rgba(96,165,250,.35)' },
        convertEol: false,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      fitRef.current = fit
      try { fit.fit() } catch { /* 布局未就绪：激活/ResizeObserver 会再 fit */ }
    }
    // 修复根因 ②：重连/新建一律 reset 清屏——本连接是唯一画面来源（node-pty 直通无 snap 重放）
    term.reset()

    // ---- 批量写入：chunk 入队，50ms 合帧 flush（队列 4MB 上限，超限丢最老并留痕） ----
    const flushWrites = (): void => {
      writeTimerRef.current = null
      const t = termRef.current
      if (t === null || writeQueueRef.current.length === 0) return
      const batch = writeQueueRef.current.join('')
      writeQueueRef.current = []
      writeBytesRef.current = 0
      t.write(batch)
    }
    const enqueueWrite = (d: string): void => {
      writeQueueRef.current.push(d)
      writeBytesRef.current += d.length
      // 超限丢最老（显示流淘汰语义；只留痕一次，恢复后重新武装）
      while (writeBytesRef.current > WRITE_QUEUE_CAP_BYTES && writeQueueRef.current.length > 1) {
        const dropped = writeQueueRef.current.shift()
        writeBytesRef.current -= dropped?.length ?? 0
        if (!writeDroppedRef.current) {
          writeDroppedRef.current = true
          console.info('[dsh-codearts] 终端写队列超 8MB，已丢弃最老输出块（显示流淘汰，非业务数据丢失）')
        }
      }
      if (writeTimerRef.current === null) {
        writeTimerRef.current = setTimeout(flushWrites, WRITE_FLUSH_MS)
      }
    }

    // fit 尺寸变化 → 防抖通知服务端 resize（node-pty TIOCSWINSZ 动态生效；仅托管流——
    // 守护会话只读，尺寸归其监督器管，本端 fit 仅本地显示）
    const scheduleResizeNotify = (): void => {
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        const t = termRef.current
        const cur = targetRef.current
        if (t !== null && cur !== null && cur.managed && cur.pid !== null) {
          void api.resizeTui(cur.pid, t.cols, t.rows).catch(() => {})
        }
      }, 300)
    }

    // ---- 键入直通（合帧）：⚠ 键盘输入实时生效——权限边界已在标题标注 ----
    // 守护会话（只读）不发送任何输入：目标由守护监督循环驱动，注入通道归其独占。
    const flushInput = (): void => {
      const buf = inputBufRef.current
      inputBufRef.current = ''
      inputTimerRef.current = null
      const cur = targetRef.current
      if (buf.length === 0 || cur === null || !cur.managed || cur.pid === null) return
      api
        .postTuiInput(cur.pid, buf)
        .catch((e: unknown) => {
          // 显式报错（禁静默）
          setErrSafe(`终端输入失败: ${errMsg(e)}`)
        })
    }
    const dataSub = term.onData((d) => {
      // 只读视图：击键不注入、不静默——直接给出能力边界提示（每次按键都提示会刷屏，
      // 用连接错误条展示一次即可）
      if (targetRef.current !== null && !targetRef.current.managed) {
        inputBufRef.current = ''
        setErrSafe('守护会话为只读画面：输入由 codearts-bridge 监督循环驱动，本面板不注入键盘。')
        return
      }
      inputBufRef.current += d
      if (inputTimerRef.current === null) {
        inputTimerRef.current = setTimeout(flushInput, INPUT_FLUSH_MS)
      }
    })

    // ---- SSE：单例连接（修复根因 ①） + 帧计数诊断 ----
    let closedByUs = false
    const es = new EventSource(target.url)
    esRef.current = es
    connKeyRef.current = targetKey
    lastFrameAtRef.current = Date.now()
    const markFrame = (): void => {
      lastFrameAtRef.current = Date.now()
      frameCountRef.current += 1
      // 连接存活诊断：每 100 帧报一次（计数在涨=连接活着；恒 0=连接/路由问题）
      if (frameCountRef.current % 100 === 0) {
        console.info(`[dsh-codearts] TUI 流帧计数: ${frameCountRef.current}（target=${targetKey}）`)
        if (!disposedRef.current) setFrames(frameCountRef.current)
      }
    }
    es.onopen = () => {
      if (closedByUs) return
      setConnSafe('connected')
    }
    es.onmessage = (ev) => {
      if (closedByUs) return
      markFrame()
      try {
        const msg = JSON.parse(ev.data) as { t: string; d?: string }
        if (msg.t === 'ping') return // 心跳：只续命，不写终端
        if (msg.t === 'hello') {
          // 握手帧：托管流把本端 xterm 尺寸 resize 回服务端 PTY（尺寸协商闭环；
          // 已有 TUI 即时生效）。守护只读流无尺寸协商（尺寸归守护监督器管）——仅本地 fit。
          const t = termRef.current
          if (t !== null && target.managed && target.pid !== null) {
            void api.resizeTui(target.pid, t.cols, t.rows).catch(() => {})
          }
          return
        }
        if (msg.t === 'snap') {
          // 服务端尾部快照（从最后一次清屏点起）：reset 后写入 = 干净恢复最近画面（无叠加——
          // 单连接守卫下本帧只出现一次；node-pty 直通顺序流无跨 chunk 截断问题）
          const t = termRef.current
          if (t !== null && typeof msg.d === 'string' && msg.d.length > 0) {
            t.reset()
            enqueueWrite(msg.d)
          }
          return
        }
        if (msg.t === 'chunk') {
          if (typeof msg.d === 'string' && msg.d.length > 0) enqueueWrite(msg.d)
          return
        }
        if (msg.t === 'exit') {
          // 守护只读流的会话消亡帧（托管流走下方 event:exit 通道）：显式断流转退出态
          closedByUs = true
          setConnSafe('exited')
          const t = termRef.current
          if (t !== null) t.write('\r\n\x1b[33m[守护会话已结束——在「查看目标」选择其他会话]\x1b[0m\r\n')
          es.close()
          if (esRef.current === es) esRef.current = null
          return
        }
        if (msg.t === 'error') {
          // 守护侧失败（会话消亡/守护下线）：显式报错并断流——不伪装成正常空白
          closedByUs = true
          setConnSafe('error')
          setErrSafe(`守护画面流失败：${msg.d ?? '未知错误'}`)
          es.close()
          if (esRef.current === es) esRef.current = null
        }
      } catch {
        // 非 JSON 帧无业务语义（服务端保证帧格式），忽略
      }
    }
    es.addEventListener('exit', () => {
      if (closedByUs) return
      closedByUs = true
      setConnSafe('exited')
      const t = termRef.current
      if (t !== null) t.write('\r\n\x1b[33m[码道 TUI 已退出——点击「重连」绑定新进程]\x1b[0m\r\n')
      es.close()
      if (esRef.current === es) esRef.current = null
    })
    es.onerror = () => {
      if (closedByUs) return
      // EventSource 对 4xx/网络错误会无限重连 → 显式断掉转错误态（重放叠加的源头一并切断）
      closedByUs = true
      es.close()
      if (esRef.current === es) esRef.current = null
      setConnSafe('error')
      setErrSafe('SSE 连接失败（端点不可达或 TUI 不在托管表）——点「重连」重试')
    }

    // ---- 心跳 watchdog：死链自动 reset+重连（复用本 effect 的重连语义） ----
    const watchdog = setInterval(() => {
      if (closedByUs) return
      if (Date.now() - lastFrameAtRef.current > HEARTBEAT_TIMEOUT_MS) {
        closedByUs = true
        es.close()
        if (esRef.current === es) esRef.current = null
        setErrSafe('心跳超时（>30s 无帧）——已自动重连')
        setNonce((v) => v + 1) // 触发重连（依赖 nonce 的 effect 重建连接）
      }
    }, HEARTBEAT_CHECK_MS)

    // ---- 容器尺寸变化 → 重排（仅 Tab 激活时；display:none 下 fit 尺寸为 0 会算错） ----
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
        if (!props.active) return // Tab 隐藏时跳过 fit（激活时由 active-effect 补 fit）
        try {
          fitRef.current?.fit()
          termRef.current?.refresh(0, (termRef.current?.rows ?? TERM_ROWS) - 1)
          scheduleResizeNotify() // 尺寸变化 → 防抖同步服务端 PTY
        } catch { /* 布局竞态：下次尺寸变化再试 */ }
      })
      : null
    if (observer !== null) observer.observe(host)

    return () => {
      observer?.disconnect()
      clearInterval(watchdog)
      closedByUs = true
      es.close()
      if (esRef.current === es) esRef.current = null
      if (connKeyRef.current === targetKey) connKeyRef.current = null
      if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = null
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
      if (inputTimerRef.current !== null) clearTimeout(inputTimerRef.current)
      inputTimerRef.current = null
      dataSub.dispose()
    }
  }, [targetKey, nonce])

  // 卸载：销毁 xterm 实例（连接已由上方清理）
  React.useEffect(() => {
    return () => {
      disposedRef.current = true
      termRef.current?.dispose()
      termRef.current = null
    }
  }, [])

  // Tab 激活 → fit + 全屏重绘（display:none 期间 init/写入的 xterm 显示后必须 refresh）
  React.useEffect(() => {
    if (props.active) {
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit()
          const term = termRef.current
          if (term !== null) {
            term.refresh(0, term.rows - 1)
            const cur = targetRef.current
            if (cur !== null && cur.managed && cur.pid !== null) {
              void api.resizeTui(cur.pid, term.cols, term.rows).catch(() => {})
            }
          }
        } catch { /* 容器未布局 */ }
      }, 60)
      return () => clearTimeout(t)
    }
  }, [props.active])

  // ④ 字号变化 → 更新 xterm 选项 + fit + 重绘（localStorage 记忆）
  React.useEffect(() => {
    const term = termRef.current
    if (term === null) return
    term.options.fontSize = fontSize
    saveFontSize(fontSize)
    try {
      fitRef.current?.fit()
      term.refresh(0, term.rows - 1)
    } catch { /* Tab 隐藏时跳过（激活时再 fit） */ }
  }, [fontSize])

  // ④ Ctrl+滚轮缩放（非 passive 监听才能 preventDefault）
  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setFontSize((v) => Math.min(24, Math.max(10, v + (e.deltaY < 0 ? 1 : -1))))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <section className="dshca-section dshca-termspan" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 320 }}>
      <h2 className="dshca-h2">
        TUI 终端
        <span className="dshca-h2note" style={{ color: '#fbbf24' }}>
          ⚠ 直连码道 TUI（键盘输入实时生效）
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span className={connBadgeCls(conn)}>{CONN_LABEL[conn]}</span>
          {conn === 'connected' && target !== null && !target.managed ? (
            <span className="dshca-badge dshca-badge-warn" title="守护会话只读：画面来自 codearts-bridge 快照代理，键盘注入不可用">只读</span>
          ) : null}
          {conn === 'connected' ? <span className="dshca-badge" title="本连接已收到的 SSE 帧数（连接存活证据）">{frames} 帧</span> : null}
          {target !== null && target.managed ? <span className="dshca-badge">PID {target.pid}</span> : null}
          {target !== null && !target.managed ? <span className="dshca-badge">守护 {target.pid !== null ? `PID ${target.pid}` : target.key}</span> : null}
          <button type="button" className="dshca-btn-ghost" onClick={() => setFontSize((v) => Math.max(10, v - 1))} title="减小终端字号（10-24px，localStorage 记忆）">
            A-
          </button>
          <span className="dshca-badge" title="终端字号（Ctrl+滚轮亦可缩放）">{fontSize}px</span>
          <button type="button" className="dshca-btn-ghost" onClick={() => setFontSize((v) => Math.min(24, v + 1))} title="增大终端字号（10-24px，localStorage 记忆）">
            A+
          </button>
          <button type="button" className="dshca-btn-ghost" onClick={() => setNonce((v) => v + 1)} title="清屏并重连 TUI 终端流（重连即 reset，不会叠加旧画面）">
            重连
          </button>
        </span>
      </h2>
      {props.tuis.length > 0 || props.bridges.length > 0 || props.externals.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          <span style={{ color: '#9a9a9a', fontSize: 11 }}>查看目标:</span>
          <button
            type="button"
            className={`dshca-chip${props.selected.kind === 'auto' && target !== null && target.managed ? ' dshca-chip-on' : ''}`}
            onClick={() => props.onSelect({ kind: 'auto' })}
            title="自动绑定最新启动的存活托管 TUI"
          >
            自动 · 最新
          </button>
          {props.tuis.map((p) => (
            <button
              key={p.pid}
              type="button"
              className={`dshca-chip${props.selected.kind === 'managed' && props.selected.pid === p.pid && p.alive ? ' dshca-chip-on' : ''}${p.alive ? '' : ' dshca-chip-dead'}`}
              onClick={() => props.onSelect({ kind: 'managed', pid: p.pid })}
              title={p.alive ? `查看 PID ${p.pid} 的终端画面（可键盘交互）` : `PID ${p.pid} 已退出（仅留档，无法重连）`}
            >
              {p.alive ? '🟢' : '⚪'} PID {p.pid}
            </button>
          ))}
          {props.bridges.map((b) => (
            <button
              key={b.refId}
              type="button"
              className={`dshca-chip dshca-chip-bridge${props.selected.kind === 'bridge' && props.selected.refId === b.refId ? ' dshca-chip-on' : ''}${b.alive ? '' : ' dshca-chip-dead'}`}
              onClick={() => props.onSelect({ kind: 'bridge', refId: b.refId })}
              title={`只读查看守护会话画面（目标 ${b.goalId}，phase=${b.phase}）——输入由 codearts-bridge 监督循环驱动，本面板不注入键盘`}
            >
              🟡 守护 {b.pid !== null ? `PID ${b.pid}` : b.refId}
            </button>
          ))}
          {props.externals.map((p) => (
            <span
              key={p.pid}
              className="dshca-chip dshca-chip-ext"
              title="非托管进程：非 codearts-bridge 守护会话，PTY 归其宿主所有，本插件无法接入画面/输入"
            >
              非托管 {p.pid}（不可接入）
            </span>
          ))}
        </div>
      ) : null}
      {selectedDead ? (
        <div className="dshca-empty">
          所选 TUI（PID {sel.kind === 'managed' ? sel.pid : '—'}）已退出——在上方选择其他 TUI，或到「概览」页点「启动 codearts」。
        </div>
      ) : null}
      {props.selected.kind === 'bridge' && selectedBridge === null ? (
        <div className="dshca-empty">
          所选守护会话（{props.selected.refId}）已不在清单——守护可能已完成/停止该目标，请在上方重新选择。
        </div>
      ) : null}
      {target === null && !selectedDead ? (
        <div className="dshca-empty">
          当前没有存活的托管 TUI——到「概览」页点「启动 codearts」后此页自动接入新进程；守护会话可在上方 chips 只读查看。
        </div>
      ) : null}
      {err !== null ? <div className="dshca-errbar" role="alert">⚠️ {err}</div> : null}
      <div
        ref={hostRef}
        className="dshca-termhost"
        style={{
          flex: 1,
          minHeight: 320,
          overflow: 'auto',
          background: '#101014',
          border: '1px solid #3a3a40',
          borderRadius: 8,
          padding: '2px 4px',
          display: target === null ? 'none' : 'block',
        }}
      />
      <div style={{ flex: 'none', color: '#9a9a9a', fontSize: 11 }}>
        码道 TUI 为全屏应用（alternate screen）：历史查看请用码道内置会话功能；终端滚动缓冲不适用于全屏绘制。Ctrl+滚轮可缩放字号。
      </div>
    </section>
  )
}
