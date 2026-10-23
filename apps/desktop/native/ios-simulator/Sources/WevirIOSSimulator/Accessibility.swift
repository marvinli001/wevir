// 辅助功能树：在本机用私有框架 AccessibilityPlatformTranslation（Simulator.app 用的那个）翻译前台应用的元素，请求经
// -[SimDevice sendAccessibilityRequestAsync:…] 送到模拟器里的 CoreSimulatorBridge。
// 翻译器的委托与请求的等待移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，版权见
// LICENSE-facebook-idb.txt）的 FBSimulatorAX/Translation/AXTranslationDispatcher.swift 与 AXTranslationTransport.swift
// （CoreSimulatorAXTranslationTransport、AXAbandonedRequests）。改动：只留 CoreSimulator 这一条传输（不自己连 XPC），
// 元素经 AXPMacPlatformElement 读（idb 早期的读法），不带 idb 的单次请求读取器、性能统计与停顿探测。

import AccessibilityPlatformTranslation
import AppKit
import CoreSimulator
import Foundation
import ObjCExceptionGuard

/// Answers `AXPTranslator`'s synchronous bridge callbacks: each translator request is sent to the device the
/// token names and waited for, never longer than the element timeout.
final class AXTranslationDispatcher: NSObject, AXPTranslationTokenDelegateHelper, @unchecked Sendable {
  /// How long one translator request may wait for the simulator to answer.
  static let elementTimeout: TimeInterval = 2

  private let lock = NSLock()
  private var transports: [String: CoreSimulatorAXTranslationTransport] = [:]

  func register(token: String, device: SimDevice) {
    lock.lock()
    defer { lock.unlock() }
    if transports[token] == nil {
      transports[token] = CoreSimulatorAXTranslationTransport(device: device)
    }
  }

  private func transport(forToken token: String) -> CoreSimulatorAXTranslationTransport? {
    lock.lock()
    defer { lock.unlock() }
    return transports[token]
  }

  private static func emptyResponse() -> AXPTranslatorResponse? {
    AXPTranslatorResponse.empty() as? AXPTranslatorResponse
  }

  // MARK: - AXPTranslationTokenDelegateHelper

  // AXPTranslator's delegation is synchronous, so the request's transport waits for each answer. The wait
  // must never run on the main queue.
  func accessibilityTranslationDelegateBridgeCallback(withToken token: String) -> AXPTranslationCallback {
    guard let transport = transport(forToken: token) else {
      return { _ in Self.emptyResponse() }
    }
    return { axRequest in
      guard let axRequest else {
        return Self.emptyResponse()
      }
      // Unanswered within the timeout: the translator reads the empty response as "no value".
      return transport.send(axRequest, timeout: Self.elementTimeout) ?? Self.emptyResponse()
    }
  }

  func accessibilityTranslationConvertPlatformFrame(toSystem rect: CGRect, withToken token: String) -> CGRect {
    rect
  }

  func accessibilityTranslationRootParent(withToken token: String) -> Any? {
    nil
  }
}

/// Sends translator requests through CoreSimulator's own client,
/// `-[SimDevice sendAccessibilityRequestAsync:completionQueue:completionHandler:]`.
final class CoreSimulatorAXTranslationTransport: @unchecked Sendable {
  // SAFETY: all are only read after init; `SimDevice` messages its service from any queue.
  private let device: SimDevice
  private let completionQueue: DispatchQueue
  private let abandoned = AXAbandonedRequests()

  init(device: SimDevice) {
    self.device = device
    self.completionQueue = DispatchQueue(label: "si.wevir.ios-simulator.accessibility.callback")
  }

  func send(_ request: AXPTranslatorRequest, timeout: TimeInterval) -> AXPTranslatorResponse? {
    let response: AXPTranslatorResponse?? = abandoned.wait(within: timeout) { answer in
      device.sendAccessibilityRequestAsync(request, completionQueue: completionQueue) { answer($0) }
    }
    return response ?? nil
  }
}

/// The requests a transport stopped waiting for whose answers have not yet arrived.
final class AXAbandonedRequests: @unchecked Sendable {
  private let lock = NSLock()
  private var outstanding = 0

  var count: Int {
    lock.withLock { outstanding }
  }

  /// The answer `send` delivers to the closure it is given, or nil when none arrived within `timeout`. A request
  /// not answered in time is counted until its answer does arrive.
  func wait<Answer>(within timeout: TimeInterval, send: (@escaping @Sendable (Answer) -> Void) -> Void) -> Answer? {
    let answered = DispatchSemaphore(value: 0)
    let pending = Pending<Answer>()
    send { [self] answer in
      lock.withLock {
        pending.answer = answer
        if pending.abandoned {
          outstanding -= 1
        }
      }
      answered.signal()
    }
    guard answered.wait(timeout: .now() + timeout) == .success else {
      lock.withLock {
        guard pending.answer == nil else { return }
        pending.abandoned = true
        outstanding += 1
      }
      return nil
    }
    return lock.withLock { pending.answer }
  }

