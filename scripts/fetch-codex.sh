#!/usr/bin/env bash
# 下载锁定版本的 codex-app-server 独立二进制并按 sha256 校验。默认装到开发缓存 .wevir-dev/codex/（gitignore），给
# packages/adapter-codex 用（ADR-0005 决策 1.2）；--target / --out 给构建安装包用：按目标平台取二进制，放进桌面端的
# 资源目录（ADR-0007 决策 5，apps/desktop 的 `pnpm resources`）。
# 写全 6 个平台（含 Windows 的 .exe）。
#
# 目录是上游 Codex 的包布局（upstream/codex/scripts/codex_package/layout.py、codex-rs/install-context/src/lib.rs）：
#   bin/codex-app-server[.exe]           入口；codex-app-server 凭自己在 bin/ 下且上一级有 codex-package.json 认出这个包
#   bin/codex-code-mode-host[.exe]       Codex 的 code mode 工具 `exec` 在独立进程里跑 JS，codex-app-server 在 bin/ 找它
#                                        （code_mode_host_program；没有它时只给 code mode 的模型调不了任何工具）
#   codex-path/rg[.exe]                  ripgrep；Codex 把这个目录放到模型所跑命令的 PATH 最前面（core 的 apply_package_path_prepend），
#                                        用户机器上没装 rg 时模型的 `rg` 也能用
#   codex-resources/bwrap                只有 Linux：Codex 的 Linux 沙箱，PATH 上没有 bwrap 时用它
#                                        （linux-sandbox/README.md）。bwrap 是 LGPL-2.0-or-later，源码在 Codex 锁定提交的
#                                        codex-rs/vendor/bubblewrap/（docs/upstream/UPSTREAM.md §2.4）
#   codex-package.json                   包元数据，与上游 layout.py 写的字段相同
# 旧版把二进制平铺在目录下，Codex 认不出包布局，也就没有 rg；那样的文件会被清掉。
#
# ripgrep 取自 BurntSushi/ripgrep 的 GitHub Release，版本与 sha256 抄自 Codex 锁定提交的
# scripts/codex_package/rg（DotSlash 清单）；MIT / Unlicense 双许可，许可证全文在 apps/desktop/licenses/ripgrep/。
#
# 版本与 docs/upstream/upstream.lock 的 codex 行一致（rust-v0.167.1 = 0a94398），也要与 adapter-codex 的
# CODEX_VERSION 一致。sha256 取自 GitHub Release API 的资产 digest（2026-11-12）：
#   curl -s https://api.github.com/repos/openai/codex/releases/tags/rust-v0.167.1 | jq '.assets[] | {name, digest}'
# 升级时版本号与下面 14 个校验和一起改（docs/upstream/UPSTREAM.md 的 Codex 升级检查清单）；ripgrep 的版本与 6 个校验和
# 跟着 Codex 锁定提交的 scripts/codex_package/rg 走。
#
# 环境变量：
#   WEVIR_GITHUB_MIRROR  替换 https://github.com 前缀（大陆网络），与 scripts/upstream-sync.sh 相同
#
# 用法：
#   bash scripts/fetch-codex.sh                                  本机平台 → .wevir-dev/codex/
#   bash scripts/fetch-codex.sh --target <三元组> --out <目录>    目标平台 → <目录>
# 三元组：aarch64-apple-darwin、x86_64-apple-darwin、x86_64-unknown-linux-musl、aarch64-unknown-linux-musl、
#         x86_64-pc-windows-msvc、aarch64-pc-windows-msvc

set -euo pipefail

version="rust-v0.167.1"
rg_version="15.2.0"
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
[ -n "$out_dir" ] || out_dir="$root/.wevir-dev/codex"

