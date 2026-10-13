#!/usr/bin/env bash
# 下载锁定版本的 codex-app-server 独立二进制到 .bin/（gitignore），按 GitHub Release 的 sha256 校验。
# 版本与 docs/upstream/upstream.lock 的 codex 行一致（rust-v0.162.1 = 092d3ac）。
#
# 环境变量：
#   WEVIR_GITHUB_MIRROR  替换 https://github.com 前缀（大陆网络），与 scripts/upstream-sync.sh 相同
#
# 用法：bash scripts/fetch-binary.sh

set -euo pipefail

version="rust-v0.162.1"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin_dir="$here/.bin"
mirror="${WEVIR_GITHUB_MIRROR:-https://github.com}"
mirror="${mirror%/}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target="aarch64-apple-darwin"; sha="84d6d3ca496551628c085a8f0f0b36f9a9e1fa0cfcea77fae0e1807b6cbecda5" ;;
  Darwin-x86_64) target="x86_64-apple-darwin"; sha="0b35efafff99a502886aafefe47d66751e22e235da91982eddeb9a2e7424712b" ;;
  Linux-x86_64) target="x86_64-unknown-linux-musl"; sha="ff6892db3e3dcaab08097d34872a99e85d8beb320797c2841c81d50e83b73267" ;;
  Linux-aarch64) target="aarch64-unknown-linux-musl"; sha="51fd0b6cac6223f97bcce9b98e78c7c0359a2cca20030548205babce98589bb4" ;;
  *) echo "fetch-binary: 不支持的平台 $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

asset="codex-app-server-$target.tar.gz"
out="$bin_dir/codex-app-server"
stamp="$bin_dir/.version"
if [ -x "$out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$version $target" ]; then
  echo "已是 $version ($target)：$out"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="$mirror/openai/codex/releases/download/$version/$asset"
echo "下载 $url"
curl -fL --retry 3 -o "$tmp/$asset" "$url"
actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
[ "$actual" = "$sha" ] || { echo "fetch-binary: sha256 不符：$actual ≠ $sha" >&2; exit 1; }
mkdir -p "$tmp/x" "$bin_dir"
tar -xzf "$tmp/$asset" -C "$tmp/x"
found="$(find "$tmp/x" -type f -name 'codex-app-server*' | head -1)"
[ -n "$found" ] || { echo "fetch-binary: 压缩包里没有 codex-app-server" >&2; exit 1; }
install -m 0755 "$found" "$out"
echo "$version $target" >"$stamp"
echo "完成：$out（$(du -h "$out" | cut -f1)）"
