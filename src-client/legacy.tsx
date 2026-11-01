/**
 * Legacy 强制 DOM 注入路径（照 dsh-taskboard sidebar-entry.ts / board-mount.tsx 双件套）。
 *
 * ⚠️ 启用条件（登记于此，别处禁止模仿）：official slot 路径探测失败或注册失败——
 * 实机实证（2026-11-01）：本宿主 client ctx 无 get 方法且属性访问受 cordis 守卫
 * （`cannot get property "slots" without inject`），官方路径在此宿主不可用；
 * taskboard 同样依赖本路径（其入口即 DOM 注入形态）——双路径才是完整实现。
 *
 * 结构（与 taskboard 逐条对齐）：
 *   - 侧栏入口：纯 DOM 按钮（无 React 树，绝不干扰外壳调和），插入侧栏根内
 *     logoRow/New Session 行旁；body 级 MutationObserver 等待外壳 + 自愈 React
 *     重渲染 + 2s 慢定时器兜底晚挂载。
 *   - 中央视图：中央列尾部追加容器（React 不管理的尾随子节点），react-dom/client
 *     createRoot 挂 CodeArtsPanel 三区页面；显隐由 <html data-dshca-active> 数据
 *     属性 + 样式表驱动（隐藏会话内容、展示本视图），外壳零 React 参与。
 *   - 视图切换收尾：点击侧栏其他行（会话/项目/搜索行）自动收起（捕获监听，豁免
 *     自身入口子树）；跨面板 dsh-panel-activate 事件互斥（开自己时驱逐他面板）。
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CodeArtsPanel } from './page'

/** 本插件入口行标识。 */
const ENTRY_SELECTOR = '[data-dshca-entry]'
/** 本插件中央视图容器标识。 */
const VIEW_SELECTOR = '[data-dshca-view]'
/** 激活态挂在 <html> 上的数据属性。 */
const ACTIVE_ATTR = 'data-dshca-active'
/** 跨面板激活事件（taskboard 家族约定）。 */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'dsh-codearts'
/** 开自己时驱逐的兄弟面板激活属性（家族互斥）。 */
const OTHER_ACTIVE_ATTRS = ['data-dsh-atb-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active']
/** 视为「用户切回会话」的侧栏行（点击即收起本面板；taskboard 同款）。 */
const SIDEBAR_ROW_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
/** 中央列三代匹配（dev shell / 官方 CSS-Module 布局 / DSH Desktop 扩展框）。 */
const COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
/** 侧栏根三代匹配（同 taskboard）。 */
const SIDEBAR_ROOT_SELECTOR =
  '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar, .dshDesktopSidebarSurface'
/** taskboard 家族既有入口（排序锚点用）。 */
const FAMILY_ENTRY_SELECTOR = '[data-dshca-entry], [data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'

/** 16px 导航图标Look的机器人（currentColor 自适应主题）。 */
const ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="10" height="7.5" rx="1.8"/><path d="M8 5.5V3.6"/><circle cx="8" cy="2.6" r="0.9"/><circle cx="6" cy="9" r="0.7" fill="currentColor" stroke="none"/><circle cx="10" cy="9" r="0.7" fill="currentColor" stroke="none"/><path d="M6.2 11h3.6"/></svg>'

/** 侧栏根元素（logoRow 的属主）；外壳未挂载时 undefined。 */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_ROOT_SELECTOR)
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? ((column.firstElementChild as HTMLElement | undefined) ?? undefined)
}

/**
 * New Session 按钮：logo 行内嵌 / 直接子 BUTTON / aria-label / 文本四级回退
 * （taskboard 同款；直接子扫描跳过自身入口防自引用锚点）。
 */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child instanceof HTMLButtonElement && !child.matches(ENTRY_SELECTOR)) return child
  }
  const byAria = root.querySelector<HTMLButtonElement>(
    'button[aria-label="新建会话"], button[aria-label="New Session"], button[aria-label*="新会话"], button[aria-label*="new session" i]',
  )
  if (byAria !== null) return byAria
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((b) => !b.matches(ENTRY_SELECTOR) && /新会话|新建会话|new session/i.test(b.textContent ?? ''))
}

/** 入口插到家族块之前（兄弟插件自愈重插时保持同序）；无锚不落位。 */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(FAMILY_ENTRY_SELECTOR),
    )
    const anchor = family.length > 0 ? (family[0] ?? null) : (base.nextElementSibling ?? null)
    root.insertBefore(entry, anchor)
  }
  return true
}

