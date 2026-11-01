/**
 * node-pty 中继（bun 运行时专用桥，2026-11-01 终局改造配套）。
 *
 * 实证：node-pty 原生 addon 在 bun 下 PTY 子进程不稳定（spawn 后秒退/无输出）——
 * 原因是 addon 内部依赖宿主 libuv 的 uv_spawn PTY 特性，bun 的兼容层不完整。
 * dsh 生产运行时是 node（直接进程内 node-pty，不受影响）；bun test 需要 PTY 时由
 * 本中继桥接：真实 node 子进程持有 PTY。
 *
 * 协议 v2（纯管道，无 IPC——bun 的 detached+ipc 通道不工作，实证 process.connected=false）：
 *   relay → parent：fd3 逐行 JSON  {t:'data', d} | {t:'exit', code}
 *   parent → relay：stdin 逐行 JSON {t:'write', d} | {t:'resize', cols, rows}
 * 父进程消亡（stdin 关闭）→ PTY 整组终结，绝不留孤儿码道。
 *
 * 用法：node tui-pty-relay.cjs <cols> <rows> <cwd> -- <file> [args...]
 */
const fs = require('node:fs');
const argv = process.argv.slice(2);
const cols = Number(argv[0]);
const rows = Number(argv[1]);
const cwd = argv[2];
const sep = argv.indexOf('--');
const file = argv[sep + 1];
const rest = argv.slice(sep + 2);
if (!file || !(cols > 0) || !(rows > 0)) {
  console.error('用法: node tui-pty-relay.cjs <cols> <rows> <cwd> -- <file> [args...]');
  process.exit(2);
}

/** fd3 逐行写（数据通道；父进程读取 child.stdio[3]）。 */
function sendLine(obj) {
  try {
    fs.writeSync(3, JSON.stringify(obj) + '\n');
  } catch { /* 父端已关：下方 stdin close 分支会终结 PTY */ }
}

const pty = require('node-pty');
const p = pty.spawn(file, rest, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd,
  env: process.env,
});

p.onData((d) => sendLine({ t: 'data', d }));
p.onExit(({ exitCode }) => {
  sendLine({ t: 'exit', code: exitCode ?? null });
  // 给 fd3 冲刷留出时间后退出
  setTimeout(() => process.exit(0), 50);
});

// stdin：父端命令通道（逐行 JSON）
let lineBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lineBuf += chunk;
  let idx;
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx);
    lineBuf = lineBuf.slice(idx + 1);
    if (line.length === 0) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.t === 'write' && typeof m.d === 'string') {
      try { p.write(m.d); } catch { /* PTY 已关 */ }
    } else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
      try { p.resize(m.cols, m.rows); } catch { /* PTY 已关 */ }
    }
  }
});
// 父端消亡 → PTY 整组终结，绝不留孤儿码道
process.stdin.on('close', () => {
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill(); } catch { /* 已退出 */ } }
  process.exit(0);
});
