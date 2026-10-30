// Wevir 的通知服务扩展（plugins/with-notification-service.js 在 prebuild 时把它加进 Xcode 工程）。推送网关送来的提醒只有通用文案
// （`WEVIR_PUSH_TITLE` / `WEVIR_PUSH_BODY`）与加密载荷 `p`；这里在手机上解密，改写成会话标题、电脑名与提醒种类（agent 的提醒是它写的
// 正文），并把跳转信息写进
// `userInfo["body"]`（expo-notifications 的 `content.data`），App 点开时据此打开那个会话或助理。
//
// 读的东西（都由 App 写，src/lib/push-store.ts）：
// - App Group 容器里的 `push/computers.json`：`{ hideOnLockScreen, computers: [{ name, routeId }] }`；
// - 共享钥匙串里每台电脑的推送密钥：服务名 `wevir.push:no-auth`，账户是 `wevir.push.<路由 ID>` 的 UTF-8，值是 base64url；
// - 重放状态 `push/replay.json`：`{ <路由 ID>: { highest, floor, seen } }`，这里读写。
//
// 解不开（退出了的电脑、被伪造）、重放的、内容不对的都显示通用的“需要处理”；锁屏且设了只显示“需要处理”时也一样（标题与跳转照旧
// 不带内容）。扩展不能丢掉一条提醒（那要 Apple 另批的权限），所以重放的只能显示通用文案，攻击者得不到别的。

import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let strings = PushStrings.load()
    let generic = PushRewriter.generic(request.content, strings: strings)
    fallback = generic
    contentHandler(PushRewriter.rewrite(request.content, strings: strings) ?? generic)
    self.contentHandler = nil
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let fallback { contentHandler(fallback) }
    contentHandler = nil
  }
}

enum PushRewriter {
  static let category = "wevir.push"
  static let targetKey = "wevirTarget"

  static var appGroup: String {
    Bundle.main.object(forInfoDictionaryKey: "WevirAppGroup") as? String ?? "group.si.wevir.mobile"
  }

