// 输入：tap / touch / touch_raw / text / key / button，组合成移植来的 HID 传输（Indigo 或 dtuhidd）的原语。
// 键位表取自 facebook/idb Tools/SimScope/SimScope/Keymap.swift（提交 14baeffc8f681380527c400a8184512b746ee918，MIT）。

import CoreGraphics
import Foundation

/// USB HID 键盘用法（Keyboard/Keypad 页）。Indigo 与 dtuhidd 都收这个值。
enum KeyUsage {
  static let returnKey: UInt32 = 0x28
  static let escape: UInt32 = 0x29
  static let delete: UInt32 = 0x2A // Backspace
  static let tab: UInt32 = 0x2B
  static let space: UInt32 = 0x2C
  static let home: UInt32 = 0x4A
  static let pageUp: UInt32 = 0x4B
  static let forwardDelete: UInt32 = 0x4C
  static let end: UInt32 = 0x4D
  static let pageDown: UInt32 = 0x4E
  static let right: UInt32 = 0x4F
  static let left: UInt32 = 0x50
  static let down: UInt32 = 0x51
  static let up: UInt32 = 0x52
  static let leftShift: UInt32 = 0xE1
  static let leftCommand: UInt32 = 0xE3

  static func letter(_ character: Character) -> UInt32 {
    0x04 + UInt32(character.asciiValue! - Character("a").asciiValue!)
  }

  /// 美式键盘布局下能直接打出的字符：用法与是否按 Shift。
  static let printable: [Character: (usage: UInt32, shift: Bool)] = {
    var table: [Character: (UInt32, Bool)] = [:]
    // Letters a–z (0x04–0x1D); uppercase shares the usage with shift.
    let letterBase: UInt32 = 0x04
    for (offset, lower) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
      let usage = letterBase + UInt32(offset)
      table[lower] = (usage, false)
      if let upper = lower.uppercased().first { table[upper] = (usage, true) }
    }
    // Number row 1–9,0 (0x1E–0x27) and their shifted symbols.
    let digitUsages: [UInt32] = [0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27]
    for (offset, digit) in "1234567890".enumerated() { table[digit] = (digitUsages[offset], false) }
    for (offset, symbol) in "!@#$%^&*()".enumerated() { table[symbol] = (digitUsages[offset], true) }
    table[" "] = (space, false)
    table["\n"] = (returnKey, false)
    table["\t"] = (tab, false)
    // Punctuation: (unshifted, shifted, usage).
    let punctuation: [(Character, Character, UInt32)] = [
      ("-", "_", 0x2D), ("=", "+", 0x2E), ("[", "{", 0x2F), ("]", "}", 0x30),
      ("\\", "|", 0x31), (";", ":", 0x33), ("'", "\"", 0x34), ("`", "~", 0x35),
      (",", "<", 0x36), (".", ">", 0x37), ("/", "?", 0x38),
    ]
    for (base, shifted, usage) in punctuation {
      table[base] = (usage, false)
      table[shifted] = (usage, true)
    }
    return table
  }()
}

/// 线缆上的 `key` 名字：一个键加上要同时按住的修饰键。
private let namedKeys: [String: (usage: UInt32, modifiers: [UInt32])] = [
  "return": (KeyUsage.returnKey, []),
  "delete": (KeyUsage.delete, []),
  "forward_delete": (KeyUsage.forwardDelete, []),
  "up": (KeyUsage.up, []),
  "down": (KeyUsage.down, []),
  "left": (KeyUsage.left, []),
  "right": (KeyUsage.right, []),
  "home": (KeyUsage.home, []),
  "end": (KeyUsage.end, []),
  "page_up": (KeyUsage.pageUp, []),
  "page_down": (KeyUsage.pageDown, []),
  "tab": (KeyUsage.tab, []),
  "escape": (KeyUsage.escape, []),
  "select_all": (KeyUsage.letter("a"), [KeyUsage.leftCommand]),
  "undo": (KeyUsage.letter("z"), [KeyUsage.leftCommand]),
  "redo": (KeyUsage.letter("z"), [KeyUsage.leftCommand, KeyUsage.leftShift]),
  "cut": (KeyUsage.letter("x"), [KeyUsage.leftCommand]),
  "copy": (KeyUsage.letter("c"), [KeyUsage.leftCommand]),
  "paste": (KeyUsage.letter("v"), [KeyUsage.leftCommand]),
]

private let namedButtons: [String: SimulatorHIDButton] = [
  "HOME": .homeButton,
  "LOCK": .lock,
  "SIDE_BUTTON": .sideButton,
  "SIRI": .siri,
  "APPLE_PAY": .applePay,
  "VOLUME_UP": .volumeUp,
  "VOLUME_DOWN": .volumeDown,
]

/// 起点离屏幕边缘不到这么多点时，触摸带上边缘标记，系统按边缘手势处理（返回、通知中心、主屏）。
private let edgeThreshold: CGFloat = 4
/// Simulator.app 菜单 I/O › Keyboard › Toggle Software Keyboard 发的 Indigo 按键源。
private let softwareKeyboardSource: Int32 = 0x3f0

