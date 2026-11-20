// 输入：点击、输入文字、按键、滚动、拖拽、设值。动作之前由 `Gate` 核对落到的应用。坐标是全局的点（主进程把截图里的
// 像素换算过来）。按元素（`ref`）的点击先用辅助功能的 AXPress、往元素里写字先用 AXSelectedText，它们不移动鼠标、不抢前台；
// 不行时才按元素中心发鼠标事件。窗口内的手势直接投给窗口所属进程，整屏手势按实际落点操作。
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

  private struct PointerTarget {
    let app: AppInfo
    let window: WindowInfo?

    var method: String { window == nil ? "pointer" : "window" }

    func post(_ event: CGEvent?) throws {
      guard let event else { throw HelperError.invalid("Could not create a pointer event.") }
      if let window {
        Input.post(try Input.windowEvent(event, for: window), pid: window.pid)
      } else {
        Input.post(event)
      }
    }
  }

  static func windowEvent(_ event: CGEvent, for window: WindowInfo) throws -> CGEvent {
    // 本进程拿不到别的应用的 NSWindow。用 AppKit 的屏幕坐标编码窗口内的 Quartz 坐标；
    // 再设 cgEvent.location 会丢失窗口内位置。
    let local = CGPoint(x: event.location.x - window.bounds.minX,
      y: CGDisplayBounds(CGMainDisplayID()).height - (event.location.y - window.bounds.minY))
    let scrolling = event.type == .scrollWheel
    let type = scrolling ? NSEvent.EventType.mouseMoved : NSEvent.EventType(rawValue: UInt(event.type.rawValue))
    guard let type, let targeted = NSEvent.mouseEvent(
      with: type, location: local, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(event.flags.rawValue)),
      timestamp: Double(event.timestamp) / 1_000_000_000, windowNumber: Int(window.windowId), context: nil,
      eventNumber: 0, clickCount: Int(event.getIntegerValueField(.mouseEventClickState)), pressure: 1
    )?.cgEvent else { throw HelperError.invalid("Could not create an event for the target window.") }
    targeted.setIntegerValueField(.mouseEventButtonNumber, value: event.getIntegerValueField(.mouseEventButtonNumber))
    targeted.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowId))
    targeted.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowId))
    if scrolling {
      targeted.type = .scrollWheel
      for field: CGEventField in [.scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2,
        .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2] {
        targeted.setIntegerValueField(field, value: event.getIntegerValueField(field))
      }
    }
    return targeted
  }

  private static func pointerTarget(
    at point: CGPoint, _ kind: ActionKind, _ params: JSON, ref: ElementRef? = nil
  ) throws -> PointerTarget {
    let window: WindowInfo?
    if let ref {
      window = Accessibility.window(of: ref)
    } else if params["background"] as? Bool == true {
      guard let id = params["windowId"] as? Int, let pid = params["pid"] as? Int,
        let found = Apps.window(id: CGWindowID(id)), found.pid == pid_t(pid)
      else { throw HelperError(code: "computer_window_not_found", message: "The captured window closed. Take a new screenshot.") }
      if let raw = params["windowFrame"] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: raw),
        !found.bounds.equalTo(frame)
      {
        throw HelperError.invalid("The captured window moved or resized. Take a new screenshot.")
      }
      window = found
    } else {
      window = nil
    }
    let app: AppInfo?
    if let window {
      guard window.bounds.contains(point) else {
        throw HelperError.invalid("The point is outside the target window. Take a new screenshot.")
      }
      app = Apps.info(pid: window.pid)
    } else {
      app = Gate.target(at: point, ignore: Gate.ignoredWindows(params))
    }
    guard let app else { throw HelperError(code: "computer_app_not_found", message: "No app at the target point.") }
    if let ref, app.pid != ref.pid {
      throw HelperError(code: "computer_stale_ref", message: "The element is covered. Read its window again.")
    }
    try Gate.check(app, kind, allow: Gate.allowMap(params))
    return PointerTarget(app: app, window: window)
  }

  // MARK: 点击

  static func click(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    let allow = Gate.allowMap(params)
    let button = params["button"] as? String ?? "left"
    let count = max(1, min(params["count"] as? Int ?? 1, 3))
    let flags = try modifiers(params)
    let kind: ActionKind = button == "left" && flags.isEmpty ? .leftClick : .pointer
    var target: CGPoint
    var elementRef: ElementRef?

    if let ref = params["ref"] as? String {
      let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
      guard let app = Apps.info(pid: element.pid) else {
        throw HelperError(code: "computer_app_not_found", message: "The app of \(ref) is no longer running.")
      }
      try Gate.check(app, kind, allow: allow)
      let center = Accessibility.center(of: element.element)
      if count == 1, flags.isEmpty {
        let action = button == "left" ? kAXPressAction : button == "right" ? kAXShowMenuAction : nil
        if let action, AXUIElementPerformAction(element.element, action as CFString) == .success {
          AgentCursor.indicate(at: center, params: params, click: true)
          return ["method": "accessibility", "app": app.json]
        }
      }
      guard let center else {
        throw HelperError(
          code: "computer_stale_ref", message: "\(ref) has no position on screen any more; read the tree again.")
      }
      target = center
      elementRef = element
    } else {
      target = try point(params)
    }

    let recipient = try pointerTarget(at: target, kind, params, ref: elementRef)
    try mouseClick(at: target, button: button, count: count, flags: flags, recipient: recipient)
    AgentCursor.indicate(at: target, params: params, click: true)
    return ["method": recipient.method, "app": recipient.app.json, "x": target.x, "y": target.y]
  }

  private static func mouseClick(
    at point: CGPoint, button: String, count: Int, flags: CGEventFlags, recipient: PointerTarget
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
      return event
    }
    if recipient.window == nil {
      post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
      pause(30)
    }
    for state in 1...count {
      try recipient.post(make(down, clickState: state))
      pause(20)
      try recipient.post(make(up, clickState: state))
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
      let center = Accessibility.center(of: element.element)
      _ = AXUIElementSetAttributeValue(element.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      if AXUIElementSetAttributeValue(element.element, kAXSelectedTextAttribute as CFString, text as CFString)
        == .success
      {
        AgentCursor.indicate(at: center, params: params)
        return ["method": "accessibility", "app": app.json]
      }
      let background = Apps.frontmost()?.pid != element.pid
      try typeString(text, pid: element.pid, params: params)
      AgentCursor.indicate(at: center, params: params)
      return ["method": background ? "background" : "keyboard", "app": app.json]
    }
    let (app, background) = try Gate.keyboardTarget(params)
    try Gate.check(app, .keyboard, allow: allow)
    try typeString(text, pid: params["pid"] == nil ? nil : app.pid, params: params)
    return ["method": background ? "background" : "keyboard", "app": app.json]
  }

  private static func typeString(_ text: String, pid: pid_t?, params: JSON) throws {
    var chunk: [UniChar] = []
    func flush() throws {
      try EscapeWatch.requireActive(params)
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
        try flush()
        tap(character == "\t" ? CGKeyCode(kVK_Tab) : CGKeyCode(kVK_Return), flags: [], pid: pid)
        continue
      }
      let units = Array(String(character).utf16)
      if chunk.count + units.count > 16 { try flush() }
      chunk.append(contentsOf: units)
    }
    try flush()
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
    for _ in 0..<times {
      try EscapeWatch.requireActive(params)
      tap(code, flags: flags, pid: params["pid"] == nil ? nil : app.pid)
    }
    return ["method": background ? "background" : "keyboard", "app": app.json]
  }

  // MARK: 滚动与拖拽

  static func scroll(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    var target: CGPoint
    var elementRef: ElementRef?
    if let ref = params["ref"] as? String {
      let element = try Accessibility.lookup(ref, scope: params["scope"] as? String ?? "")
      guard let center = Accessibility.center(of: element.element) else {
        throw HelperError(code: "computer_stale_ref", message: "\(ref) has no position on screen any more.")
      }
      target = center
      elementRef = element
    } else {
      target = try point(params)
    }
    let dx = Int32((params["dx"] as? NSNumber)?.intValue ?? 0)
    let dy = Int32((params["dy"] as? NSNumber)?.intValue ?? 0)
    guard dx != 0 || dy != 0 else { throw HelperError.invalid("dx or dy must not be 0") }
    let recipient = try pointerTarget(at: target, .scroll, params, ref: elementRef)
    AgentCursor.indicate(at: target, params: params)
    if recipient.window == nil {
      post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: target, mouseButton: .left))
      pause(30)
    }
    // 一次最多滚 10 行，分几次发，应用来得及跟上。
    var remainingX = dx
    var remainingY = dy
    while remainingX != 0 || remainingY != 0 {
      try EscapeWatch.requireActive(params)
      let stepX = max(-10, min(10, remainingX))
      let stepY = max(-10, min(10, remainingY))
      let event = CGEvent(
        scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: -stepY, wheel2: -stepX, wheel3: 0)
      event?.location = target
      try recipient.post(event)
      remainingX -= stepX
      remainingY -= stepY
      pause(30)
    }
    return ["method": recipient.method, "app": recipient.app.json]
  }

  static func drag(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    let from = try point(params, "from")
    let to = try point(params, "to")
    let recipient = try pointerTarget(at: from, .pointer, params)
    _ = try pointerTarget(at: to, .pointer, params)
    func mouse(_ type: CGEventType, _ point: CGPoint) throws {
      try recipient.post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left))
    }
    if recipient.window == nil {
      try mouse(.mouseMoved, from)
      pause(40)
    }
    AgentCursor.indicate(at: from, params: params, dragging: true)
    try mouse(.leftMouseDown, from)
    pause(80)
    var lastPoint = from
    defer { try? mouse(.leftMouseUp, lastPoint) }
    let steps = 20
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      try EscapeWatch.requireActive(params)
      try mouse(.leftMouseDragged, point)
      lastPoint = point
      AgentCursor.indicate(at: point, params: params, dragging: true)
      pause(15)
    }
    pause(60)
    return ["method": recipient.method, "app": recipient.app.json]
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
    let center = Accessibility.center(of: element.element)
    let status = AXUIElementSetAttributeValue(element.element, kAXValueAttribute as CFString, newValue)
    guard status == .success else {
      throw HelperError(code: "computer_unknown_error", message: "\(app.name) rejected the value (AX error \(status.rawValue)).")
    }
    AgentCursor.indicate(at: center, params: params)
    return ["method": "accessibility", "app": app.json]
  }
}
