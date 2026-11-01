/**
 * dsh 原生 slot 体系挂载（照 dsh-taskboard 正统形态）+ legacy DOM 注入兜底。
 *
 *   - `sidebar.panellist` slot：贡献侧栏按钮行（宿主外壳拥有按钮态与面板切换）
 *   - `main` slot：同 id 的中央面板内容（React 组件，宿主负责渲染）
 *
 * 探测纪律（实机教训 2026-11-01）：client ctx 的服务访问受 cordis 守卫——本宿主
 * 实测 `ctx.get('slots')`/`ctx.slots` 直接抛 `cannot get property "slots" without
 * inject`。因此探测全程 try/catch 包裹，任何守卫抛错一律视作「官方路径不可用」，
 * 绝不允许逃逸；探测 3 轮 ×350ms 全败 → **显式声明的 legacy DOM 注入路径**
 * （src-client/legacy.tsx，taskboard 双件套对齐）。两路径切换均 console.info 显式
 * 登记；legacy 也失败才 console.error 并向上抛出（由 apply 兜住记录）。
 */
import * as React from 'react'
import { CodeArtsPanel } from './page'
import { PANEL_STYLES } from './styles'
import { mountLegacy } from './legacy'

/** 面板 id：侧栏行与 main slot 占据者共用（宿主按此关联两者）。 */
export const OFFICIAL_PANEL_ID = 'dsh-codearts'

/** 侧栏行在全局面板行中的次序（插件行 0 之后）。 */
const PANEL_ROW_ORDER = 10

/** 探测轮数与间隔（与 taskboard 同参：3 × 350ms）。 */
const PROBE_ROUNDS = 3
const PROBE_INTERVAL_MS = 350

/** slots 服务的窄面（本插件用到的全部能力）。 */
interface SlotsServiceFace {
  inject(key: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: (props: never) => React.ReactNode): () => void
  spec(key: string): unknown
}

/** 客户端 ctx 的窄面（effect 用于登记卸载钩子）。 */
export interface MountContextFace {
  get?(name: string): unknown
  effect?(callback: () => () => void, name: string): unknown
}

/**
 * 可用的 slots 服务；不可用一律返回 undefined（**绝不抛错**——cordis 守卫对未
 * 声明服务的 get/属性访问都会抛，那是探测失败的信号而非插件故障）。
 */
function officialSlots(ctx: MountContextFace): SlotsServiceFace | undefined {
  let raw: unknown
  try {
    raw = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
  } catch {
    raw = undefined
  }
  if (raw === undefined) {
    try {
      raw = (ctx as unknown as Record<string, unknown>).slots
    } catch {
      return undefined // cordis 守卫抛错：未声明 slots → 官方路径不可用
    }
  }
  const slots = raw as SlotsServiceFace | undefined
  if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function' || typeof slots.spec !== 'function') {
    return undefined
  }
  try {
    if (slots.spec('main') === undefined) return undefined
    if (slots.spec('sidebar.panellist') === undefined) return undefined
  } catch {
    return undefined
  }
  return slots
}

// ---------------------------------------------------------------- 图标

/** 侧栏行图标：静态机器人 SVG glyph（currentColor 自适应主题；16px 基准）。 */
export function PanelIcon(props: { size?: number }): React.ReactNode {
  const size = typeof props.size === 'number' ? props.size : 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <rect x={3} y={5.5} width={10} height={7.5} rx={1.8} />
      <path d="M8 5.5V3.6" />
      <circle cx={8} cy={2.6} r={0.9} />
      <circle cx={6} cy={9} r={0.7} fill="currentColor" stroke="none" />
      <circle cx={10} cy={9} r={0.7} fill="currentColor" stroke="none" />
      <path d="M6.2 11h3.6" />
    </svg>
  )
}

// ---------------------------------------------------------------- 注册

/**
 * 官方路径注册：sidebar.panellist 贡献按钮行（label 交给宿主渲染侧栏文字），
 * main 贡献页面。返回注销函数；任何一步失败先拆除半成品再显式抛错。
 */
