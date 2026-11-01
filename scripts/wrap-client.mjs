/**
 * dsh-codearts 客户端包装器 —— 照 dsh-taskboard 的 lib/client.js 形态：
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-codearts",
 *     factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports; ...
 *       <CJS 打包产物（react 经 require 注入，由宿主提供）>
 *       return module.exports;
 *     }
 *   })
 *
 * 为什么用包装形态而非裸 ESM：宿主 __ModuleLoader__ 以惰性 CJS 工厂加载客户端
 * 插件（taskboard 同款签名），factory 收到的 require 由宿主提供 react 等运行时；
 * 打包产物因此除宿主注入的 react 外无任何外部裸导入依赖。
 *
 * 用法：bun scripts/wrap-client.mjs   （读 dist-client/client.cjs → 写 lib/client.js）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dist-client', 'index.js');
const out = join(root, 'lib', 'client.js');

const bundled = readFileSync(src, 'utf8');

// xterm.css：bun build 把 JS 内 import 的 CSS 打成旁路产物（dist-client/*.css）——
// 读出后以 <style> 注入片段放进 factory 体内（运行时先于 React 渲染执行）。
const distDir = join(root, 'dist-client');
const cssFiles = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('.css')) : [];
const css = cssFiles.map((f) => readFileSync(join(distDir, f), 'utf8')).join('\n');
const cssInject = css.length > 0
  ? `(function(){var s=document.createElement("style");s.id="dshca-xterm-css";s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n`
  : '';

// 产物自检（显式报错，禁止带病出包）：
if (bundled.length < 4096) throw new Error(`打包产物异常过小（${bundled.length} 字节），拒绝包装: ${src}`);
if (!bundled.includes('require("react")')) {
  throw new Error('打包产物缺少 require("react") 外部引用——react 必须保持 external（宿主注入），拒绝包装');
}
if (/^\s*import\s/m.test(bundled)) {
  throw new Error('打包产物含顶层 ESM import 语句——CJS 形态不允许，拒绝包装');
}

/**
 * 头注释与包装骨架逐字对齐 dsh-taskboard（factory 签名 (require)，惰性 CJS 模块，
 * Symbol.toStringTag 标注），保证宿主 __ModuleLoader__ 的两种消费路径都兼容。
 */
const header = `/**
 * dsh-codearts — 浏览器半边（构建产物，勿手改；源码在 src-client/，构建入口 scripts/build-client.mjs）
 *
 * 侧栏「codearts 控制」面板（dsh 原生 slot 体系，照 dsh-taskboard 正统形态）：
 *   - sidebar.panellist slot → 侧栏按钮行（🤖 图标）
 *   - main slot              → 中央面板页（React 组件，宿主负责渲染）
 *   - 探测 3 轮 ×350ms 失败（或注册失败）→ 显式声明的降级路径：legacy DOM 注入
 *     （侧栏入口按钮 + 中央视图，taskboard sidebar-entry/board-mount 双件套对齐，
 *     见 src-client/legacy.tsx）
 *
 * 四区功能：
 *   ① 终端区（置顶）：xterm.js 直连码道 TUI（SSE /codearts/tui/stream 实时画面 +
 *      POST tui/input 键级输入，⚠ 键盘实时生效）；交互流时间线 + 原始日志随其后
 *   ② 运行状态区：TUI 进程卡（PID/RSS/运行时长/存活徽章）+ 启动/停止 codearts
 *   ③ 模型配置区：单选卡片列表（点击整行设为默认）+ ⭐recent + 自定义模型添加/移除
 *   ④ 目标管理区：目标列表 + 详情 + 暂停/恢复/停止/立即验收 + 启动新目标表单
 *
 * 纪律：全部 fetch 失败显式显示错误条（禁静默）；样式为自带深色面板白色系高对比
 * （不依赖 dsw 令牌做文字色）。
 */
window.__ModuleLoader__.load({
	id: "dsh-codearts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${cssInject}`;

const footer = `
		return module.exports;
	}
});
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header + bundled + footer, 'utf8');

const size = statSync(out).size;
if (size < 8192) throw new Error(`包装产物异常过小（${size} 字节）: ${out}`);
console.log(`[dsh-codearts] 客户端包装完成: ${out}（${size} 字节）`);
