#!/usr/bin/env bash
# 在 Linux 上编 node-pty 的原生模块 pty.node（用户终端，Host 的可选依赖）。node-pty 1.1.0 的 npm 包只带 macOS 与 Windows 的
# 预编译，pnpm-workspace.yaml 的 allowBuilds 也不让它在安装时现编，所以 Linux 上由这个脚本显式编：
#
#   - 就地编进 node_modules 里的 node-pty（build/Release/pty.node，node-pty 先在那里找）：开发与测试里的 Host 能加载它，
#     `pnpm vitest run --project host terminals` 不再跳过；
#   - 复制一份到 <目录>/linux-<架构>/pty.node（默认 .wevir-dev/node-pty/）：apps/desktop 的 stage-resources.ts 从那里放进安装包。
#
# pty.node 是 Node-API 模块，与 Node、Electron 的版本无关；但它链接的 glibc 符号版本取决于编它的系统。release.yml 在
# Debian 11（glibc 2.31）的容器里编，安装包在更旧的发行版之外都能加载；编完打印它要的最高 glibc 版本。
# node-gyp 用 Node 自带的 npm 里的那份（不另从 npm 下载），要 python3、make 与 g++；它会下载这个 Node 版本的头文件。
#
# 用法：
#   bash scripts/build-node-pty.sh [--out <目录>]

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$root/.wevir-dev/node-pty"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out_dir="${2:?--out 需要一个目录}"; shift 2 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Linux ]; then
  echo "只在 Linux 上编：macOS 与 Windows 用 node-pty 自带的预编译" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "不支持的架构：$(uname -m)" >&2; exit 1 ;;
esac

pkg="$(cd "$root/packages/host" && node -p "require('node:path').dirname(require.resolve('node-pty/package.json'))")"

gyp="$(dirname "$(command -v node)")/../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
if [ -f "$gyp" ]; then
  gyp_cmd=(node "$gyp")
elif command -v node-gyp > /dev/null; then
  gyp_cmd=(node-gyp)
else
  echo "没有找到 node-gyp（Node 自带的 npm 里应该有）" >&2
  exit 1
fi

echo "编 $pkg（linux-$arch）"
(cd "$pkg" && "${gyp_cmd[@]}" rebuild --release -j max)
# gyp 按相对路径给 node-addon-api 写的时间戳，在 pnpm 的布局下落到了包目录里。
rm -rf "$pkg"/node-addon-api@*

mkdir -p "$out_dir/linux-$arch"
cp "$pkg/build/Release/pty.node" "$out_dir/linux-$arch/pty.node"
echo "→ $out_dir/linux-$arch/pty.node"
if command -v objdump > /dev/null; then
  glibc="$(objdump -T "$out_dir/linux-$arch/pty.node" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 || true)"
  echo "要求的最高 glibc 符号版本：${glibc:-无}"
fi