function tryRegister(slots: SlotsServiceFace): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      slots.inject('main', () =>
        slots.register({ name: 'main', key: OFFICIAL_PANEL_ID }, function OfficialCodeArtsPage(): React.ReactNode {
          return React.createElement(CodeArtsPanel)
        }),
      ),
    )
    disposers.push(
      slots.inject('sidebar.panellist', () =>
        slots.register(
          { name: 'sidebar.panellist', id: OFFICIAL_PANEL_ID, order: PANEL_ROW_ORDER, label: () => 'codearts 控制' },
          function OfficialCodeArtsIcon(props: { size?: number }): React.ReactNode {
            return PanelIcon(props)
          },
        ),
      ),
    )
  } catch (error) {
    for (const dispose of disposers.splice(0)) dispose()
    throw new Error(`[dsh-codearts] 侧栏面板注册失败: ${error instanceof Error ? error.message : String(error)}`)
  }
  console.info('[dsh-codearts] 官方 slot 路径已启用（sidebar.panellist + main）:', OFFICIAL_PANEL_ID)
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * 挂载兼容层：官方 slot 路径优先（防御式探测 + 3×350ms 宽限重试）；全败 →
 * legacy DOM 注入（显式声明的降级路径）。返回总注销函数。
 */
export function mountCompat(ctx: MountContextFace): () => void {
  const stylesDisposer = installStyles()

  const tryOfficial = (): (() => void) | undefined => {
    const slots = officialSlots(ctx)
    if (slots === undefined) return undefined
    try {
      return tryRegister(slots)
    } catch (error) {
      console.error('[dsh-codearts] 官方路径注册失败（转 legacy）:', error)
      return undefined
    }
  }

  // ① 立即探测
  const immediate = tryOfficial()
  if (immediate !== undefined) {
    return () => {
      immediate()
      stylesDisposer()
    }
  }

  // ③ 全败 → legacy DOM 注入（显式声明并登记的降级路径；同步失败才向上抛）
  let legacyDisposer: (() => void) | undefined
  const startLegacy = (): (() => void) => {
    try {
      return mountLegacy()
    } catch (error) {
      console.error('[dsh-codearts] legacy 路径也失败——客户端挂载终止（不影响宿主外壳）:', error)
      throw error
    }
  }

  // ② 有界宽限重试（覆盖基座晚于 profile 插件加载的奇异时序）
  let round = 0
  const timer = setInterval(() => {
    try {
      const upgraded = tryOfficial()
      if (upgraded !== undefined) {
        clearInterval(timer)
        if (legacyDisposer !== undefined) {
          legacyDisposer()
          legacyDisposer = undefined
        }
        return
      }
    } catch (error) {
      // 探测过程的延迟异常绝不允许逃逸成宿主未捕获错误：就地显式报告并停表
      console.error('[dsh-codearts] 探测过程异常（停止后续探测，不影响宿主外壳）:', error)
      clearInterval(timer)
      return
    }
    round += 1
    if (round >= PROBE_ROUNDS && legacyDisposer === undefined) {
      try {
        legacyDisposer = startLegacy()
      } catch {
        // startLegacy 内已 console.error；向上抛会被本回调外层吞掉——挂载终止即可
        clearInterval(timer)
      }
    }
  }, PROBE_INTERVAL_MS)

  return () => {
    clearInterval(timer)
    legacyDisposer?.()
    stylesDisposer()
  }
}

/** 注入面板样式表（幂等：按 id 去重）。只能在浏览器钩子（apply）内调用，禁在模块顶层碰 document。 */
export function installStyles(): () => void {
  const STYLE_ID = 'dshca-styles'
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => undefined
  const styleEl = document.createElement('style')
  styleEl.id = STYLE_ID
  styleEl.textContent = PANEL_STYLES
  document.head.appendChild(styleEl)
  return () => {
    styleEl.remove()
  }
}
