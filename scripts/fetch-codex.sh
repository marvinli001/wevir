#!/usr/bin/env bash
# 下载锁定版本的 codex-app-server 独立二进制到开发缓存 .wevir-dev/bin/（gitignore），按 sha256 校验。
# 改写自 spikes/codex-app-server/scripts/fetch-binary.sh：写全 6 个平台（含 Windows 的 .exe），装到仓库的开发缓存，
# 给 packages/adapter-codex 用（ADR-0005 决策 1.2）。打包后的位置由 R9 定。
#
# 版本与 docs/upstream/upstream.lock 的 codex 行一致（rust-v0.162.1 = 092d3ac），也要与 adapter-codex 的
# CODEX_VERSION 一致。sha256 取自 GitHub Release API 的资产 digest（2026-10-14）：
#   curl -s https://api.github.com/repos/openai/codex/releases/tags/rust-v0.162.1 | jq '.assets[] | {name, digest}'
# 升级时版本号与这 6 个校验和一起改（docs/upstream/UPSTREAM.md 的 Codex 升级检查清单）。
#
# 环境变量：
#   WEVIR_GITHUB_MIRROR  替换 https://github.com 前缀（大陆网络），与 scripts/upstream-sync.sh 相同
#
# 用法：bash scripts/fetch-codex.sh

set -euo pipefail

version="rust-v0.162.1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$root/.wevir-dev/bin"
mirror="${WEVIR_GITHUB_MIRROR:-https://github.com}"
mirror="${mirror%/}"

exe=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    target="aarch64-apple-darwin"
    sha="84d6d3ca496551628c085a8f0f0b36f9a9e1fa0cfcea77fae0e1807b6cbecda5" ;;
  Darwin-x86_64)
    target="x86_64-apple-darwin"
    sha="0b35efafff99a502886aafefe47d66751e22e235da91982eddeb9a2e7424712b" ;;
  Linux-x86_64)
    target="x86_64-unknown-linux-musl"
    sha="ff6892db3e3dcaab08097d34872a99e85d8beb320797c2841c81d50e83b73267" ;;
  Linux-aarch64 | Linux-arm64)
    target="aarch64-unknown-linux-musl"
    sha="51fd0b6cac6223f97bcce9b98e78c7c0359a2cca20030548205babce98589bb4" ;;
  MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64)
    target="x86_64-pc-windows-msvc"
    exe=".exe"
    sha="645a5ade43c6d3636f2476dc455e886198b4ebe2c8dbcd227f608c5237c8b3ee" ;;
  MINGW*-aarch64 | MSYS*-aarch64 | MINGW*-arm64 | MSYS*-arm64)
    target="aarch64-pc-windows-msvc"
    exe=".exe"
    sha="6e8da0dd2da2579e7dd2836f9247e1c1b7f81561b963540d11ef6fa6335b394a" ;;
  *) echo "fetch-codex: 不支持的平台 $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# Windows 的压缩包名是 codex-app-server-<target>.exe.tar.gz，里面是 .exe。
asset="codex-app-server-$target$exe.tar.gz"
out="$bin_dir/codex-app-server$exe"
stamp="$bin_dir/codex-app-server.version"
if [ -f "$out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$version $target" ]; then
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
url="$mirror/openai/codex/releases/download/$version/$asset"
echo "下载 $url"
curl -fL --retry 3 -o "$tmp/$asset" "$url"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$sha" ] || { echo "fetch-codex: sha256 不符：$actual ≠ $sha" >&2; exit 1; }
mkdir -p "$tmp/x" "$bin_dir"
tar -xzf "$tmp/$asset" -C "$tmp/x"
found="$(find "$tmp/x" -type f -name "codex-app-server*$exe" | head -1)"
[ -n "$found" ] || { echo "fetch-codex: 压缩包里没有 codex-app-server$exe" >&2; exit 1; }
rm -f "$out" "$stamp"
cp "$found" "$out"
chmod 0755 "$out"
echo "$version $target" >"$stamp"
echo "完成：$out（$(du -h "$out" | cut -f1)）"
