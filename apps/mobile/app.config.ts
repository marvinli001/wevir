// Expo 的应用配置（CNG：ios/、android/ 由 `expo prebuild` 从这里生成，不进仓库）。需要原生模块（mDNS、相机、钥匙串、录音），用
// development build（expo-dev-client），不用 Expo Go。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import en from './native-strings/en.json';

const ICONS = '../../assets/icons';
/** 与 src/lib/keychain.ts 的 `IOS_APP_GROUP` 相同（配置加载器读不了 src 下的 TS 模块，keychain.test.ts 核对两者一致）。 */
export const IOS_APP_GROUP = 'group.si.wevir.mobile';
const BUNDLE_ID = 'si.wevir.mobile';
/** 签名团队；换团队构建时用 `WEVIR_APPLE_TEAM_ID` 覆盖。 */
const APPLE_TEAM_ID = process.env.WEVIR_APPLE_TEAM_ID || '678WA95W4U';
/**
 * iOS 的构建号（CFBundleVersion）。TestFlight 要求同一版本号下逐次递增：scripts/testflight.sh 每次填 UTC 时间
 * （`20261028.1530`）。不设时是 `1`（开发构建）。
 */
const BUILD_NUMBER = process.env.WEVIR_BUILD_NUMBER || '1';
/**
 * versionName 对应的 versionCode：`X.Y.Z` 与 `X.Y.Z-beta.N` 共用桌面端的版本线（正式版 X.Y.Z 之后的开发版是 X.Y.(Z+1)-beta.N），
 * 按 semver 的先后单调递增：X·10⁸ + Y·10⁶ + Z·10⁴ + (开发版 N，正式版 9999)。Android 要求新包的 versionCode 更大才能覆盖安装。
 */
export function androidVersionCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`not a release version: ${version}`);
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const beta = match[4] === undefined ? 9999 : Number(match[4]);
  const code = major * 1e8 + minor * 1e6 + patch * 1e4 + beta;
  // 每一段不许溢出到上一段；2,100,000,000 是 Google Play 的上限。
  if (
    minor > 99 ||
    patch > 99 ||
    beta > 9999 ||
    (match[4] !== undefined && beta === 9999) ||
    code > 2_100_000_000
  ) {
    throw new Error(`version out of the versionCode range: ${version}`);
  }
  return code;
}

/**
 * 推送（src/lib/push-native.ts）的构建配置：
 * - Android 的 FCM 要 Firebase 项目的 `google-services.json`。它不进仓库：放在 `apps/mobile/google-services.json`，或用
 *   `WEVIR_GOOGLE_SERVICES_FILE` 指过去。没有这个文件时照样构建，只是 App 不向系统要 FCM 令牌、不登记推送（只在前台时提醒）。
 * - iOS 的 `aps-environment`：开发构建是 `development`（令牌只在 APNs 沙盒有效，登记成 `apns_sandbox`），发行构建设
 *   `WEVIR_APNS_ENVIRONMENT=production`。
 */
