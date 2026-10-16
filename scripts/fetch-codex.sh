#!/usr/bin/env bash
# 下载锁定版本的 codex-app-server 独立二进制并按 sha256 校验。默认装到开发缓存 .wevir-dev/bin/（gitignore），给
# packages/adapter-codex 用（ADR-0005 决策 1.2）；--target / --out 给构建安装包用：按目标平台取二进制，放进桌面端的
# 资源目录（ADR-0007 决策 5，apps/desktop 的 `pnpm resources`）。
# 改写自 spikes/codex-app-server/scripts/fetch-binary.sh：写全 6 个平台（含 Windows 的 .exe）。
#
# Linux 另带 bwrap（Codex 的 Linux 沙箱；PATH 上没有 bwrap 时，Codex 用可执行文件旁边的 codex-resources/bwrap，
# upstream/codex/codex-rs/linux-sandbox/README.md）。bwrap 是 LGPL-2.0-or-later，源码在 Codex 锁定提交的
# codex-rs/vendor/bubblewrap/（docs/upstream/UPSTREAM.md §2.4）。
#
# 另带 codex-code-mode-host（Codex 的 code mode 工具 `exec` 在独立进程里跑 JS，codex-app-server 在自己旁边找它，
# upstream/codex/codex-rs/install-context/src/lib.rs 的 code_mode_host_program；没有它时只给 code mode 的模型调不了任何工具）。
#
# 版本与 docs/upstream/upstream.lock 的 codex 行一致（rust-v0.162.1 = 092d3ac），也要与 adapter-codex 的
# CODEX_VERSION 一致。sha256 取自 GitHub Release API 的资产 digest（2026-10-14）：
#   curl -s https://api.github.com/repos/openai/codex/releases/tags/rust-v0.162.1 | jq '.assets[] | {name, digest}'
# 升级时版本号与下面 14 个校验和一起改（docs/upstream/UPSTREAM.md 的 Codex 升级检查清单）。
#
# 环境变量：
#   WEVIR_GITHUB_MIRROR  替换 https://github.com 前缀（大陆网络），与 scripts/upstream-sync.sh 相同
#
# 用法：
#   bash scripts/fetch-codex.sh                                  本机平台 → .wevir-dev/bin/
#   bash scripts/fetch-codex.sh --target <三元组> --out <目录>    目标平台 → <目录>
# 三元组：aarch64-apple-darwin、x86_64-apple-darwin、x86_64-unknown-linux-musl、aarch64-unknown-linux-musl、
#         x86_64-pc-windows-msvc、aarch64-pc-windows-msvc

set -euo pipefail

version="rust-v0.162.1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mirror="${WEVIR_GITHUB_MIRROR:-https://github.com}"
mirror="${mirror%/}"

target=""
out_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:?--target 需要一个三元组}"; shift 2 ;;
    --out) out_dir="${2:?--out 需要一个目录}"; shift 2 ;;
    *) echo "fetch-codex: 不认识的参数 $1" >&2; exit 2 ;;
  esac
done

if [ -z "$target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target="aarch64-apple-darwin" ;;
    Darwin-x86_64) target="x86_64-apple-darwin" ;;
    Linux-x86_64) target="x86_64-unknown-linux-musl" ;;
    Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-musl" ;;
    MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) target="x86_64-pc-windows-msvc" ;;
    MINGW*-aarch64 | MSYS*-aarch64 | MINGW*-arm64 | MSYS*-arm64) target="aarch64-pc-windows-msvc" ;;
    *) echo "fetch-codex: 不支持的平台 $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
fi
[ -n "$out_dir" ] || out_dir="$root/.wevir-dev/bin"