/** 中央列元素。 */
function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(COLUMN_SELECTOR) ?? undefined
}

/**
 * 挂载 legacy 双件套（侧栏入口 + 中央视图）。同步阶段不抛错（外壳未就绪由
 * observer/定时器接力）；返回总注销函数。
 */
export function mountLegacy(): () => void {
  // ---- 微型打开状态（taskboard controller 的窄面替代） ----
  let open = false
  const listeners = new Set<() => void>()

  let root: Root | undefined
  let container: HTMLDivElement | undefined

  /** 中央视图就位（幂等）；列未挂载时由 observer 重试。 */
  const ensureView = (): void => {
    if (container !== undefined) return
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshcaView = ''
    container.className = 'dshca-view'
    column.appendChild(container)
    root = createRoot(container)
    root.render(React.createElement(CodeArtsPanel))
  }

  const applyActive = (): void => {
    if (open) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      ensureView()
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const emit = (): void => {
    applyActive()
    for (const listener of [...listeners]) listener()
  }
  const setOpen = (value: boolean): void => {
    if (open === value) return
    open = value
    emit()
  }

  // ---- 侧栏入口（纯 DOM） ----
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshcaEntry = ''
  entry.className = 'dshca-entry'
  entry.setAttribute('aria-label', 'codearts 控制')
  entry.title = 'codearts 控制（CodeArts CLI 进程/交互流/模型/目标）'
  entry.innerHTML = `<span class="dshca-entry-icon">${ICON}</span><span class="dshca-entry-label">codearts 控制</span>`
  entry.addEventListener('click', () => setOpen(!open))

  let sidebarNode: HTMLElement | undefined
  let placed = false
  let failReported = false
  let attempts = 0

  const tryPlace = (): void => {
    attempts += 1
    if (sidebarNode !== undefined && !sidebarNode.isConnected) {
      rootObserver.disconnect()
      sidebarNode = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect()
      sidebarNode = undefined
      placed = false
    }
    sidebarNode ??= sidebarRoot()
    if (sidebarNode === undefined) return
    placed = placeEntry(sidebarNode, entry)
    if (placed) {
      rootObserver.observe(sidebarNode, { childList: true, subtree: true })
    }
  }

  // 外壳整体重建的兜底观察器
  const waitObserver = new MutationObserver(() => {
    tryPlace()
  })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // 自愈：外壳重渲染挤掉入口后同帧重插
  const rootObserver = new MutationObserver(() => {
    if (sidebarNode === undefined || !sidebarNode.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!sidebarNode.contains(entry)) placed = placeEntry(sidebarNode, entry)
  })

  // 慢定时器：无 mutation 流量的晚挂载也能等到；落位后每次 tick 只付一次 contains 检查
  const retry = setInterval(() => {
    tryPlace()
    // 显式失败报告（只报一次，不抛出——外壳可能真的晚到，继续留观察器接力）
    if (!placed && !failReported && attempts >= 10) {
      failReported = true
      console.error(
        '[dsh-codearts] legacy 挂载 20s 未找到侧栏根（选择器: ' +
          SIDEBAR_ROOT_SELECTOR +
          '）——观察器继续留驻，外壳出现后将自动落位',
      )
    }
  }, 2000)

  // 点击侧栏其他行 → 收起（捕获阶段；豁免自身入口子树，防先收后翻的竞态）
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!open) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest(ENTRY_SELECTOR) !== null) return
    if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) setOpen(false)
  }
  document.addEventListener('click', onClickSidebarRow, true)

  // 跨面板互斥：他面板激活时收起自己
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent).detail
    if (detail !== PANEL_NAME && open) setOpen(false)
  }
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

  // 激活态同步到入口按钮
  const syncEntry = (): void => {
    if (open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  listeners.add(syncEntry)
  applyActive()
  tryPlace()

  console.info('[dsh-codearts] legacy DOM 注入路径已启用（侧栏入口 + 中央视图，taskboard 双件套对齐）')

  return () => {
    clearInterval(retry)
    waitObserver.disconnect()
    rootObserver.disconnect()
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    listeners.delete(syncEntry)
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    container?.remove()
    entry.remove()
  }
}

/** 供审查：视图选择器常量（防止 tree-shake 掉常量导致测试断言失配）。 */
export const __SELECTORS = { VIEW_SELECTOR, ENTRY_SELECTOR, ACTIVE_ATTR }
