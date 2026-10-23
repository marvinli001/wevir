// 设备私钥在 iOS 钥匙串里的位置。以后的通知服务扩展（Notification Service Extension，推送到达时解密）要读同一把私钥，所以私钥
// 放在 App 与扩展共有的 App Group 里，不放 App 自己的默认访问组。App Group 名不带 Team ID 前缀，运行时不用知道 Team ID。
// app.config.ts 的 `com.apple.security.application-groups` 用的是同一个常量；扩展也要加这个 App Group。
//
// 扩展按 expo-secure-store 的写法查：`kSecClassGenericPassword`，`kSecAttrService` 为 `<KEYCHAIN_SERVICE>:no-auth`，
// `kSecAttrAccount` 为键名（`wevir.device.<路由 ID>`）的 UTF-8，`kSecAttrAccessGroup` 为 `IOS_APP_GROUP`；值是私钥的 base64url（UTF-8）。

/** App 与以后的扩展共有的 App Group，也是设备私钥的钥匙串访问组。 */
export const IOS_APP_GROUP = 'group.si.wevir.mobile';

/** 设备私钥的钥匙串服务名（expo-secure-store 的 `keychainService`）。 */
export const KEYCHAIN_SERVICE = 'wevir.device';
