// 推送载荷的解密与重放检查，与 `@wevir/noise` 的 push.ts 逐字节一致（同一组测试向量 packages/noise/test-vectors/push.json，
// apps/mobile/src/lib/push-swift.test.ts 在 macOS 上编译本文件核对）。扩展拿到的是 App 派生好的推送密钥（src/lib/push-store.ts），
// 所以这里只有 ChaChaPoly，不做 X25519 与 HKDF。只用 Foundation 与 CryptoKit。

import CryptoKit
import Foundation

enum PushCrypto {
  static let envelopeVersion: UInt8 = 1
  static let headerLength = 9
  static let tagLength = 16

  /// base64url，不带填充；有别的字符或长度不可能时 nil。
  static func base64URLDecode(_ text: String) -> Data? {
    if text.count % 4 == 1 { return nil }
    for scalar in text.unicodeScalars {
      switch scalar {
      case "A"..."Z", "a"..."z", "0"..."9", "-", "_": continue
      default: return nil
      }
    }
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while standard.count % 4 != 0 { standard += "=" }
    return Data(base64Encoded: standard)
  }

  struct Opened {
    let counter: Int64
    let plaintext: Data
  }

  /// 信封是 `版本 ‖ 计数（8 字节大端）‖ ChaChaPoly(密文 ‖ 16 字节标签)`；nonce 是 4 个零字节加计数的 8 字节小端，附加数据是信封头。
  /// 版本、长度、计数不对或校验失败时 nil。
  static func open(key: Data, envelope: Data) -> Opened? {
    let bytes = [UInt8](envelope)
    guard key.count == 32, bytes.count >= headerLength + tagLength, bytes[0] == envelopeVersion else {
      return nil
    }
    var counter: UInt64 = 0
    for index in 1..<headerLength { counter = (counter << 8) | UInt64(bytes[index]) }
    // 与 JS 一致：计数在 1 到 2^53 - 1 之间。
    guard counter >= 1, counter < (UInt64(1) << 53) else { return nil }
    var nonce = [UInt8](repeating: 0, count: 12)
    for index in 0..<8 { nonce[4 + index] = UInt8((counter >> (8 * UInt64(index))) & 0xff) }
    let header = Data(bytes[0..<headerLength])
    let body = bytes[headerLength...]
    do {
      let box = try ChaChaPoly.SealedBox(
        nonce: ChaChaPoly.Nonce(data: nonce),
        ciphertext: Data(body.dropLast(tagLength)),
        tag: Data(body.suffix(tagLength))
      )
      let plaintext = try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: header)
      return Opened(counter: Int64(counter), plaintext: plaintext)
    } catch {
      return nil
    }
  }
}

/// 设备端的重放检查（每台电脑一个），同 `@wevir/noise` 的 `PushReplayGuard`：收过的计数不再收，比见过的最大值小一个窗口以上的不收；
/// 只记窗口里的计数，最多 1024 个，记满时丢最小的并把下沿抬过它。状态的 JSON 形状与 JS 相同（`highest`、`floor`、`seen`）。
struct PushReplayGuard: Codable {
  static let window: Int64 = 10 * 60_000
  static let maxEntries = 1024

  var highest: Int64 = 0
  var floor: Int64 = 0
  var seen: [Int64] = []

  mutating func accept(_ counter: Int64) -> Bool {
    if counter < 1 || counter < floor || seen.contains(counter) { return false }
    if counter <= highest - PushReplayGuard.window { return false }
    var set = Set(seen)
    set.insert(counter)
    if counter > highest { highest = counter }
    let lowest = highest - PushReplayGuard.window
    set = set.filter { $0 > lowest }
    while set.count > PushReplayGuard.maxEntries, let minimum = set.min() {
      set.remove(minimum)
      floor = max(floor, minimum + 1)
    }
    seen = set.sorted()
    return true
  }
}

/// 解密后的一条提醒（`PushMessageSchema` 里显示与跳转要的字段）。
struct PushMessage: Decodable {
  let v: Int
  let id: String
  let kind: String
  let title: String
  let host: String
  let sessionId: String?
  let channelId: String?

  static let kinds: Set<String> = ["approval", "question", "completed", "failed", "automation", "channel"]

  /// 版本、种类与长度不合 schema 时 nil。
  static func decode(_ data: Data) -> PushMessage? {
    guard let message = try? JSONDecoder().decode(PushMessage.self, from: data),
      message.v == 1, kinds.contains(message.kind),
      message.title.utf16.count <= 200, message.host.utf16.count <= 64, message.id.utf16.count <= 160
    else { return nil }
    return message
  }
}
