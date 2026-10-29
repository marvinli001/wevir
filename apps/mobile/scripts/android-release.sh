#!/usr/bin/env bash
# 打 Android 的发行 APK（不用 EAS）：生成 android/（versionName 是给定的版本，versionCode 由它算出，见 app.config.ts 的
# androidVersionCode），Gradle 的 release 构建，用发行密钥库签名（plugins/with-android-signing.js），最后核对签名证书与版本。
# 发布流水线（.github/workflows/release.yml 的 android 作业）用它打包，版本与桌面端这次发布的相同。
#
# 产物：apps/mobile/build/android/Wevir-<版本>-android.apk（gitignore），一个包含 arm64-v8a 与 armeabi-v7a（手机与 Apple 芯片上的模拟器；不含 x86 与 x86_64）。
#
# 用法：
#   bash apps/mobile/scripts/android-release.sh <版本>
#
# 环境变量：
#   WEVIR_ANDROID_KEYSTORE            发行密钥库（PKCS#12）的路径，必填
#   WEVIR_ANDROID_KEYSTORE_PASSWORD   密钥库与密钥的密码，必填
#   WEVIR_ANDROID_KEY_ALIAS           密钥别名，默认 wevir
#   WEVIR_ANDROID_CERT_SHA256         签名证书的 SHA-256（十六进制，冒号可有可无）；设了就核对，换错密钥库时失败
#   ANDROID_HOME、JAVA_HOME           Android SDK 与 JDK 17（GitHub 的 Ubuntu runner 自带 SDK）

set -euo pipefail

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]]; then
  echo "usage: $0 <version>   (X.Y.Z or X.Y.Z-beta.N)" >&2
  exit 2
fi
: "${WEVIR_ANDROID_KEYSTORE:?WEVIR_ANDROID_KEYSTORE is not set}"
: "${WEVIR_ANDROID_KEYSTORE_PASSWORD:?WEVIR_ANDROID_KEYSTORE_PASSWORD is not set}"
: "${ANDROID_HOME:?ANDROID_HOME is not set}"
WEVIR_ANDROID_KEYSTORE="$(cd "$(dirname "$WEVIR_ANDROID_KEYSTORE")" && pwd)/$(basename "$WEVIR_ANDROID_KEYSTORE")"
export WEVIR_ANDROID_KEYSTORE WEVIR_ANDROID_KEYSTORE_PASSWORD
export WEVIR_ANDROID_VERSION="$version"

app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app"
out="$app/build/android"
apk="$out/Wevir-$version-android.apk"
mkdir -p "$out"

step() { printf '\n==> %s\n' "$*"; }

step "prebuild (android $version)"
CI=1 pnpm exec expo prebuild --clean --platform android --no-install

step "gradle assembleRelease"
(cd android && ./gradlew --no-daemon assembleRelease \
  -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)
cp android/app/build/outputs/apk/release/app-release.apk "$apk"

step "verify $apk"
build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n 1)"
certs="$("$build_tools/apksigner" verify --print-certs "$apk")"
if grep -qi 'CN=Android Debug' <<<"$certs"; then
  echo "$apk is signed with the debug key" >&2
  exit 1
fi
if [ -n "${WEVIR_ANDROID_CERT_SHA256:-}" ]; then
  want="$(tr -d ':' <<<"$WEVIR_ANDROID_CERT_SHA256" | tr 'A-F' 'a-f')"
  got="$(awk -F': ' '/Signer.* certificate SHA-256 digest: / { print $NF; exit }' <<<"$certs")"
  if [ "$got" != "$want" ]; then
    echo "signing certificate is $got, expected $want" >&2
    exit 1
  fi
fi
# 整份读完再取第一行：管道接 head 会在 pipefail 下因 SIGPIPE 失败。
badging="$("$build_tools/aapt2" dump badging "$apk")"
badging="${badging%%$'\n'*}"
grep -q "versionName='$version'" <<<"$badging" || {
  echo "unexpected package line: $badging" >&2
  exit 1
}
echo "$badging"
ls -l "$apk"
