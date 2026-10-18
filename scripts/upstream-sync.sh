#!/usr/bin/env bash
# 按 docs/upstream/upstream.lock 把上游参考仓库同步到 upstream/<名称>/。
#
# 每个仓库都是浅克隆，HEAD 处于锁定提交的分离头指针状态。可重复执行：
# 已在锁定提交的仓库直接跳过；lock 里的 SHA 变了就只拉取新提交再切换过去。
# upstream/ 是只读参考，脚本不会用 --force 覆盖本地改动；有冲突时 git 会报错退出。
#
# 环境变量：
#   WEVIR_GITHUB_MIRROR  替换仓库 URL 里的 https://github.com 前缀（大陆网络），例如
#                        https://<镜像域名> 或 https://<代理域名>/https://github.com
#
# 用法：bash scripts/upstream-sync.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$root/docs/upstream/upstream.lock"
dest_root="$root/upstream"
mirror="${WEVIR_GITHUB_MIRROR:-}"
mirror="${mirror%/}"

die() {
  echo "upstream-sync: $*" >&2
  exit 1
}

[ -f "$lock" ] || die "找不到 $lock"

# 按 SHA 浅拉取单个提交。GitHub 支持直接 fetch 可达提交；个别镜像不支持时，
# 退回到沿分支浅拉取并逐步加深，直到锁定提交出现（最多再加深 1000 个提交）。
fetch_commit() {
  local dir="$1" sha="$2" branch="$3" err i=0
  if err="$(git -C "$dir" fetch --quiet --depth 1 --no-tags origin "$sha" 2>&1)"; then
    return 0
  fi
  echo "  按 SHA 拉取失败，改为沿分支 $branch 浅拉取：$err" >&2
  git -C "$dir" fetch --quiet --depth 1 --no-tags origin "$branch"
  until git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -le 10 ] || die "${dir}：分支 $branch 最近的提交里找不到 $sha"
    git -C "$dir" fetch --quiet --deepen 100 --no-tags origin "$branch"
  done
}

count=0
while read -r name url branch sha extra <&3 || [ -n "${name:-}" ]; do
  case "${name:-}" in '' | '#'*) continue ;; esac
  [ -n "${sha:-}" ] && [ -z "${extra:-}" ] || die "lock 行格式应为「名称 仓库URL 分支 提交SHA」：$name"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$name" != . ] && [ "$name" != .. ] || die "非法名称：$name"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "${name}：提交 SHA 必须是 40 位小写十六进制：$sha"

  fetch_url="$url"
  if [ -n "$mirror" ]; then
    case "$url" in https://github.com/*) fetch_url="$mirror${url#https://github.com}" ;; esac
  fi

  dir="$dest_root/$name"
  echo "==> $name @ ${sha:0:12} ($branch) ← $fetch_url"

  if [ -e "$dir" ] && [ ! -d "$dir/.git" ]; then
    die "$dir 已存在但不是 git 仓库，请先手动删除"
  fi
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$dest_root"
    git init --quiet "$dir"
    git -C "$dir" remote add origin "$fetch_url"
  else
    git -C "$dir" remote set-url origin "$fetch_url"
  fi

  head="$(git -C "$dir" rev-parse --verify --quiet HEAD || true)"
  if [ "$head" = "$sha" ]; then
    echo "  已在锁定提交，跳过"
  else
    fetch_commit "$dir" "$sha" "$branch"
    git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "$sha"
  fi

  head="$(git -C "$dir" rev-parse HEAD)"
  [ "$head" = "$sha" ] || die "${name}：HEAD 是 ${head}，与 lock 中的 $sha 不一致"
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    echo "  警告：$dir 有本地改动；upstream/ 应保持只读" >&2
  fi
  count=$((count + 1))
done 3<"$lock"

[ "$count" -gt 0 ] || die "$lock 里没有仓库"
echo "完成：$count 个仓库已同步到 $dest_root"
