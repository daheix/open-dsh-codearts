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
 *   - 单例连接：connPidRef 守卫，同一 pid 只建一条 SSE；Tab 面板常挂载，切 Tab 不断流。
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

/** 终端 Tab（独占整页）：xterm + 连接状态徽章 + 重连 + 键入直通。 */
export function TerminalZone(props: { tuis: TuiProc[]; active: boolean }): React.ReactNode {
  const alive = props.tuis.filter((p) => p.alive)
  const pid = alive.length > 0 ? (alive[alive.length - 1] ?? null)!.pid : null
  const [nonce, setNonce] = React.useState(0) // 重连信号（手动重连/心跳超时共用）
  const [conn, setConn] = React.useState<ConnState>(pid === null ? 'idle' : 'connecting')
  const [err, setErr] = React.useState<string | null>(null)
  const [frames, setFrames] = React.useState(0) // 帧计数（连接存活可视化）
  const [fontSize, setFontSize] = React.useState(loadFontSize)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const esRef = React.useRef<EventSource | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  /** 连接单例守卫：当前 SSE 绑定的 pid（与 esRef 联动，防重复建连）。 */
  const connPidRef = React.useRef<number | null>(null)
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

  // pid 或重连信号变化 → 断旧（reset 语义）建新；同一 pid 且连接健在则跳过（单例守卫）
  React.useEffect(() => {
    disposedRef.current = false
    if (pid === null) {
      connPidRef.current = null
      setConnSafe('idle')
      setErrSafe(null)
      return
    }
    // 单例守卫：同 pid 的活跃连接不重建（重渲染/Tab 切换不再产生第二路数据源）
    if (esRef.current !== null && connPidRef.current === pid) return
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

    // fit 尺寸变化 → 防抖通知服务端 resize（node-pty TIOCSWINSZ 动态生效）
    const scheduleResizeNotify = (): void => {
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        const t = termRef.current
        if (t !== null && pid !== null) void api.resizeTui(pid, t.cols, t.rows).catch(() => {})
      }, 300)
    }

    // ---- 键入直通（合帧）：⚠ 键盘输入实时生效——权限边界已在标题标注 ----
    const flushInput = (): void => {
      const buf = inputBufRef.current
      inputBufRef.current = ''
      inputTimerRef.current = null
      if (buf.length === 0 || pid === null) return
      api
        .postTuiInput(pid, buf)
        .catch((e: unknown) => {
          // 显式报错（禁静默）
          setErrSafe(`终端输入失败: ${errMsg(e)}`)
        })
    }
    const dataSub = term.onData((d) => {
      inputBufRef.current += d
      if (inputTimerRef.current === null) {
        inputTimerRef.current = setTimeout(flushInput, INPUT_FLUSH_MS)
      }
    })

    // ---- SSE：单例连接（修复根因 ①） + 帧计数诊断 ----
    let closedByUs = false
    const es = new EventSource(`/codearts/tui/stream?pid=${pid}`)
    esRef.current = es
    connPidRef.current = pid
    lastFrameAtRef.current = Date.now()
    const markFrame = (): void => {
      lastFrameAtRef.current = Date.now()
      frameCountRef.current += 1
      // 连接存活诊断：每 100 帧报一次（计数在涨=连接活着；恒 0=连接/路由问题）
      if (frameCountRef.current % 100 === 0) {
        console.info(`[dsh-codearts] TUI 流帧计数: ${frameCountRef.current}（pid=${pid}）`)
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
          // 握手帧：把本端 xterm 尺寸 resize 回服务端 PTY（尺寸协商闭环；已有 TUI 即时生效）
          const t = termRef.current
          if (t !== null) void api.resizeTui(pid, t.cols, t.rows).catch(() => {})
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
      if (connPidRef.current === pid) connPidRef.current = null
      if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = null
      if (resizeTimerRef.current !== null) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
      if (inputTimerRef.current !== null) clearTimeout(inputTimerRef.current)
      inputTimerRef.current = null
      dataSub.dispose()
    }
  }, [pid, nonce])

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
            if (pid !== null) void api.resizeTui(pid, term.cols, term.rows).catch(() => {})
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
          {conn === 'connected' ? <span className="dshca-badge" title="本连接已收到的 SSE 帧数（连接存活证据）">{frames} 帧</span> : null}
          {pid !== null ? <span className="dshca-badge">PID {pid}</span> : null}
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
      {pid === null ? (
        <div className="dshca-empty">
          当前没有存活的托管 TUI——到「概览」页点「启动 codearts」后此页自动接入新进程。
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
          display: pid === null ? 'none' : 'block',
        }}
      />
      <div style={{ flex: 'none', color: '#9a9a9a', fontSize: 11 }}>
        码道 TUI 为全屏应用（alternate screen）：历史查看请用码道内置会话功能；终端滚动缓冲不适用于全屏绘制。Ctrl+滚轮可缩放字号。
      </div>
    </section>
  )
}