  /// 通用文案：“Wevir：需要处理”。
  static func generic(_ original: UNNotificationContent, strings: PushStrings) -> UNNotificationContent {
    let content = (original.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    content.title = strings["WEVIR_PUSH_TITLE"] ?? "Wevir"
    content.subtitle = ""
    content.body = strings["WEVIR_PUSH_BODY"] ?? "Needs attention"
    content.categoryIdentifier = category
    return content
  }

  /// 解开并改写；解不开、重放、内容不对时 nil（显示通用文案）。
  static func rewrite(_ original: UNNotificationContent, strings: PushStrings) -> UNNotificationContent? {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else { return nil }
    return rewrite(
      original, strings: strings, dir: container.appendingPathComponent("push", isDirectory: true),
      pushKey: { Keychain.pushKey(routeId: $0, accessGroup: appGroup) },
      locked: { Keychain.deviceLocked(accessGroup: appGroup) })
  }

  /// 同上，共享目录、密钥与锁屏状态由调用方给（src/lib/push-swift.test.ts 在 macOS 上直接跑这一段）。
  static func rewrite(
    _ original: UNNotificationContent, strings: PushStrings, dir: URL,
    pushKey: (String) -> Data?, locked: () -> Bool
  ) -> UNNotificationContent? {
    guard original.userInfo["wevir"] as? String == "push",
      let payload = original.userInfo["p"] as? String,
      let envelope = PushCrypto.base64URLDecode(payload),
      let shared = SharedState.read(dir.appendingPathComponent("computers.json"))
    else { return nil }

    for computer in shared.computers {
      guard let key = pushKey(computer.routeId),
        let opened = PushCrypto.open(key: key, envelope: envelope)
      else { continue }
      let replayURL = dir.appendingPathComponent("replay.json")
      var replay = ReplayStates.read(replayURL)
      var guardState = replay[computer.routeId] ?? PushReplayGuard()
      guard guardState.accept(opened.counter) else { return nil }
      replay[computer.routeId] = guardState
      ReplayStates.write(replay, to: replayURL)
      guard let message = PushMessage.decode(opened.plaintext) else { return nil }

      let content = (original.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
      var target: [String: Any] = ["computer": computer.name]
      if let sessionId = message.sessionId { target["sessionId"] = sessionId }
      if let channelId = message.channelId { target["channelId"] = channelId }
      var userInfo = content.userInfo
      userInfo["body"] = [targetKey: target]
      userInfo.removeValue(forKey: "p")
      content.userInfo = userInfo
      content.categoryIdentifier = category
      content.threadIdentifier = "\(computer.name)/\(message.sessionId ?? message.channelId ?? "")"
      if shared.hideOnLockScreen && locked() {
        content.title = strings["WEVIR_PUSH_TITLE"] ?? "Wevir"
        content.subtitle = ""
        content.body = strings["WEVIR_PUSH_BODY"] ?? "Needs attention"
        return content
      }
      let host = message.host.trimmingCharacters(in: .whitespacesAndNewlines)
      let title = message.title.trimmingCharacters(in: .whitespacesAndNewlines)
      content.title = title.isEmpty ? (host.isEmpty ? "Wevir" : host) : title
      content.subtitle = host
      // agent 的提醒（0.142.0）显示 agent 写的正文，别的种类显示种类文案。
      let body = message.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      content.body = body.isEmpty
        ? strings["WEVIR_PUSH_KIND_\(message.kind.uppercased())"] ?? strings["WEVIR_PUSH_BODY"] ?? ""
        : body
      return content
    }
    return nil
  }
}

struct SharedState: Decodable {
  struct Computer: Decodable {
    let name: String
    let routeId: String
  }

  let hideOnLockScreen: Bool
  let computers: [Computer]

  static func read(_ url: URL) -> SharedState? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(SharedState.self, from: data)
  }
}

enum ReplayStates {
  static func read(_ url: URL) -> [String: PushReplayGuard] {
    guard let data = try? Data(contentsOf: url),
      let states = try? JSONDecoder().decode([String: PushReplayGuard].self, from: data)
    else { return [:] }
    return states
  }

  static func write(_ states: [String: PushReplayGuard], to url: URL) {
    guard let data = try? JSONEncoder().encode(states) else { return }
    try? data.write(to: url, options: .atomic)
  }
}

enum Keychain {
  /// expo-secure-store 写的推送密钥（src/lib/push-store.ts）。
  static func pushKey(routeId: String, accessGroup: String) -> Data? {
    let account = Data("wevir.push.\(routeId)".utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "wevir.push:no-auth",
      kSecAttrGeneric as String: account,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data,
      let text = String(data: data, encoding: .utf8),
      let key = PushCrypto.base64URLDecode(text),
      key.count == 32
    else { return nil }
    return key
  }

  /// 锁着屏：设备私钥（“解锁后才读得到”，src/lib/storage.ts）此时读不出来。
  static func deviceLocked(accessGroup: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "wevir.device:no-auth",
      kSecAttrAccessGroup as String: accessGroup,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &item) == errSecInteractionNotAllowed
  }
}

/// 扩展的文案（PushStrings.json，prebuild 时从 native-strings/*.json 的 `Localizable.strings` 生成），按系统语言选一种。
struct PushStrings {
  let table: [String: String]

  subscript(key: String) -> String? { table[key] }

  static func load() -> PushStrings {
    guard let url = Bundle.main.url(forResource: "PushStrings", withExtension: "json"),
      let data = try? Data(contentsOf: url),
      let all = try? JSONDecoder().decode([String: [String: String]].self, from: data)
    else { return PushStrings(table: [:]) }
    let language =
      Bundle.preferredLocalizations(from: Array(all.keys), forPreferences: Locale.preferredLanguages).first
      ?? "en"
    return PushStrings(table: all[language] ?? all["en"] ?? [:])
  }
}
