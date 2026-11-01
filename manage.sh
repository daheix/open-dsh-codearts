#!/usr/bin/env bash
# dsh-codearts 独立仓库使用管理
#
# 用法:
#   ./manage.sh deploy    校验源码并原子同步到 dsh profile（重启 dsh 后生效）
#   ./manage.sh build     重新构建侧栏客户端产物 lib/client.js
#   ./manage.sh test      运行完整测试套件（沙箱 fixture，不触真实 CLI）
#   ./manage.sh status    查看 dsh 中插件/终端/目标的实时状态
#   ./manage.sh logs [-f] 查看 dsh 日志中的插件记录
#
# 环境变量:
#   DSH_PROFILE_DIR  profile 目录（默认 ~/.dsh/profiles/web）
#   DSH_URL          dsh 地址（默认 http://127.0.0.1:3080）
#   DSH_LOG          dsh 日志（默认 ~/.dsh/logs/web-3080.log）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
TARGET="$PROFILE/node_modules/dsh-codearts"
DSH_URL="${DSH_URL:-http://127.0.0.1:3080}"
DSH_LOG="${DSH_LOG:-$HOME/.dsh/logs/web-3080.log}"

die() { echo "错误: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
dsh-codearts 独立仓库使用管理

用法:
  ./manage.sh deploy    校验源码并原子同步到 dsh profile（重启 dsh 后生效）
  ./manage.sh build     重新构建侧栏客户端产物 lib/client.js
  ./manage.sh test      运行完整测试套件（沙箱 fixture，不触真实 CLI）
  ./manage.sh status    查看 dsh 中插件/终端/目标的实时状态
  ./manage.sh logs [-f] 查看 dsh 日志中的插件记录

环境变量:
  DSH_PROFILE_DIR  profile 目录（默认 ~/.dsh/profiles/web）
  DSH_URL          dsh 地址（默认 http://127.0.0.1:3080）
  DSH_LOG          dsh 日志（默认 ~/.dsh/logs/web-3080.log）
EOF
}

# 部署到 profile 的运行时文件（源码目录 → profile 相对路径）
RUNTIME_FILES=(
  package.json
  cordis.patch.yml
  lib/activity-parser.js
  lib/activity-probe.js
  lib/audit.js
  lib/client.js
  lib/goal-supervisor.js
  lib/index.js
  lib/install-manager.js
  lib/model-manager.js
  lib/process-manager.js
  lib/routes.js
  lib/tui-pty-relay.cjs
)

cmd_deploy() {
  [ -d "$TARGET" ] || die "profile 未安装插件: $TARGET（首次安装见 README「独立安装」）"

  echo "== 1/4 源码语法校验 =="
  local f
  for f in "${RUNTIME_FILES[@]}"; do
    case "$f" in
      *.js|*.cjs) node --check "$ROOT/$f" >/dev/null || die "语法错误: $f" ;;
    esac
    [ -f "$ROOT/$f" ] || die "缺少运行时文件: $f"
    echo "  ✓ $f"
  done

  echo "== 2/4 防污染检查 =="
  # 历史事故：lib/package.json 会改变模块解析基准，exports './lib/client.js' 被解析成 lib/lib/client.js
  if [ -e "$TARGET/lib/package.json" ]; then
    echo "  检测到污染文件 $TARGET/lib/package.json（历史事故根因），删除"
    rm -f "$TARGET/lib/package.json"
  fi
  if node -e "
const p = require('$ROOT/package.json');
const bad = Object.entries(p.dependencies ?? {}).filter(([k, v]) => k === '@deepseek-ai/dsh-tools' || v === '*');
if (bad.length) { console.error('不可公网解析的依赖: ' + JSON.stringify(bad)); process.exit(1); }
if (!(p.dependencies ?? {})['node-pty']) { console.error('缺少运行时依赖 node-pty'); process.exit(1); }
" 2>/dev/null; then
    :
  else
    die "package.json 运行时依赖不合规（禁止 @deepseek-ai/dsh-tools 与 \"*\" 版本；必须声明 node-pty）"
  fi
  if [ ! -d "$TARGET/node_modules/node-pty" ]; then
    echo "  ⚠ 目标缺少 node_modules/node-pty —— HTTP/模型功能可用，但 TUI 终端不可用"
    echo "    修复: dsh plugin --profile <profile> rebuild node-pty"
  fi
  echo "  ✓ 无 lib/package.json 污染，运行时依赖合规"

  echo "== 3/4 原子同步 =="
  for f in "${RUNTIME_FILES[@]}"; do
    mkdir -p "$(dirname "$TARGET/$f")"
    cp -f "$ROOT/$f" "$TARGET/$f.tmp-deploy"
    mv -f "$TARGET/$f.tmp-deploy" "$TARGET/$f"
    cmp -s "$ROOT/$f" "$TARGET/$f" || die "同步校验失败: $f"
    echo "  ✓ $f"
  done

  echo "== 4/4 目标语法校验 =="
  for f in "${RUNTIME_FILES[@]}"; do
    case "$f" in
      *.js|*.cjs) node --check "$TARGET/$f" >/dev/null || die "目标语法错误: $f" ;;
    esac
  done
  echo "  ✓ 全部通过"
  echo
  echo "部署完成：$TARGET"
  echo "注意：dsh 进程不会热加载模块，需重启 dsh 后生效；"
  echo "      重启会中断正在运行的码道 TUI/目标，请在安全窗口执行。"
}

