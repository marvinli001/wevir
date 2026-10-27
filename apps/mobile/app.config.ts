// Expo 的应用配置（CNG：ios/、android/ 由 `expo prebuild` 从这里生成，不进仓库）。需要原生模块（mDNS、相机、钥匙串），用
// development build（expo-dev-client），不用 Expo Go。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import en from './native-strings/en.json';

const ICONS = '../../assets/icons';
/** 与 src/lib/keychain.ts 的 `IOS_APP_GROUP` 相同（配置加载器读不了 src 下的 TS 模块，keychain.test.ts 核对两者一致）。 */
export const IOS_APP_GROUP = 'group.si.wevir.mobile';
const BUNDLE_ID = 'si.wevir.mobile';

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
  return {
    ...config,
    name: 'Wevir',
    slug: 'wevir',
    version: '0.1.0',
    // 配对链接 `wevir://pair?…`：系统相机扫码、点链接都打开 App 的添加电脑页（src/app/+native-intent.tsx）。
    scheme: 'wevir',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: `${ICONS}/exports/ios/light/AppIcon-1024.png`,
    backgroundColor: '#f7f6f3',
    ios: {
      bundleIdentifier: BUNDLE_ID,
      supportsTablet: false,
      // Icon Composer 工程（浅色、深色与 tinted 由系统按外观切换），与桌面端同一份。
      icon: `${ICONS}/source/Wevir.icon`,
      infoPlist: {
        // 本地网络权限（iOS 14 起）与 Bonjour 浏览的服务类型（`_wevir._tcp`，host-api.md §1.1）。
        NSLocalNetworkUsageDescription: en.NSLocalNetworkUsageDescription,
        NSBonjourServices: ['_wevir._tcp'],
        CFBundleAllowMixedLocalizations: true,
      },
      // 设备私钥与推送密钥存在这个 App Group 的钥匙串访问组里，通知服务扩展也读得到（src/lib/keychain.ts、push-store.ts）。真机构建要
      // 在开发者账号里登记这个 App Group，给 App 与扩展（`si.wevir.mobile.NotificationService`）的 App ID 都打开，App 的还要打开 Push。
      entitlements: {
        'com.apple.security.application-groups': [IOS_APP_GROUP],
      },
    },
    android: {
      package: BUNDLE_ID,
      ...(push.googleServices !== undefined && { googleServicesFile: push.googleServices }),
      adaptiveIcon: {
        foregroundImage: `${ICONS}/exports/android/res/drawable-xxxhdpi/wevir_foreground.png`,
        backgroundImage: `${ICONS}/exports/android/res/drawable-xxxhdpi/wevir_background.png`,
      },
      // react-native-zeroconf 自己声明组播锁与 Wi-Fi 状态的权限；不要录音。
      blockedPermissions: ['android.permission.RECORD_AUDIO'],
    },
    // Info.plist 的权限说明，十种语言（与界面同一组）。
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
          cameraPermission: en.NSCameraUsageDescription,
          microphonePermission: false,
          recordAudioAndroid: false,
        },
      ],
      ['expo-secure-store', { faceIDPermission: false }],
      [
        'expo-image-picker',
        {
          photosPermission: en.NSPhotoLibraryUsageDescription,
          cameraPermission: en.NSCameraUsageDescription,
          microphonePermission: false,
        },
      ],
      // 本地缓存整库加密（src/lib/cache-store.ts）：编进 SQLCipher。
      ['expo-sqlite', { useSQLCipher: true }],
      // App 锁与高风险审批的本人验证（src/state/lock.tsx）。
      ['expo-local-authentication', { faceIDPermission: en.NSFaceIDUsageDescription }],
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
