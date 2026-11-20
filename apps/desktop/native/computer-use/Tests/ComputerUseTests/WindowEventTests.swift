import AppKit
import XCTest
@testable import wevir_computer_use

final class WindowEventTests: XCTestCase {
  func testForeignWindowReceivesLocalPointsAndScrollDeltas() throws {
    let window = WindowInfo(windowId: 1234567, pid: 1, ownerName: "Fixture", title: nil,
      bounds: CGRect(x: -610, y: 230, width: 420, height: 280), layer: 0, alpha: 1)
    let point = CGPoint(x: -580, y: 300)
    let click = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
      mouseCursorPosition: point, mouseButton: .left))
    let scroll = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
      wheel1: -3, wheel2: 2, wheel3: 0))
    scroll.location = point
    for event in [click, scroll] {
      let targeted = try Input.windowEvent(event, for: window)
      XCTAssertEqual(targeted.location, CGPoint(x: 30, y: 70))
      XCTAssertEqual(targeted.type, event.type)
      XCTAssertEqual(NSEvent(cgEvent: targeted)?.windowNumber, Int(window.windowId))
    }
    let targeted = try Input.windowEvent(scroll, for: window)
    XCTAssertEqual(targeted.getIntegerValueField(.scrollWheelEventDeltaAxis1), -3)
    XCTAssertEqual(targeted.getIntegerValueField(.scrollWheelEventDeltaAxis2), 2)
  }
}