exe=""
bwrap_sha=""
case "$target" in
  aarch64-apple-darwin)
    sha="84d6d3ca496551628c085a8f0f0b36f9a9e1fa0cfcea77fae0e1807b6cbecda5"
    host_sha="1f464a2894adbc916e431b6bf19bef2cb485cf7e13e636d42578c581962b3727" ;;
  x86_64-apple-darwin)
    sha="0b35efafff99a502886aafefe47d66751e22e235da91982eddeb9a2e7424712b"
    host_sha="cd52af8a6884b18239aaf36d0c99bc990e7dcf75b0917155474ffde88a111d37" ;;
  x86_64-unknown-linux-musl)
    sha="ff6892db3e3dcaab08097d34872a99e85d8beb320797c2841c81d50e83b73267"
    host_sha="458239ea45c1fc508d89695f180ab352f2834709a8a46929a4466f4f04399ada"
    bwrap_sha="fa78980959466bd7a04643384c6293511f06a3140345c1237cfc75ccde7f3eea" ;;
  aarch64-unknown-linux-musl)
    sha="51fd0b6cac6223f97bcce9b98e78c7c0359a2cca20030548205babce98589bb4"
    host_sha="1395ce9367f8acd280674dff083edf25bf221d908b8351d5bd4f3fdde9181e9a"
    bwrap_sha="83377376b697058a1bf6e73d754b027c66ef58b0a0e22527e12110865b33bc9c" ;;
  x86_64-pc-windows-msvc)
    exe=".exe"
    sha="645a5ade43c6d3636f2476dc455e886198b4ebe2c8dbcd227f608c5237c8b3ee"
    host_sha="9fd8dbfd188fae23774081dc42297e85c87740697684ccae41c0e522b1d00382" ;;
  aarch64-pc-windows-msvc)
    exe=".exe"
    sha="6e8da0dd2da2579e7dd2836f9247e1c1b7f81561b963540d11ef6fa6335b394a"
    host_sha="415038b2a58f9db858ed35cbca718005669d83b7ada2bb2a8503ec56d881f43b" ;;
  *) echo "fetch-codex: 不支持的目标 $target" >&2; exit 1 ;;
esac

out="$out_dir/codex-app-server$exe"
host_out="$out_dir/codex-code-mode-host$exe"
bwrap_out="$out_dir/codex-resources/bwrap"
stamp="$out_dir/codex-app-server.version"
if [ -f "$out" ] && [ -f "$host_out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$version $target" ] &&
  { [ -z "$bwrap_sha" ] || [ -f "$bwrap_out" ]; }; then
  echo "已是 $version ($target)：$out"
  exit 0
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 下载一个资产、校验 sha256、解开，打印解出的文件中名字匹配 $3 的那一个。
fetch_asset() {
  local asset="$1" expected="$2" pattern="$3"
  local url="$mirror/openai/codex/releases/download/$version/$asset"
  echo "下载 $url" >&2
  curl -fL --retry 3 -o "$tmp/$asset" "$url"
  local actual
  actual="$(sha256 "$tmp/$asset")"
  [ "$actual" = "$expected" ] || { echo "fetch-codex: $asset 的 sha256 不符：$actual ≠ $expected" >&2; exit 1; }
  mkdir -p "$tmp/x-$asset"
  tar -xzf "$tmp/$asset" -C "$tmp/x-$asset"
  local found
  found="$(find "$tmp/x-$asset" -type f -name "$pattern" | head -1)"
  [ -n "$found" ] || { echo "fetch-codex: $asset 里没有 $pattern" >&2; exit 1; }
  echo "$found"
}

# Windows 的压缩包名是 codex-app-server-<target>.exe.tar.gz，里面是 .exe。
binary="$(fetch_asset "codex-app-server-$target$exe.tar.gz" "$sha" "codex-app-server*$exe")"
mkdir -p "$out_dir"
rm -f "$out" "$stamp"
cp "$binary" "$out"
chmod 0755 "$out"
host="$(fetch_asset "codex-code-mode-host-$target$exe.tar.gz" "$host_sha" "codex-code-mode-host*$exe")"
rm -f "$host_out"
cp "$host" "$host_out"
chmod 0755 "$host_out"
if [ -n "$bwrap_sha" ]; then
  bwrap="$(fetch_asset "bwrap-$target.tar.gz" "$bwrap_sha" "bwrap*")"
  mkdir -p "$out_dir/codex-resources"
  rm -f "$bwrap_out"
  cp "$bwrap" "$bwrap_out"
  chmod 0755 "$bwrap_out"
fi
echo "$version $target" >"$stamp"
echo "完成：$out（$(du -h "$out" | cut -f1)）"
