// 输入：点击、输入文字、按键、滚动、拖拽、设值。动作之前由 `Gate` 核对落到的应用。坐标是全局的点（主进程把截图里的
// 像素换算过来）。按元素（`ref`）的点击先用辅助功能的 AXPress、往元素里写字先用 AXSelectedText，它们不移动鼠标、不抢前台；
// 不行时才按元素中心的坐标发鼠标事件。给了 `background`（目标窗口的 `pid` 与 `windowId`）的点击和给了 `pid` 的按键直接发给
// 那个进程（CGEvent.postToPid），不把应用调到前台；应用不认这样的事件时，先 computer_open_app 再按前台的方式做。
// 这里发出的事件都带 `syntheticMarker`，Esc 的监听据此分出是不是用户按的。

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// 写在 Wevir 发出的事件的 eventSourceUserData 上。
let syntheticMarker: Int64 = 0x5745_5649_5243_5531

enum Input {
  private static let source = CGEventSource(stateID: .hidSystemState)

  private static func post(_ event: CGEvent?, pid: pid_t? = nil) {
    guard let event else { return }
    event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    if let pid {
      event.postToPid(pid)
    } else {
      event.post(tap: .cghidEventTap)
    }
  }

  private static func pause(_ milliseconds: Double = 8) {
    Thread.sleep(forTimeInterval: milliseconds / 1000)
  }

  private static func point(_ params: JSON, _ key: String? = nil) throws -> CGPoint {
    let raw = key.map { params[$0] as? JSON ?? [:] } ?? params
    guard let x = (raw["x"] as? NSNumber)?.doubleValue, let y = (raw["y"] as? NSNumber)?.doubleValue else {
      throw HelperError.invalid("\(key ?? "x and y") must give x and y")
    }
    return CGPoint(x: x, y: y)
  }