exe=""
bwrap_sha=""
# ripgrep 没有 aarch64 的 musl 构建，Linux arm64 用 gnu 的（与上游一致）；Windows 的发布包是 zip。
case "$target" in
  aarch64-apple-darwin)
    sha="d8ccd88f64b776bbf8d330a46a0d2d80eae7580dcd981e0f97070eae58a4bf63"
    host_sha="5ad9ce0aee5b66ea5a42a01eee66ee48f352aaca9a0ada6e280c7c569ed344c1"
    rg_target="aarch64-apple-darwin"
    rg_sha="3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4" ;;
  x86_64-apple-darwin)
    sha="0e9780f0083f8f79931206fcf4bda6d19d4e88a6b604904a21746c407be3fc3a"
    host_sha="1a5c09c96565646813800a4d9786790f446c6572849c6adaa2aa4ac070e0dd65"
    rg_target="x86_64-apple-darwin"
    rg_sha="af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1" ;;
  x86_64-unknown-linux-musl)
    sha="009fce8607080643ad4773d3eceee58a1ad35df8e1af7c015313d04473b8dbe1"
    host_sha="dc8a10a95df3878dda60a62b72acf9c1d1ee18599c04934952f128d9dcc78320"
    bwrap_sha="eb799e781a9ffd37b1ee46280fda10212a6efaf3cccfb8bf7603a00520355ac7"
    rg_target="x86_64-unknown-linux-musl"
    rg_sha="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c" ;;
  aarch64-unknown-linux-musl)
    sha="9d6d88aa001979d6d530ae181c4b365565cda780455525ca5134bf0a8f03df28"
    host_sha="b6513596c09c00805909477d2b715f29b67c34ffe79c577054024e565fd96707"
    bwrap_sha="e85fd048d06487116eb8f274fe84eafc123c6fe590113b6d6f8ea43f7b3c13bb"
    rg_target="aarch64-unknown-linux-gnu"
    rg_sha="a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d" ;;
  x86_64-pc-windows-msvc)
    exe=".exe"
    sha="10df9d6b0bf8b3462164ef19b26bd40c47ac7539ffcba5967f90b0cdc7455c48"
    host_sha="5a4d5559820626397e4a32347b3b4c2c3078f34b5e7ae2c80f282e8667c7fcd5"
    rg_target="x86_64-pc-windows-msvc"
    rg_sha="71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5" ;;
  aarch64-pc-windows-msvc)
    exe=".exe"
    sha="33fbd4739293fea8e106a0166a50d335efeaefd97a3f55ed03f7bbb59f7aac60"
    host_sha="ad2ef5cabc4a71b713c425a77a4f9ded657221b94993d209aa44ac75941728be"
    rg_target="aarch64-pc-windows-msvc"
    rg_sha="e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f" ;;
  *) echo "fetch-codex: 不支持的目标 $target" >&2; exit 1 ;;
esac
rg_ext="tar.gz"
[ -z "$exe" ] || rg_ext="zip"

out="$out_dir/bin/codex-app-server$exe"
host_out="$out_dir/bin/codex-code-mode-host$exe"
rg_out="$out_dir/codex-path/rg$exe"
bwrap_out="$out_dir/codex-resources/bwrap"
meta="$out_dir/codex-package.json"
stamp="$out_dir/codex-app-server.version"
stamp_value="$version $target rg-$rg_version"
if [ -f "$out" ] && [ -f "$host_out" ] && [ -f "$rg_out" ] && [ -f "$meta" ] &&
  [ "$(cat "$stamp" 2>/dev/null)" = "$stamp_value" ] &&
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

# 解开压缩包。zip 只有 ripgrep 的 Windows 包用：bsdtar（macOS、Windows 10 起的 System32\tar.exe）能读，GNU tar 不能，
# 所以优先 unzip（Linux、macOS、Git Bash 自带），没有再用 PowerShell。
extract() {
  local archive="$1" dest="$2"
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$archive" -d "$dest"
      elif command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command \
          "Expand-Archive -LiteralPath '$(cygpath -w "$archive")' -DestinationPath '$(cygpath -w "$dest")' -Force"
      else
        tar -xf "$archive" -C "$dest"
      fi ;;
    *) tar -xzf "$archive" -C "$dest" ;;
  esac
}

