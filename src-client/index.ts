/**
 * dsh-codearts — 浏览器半边入口（Cordis 客户端插件形状：name / inject / apply）。
 *
 * 宿主 __ModuleLoader__ 以惰性 CJS 工厂加载本模块（见 scripts/wrap-client.mjs），
 * apply(ctx) 在 web 外壳就绪后被调用；ctx 携带 slots/layout 等服务定位器。
 *
 * 纪律：
 *   - 模块顶层禁止触碰 document/window（加载期可能在非 DOM 环境）——所有 DOM
 *     工作都在 apply 之后的浏览器钩子里进行；
 *   - 本插件任何异常都不允许影响宿主外壳（apply 全量 try/catch + 显式报错日志）。
 *
 * 挂载顺序：官方 slot 路径（防御式探测）→ 探测失败/注册失败 → legacy DOM 注入
 * （显式声明的降级路径，taskboard 双件套对齐）；两路径切换均 console.info 登记。
 */
import { mountCompat, type MountContextFace } from './slots'

/** 客户端插件名（宿主日志识别用）。 */
export const name = 'dsh-codearts/client'

/** 注入服务需求：本插件只依赖 slots（可选探测），无强制注入。 */
export const inject: string[] = []

/**
 * apply：挂载侧栏「码道控制」面板（官方 slot 路径）或显式降级的悬浮面板。
 * 卸载钩子优先走宿主 ctx.effect 登记（随插件生命周期自动回收）。
 */
export function apply(ctx: MountContextFace): void {
  try {
    const dispose = mountCompat(ctx)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-codearts: client mount')
    }
    // ctx.effect 不可用时保持挂载（客户端插件与外壳同生命周期，无独立卸载路径）
  } catch (error) {
    console.error('[dsh-codearts] client apply 失败（不影响宿主外壳）:', error)
  }
}