  private final class Pending<Answer>: @unchecked Sendable {
    var answer: Answer?
    var abandoned = false
  }
}

enum Accessibility {
  // AXPTranslator is a process-wide singleton whose internal state is not synchronized, so every touch of the
  // translator or its elements funnels through this one serial queue (idb does the same).
  private static let queue = DispatchQueue(label: "si.wevir.ios-simulator.accessibility")
  private static let dispatcher = AXTranslationDispatcher()
  private static let maxNodes = 3000
  private static let maxDepth = 64

  private static let translator: AXPTranslator? = {
    guard (try? SimulatorControlFrameworkLoader.accessibilityFrameworks.loadPrivateFrameworks(log)) != nil,
      let translator = AXPTranslator.sharedInstance() as? AXPTranslator
    else { return nil }
    translator.supportsDelegateTokens = true
    translator.accessibilityEnabled = true
    translator.bridgeTokenDelegate = dispatcher
    return translator
  }()

  /// `point?`（当前方向下的点）只取那个点上的元素，否则取前台应用的整棵树。`id` 是 `@aN`，每次读树重新编号。
  static func tree(_ session: DeviceSession, params: JSON) throws -> JSON {
    var point: CGPoint?
    if let value = params["point"] as? JSON {
      point = CGPoint(x: try value.double("x"), y: try value.double("y"))
    }
    return try queue.sync {
      let translator = try self.translator(for: session)
      let token = session.udid
      let translation: AXPTranslationObject?
      if let point {
        translation = translator.object(at: point, displayId: 0, bridgeDelegateToken: token)
      } else {
        translation = translator.frontmostApplication(withDisplayId: 0, bridgeDelegateToken: token)
      }
      guard let translation else {
        throw HelperError(code: "sim_ax_unavailable", message: "The simulator returned no accessibility element")
      }
      translation.bridgeDelegateToken = token
      guard let element = translator.macPlatformElement(fromTranslation: translation) as? AXPMacPlatformElement else {
        throw HelperError(code: "sim_ax_unavailable", message: "The accessibility element could not be translated")
      }
      var counter = 0
      let root = try serialize(element, token: token, depth: 0, counter: &counter, children: point == nil)
      return ["root": root, "count": counter, "truncated": counter >= maxNodes]
    }
  }

  static func frontmostPid(_ session: DeviceSession) throws -> pid_t {
    try queue.sync {
      let translator = try self.translator(for: session)
      guard let translation = translator.frontmostApplication(withDisplayId: 0, bridgeDelegateToken: session.udid) else {
        throw HelperError(code: "sim_ax_unavailable", message: "The simulator returned no frontmost application")
      }
      return translation.pid
    }
  }

  private static func translator(for session: DeviceSession) throws -> AXPTranslator {
    guard let translator else {
      throw HelperError(code: "sim_ax_unavailable", message: "AccessibilityPlatformTranslation is unavailable")
    }
    dispatcher.register(token: session.udid, device: session.simulator.device)
    return translator
  }

  private static func serialize(
    _ element: AXPMacPlatformElement, token: String, depth: Int, counter: inout Int, children readChildren: Bool
  ) throws -> JSON {
    counter += 1
    element.translation?.bridgeDelegateToken = token
    var node: JSON = ["id": "@a\(counter)"]
    let attributes = try FBObjCExceptionGuard.guarded { () -> JSON in
      var attributes: JSON = [:]
      if let role = element.accessibilityRole()?.rawValue {
        attributes["role"] = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
      }
      if let label = element.accessibilityLabel(), !label.isEmpty { attributes["label"] = label }
      if let value = element.accessibilityValue() {
        let text = (value as? String) ?? (value as? NSNumber)?.stringValue ?? (value as? NSAttributedString)?.string
        if let text, !text.isEmpty { attributes["value"] = text }
      }
      if let identifier = element.accessibilityIdentifier(), !identifier.isEmpty { attributes["identifier"] = identifier }
      let frame = element.accessibilityFrame()
      attributes["frame"] = [
        "x": Double(frame.origin.x), "y": Double(frame.origin.y), "width": Double(frame.width), "height": Double(frame.height),
      ]
      attributes["enabled"] = element.isAccessibilityEnabled()
      attributes["focused"] = element.isAccessibilityFocused()
      return attributes
    }
    node.merge(attributes) { _, new in new }
    guard readChildren, depth < maxDepth else { return node }
    let children = (try? FBObjCExceptionGuard.guarded { element.accessibilityChildren() }) ?? nil
    var serialized: [JSON] = []
    for case let child as AXPMacPlatformElement in children ?? [] {
      guard counter < maxNodes else { break }
      serialized.append(try serialize(child, token: token, depth: depth + 1, counter: &counter, children: true))
    }
    if !serialized.isEmpty { node["children"] = serialized }
    return node
  }
}