# 下载 $1（地址）、校验 sha256 $3、解开，打印解出的文件中名字匹配 $4 的那一个。$2 是压缩包的文件名。
fetch_url() {
  local url="$1" asset="$2" expected="$3" pattern="$4"
  echo "下载 $url" >&2
  if ! curl -fL --retry 3 -o "$tmp/$asset" "$url"; then
    # 网页下载入口可能持续 504，官方资产 API 仍可用；显式镜像不回退直连。
    [ "$mirror" = https://github.com ] || return 1
    local release_path="${url#https://github.com/}"
    local repository="${release_path%%/releases/download/*}"
    local tag="${release_path#*/releases/download/}"
    tag="${tag%/*}"
    local api_headers=(-H 'X-GitHub-Api-Version: 2026-03-10')
    if [ -n "${GH_TOKEN:-}" ]; then
      api_headers+=(-H "Authorization: Bearer $GH_TOKEN")
    fi
    local metadata="$tmp/release-${repository//\//-}-${tag//\//-}.json"
    if [ ! -f "$metadata" ]; then
      curl -fL --retry 3 "${api_headers[@]}" -o "$metadata" \
        "https://api.github.com/repos/$repository/releases/tags/$tag" || return 1
    fi
    local asset_id
    asset_id="$(node --input-type=module - "$metadata" "$asset" <<'JS'
import { readFileSync } from 'node:fs';
const release = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const asset = release.assets.find((entry) => entry.name === process.argv[3]);
if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
  throw new Error(`Release asset not found: ${process.argv[3]}`);
}
process.stdout.write(String(asset.id));
JS
    )" || return 1
    echo "改用 GitHub 资产 API：$asset" >&2
    curl -fL --retry 3 "${api_headers[@]}" -H 'Accept: application/octet-stream' -o "$tmp/$asset" \
      "https://api.github.com/repos/$repository/releases/assets/$asset_id" || return 1
  fi
  local actual
  actual="$(sha256 "$tmp/$asset")"
  [ "$actual" = "$expected" ] || { echo "fetch-codex: $asset 的 sha256 不符：$actual ≠ $expected" >&2; exit 1; }
  mkdir -p "$tmp/x-$asset"
  extract "$tmp/$asset" "$tmp/x-$asset"
  local found
  found="$(find "$tmp/x-$asset" -type f -name "$pattern" | head -1)"
  [ -n "$found" ] || { echo "fetch-codex: $asset 里没有 $pattern" >&2; exit 1; }
  echo "$found"
}

# Codex Release 的资产：下载、校验、解开，打印名字匹配 $3 的文件。
fetch_asset() {
  fetch_url "$mirror/openai/codex/releases/download/$version/$1" "$1" "$2" "$3"
}

# Windows 的压缩包名是 codex-app-server-<target>.exe.tar.gz，里面是 .exe。
binary="$(fetch_asset "codex-app-server-$target$exe.tar.gz" "$sha" "codex-app-server*$exe")"
host="$(fetch_asset "codex-code-mode-host-$target$exe.tar.gz" "$host_sha" "codex-code-mode-host*$exe")"
rg_asset="ripgrep-$rg_version-$rg_target.$rg_ext"
rg="$(fetch_url "$mirror/BurntSushi/ripgrep/releases/download/$rg_version/$rg_asset" "$rg_asset" "$rg_sha" "rg$exe")"
if [ -n "$bwrap_sha" ]; then
  bwrap="$(fetch_asset "bwrap-$target.tar.gz" "$bwrap_sha" "bwrap*")"
fi

# 都下载并校验完才动目标目录。旧版平铺在目录根的二进制与按旧布局留下的 bwrap 一并清掉（Codex 认不出平铺的包）。
mkdir -p "$out_dir/bin" "$out_dir/codex-path"
rm -f "$stamp" "$meta" "$out_dir/codex-app-server$exe" "$out_dir/codex-code-mode-host$exe"
rm -rf "$out_dir/codex-resources"
install_exe() { rm -f "$2"; cp "$1" "$2"; chmod 0755 "$2"; }
install_exe "$binary" "$out"
install_exe "$host" "$host_out"
install_exe "$rg" "$rg_out"
if [ -n "$bwrap_sha" ]; then
  mkdir -p "$out_dir/codex-resources"
  install_exe "$bwrap" "$bwrap_out"
fi
cat >"$meta" <<JSON
{
  "layoutVersion": 1,
  "version": "${version#rust-v}",
  "target": "$target",
  "variant": "codex-app-server",
  "entrypoint": "bin/codex-app-server$exe",
  "resourcesDir": "codex-resources",
  "pathDir": "codex-path"
}
JSON
echo "$stamp_value" >"$stamp"
echo "完成：${out}（$(du -h "$out" | cut -f1)），rg $rg_version"