enum Input {
  // MARK: - Touch

  static func tap(_ session: DeviceSession, params: JSON) throws {
    let point = try point(params)
    let duration = params.optionalDouble("duration") ?? 0
    guard duration >= 0, duration <= 60 else { throw HelperError.invalid("duration must be in [0, 60] seconds") }
    try deliver(session) { hid in
      let target = session.unrotate(point)
      try await hid.primitives.sendTouch(direction: .down, x: target.x, y: target.y, edge: .none)
      if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000)) }
      try await hid.primitives.sendTouch(direction: .up, x: target.x, y: target.y, edge: .none)
    }
  }

  /// `points: [{x, y, dtMs}]` 是一指拖动（首点按下、末点抬起），`points2: [{x1, y1, x2, y2, dtMs}]` 是双指。
  static func touch(_ session: DeviceSession, params: JSON) throws {
    if let points = params.array("points") {
      let samples = try points.map { sample -> (CGPoint, Double) in
        (try point(sample), max(0, sample.optionalDouble("dtMs") ?? 0))
      }
      guard samples.count >= 1, samples.count <= 10_000 else { throw HelperError.invalid("points must have 1–10000 samples") }
      let edge = self.edge(of: samples[0].0, in: session)
      try deliver(session) { hid in
        for (index, (point, delay)) in samples.enumerated() {
          if delay > 0 { try await Task.sleep(nanoseconds: UInt64(min(delay, 1000) * 1_000_000)) }
          let target = session.unrotate(point)
          try await hid.primitives.sendTouch(direction: .down, x: target.x, y: target.y, edge: edge)
          if index == samples.count - 1 {
            try await hid.primitives.sendTouch(direction: .up, x: target.x, y: target.y, edge: edge)
          }
        }
      }
    } else if let points = params.array("points2") {
      let samples = try points.map { sample -> (CGPoint, CGPoint, Double) in
        (
          CGPoint(x: try sample.double("x1"), y: try sample.double("y1")),
          CGPoint(x: try sample.double("x2"), y: try sample.double("y2")),
          max(0, sample.optionalDouble("dtMs") ?? 0)
        )
      }
      guard samples.count >= 1, samples.count <= 10_000 else { throw HelperError.invalid("points2 must have 1–10000 samples") }
      try deliver(session) { hid in
        for (index, (first, second, delay)) in samples.enumerated() {
          if delay > 0 { try await Task.sleep(nanoseconds: UInt64(min(delay, 1000) * 1_000_000)) }
          let a = session.unrotate(first)
          let b = session.unrotate(second)
          try await hid.primitives.sendTwoFingerTouch(direction: .down, finger1: a, finger2: b)
          if index == samples.count - 1 {
            try await hid.primitives.sendTwoFingerTouch(direction: .up, finger1: a, finger2: b)
          }
        }
      }
    } else {
      throw HelperError.invalid("points or points2 is required")
    }
  }

  /// 窗格的实时拖动：逐事件下发。`finger: 1` 的事件与 0 号手指当前的位置合成双指触摸。
  static func touchRaw(_ session: DeviceSession, params: JSON) throws {
    let phase = try params.string("phase")
    guard ["down", "move", "up"].contains(phase) else { throw HelperError.invalid("phase must be down, move or up") }
    let finger = Int(params.optionalDouble("finger") ?? 0)
    guard finger == 0 || finger == 1 else { throw HelperError.invalid("finger must be 0 or 1") }
    let point = session.unrotate(try point(params))
    let raw = session.rawTouch
    raw.lock.lock()
    let state = raw.update(finger: finger, phase: phase, point: point)
    raw.lock.unlock()
    try deliver(session) { hid in
      switch state {
      case let .single(direction, point, edge):
        try await hid.primitives.sendTouch(direction: direction, x: point.x, y: point.y, edge: edge)
      case let .double(direction, first, second):
        try await hid.primitives.sendTwoFingerTouch(direction: direction, finger1: first, finger2: second)
      case .ignore:
        break
      }
    }
  }

  // MARK: - Keyboard

  /// 逐字符按美式键盘布局按键；有字符打不出时整段走模拟器的粘贴板（simctl pbcopy）再按 ⌘V。
  static func text(_ session: DeviceSession, params: JSON) throws {
    guard let text = params["text"] as? String else { throw HelperError.invalid("text is required") }
    guard text.count <= 10_000 else { throw HelperError.invalid("text is longer than 10000 characters") }
    let keys = text.map { KeyUsage.printable[$0] }
    if keys.contains(where: { $0 == nil }) {
      try Simctl.pasteboardCopy(udid: session.udid, text: text)
      try press(session, usage: KeyUsage.letter("v"), modifiers: [KeyUsage.leftCommand], count: 1)
      return
    }
    try deliver(session) { hid in
      for case let (usage, shift)? in keys {
        if shift { try await hid.primitives.sendKeyboard(direction: .down, keyCode: KeyUsage.leftShift) }
        try await hid.primitives.sendKeyboard(direction: .down, keyCode: usage)
        try await hid.primitives.sendKeyboard(direction: .up, keyCode: usage)
        if shift { try await hid.primitives.sendKeyboard(direction: .up, keyCode: KeyUsage.leftShift) }
      }
    }
  }

  static func key(_ session: DeviceSession, params: JSON) throws {
    let name = try params.string("key")
    guard let key = namedKeys[name] else { throw HelperError.invalid("unknown key \(name)") }
    let count = Int(params.optionalDouble("count") ?? 1)
    guard count >= 1, count <= 100 else { throw HelperError.invalid("count must be in [1, 100]") }
    try press(session, usage: key.usage, modifiers: key.modifiers, count: count)
  }

  private static func press(_ session: DeviceSession, usage: UInt32, modifiers: [UInt32], count: Int) throws {
    try deliver(session) { hid in
      for _ in 0..<count {
        for modifier in modifiers { try await hid.primitives.sendKeyboard(direction: .down, keyCode: modifier) }
        try await hid.primitives.sendKeyboard(direction: .down, keyCode: usage)
        try await hid.primitives.sendKeyboard(direction: .up, keyCode: usage)
        for modifier in modifiers.reversed() { try await hid.primitives.sendKeyboard(direction: .up, keyCode: modifier) }
      }
    }
  }

  // MARK: - Buttons

  static func button(_ session: DeviceSession, params: JSON) throws {
    let name = try params.string("name")
    guard let button = namedButtons[name.uppercased()] else { throw HelperError.invalid("unknown button \(name)") }
    let duration = params.optionalDouble("duration") ?? 0
    guard duration >= 0, duration <= 60 else { throw HelperError.invalid("duration must be in [0, 60] seconds") }
    try deliver(session) { hid in
      try await hid.primitives.sendButton(direction: .down, button: button)
      if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000)) }
      try await hid.primitives.sendButton(direction: .up, button: button)
    }
  }

  /// Simulator.app 的 ⌘K（Toggle Software Keyboard）：Indigo 按键源 0x3f0 按下再抬起，只有切换、没有显示 / 收起之分。
  /// dtuhidd 上没有对应的用法。
  static func toggleSoftwareKeyboard(_ session: DeviceSession) throws {
    try deliver(session) { hid in
      guard let indigo = hid.indigo else {
        throw HelperError(code: "sim_hid_unavailable", message: "Toggling the software keyboard needs the Indigo HID transport")
      }
      try await indigo.sendButton(direction: .down, source: softwareKeyboardSource)
      try await indigo.sendButton(direction: .up, source: softwareKeyboardSource)
    }
  }

  // MARK: - Helpers

  private static func point(_ params: JSON) throws -> CGPoint {
    CGPoint(x: try params.double("x"), y: try params.double("y"))
  }

  /// 起点贴着哪条边（当前方向下的点），换算成竖放时的边。
  private static func edge(of point: CGPoint, in session: DeviceSession) -> SimulatorHIDEdge {
    let size = session.portraitPointSize
    let target = session.unrotate(point)
    if target.y <= edgeThreshold { return .top }
    if target.y >= size.height - edgeThreshold { return .bottom }
    if target.x <= edgeThreshold { return .left }
    if target.x >= size.width - edgeThreshold { return .right }
    return .none
  }

  /// 在设备的 HID 传输上执行一串发送，最后等 dtuhidd 送达 / Indigo 回执，好让下一条命令看到的是已生效的画面。
  private static func deliver(
    _ session: DeviceSession, _ body: @escaping @Sendable (SimulatorHIDTransport) async throws -> Void
  ) throws {
    let hid = try session.hid()
    do {
      try runBlocking {
        try await body(hid)
        try await hid.flush()
        try await hid.acknowledged()
      }
    } catch let error as HelperError {
      throw error
    } catch {
      throw HelperError.wrap(error, code: "sim_hid_unavailable")
    }
  }
}

/// `touch_raw` 的两指状态。
final class RawTouchState: @unchecked Sendable {
  enum Delivery {
    case single(SimulatorHIDDirection, CGPoint, SimulatorHIDEdge)
    case double(SimulatorHIDDirection, CGPoint, CGPoint)
    case ignore
  }

  let lock = NSLock()
  private var positions: [CGPoint?] = [nil, nil]
  private var twoFinger = false

  func update(finger: Int, phase: String, point: CGPoint) -> Delivery {
    switch phase {
    case "down", "move":
      if phase == "move", positions[finger] == nil { return .ignore }
      positions[finger] = point
      if finger == 1 || twoFinger {
        twoFinger = true
        let first = positions[0] ?? point
        let second = positions[1] ?? point
        return .double(.down, first, second)
      }
      return .single(.down, point, .none)
    default:
      guard positions[finger] != nil else { return .ignore }
      positions[finger] = point
      if twoFinger {
        // 任一指抬起就结束这次双指触摸；另一指要继续须重新按下。
        let delivery = Delivery.double(.up, positions[0] ?? point, positions[1] ?? point)
        positions = [nil, nil]
        twoFinger = false
        return delivery
      }
      positions[finger] = nil
      return .single(.up, point, .none)
    }
  }
}