cmd_build() {
  [ -f "$ROOT/scripts/build-client.mjs" ] || die "缺少 scripts/build-client.mjs"
  echo "== 构建侧栏客户端 =="
  ( cd "$ROOT" && PATH="$HOME/.bun/bin:$PATH" bun scripts/build-client.mjs )
  [ -f "$ROOT/lib/client.js" ] || die "构建结束但 lib/client.js 不存在"
  node --check "$ROOT/lib/client.js" >/dev/null || die "产物语法错误"
  echo "✓ lib/client.js 构建完成（$(stat -c%s "$ROOT/lib/client.js") 字节）"
  echo "  下一步: ./manage.sh deploy"
}

cmd_test() {
  echo "== 完整测试套件（沙箱 fixture） =="
  ( cd "$ROOT" && PATH="$HOME/.bun/bin:$PATH" bun test test/dsh-codearts.test.ts )
}

cmd_status() {
  command -v curl >/dev/null || die "缺少 curl"
  echo "== profile 安装 =="
  if [ -d "$TARGET" ]; then
    echo "  ✓ $TARGET"
    [ -e "$TARGET/lib/package.json" ] && echo "  ⚠ 发现污染文件 lib/package.json（运行 ./manage.sh deploy 清理）"
  else
    echo "  ✗ 未安装"
  fi
  if python3 - "$PROFILE/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
b = d.get("dsh", {}).get("profile", {}).get("bundles", [])
print("  bundle 注册:", "是" if "dsh-codearts" in b else "否")
PY
  then :; else
    echo "  ⚠ profile package.json 读取失败"
  fi

  echo
  echo "== 运行时状态（$DSH_URL） =="
  curl -fsS --max-time 8 "$DSH_URL/codearts/status" | python3 -c "$(cat <<'PY'
import json, sys
d = json.load(sys.stdin)
p = d.get("processes", {})
tui = p.get("tui", [])
alive = [x for x in tui if x.get("alive")]
pids = ", ".join(str(x.get("pid")) for x in alive)
print("  TUI:", f"{len(alive)} 存活" + (f"（PID {pids}）" if alive else ""))
print("  runOnce 活跃:", p.get("runOnceActive", 0))
g = d.get("goals", [])
active = [x for x in g if x.get("state") in ("active", "verifying")]
print("  目标: 历史", len(g), "| 运行中", len(active))
for x in active:
    s = x.get("stats", {})
    print(f"    - {x.get('goalId')} {x.get('state')} 注入={s.get('injections')} 会话={x.get('session', {}).get('state')}")
PY
)" || die "无法连接 $DSH_URL（dsh 未运行？）"

  echo
  echo "== 模型 =="
  curl -fsS --max-time 8 "$DSH_URL/codearts/models" | python3 -c "$(cat <<'PY'
import json, sys
m = json.load(sys.stdin).get("models", {})
r = m.get("recent") or []
print("  当前:", (r[0].get("id") if r else "未知"))
print("  最近:", len(r), "| 内置候选:", len(m.get("builtin") or []), "| 自定义:", len(m.get("custom") or []))
PY
)" || echo "  ⚠ 模型接口不可用"
}

cmd_logs() {
  [ -f "$DSH_LOG" ] || die "日志不存在: $DSH_LOG"
  if [ "${1:-}" = "-f" ]; then
    tail -n 50 -f "$DSH_LOG" | grep --line-buffered -i "codearts"
  else
    grep -i "codearts" "$DSH_LOG" | tail -n "${1:-50}"
  fi
}

case "${1:-}" in
  deploy) cmd_deploy ;;
  build)  cmd_build ;;
  test)   cmd_test ;;
  status) cmd_status ;;
  logs)   shift; cmd_logs "${1:-}" ;;
  *)
    usage
    exit 1
    ;;
esac
