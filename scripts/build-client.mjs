/**
 * dsh-codearts 客户端一键构建（bun build + wrap，零外部依赖解析）。
 *
 * 为什么 bun build 而非 tsdown：宿主以惰性 CJS 工厂加载客户端（__ModuleLoader__），
 * react 由宿主注入，产物只要求「CJS + react external + 中文字符串字面量原样保留」；
 * bun build 一条命令满足且不需要本地安装 react（--external 空格形态不触发模块解析，
 * 已实证）。本插件 package.json 含不可解析的 "*" 依赖（宿主运行时符号链接解析），
 * 全量 bun install 不可行——故构建链必须零安装可用，bun build 是唯一满足者。
 *
 * 用法：export PATH="$HOME/.bun/bin:$PATH" && bun scripts/build-client.mjs
 * 产物：dist-client/index.js+index.css（中间产物）→ lib/client.js（提交入库的最终工件）
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src-client', 'index.ts');
const outDir = join(root, 'dist-client');
// bun build --outdir：CSS 旁路产物与 JS 同目录输出（--outfile 与 CSS import 同用会
// 报 Multiple files share the same output path，bun 1.4 实证）
const outFile = join(outDir, 'index.js');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${res.status}）:\n${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  }
  return res;
}

const bun = process.env.BUN_BIN ?? 'bun';
if (spawnSync(bun, ['--version'], { encoding: 'utf8' }).status !== 0) {
  throw new Error('bun 不可用：请先 export PATH="$HOME/.bun/bin:$PATH"');
}

console.log('[dsh-codearts] 清理中间产物 …');
rmSync(outFile, { force: true });

// xterm 就地准备：bun 打包需要从 src-client 向上解析 node_modules；构建期依赖装在
// scripts/build-client/（不在解析路径上）→ 幂等拷贝到 src-client/node_modules（gitignored）。
// 为什么不装到插件根 node_modules：根 package.json 含不可公网解析的 "*" 依赖，全量 install 必败。
const xtermSrc = join(root, 'scripts', 'build-client', 'node_modules', '@xterm');
const xtermDst = join(root, 'src-client', 'node_modules', '@xterm');
if (!existsSync(xtermSrc)) {
  throw new Error(`@xterm 未安装: ${xtermSrc} —— 先在 scripts/build-client/ 内执行 bun install`);
}
rmSync(xtermDst, { force: true, recursive: true });
mkdirSync(join(root, 'src-client', 'node_modules'), { recursive: true });
cpSync(xtermSrc, xtermDst, { recursive: true });
console.log('[dsh-codearts] @xterm 已就位 → src-client/node_modules/@xterm');

console.log('[dsh-codearts] bun build（CJS，react external）…');
run(bun, [
  'build', entry,
  '--format=cjs',
  '--external', 'react',
  '--external', 'react/jsx-runtime',
  '--external', 'react-dom',
  '--external', 'react-dom/client',
  '--outdir', outDir,
]);

if (!existsSync(outFile)) throw new Error(`bun build 未产出 ${outFile}`);
const size = statSync(outFile).size;
if (size < 4096) throw new Error(`打包产物异常过小（${size} 字节）: ${outFile}`);
console.log(`[dsh-codearts] 打包完成: dist-client/index.js（${size} 字节）`);

console.log('[dsh-codearts] 类型检查（tsc --noEmit，构建期依赖在 scripts/build-client/）…');
const tsc = join(root, 'scripts', 'build-client', 'node_modules', 'typescript', 'lib', 'tsc.js');
if (!existsSync(tsc)) {
  throw new Error(`tsc 不存在: ${tsc} —— 先在 scripts/build-client/ 内执行 bun install（构建期一次性准备）`);
}
run(bun, [tsc, '-p', join(root, 'tsconfig.json')]);
console.log('[dsh-codearts] 类型检查通过');

console.log('[dsh-codearts] 包装为 __ModuleLoader__ 形态 …');
run(bun, [join(root, 'scripts', 'wrap-client.mjs')]);

console.log('[dsh-codearts] 客户端构建全链完成 ✅');
