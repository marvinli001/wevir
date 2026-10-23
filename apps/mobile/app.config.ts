// Expo 的应用配置（CNG：ios/、android/ 由 `expo prebuild` 从这里生成，不进仓库）。需要原生模块（mDNS、相机、钥匙串），用
// development build（expo-dev-client），不用 Expo Go。

import type { ConfigContext, ExpoConfig } from 'expo/config';
import en from './native-strings/en.json';

const ICONS = '../../assets/icons';
/** 与 src/lib/keychain.ts 的 `IOS_APP_GROUP` 相同（配置加载器读不了 src 下的 TS 模块，keychain.test.ts 核对两者一致）。 */
export const IOS_APP_GROUP = 'group.si.wevir.mobile';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Wevir',
  slug: 'wevir',
  version: '0.1.0',
  // 配对链接 `wevir://pair?…`：系统相机扫码、点链接都打开 App 的添加电脑页（src/app/+native-intent.tsx）。
  scheme: 'wevir',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: `${ICONS}/exports/ios/light/AppIcon-1024.png`,
  backgroundColor: '#fcfbfa',
  ios: {
    bundleIdentifier: 'si.wevir.mobile',
    supportsTablet: false,
    // Icon Composer 工程（浅色、深色与 tinted 由系统按外观切换），与桌面端同一份。
    icon: `${ICONS}/source/Wevir.icon`,
    infoPlist: {
      // 本地网络权限（iOS 14 起）与 Bonjour 浏览的服务类型（`_wevir._tcp`，host-api.md §1.1）。
      NSLocalNetworkUsageDescription: en.NSLocalNetworkUsageDescription,
      NSBonjourServices: ['_wevir._tcp'],
      CFBundleAllowMixedLocalizations: true,
    },
    // 设备私钥存在这个 App Group 的钥匙串访问组里，以后的通知服务扩展也读得到（src/lib/keychain.ts）。真机构建要在开发者账号里
    // 登记这个 App Group，并给 App 与扩展的 App ID 都打开。
    entitlements: {
      'com.apple.security.application-groups': [IOS_APP_GROUP],
    },
  },
  android: {
    package: 'si.wevir.mobile',
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
    'expo-localization',
    './plugins/with-android-cleartext.js',
  ],
  experiments: {
    typedRoutes: false,
  },
});
