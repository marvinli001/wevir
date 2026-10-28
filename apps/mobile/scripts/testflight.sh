#!/usr/bin/env bash
# 在本机用 Xcode 打 iOS 的 TestFlight 包（不用 EAS）：生成发行配置的 ios/（`WEVIR_APNS_ENVIRONMENT=production`，构建号取 UTC
# 时间），Release 归档，自动签名（`-allowProvisioningUpdates`：分发证书与描述文件由 Xcode 用 Settings → Accounts 里登录的
# 团队账号建），再按 App Store Connect 的方式导出。
#
#   export  只导出 .ipa，并核对两个 target 的版本号、构建号、签名团队与 entitlements（默认）
#   upload  导出时直接传到 App Store Connect（`destination upload`）。要先在 App Store Connect 建好这个 bundle ID 的 App 记录
#
# 产物在 apps/mobile/build/testflight/<构建号>/（gitignore）：Wevir.xcarchive、Wevir.ipa、xcodebuild 的日志。
#
# 用法：
#   bash apps/mobile/scripts/testflight.sh [export|upload]
#
# 环境变量：WEVIR_BUILD_NUMBER（默认 UTC 的 `YYYYMMDD.HHMM`，同一版本号下必须比上一次上传的大）、WEVIR_APPLE_TEAM_ID（默认见
# app.config.ts）。

set -euo pipefail

mode="${1:-export}"
case "$mode" in
  export | upload) ;;
  *)
    echo "usage: $0 [export|upload]" >&2
    exit 2
    ;;
esac

app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$app"

export WEVIR_APNS_ENVIRONMENT=production
export WEVIR_BUILD_NUMBER="${WEVIR_BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M)}"
team="${WEVIR_APPLE_TEAM_ID:-678WA95W4U}"
export WEVIR_APPLE_TEAM_ID="$team"

out="$app/build/testflight/$WEVIR_BUILD_NUMBER"
archive="$out/Wevir.xcarchive"
mkdir -p "$out"

step() { printf '\n==> %s\n' "$*"; }
# xcodebuild 的输出很长：写进日志，失败时打印末尾。
run_logged() {
  local log="$1"
  shift
  if ! "$@" >"$log" 2>&1; then
    tail -n 80 "$log" >&2
    echo "failed; full log: $log" >&2
    exit 1
  fi
}

# 终端不是 UTF-8 时 CocoaPods 报 Encoding::CompatibilityError。
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

step "prebuild (production APNs, build $WEVIR_BUILD_NUMBER)"
# `pod install` 单独跑：prebuild 里它失败只打警告，脚本会接着去归档一个不完整的工程。
CI=1 pnpm exec expo prebuild --clean --platform ios --no-install
(cd ios && pod install)

workspace="$(find ios -maxdepth 1 -name '*.xcworkspace' | head -n 1)"
[ -n "$workspace" ] || {
  echo "no Xcode workspace in ios/" >&2
  exit 1
}
scheme="$(basename "$workspace" .xcworkspace)"

step "archive ($scheme, Release)"
run_logged "$out/archive.log" xcodebuild \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  -allowProvisioningUpdates \
  archive

destination=export
[ "$mode" = upload ] && destination=upload
cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>$destination</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>$team</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST

step "export ($destination)"
run_logged "$out/export.log" xcodebuild \
  -exportArchive \
  -archivePath "$archive" \
  -exportPath "$out" \
  -exportOptionsPlist "$out/ExportOptions.plist" \
  -allowProvisioningUpdates

if [ "$mode" = upload ]; then
  step "uploaded build $WEVIR_BUILD_NUMBER; App Store Connect processes it before it appears in TestFlight"
  exit 0
fi

ipa="$(find "$out" -maxdepth 1 -name '*.ipa' | head -n 1)"
step "verify $ipa"
unpacked="$out/unpacked"
rm -rf "$unpacked"
unzip -q "$ipa" -d "$unpacked"
bundle="$(find "$unpacked/Payload" -maxdepth 1 -name '*.app' | head -n 1)"
extension="$bundle/PlugIns/WevirNotificationService.appex"
[ -d "$extension" ] || {
  echo "notification service extension is not embedded" >&2
  exit 1
}

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1"; }
entitlement() { codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -extract "$2" raw -o - - 2>/dev/null || true; }

failed=0
check() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ok    %-40s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-40s %s (expected %s)\n' "$label" "$actual" "$expected"
    failed=1
  fi
}

version="$(plist "$bundle/Info.plist" CFBundleShortVersionString)"
check 'app CFBundleVersion' "$(plist "$bundle/Info.plist" CFBundleVersion)" "$WEVIR_BUILD_NUMBER"
check 'extension CFBundleVersion' "$(plist "$extension/Info.plist" CFBundleVersion)" "$WEVIR_BUILD_NUMBER"
check 'extension CFBundleShortVersionString' "$(plist "$extension/Info.plist" CFBundleShortVersionString)" "$version"
for target in "$bundle" "$extension"; do
  name="$(basename "$target")"
  check "$name team" "$(entitlement "$target" com\\.apple\\.developer\\.team-identifier)" "$team"
  check "$name App Group" "$(entitlement "$target" com\\.apple\\.security\\.application-groups.0)" 'group.si.wevir.mobile'
  check "$name beta-reports-active" "$(entitlement "$target" beta-reports-active)" 'true'
done
check 'app aps-environment' "$(entitlement "$bundle" aps-environment)" 'production'
check 'extension embedded in app signature' "$(codesign --verify --deep --strict "$bundle" 2>&1 && echo valid)" 'valid'
rm -rf "$unpacked"

[ "$failed" = 0 ] || exit 1
step "ok: $ipa (version $version, build $WEVIR_BUILD_NUMBER)"
