#!/bin/sh
# Install the Wevir command-line client on Linux or macOS. The package carries its own Node, so neither Node nor
# the desktop app is needed. Re-run it to update.
#
#   curl -fsSL https://dl.edgeweir.com/cli/install.sh | sh
#   curl -fsSL https://dl.edgeweir.com/cli/install.sh | sh -s -- --channel beta
#
# Options (or the environment variable in brackets):
#   --channel stable|beta   Release channel (WEVIR_CLI_CHANNEL). Default stable; beta until the first stable release
#   --version <version>     Install this version instead of the channel's newest (WEVIR_CLI_VERSION)
#   --prefix <dir>          Where versions are kept (WEVIR_CLI_PREFIX). Default ~/.local/share/wevir-cli
#   --bin-dir <dir>         Where the wevir link goes (WEVIR_CLI_BIN_DIR). Default ~/.local/bin
#
# WEVIR_CLI_MIRROR=<url> downloads only from that address (a directory laid out like https://dl.edgeweir.com/cli).
# Each package is checked against the sha256 in the release's checksums file before it is unpacked.
#
# Layout: <prefix>/<version>/ (bin/wevir, lib/), <prefix>/current -> <version>, <bin-dir>/wevir -> <prefix>/current/bin/wevir.
# The previous version stays until the next install, so a Host started from it keeps running.
# Uninstall: rm -rf ~/.local/share/wevir-cli ~/.local/bin/wevir (data stays in the Wevir data directory).

set -eu

LINES="https://dl.edgeweir.com/cli https://github.com/marvinli001/wevir/releases/download/cli https://download.wevir.si/cli"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'wevir install: %s\n' "$*" >&2
  exit 1
}

fetch() { # fetch <url> <file>
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 -o "$2" "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -T 30 -O "$2" "$1"
  else
    fail "needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl > /dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    fail "needs sha256sum, shasum or openssl to check the download"
  fi
}

platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case $os in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported system $os (Linux and macOS; on Windows use install.ps1)" ;;
  esac
  case $arch in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported architecture $arch (x86_64 and arm64)" ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ] && { ls /lib/ld-musl-* > /dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
    fail "this system uses musl libc (Alpine and similar); the bundled Node needs glibc 2.28 or newer"
  fi
  say "$os-$arch"
}

valid_version() {
  case $1 in
    '' | *[!0-9A-Za-z.-]*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  channel=${WEVIR_CLI_CHANNEL:-}
  version=${WEVIR_CLI_VERSION:-}
  prefix=${WEVIR_CLI_PREFIX:-${HOME:?HOME is not set}/.local/share/wevir-cli}
  bin_dir=${WEVIR_CLI_BIN_DIR:-$HOME/.local/bin}
  while [ $# -gt 0 ]; do
    case $1 in
      --channel) channel=${2:?--channel needs stable or beta}; shift 2 ;;
      --version) version=${2:?--version needs a version}; shift 2 ;;
      --prefix) prefix=${2:?--prefix needs a directory}; shift 2 ;;
      --bin-dir) bin_dir=${2:?--bin-dir needs a directory}; shift 2 ;;
      -h | --help)
        say "Usage: install.sh [--channel stable|beta] [--version <version>] [--prefix <dir>] [--bin-dir <dir>]"
        exit 0
        ;;
      *) fail "unknown option $1" ;;
    esac
  done
  case $channel in
    '' | stable | beta) ;;
    *) fail "--channel is stable or beta, not $channel" ;;
  esac
  lines=${WEVIR_CLI_MIRROR:-$LINES}
  plat=$(platform)

  tmp=$(mktemp -d 2> /dev/null || mktemp -d -t wevir-cli)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  # The channel's newest version: the first line that answers. Without --channel, stable, or beta while there is no
  # stable release yet.
  if [ -z "$version" ]; then
    for pointer in $(if [ -n "$channel" ]; then echo "$channel"; else echo "stable beta"; fi); do
      file=latest.txt
      [ "$pointer" = beta ] && file=beta.txt
      for line in $lines; do
        if fetch "$line/$file" "$tmp/pointer" 2> /dev/null; then
          version=$(tr -d ' \r\n' < "$tmp/pointer")
          valid_version "$version" && break 2
          version=
        fi
      done
      [ -z "$channel" ] && [ "$pointer" = stable ] && say "No stable release yet; installing the beta channel."
    done
    [ -n "$version" ] || fail "could not read the newest ${channel:-stable or beta} version from $lines"
  fi
  valid_version "$version" || fail "not a version: $version"

  name=wevir-cli-$version-$plat
  archive=$name.tar.gz
  sums=wevir-cli-$version-checksums.txt
  got=
  for line in $lines; do
    say "Downloading $line/$archive"
    if fetch "$line/$sums" "$tmp/$sums" && fetch "$line/$archive" "$tmp/$archive"; then
      expected=$(grep " \*\{0,1\}$archive\$" "$tmp/$sums" | cut -d ' ' -f 1 | head -n 1)
      actual=$(sha256 "$tmp/$archive")
      if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
        got=1
        break
      fi
      say "sha256 of $archive from $line is $actual, expected ${expected:-nothing}; trying the next line" >&2
    fi
  done
  [ -n "$got" ] || fail "could not download a verified $archive"

  mkdir -p "$prefix" "$bin_dir"
  unpack=$prefix/.unpack-$$
  rm -rf "$unpack"
  mkdir -p "$unpack"
  tar -xzf "$tmp/$archive" -C "$unpack"
  [ -x "$unpack/$name/bin/wevir" ] || fail "$archive has no $name/bin/wevir"
  previous=$(readlink "$prefix/current" 2> /dev/null || true)
  if [ -e "$prefix/$version" ]; then
    mv "$prefix/$version" "$unpack/old"
  fi
  mv "$unpack/$name" "$prefix/$version"
  rm -rf "$unpack"
  ln -sfn "$version" "$prefix/current"
  ln -sf "$prefix/current/bin/wevir" "$bin_dir/wevir"

  # Keep the new version and the one it replaced.
  for dir in "$prefix"/*; do
    base=${dir##*/}
    if [ -d "$dir" ] && [ ! -L "$dir" ] && valid_version "$base"; then
      [ "$base" = "$version" ] || [ "$base" = "$previous" ] || rm -rf "$dir"
    fi
  done

  say "Installed wevir $version in $prefix/$version"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) say "Add $bin_dir to PATH, for example: echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile" ;;
  esac
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    say "A Host started by wevir $previous keeps running on that version; to switch: wevir host stop, then wevir host start"
  fi
  say "Next: wevir host start"
}

main "$@"