  private static func modifiers(_ params: JSON) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in params["modifiers"] as? [String] ?? [] {
      guard let flag = Keys.modifier(name) else { throw HelperError.invalid("unknown modifier \(name)") }
      flags.insert(flag)
    }
    return flags
  }

  // MARK: 点击

  static func click(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    let allow = Gate.allowMap(params)
    let ignore = Gate.ignoredWindows(params)
    let button = params["button"] as? String ?? "left"
    let count = max(1, min(params["count"] as? Int ?? 1, 3))
    let flags = try modifiers(params)
    let kind: ActionKind = button == "left" && flags.isEmpty ? .leftClick : .pointer
    var target: CGPoint

    if let ref = params["ref"] as? String {
      let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
      guard let app = Apps.info(pid: element.pid) else {
        throw HelperError(code: "computer_app_not_found", message: "The app of \(ref) is no longer running.")
      }
      try Gate.check(app, kind, allow: allow)
      if count == 1, flags.isEmpty {
        let action = button == "left" ? kAXPressAction : button == "right" ? kAXShowMenuAction : nil
        if let action, AXUIElementPerformAction(element.element, action as CFString) == .success {
          return ["method": "accessibility", "app": app.json]
        }
      }
      guard let frame = Accessibility.frame(of: element.element), frame.width > 0, frame.height > 0 else {
        throw HelperError(
          code: "computer_stale_ref", message: "\(ref) has no position on screen any more; read the tree again.")
      }
      target = CGPoint(x: frame.midX, y: frame.midY)
    } else {
      target = try point(params)
    }

    // 目标窗口的应用不在前台时直接发给它的进程；在前台时照常发（更可靠）。
    if params["background"] as? Bool == true, let rawPid = params["pid"] as? Int,
      let rawWindow = params["windowId"] as? Int, Apps.frontmost()?.pid != pid_t(rawPid)
    {
      let pid = pid_t(rawPid)
      guard let app = Apps.info(pid: pid) else {
        throw HelperError(code: "computer_app_not_found", message: "The target app is no longer running.")
      }
      try Gate.check(app, kind, allow: allow)
      try mouseClick(at: target, button: button, count: count, flags: flags, pid: pid, windowId: CGWindowID(rawWindow))
      return ["method": "background", "app": app.json, "x": target.x, "y": target.y]
    }

    guard let app = Gate.target(at: target, ignore: ignore) else {
      throw HelperError(code: "computer_app_not_found", message: "Nothing is on screen at that point.")
    }
    try Gate.check(app, kind, allow: allow)
    try mouseClick(at: target, button: button, count: count, flags: flags, pid: nil, windowId: nil)
    return ["method": "pointer", "app": app.json, "x": target.x, "y": target.y]
  }

  private static func mouseClick(
    at point: CGPoint, button: String, count: Int, flags: CGEventFlags, pid: pid_t?, windowId: CGWindowID?
  ) throws {
    let (down, up, mouseButton): (CGEventType, CGEventType, CGMouseButton)
    switch button {
    case "left": (down, up, mouseButton) = (.leftMouseDown, .leftMouseUp, .left)
    case "right": (down, up, mouseButton) = (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (down, up, mouseButton) = (.otherMouseDown, .otherMouseUp, .center)
    default: throw HelperError.invalid("button must be left, right or middle")
    }
    func make(_ type: CGEventType, clickState: Int) -> CGEvent? {
      let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: mouseButton)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
      event?.flags = flags
      if let windowId {
        event?.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
        event?.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
      }
      return event
    }
    if pid == nil {
      post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
      pause(30)
    }
    for state in 1...count {
      post(make(down, clickState: state), pid: pid)
      pause(20)
      post(make(up, clickState: state), pid: pid)
      pause(40)
    }
  }

  // MARK: 文字与按键

  static func type(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    guard let text = params["text"] as? String, !text.isEmpty else { throw HelperError.invalid("text is required") }
    let allow = Gate.allowMap(params)
    if let ref = params["ref"] as? String {
      let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
      guard let app = Apps.info(pid: element.pid) else {
        throw HelperError(code: "computer_app_not_found", message: "The app of \(ref) is no longer running.")
      }
      try Gate.check(app, .value, allow: allow)
      _ = AXUIElementSetAttributeValue(element.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      if AXUIElementSetAttributeValue(element.element, kAXSelectedTextAttribute as CFString, text as CFString)
        == .success
      {
        return ["method": "accessibility", "app": app.json]
      }
      let background = Apps.frontmost()?.pid != element.pid
      typeString(text, pid: background ? element.pid : nil)
      return ["method": background ? "background" : "keyboard", "app": app.json]
    }
    let (app, background) = try Gate.keyboardTarget(params)
    try Gate.check(app, .keyboard, allow: allow)
    typeString(text, pid: background ? app.pid : nil)
    return ["method": background ? "background" : "keyboard", "app": app.json]
  }

  private static func typeString(_ text: String, pid: pid_t?) {
    var chunk: [UniChar] = []
    func flush() {
      guard !chunk.isEmpty else { return }
      for keyDown in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(event, pid: pid)
      }
      chunk.removeAll()
      pause(6)
    }
    for character in text {
      if character == "\n" || character == "\r\n" || character == "\t" {
        flush()
        tap(character == "\t" ? CGKeyCode(kVK_Tab) : CGKeyCode(kVK_Return), flags: [], pid: pid)
        continue
      }
      let units = Array(String(character).utf16)
      if chunk.count + units.count > 16 { flush() }
      chunk.append(contentsOf: units)
    }
    flush()
  }

  private static func tap(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t?) {
    for keyDown in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown)
      event?.flags = flags
      post(event, pid: pid)
      pause(10)
    }
  }

  static func key(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    guard let combo = params["keys"] as? String, !combo.isEmpty else { throw HelperError.invalid("keys is required") }
    let (code, flags) = try Keys.parse(combo)
    let times = max(1, min(params["repeat"] as? Int ?? 1, 50))
    let (app, background) = try Gate.keyboardTarget(params)
    try Gate.check(app, .keyboard, allow: Gate.allowMap(params))
    for _ in 0..<times { tap(code, flags: flags, pid: background ? app.pid : nil) }
    return ["method": background ? "background" : "keyboard", "app": app.json]
  }

  // MARK: 滚动与拖拽

  static func scroll(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    var target: CGPoint
    if let ref = params["ref"] as? String {
      let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
      guard let frame = Accessibility.frame(of: element.element) else {
        throw HelperError(code: "computer_stale_ref", message: "\(ref) has no position on screen any more.")
      }
      target = CGPoint(x: frame.midX, y: frame.midY)
    } else {
      target = try point(params)
    }
    let dx = Int32((params["dx"] as? NSNumber)?.intValue ?? 0)
    let dy = Int32((params["dy"] as? NSNumber)?.intValue ?? 0)
    guard dx != 0 || dy != 0 else { throw HelperError.invalid("dx or dy must not be 0") }
    guard let app = Gate.target(at: target, ignore: Gate.ignoredWindows(params)) else {
      throw HelperError(code: "computer_app_not_found", message: "Nothing is on screen at that point.")
    }
    try Gate.check(app, .scroll, allow: Gate.allowMap(params))
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left))
    pause(30)
    // 一次最多滚 10 行，分几次发，应用来得及跟上。
    var remainingX = dx
    var remainingY = dy
    while remainingX != 0 || remainingY != 0 {
      let stepX = max(-10, min(10, remainingX))
      let stepY = max(-10, min(10, remainingY))
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: -stepY, wheel2: -stepX, wheel3: 0)
      event?.location = target
      post(event)
      remainingX -= stepX
      remainingY -= stepY
      pause(30)
    }
    return ["method": "pointer", "app": app.json]
  }

  static func drag(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    let from = try point(params, "from")
    let to = try point(params, "to")
    let ignore = Gate.ignoredWindows(params)
    let allow = Gate.allowMap(params)
    guard let source = Gate.target(at: from, ignore: ignore), let destination = Gate.target(at: to, ignore: ignore)
    else { throw HelperError(code: "computer_app_not_found", message: "Nothing is on screen at that point.") }
    try Gate.check(source, .pointer, allow: allow)
    if destination.pid != source.pid { try Gate.check(destination, .pointer, allow: allow) }
    post(CGEvent(mouseEventSource: self.source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
    pause(40)
    post(CGEvent(mouseEventSource: self.source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    pause(80)
    let steps = 20
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      post(CGEvent(mouseEventSource: self.source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left))
      pause(15)
    }
    pause(60)
    post(CGEvent(mouseEventSource: self.source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
    return ["method": "pointer", "app": source.json]
  }

  // MARK: 设值

  static func setValue(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    guard let ref = params["ref"] as? String else { throw HelperError.invalid("ref is required") }
    guard let value = params["value"] as? String else { throw HelperError.invalid("value must be a string") }
    let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
    guard let app = Apps.info(pid: element.pid) else {
      throw HelperError(code: "computer_app_not_found", message: "The app of \(ref) is no longer running.")
    }
    try Gate.check(app, .value, allow: Gate.allowMap(params))
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element.element, kAXValueAttribute as CFString, &settable) == .success,
      settable.boolValue
    else {
      throw HelperError(
        code: "computer_invalid_argument",
        message: "\(ref) does not accept a value. Click it and type instead, or pick another element.")
    }
    var current: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(element.element, kAXValueAttribute as CFString, &current)
    let newValue: CFTypeRef
    if current is NSNumber {
      guard let number = Double(value) ?? (["true", "on"].contains(value.lowercased()) ? 1 : ["false", "off"].contains(value.lowercased()) ? 0 : nil)
      else { throw HelperError.invalid("\(ref) holds a number; give a number (or true/false)") }
      newValue = NSNumber(value: number)
    } else {
      newValue = value as CFString
    }
    let status = AXUIElementSetAttributeValue(element.element, kAXValueAttribute as CFString, newValue)
    guard status == .success else {
      throw HelperError(code: "computer_unknown_error", message: "\(app.name) rejected the value (AX error \(status.rawValue)).")
    }
    return ["method": "accessibility", "app": app.json]
  }
}
