// Esc 立即停止：电脑操作期间（主进程打开时）在 HID 层的事件流上挂一个监听（会话层的监听收不到别的进程注入的按键），用户按下 Esc 时吞掉这次按键并发 `escape` 事件。
// Wevir 自己发出的按键带 `syntheticMarker`，不算。监听要辅助功能权限；系统因为超时停用它时重新打开。

import CoreGraphics
import Foundation

enum EscapeWatch {
  private static var tap: CFMachPort?
  private static var runLoopSource: CFRunLoopSource?

  static func set(_ params: JSON) throws -> JSON {
    let on = params["on"] as? Bool ?? false
    if on { try Permissions.requireAccessibility() }
    let active: Bool = onMain {
      if on { start() } else { stop() }
      return tap != nil
    }
    return ["active": active]
  }

  private static func start() {
    guard tap == nil else { return }
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    guard
      let port = CGEvent.tapCreate(
        tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
        callback: { _, type, event, _ in
          if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = EscapeWatch.tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
          }
          if type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 53,
            event.getIntegerValueField(.eventSourceUserData) != syntheticMarker
          {
            send(["event": "escape"])
            return nil
          }
          return Unmanaged.passUnretained(event)
        }, userInfo: nil)
    else { return }
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    tap = port
    runLoopSource = source
  }

  private static func stop() {
    guard let port = tap else { return }
    CGEvent.tapEnable(tap: port, enable: false)
    if let runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes) }
    CFMachPortInvalidate(port)
    tap = nil
    runLoopSource = nil
  }
}