function pushBuildConfig(projectRoot: string) {
  const googleServices = process.env.WEVIR_GOOGLE_SERVICES_FILE ?? './google-services.json';
  const hasGoogleServices = existsSync(resolve(projectRoot, googleServices));
  const apnsEnvironment: 'development' | 'production' =
    process.env.WEVIR_APNS_ENVIRONMENT === 'production' ? 'production' : 'development';
  return { googleServices: hasGoogleServices ? googleServices : undefined, apnsEnvironment };
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  const push = pushBuildConfig(projectRoot ?? process.cwd());
  // Android 发行包的版本（scripts/android-release.sh）：versionName 跟随桌面端这次发布的版本（`0.0.2-beta.17`、`0.1.0`），
  // versionCode 由它算出。不设时是开发构建（顶层的 `version` 与 versionCode 1）。
  const androidVersion = process.env.WEVIR_ANDROID_VERSION || undefined;
  return {
    ...config,
    name: 'Wevir',
    slug: 'wevir',
    version: '1.0.0',
    // 配对链接 `wevir://pair?…`：系统相机扫码、点链接都打开 App 的添加电脑页（src/app/+native-intent.tsx）。
    scheme: 'wevir',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: `${ICONS}/exports/ios/light/AppIcon-1024.png`,
    backgroundColor: '#f7f6f3',
    ios: {
      bundleIdentifier: BUNDLE_ID,
      appleTeamId: APPLE_TEAM_ID,
      buildNumber: BUILD_NUMBER,
      supportsTablet: false,
      // Icon Composer 工程（浅色、深色与 tinted 由系统按外观切换），与桌面端同一份。
      icon: `${ICONS}/source/Wevir.icon`,
      infoPlist: {
        // 本地网络权限（iOS 14 起）与 Bonjour 浏览的服务类型（`_wevir._tcp`，host-api.md §1.1）。
        NSLocalNetworkUsageDescription: en.ios.NSLocalNetworkUsageDescription,
        NSBonjourServices: ['_wevir._tcp'],
        // 听写（src/state/dictation.ts）录音。
        NSMicrophoneUsageDescription: en.ios.NSMicrophoneUsageDescription,
        CFBundleAllowMixedLocalizations: true,
        // 不写 ITSAppUsesNonExemptEncryption：配对与推送用的 Noise 是 App 自己实现的标准算法，写 true 就必须带上 Apple 审过
        // 文稿后给的 ITSEncryptionExportComplianceCode，否则上传被拒（90592）。不在法国区上架不需要文稿，也就没有这个代码，
        // 所以每个构建在 App Store Connect 里回答一次出口合规问题。
      },
      // 设备私钥与推送密钥存在这个 App Group 的钥匙串访问组里，通知服务扩展也读得到（src/lib/keychain.ts、push-store.ts）。真机构建要
      // 在开发者账号里登记这个 App Group，给 App 与扩展（`si.wevir.mobile.NotificationService`）的 App ID 都打开，App 的还要打开 Push。
      entitlements: {
        'com.apple.security.application-groups': [IOS_APP_GROUP],
      },
    },
    android: {
      package: BUNDLE_ID,
      ...(androidVersion !== undefined && {
        version: androidVersion,
        versionCode: androidVersionCode(androidVersion),
      }),
      ...(push.googleServices !== undefined && { googleServicesFile: push.googleServices }),
      adaptiveIcon: {
        foregroundImage: `${ICONS}/exports/android/res/drawable-xxxhdpi/wevir_foreground.png`,
        backgroundImage: `${ICONS}/exports/android/res/drawable-xxxhdpi/wevir_background.png`,
      },
      // react-native-zeroconf 自己声明组播锁与 Wi-Fi 状态的权限；录音权限由 expo-audio 声明（听写）。
    },
    // Info.plist 的权限说明，十种语言（与界面同一组）。放在每个文件的 `ios` 下：顶层的键 Expo 也写进 Android 的 strings.xml，
    // 默认语言里没有它们，release 构建的 lint（ExtraTranslation）会失败。
    locales: {
      en: './native-strings/en.json',
      'zh-Hans': './native-strings/zh-Hans.json',
      'zh-Hant': './native-strings/zh-Hant.json',
      ja: './native-strings/ja.json',
      ko: './native-strings/ko.json',
      de: './native-strings/de.json',
      es: './native-strings/es.json',
      fr: './native-strings/fr.json',
      it: './native-strings/it.json',
      ru: './native-strings/ru.json',
    },
    plugins: [
      'expo-router',
      [
        'expo-camera',
        {
          cameraPermission: en.ios.NSCameraUsageDescription,
          // 不录视频；麦克风的说明给听写用，三个插件写同一句，免得谁把它删掉。
          microphonePermission: en.ios.NSMicrophoneUsageDescription,
          recordAudioAndroid: false,
        },
      ],
      ['expo-secure-store', { faceIDPermission: false }],
      [
        'expo-image-picker',
        {
          photosPermission: en.ios.NSPhotoLibraryUsageDescription,
          cameraPermission: en.ios.NSCameraUsageDescription,
          microphonePermission: en.ios.NSMicrophoneUsageDescription,
        },
      ],
      // 听写只在前台录音，不要后台播放与录音（不加 UIBackgroundModes 的 audio、Android 的前台服务）。
      [
        'expo-audio',
        {
          microphonePermission: en.ios.NSMicrophoneUsageDescription,
          recordAudioAndroid: true,
          enableBackgroundPlayback: false,
          enableBackgroundRecording: false,
        },
      ],
      // 本地缓存整库加密（src/lib/cache-store.ts）：编进 SQLCipher。
      ['expo-sqlite', { useSQLCipher: true }],
      // App 锁与高风险审批的本人验证（src/state/lock.tsx）。
      ['expo-local-authentication', { faceIDPermission: en.ios.NSFaceIDUsageDescription }],
      'expo-localization',
      [
        'expo-notifications',
        {
          // 状态栏的小图标只用透明度。
          icon: `${ICONS}/exports/android/light/monochrome-432.png`,
          mode: push.apnsEnvironment,
          // 验证码是静默推送（APNs 后台推送），要 `remote-notification` 后台模式。
          enableBackgroundRemoteNotifications: true,
        },
      ],
      ['./plugins/with-notification-service.js', { appGroup: IOS_APP_GROUP }],
      './plugins/with-android-cleartext.js',
      './plugins/with-android-theme.js',
      './plugins/with-android-signing.js',
    ],
    experiments: {
      typedRoutes: false,
    },
    extra: {
      ...config.extra,
      // src/lib/push-native.ts 的 `pushBuildConfig`。
      push: { fcm: push.googleServices !== undefined, apnsEnvironment: push.apnsEnvironment },
    },
  };
};
