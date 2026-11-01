#!/usr/bin/env bash
# open-dsh-codearts 安装器
#
# 用法:
#   ./install.sh [profile]        # profile 默认 web
#   DSH_CODEARTS_SPEC=github:daheix/open-dsh-codearts ./install.sh
#
# 做的事:
#   1. 调用 dsh plugin add（新 profile 会由 dsh 自动初始化）
#   2. 允许 pnpm 构建原生模块 node-pty（只增改 allowBuilds.node-pty，不动其他配置）
#   3. 若首装被 pnpm 拦截，清理依赖后重装一次
#   4. 硬验证：bundle 已注册 + node-pty 已编译 + 插件文件存在
# 不自动重启 dsh（避免中断正在运行的 TUI/目标）。
set -euo pipefail

PROFILE="${1:-web}"
SPEC="${DSH_CODEARTS_SPEC:-github:daheix/open-dsh-codearts}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DIR="$DSH_HOME/profiles/$PROFILE"
WORKSPACE="$DIR/pnpm-workspace.yaml"

die() { echo "错误: $*" >&2; exit 1; }

command -v dsh >/dev/null 2>&1 || die "未找到 dsh（请先安装 DeepSeek Harness 并加入 PATH）"
command -v node >/dev/null 2>&1 || die "未找到 node"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm（dsh plugin 依赖 pnpm）"

echo "== 安装 dsh-codearts 到 profile: $PROFILE =="

# pnpm 10+ 默认阻止依赖执行安装脚本；node-pty 需要编译原生模块。
# 只改 node-pty 一行，保留用户已有 allowBuilds 条目。
allow_build() {
  if [ ! -f "$WORKSPACE" ]; then
    mkdir -p "$DIR"
    cat > "$WORKSPACE" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-pty: true
YAML
    return
  fi
  if grep -qE '^[[:space:]]*node-pty:' "$WORKSPACE"; then
    sed -i.bak -E 's/^([[:space:]]*node-pty:).*/\1 true/' "$WORKSPACE"
    rm -f "$WORKSPACE.bak"
    return
  fi
  if grep -q '^allowBuilds:' "$WORKSPACE"; then
    awk '
      { print }
      /^allowBuilds:/ && !done { print "  node-pty: true"; done = 1 }
    ' "$WORKSPACE" > "$WORKSPACE.tmp"
    mv "$WORKSPACE.tmp" "$WORKSPACE"
    return
  fi
  printf '\nallowBuilds:\n  node-pty: true\n' >> "$WORKSPACE"
}

bundle_registered() {
  node -e "
const p = require('$DIR/package.json');
const bundles = p.dsh?.profile?.bundles ?? [];
process.exit(bundles.includes('dsh-codearts') ? 0 : 1);
" >/dev/null 2>&1
}

pty_built() {
  [ -f "$DIR/node_modules/node-pty/build/Release/pty.node" ]
}

set +e
dsh plugin --profile "$PROFILE" add "$SPEC"
FIRST_EXIT=$?
set -e

[ -f "$DIR/package.json" ] || die "profile 初始化失败：$DIR/package.json 不存在"

if [ "$FIRST_EXIT" -ne 0 ] || ! bundle_registered || ! pty_built; then
  echo
  echo "== 首次安装未完整完成，允许 node-pty 构建后重装 =="
  allow_build
  grep -q 'node-pty: true' "$WORKSPACE" || die "无法写入 node-pty 构建许可：$WORKSPACE"
  dsh plugin --profile "$PROFILE" remove dsh-codearts >/dev/null 2>&1 || true
  dsh plugin --profile "$PROFILE" add "$SPEC"
fi

# 最终硬验证：失败即报错，不做静默降级
bundle_registered || die "插件已安装但未注册到 dsh.profile.bundles：请检查 $DIR/package.json"
pty_built || die "node-pty 未编译：查看 pnpm 输出，或执行 dsh plugin --profile $PROFILE rebuild node-pty"
[ -f "$DIR/node_modules/dsh-codearts/lib/index.js" ] || die "插件入口缺失：$DIR/node_modules/dsh-codearts/lib/index.js"

echo
echo "✓ 安装成功：dsh.profile.bundles 已包含 dsh-codearts，node-pty 原生模块已编译"
echo "  重启 dsh 后生效：dsh --profile $PROFILE --port 3080"
echo "  验证接口：curl -s http://127.0.0.1:3080/codearts/status | head -c 400"
