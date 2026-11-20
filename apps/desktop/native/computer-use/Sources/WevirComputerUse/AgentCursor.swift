import AppKit
import QuartzCore

/// 指针尖端也要能落在菜单栏和副屏边缘。
private final class CursorPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

enum AgentCursor {
  private static var panel: CursorPanel?
  private static var ring: CAShapeLayer?
  private static var owner: String?
  private static var dismissal: Timer?
  private static let size = CGSize(width: 52, height: 52)
  private static let tip = CGPoint(x: 20, y: 32)

  /// 输入在串行工作队列里执行，面板和定时器只在主线程上读写。
  static func indicate(at point: CGPoint?, params: JSON, click: Bool = false, dragging: Bool = false) {
    guard let point, let scope = params["scope"] as? String else { return }
    DispatchQueue.main.async {
      guard EscapeWatch.scopes.contains(scope), let primary = NSScreen.screens.first else { return }
      let origin = CGPoint(x: point.x - tip.x, y: primary.frame.maxY - point.y - tip.y)
      let window = panel ?? makePanel()
      let animate = window.isVisible && owner == scope && !dragging
        && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      owner = scope
      if animate {
        NSAnimationContext.runAnimationGroup { context in
          context.duration = 0.12
          context.timingFunction = CAMediaTimingFunction(name: .easeOut)
          window.animator().setFrameOrigin(origin)
        }
      } else {
        window.setFrameOrigin(origin)
      }
      if !window.isVisible { window.orderFrontRegardless() }
      if click, let ring {
        let flash = CABasicAnimation(keyPath: "opacity")
        flash.fromValue = 1
        flash.toValue = 0
        flash.duration = 0.36
        ring.add(flash, forKey: "click")
      }
      dismissal?.invalidate()
      dismissal = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: false) { _ in hide() }
    }
  }

  static func hide(scope: String? = nil) {
    guard scope == nil || scope == owner else { return }
    dismissal?.invalidate()
    dismissal = nil
    ring?.removeAllAnimations()
    panel?.orderOut(nil)
    owner = nil
  }

  private static func makePanel() -> CursorPanel {
    let bounds = CGRect(origin: .zero, size: size)
    let window = CursorPanel(
      contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.title = "Wevir"
    window.level = .screenSaver
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.hidesOnDeactivate = false
    window.ignoresMouseEvents = true
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    window.animationBehavior = .none
    window.setAccessibilityElement(false)

    let view = NSView(frame: bounds)
    view.wantsLayer = true
    view.setAccessibilityElement(false)
    window.contentView = view
    let accent = NSColor(srgbRed: 0.95, green: 0.50, blue: 0.13, alpha: 1).cgColor
    let ripple = CAShapeLayer()
    ripple.path = CGPath(ellipseIn: CGRect(x: tip.x - 10, y: tip.y - 10, width: 20, height: 20), transform: nil)
    ripple.fillColor = NSColor.white.withAlphaComponent(0.28).cgColor
    ripple.strokeColor = accent
    ripple.lineWidth = 2
    ripple.opacity = 0
    view.layer?.addSublayer(ripple)

    let arrow = CAShapeLayer()
    let shape = CGMutablePath()
    shape.move(to: tip)
    for (dx, dy): (CGFloat, CGFloat) in [(5, -23), (10, -15), (17, -22), (20, -19), (13, -12), (22, -10)] {
      shape.addLine(to: CGPoint(x: tip.x + dx, y: tip.y + dy))
    }
    shape.closeSubpath()
    arrow.path = shape
    arrow.fillColor = accent
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.8
    arrow.lineJoin = .round
    arrow.shadowColor = NSColor.black.cgColor
    arrow.shadowOpacity = 0.55
    arrow.shadowOffset = CGSize(width: 0, height: -1)
    arrow.shadowRadius = 2
    view.layer?.addSublayer(arrow)
    panel = window
    ring = ripple
    return window
  }
}
