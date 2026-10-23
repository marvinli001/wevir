// 设备：加载 CoreSimulator / SimulatorKit，按 udid 找 SimDevice，每台设备一个 DeviceSession（HID、帧缓冲、方向、录像与流）。
// 服务上下文的取法移植自 facebook/idb FBSimulatorControl/Management/SimulatorServiceContext.swift
// （提交 14baeffc8f681380527c400a8184512b746ee918，MIT）。

import CoreGraphics
import CoreSimulator
import Foundation
import ObjCExceptionGuard
import IOSurface

/// 设备方向（设备朝向的约定，与 UIDeviceOrientation 同名）。
enum DeviceOrientation: String {
  case portrait
  case portraitUpsideDown
  case landscapeLeft
  case landscapeRight

  var isLandscape: Bool { self == .landscapeLeft || self == .landscapeRight }

  /// 向右（顺时针）转 90°：竖屏 → 横屏（Home 在左，landscapeRight）→ 倒竖屏 → landscapeLeft → 竖屏。
  func rotated(_ direction: String) -> DeviceOrientation {
    let clockwise: [DeviceOrientation] = [.portrait, .landscapeRight, .portraitUpsideDown, .landscapeLeft]
    let index = clockwise.firstIndex(of: self) ?? 0
    let step = direction == "left" ? 3 : 1
    return clockwise[(index + step) % 4]
  }

  var hidOrientation: SimulatorHIDDeviceOrientation {
    switch self {
    case .portrait: .portrait
    case .portraitUpsideDown: .portraitUpsideDown
    case .landscapeLeft: .landscapeLeft
    case .landscapeRight: .landscapeRight
    }
  }
}

/// 在当前线程上等一个 async 操作完成。请求在各自设备的串行队列（GCD 线程，不是协作线程池）上执行，阻塞等待不会卡住
/// 移植代码里的 actor。
func runBlocking<T>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  let box = ResultBox<T>()
  Task {
    do {
      box.result = .success(try await operation())
    } catch {
      box.result = .failure(error)
    }
    semaphore.signal()
  }
  semaphore.wait()
  return try box.result!.get()
}

private final class ResultBox<T>: @unchecked Sendable {
  var result: Result<T, Error>?
}

final class SimulatorRegistry: @unchecked Sendable {
  static let shared = SimulatorRegistry()

  private let lock = NSLock()
  private var deviceSet: SimDeviceSet?
  private var sessions: [String: DeviceSession] = [:]

  /// 加载私有框架并取默认设备集。CoreSimulator 弱链接，SimulatorKit 要在取帧之前加载：ROCK 代理要靠它解码帧缓冲的回调。
  func prepare() throws {
    lock.lock()
    defer { lock.unlock() }
    if deviceSet != nil { return }
    try SimulatorControlFrameworkLoader.essentialFrameworks.loadPrivateFrameworks(log)
    try SimulatorControlFrameworkLoader.xcodeFrameworks.loadPrivateFrameworks(log)
    guard
      let serviceContextClass = NSClassFromString("SimServiceContext") as? SimServiceContext.Type,
      serviceContextClass.responds(to: NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"))
    else {
      throw HelperError(code: "sim_framework_missing", message: "SimServiceContext is unavailable in CoreSimulator")
    }
    // An empty developer directory makes -[SimServiceContext sharedServiceContextForDeveloperDir:error:]
    // crash with an opaque NSException; throw a clear error instead.
    guard let developerDirectory = PrivateFrameworks.developerDirectory else {
      throw HelperError(code: "sim_framework_missing", message: "No Xcode is selected (xcode-select -p)")
    }
    var error: AnyObject?
    let context = try FBObjCExceptionGuard.guarded {
      serviceContextClass.sharedServiceContext(forDeveloperDir: developerDirectory, error: &error)
    }
    guard let context = context as? SimServiceContext else {
      throw HelperError(
        code: "sim_framework_missing",
        message: "CoreSimulator has no service context for \(developerDirectory): \((error as? NSError)?.localizedDescription ?? "unknown")")
    }
    // defaultDeviceSetWithError: takes (id *) not (NSError **), so use the raw API
    guard let set = context.defaultDeviceSetWithError(&error) as? SimDeviceSet else {
      throw HelperError(
        code: "sim_framework_missing",
        message: "CoreSimulator has no default device set: \((error as? NSError)?.localizedDescription ?? "unknown")")
    }
    deviceSet = set
  }

  /// 已加载的 CoreSimulator 版本（例如 "1051.54"）；HID 传输的选择依据它。
  var coreSimulatorVersion: String? {
    guard let simDeviceClass = NSClassFromString("SimDevice") else { return nil }
    return Bundle(for: simDeviceClass).infoDictionary?["CFBundleVersion"] as? String
  }

  /// 选中的 Xcode 的版本（例如 "26.5"），读 Xcode.app 的 Info.plist。
  var xcodeVersion: String? {
    guard let developer = PrivateFrameworks.developerDirectory else { return nil }
    let plist = ((developer as NSString).deletingLastPathComponent as NSString).appendingPathComponent("Info.plist")
    return NSDictionary(contentsOfFile: plist)?["CFBundleShortVersionString"] as? String
  }

  /// 已启动设备的会话；设备不存在或没启动时抛 `sim_not_found` / `sim_not_booted`。
  func session(_ udid: String) throws -> DeviceSession {
    try prepare()
    lock.lock()
    defer { lock.unlock() }
    guard let set = deviceSet else { throw HelperError(code: "sim_framework_missing", message: "CoreSimulator is not loaded") }
    let devices = (try? FBObjCExceptionGuard.guarded { set.devices as? [SimDevice] }) ?? nil
    guard let device = devices?.first(where: { $0.udid.uuidString.caseInsensitiveCompare(udid) == .orderedSame }) else {
      throw HelperError(code: "sim_not_found", message: "No simulator with udid \(udid)")
    }
    let state = TargetState(rawValue: UInt(device.state)) ?? .unknown
    guard state == .booted else {
      sessions[udid.uppercased()]?.close()
      sessions[udid.uppercased()] = nil
      throw HelperError(code: "sim_not_booted", message: "Simulator \(udid) is \(state.stateString)")
    }
    if let existing = sessions[udid.uppercased()], existing.simulator.device === device {
      return existing
    }
    let session = DeviceSession(simulator: Simulator(device: device, logger: log.withName(udid)))
    sessions[udid.uppercased()] = session
    return session
  }

  func allSessions() -> [DeviceSession] {
    lock.lock()
    defer { lock.unlock() }
    return Array(sessions.values)
  }
}

/// 一台已启动设备上的全部状态。命令在 `queue` 上逐个执行，输入的先后因此与请求一致。
final class DeviceSession: @unchecked Sendable {
  let simulator: Simulator
  let queue: DispatchQueue
  let framebuffer: FramebufferHub
  let rawTouch = RawTouchState()

  private let lock = NSLock()
  private var hidTransport: SimulatorHIDTransport?
  private var currentOrientation: DeviceOrientation = .portrait
  private lazy var purple = SimulatorPurpleHIDTransport(simulator: simulator)

  init(simulator: Simulator) {
    self.simulator = simulator
    self.queue = DispatchQueue(label: "si.wevir.ios-simulator.device.\(simulator.udid)")
    self.framebuffer = FramebufferHub(simulator: simulator)
    syncOrientation()
  }

  var udid: String { simulator.udid }

  /// 主屏竖放时的点尺寸与倍率（`-[SimDeviceType mainScreenSize]` 是像素）。
  var portraitPointSize: CGSize {
    guard let type = simulator.device.deviceType else { return .zero }
    let scale = CGFloat(type.mainScreenScale)
    return CGSize(width: type.mainScreenSize.width / scale, height: type.mainScreenSize.height / scale)
  }

  var scale: Double { Double(simulator.device.deviceType?.mainScreenScale ?? 1) }

  var orientation: DeviceOrientation {
    lock.lock()
    defer { lock.unlock() }
    return currentOrientation
  }

  /// 当前方向下的点尺寸：横屏时宽高互换。
  var pointSize: CGSize {
    let size = portraitPointSize
    return orientation.isLandscape ? CGSize(width: size.height, height: size.width) : size
  }

  var screen: JSON {
    let size = pointSize
    return ["width": Double(size.width), "height": Double(size.height), "scale": scale]
  }

  // MARK: - HID

  /// 第一次输入时协商 HID 传输：CoreSimulator 1155.4（Xcode 27）起用 dtuhidd，否则用 Indigo。
  func hid() throws -> SimulatorHIDTransport {
    lock.lock()
    if let hidTransport {
      lock.unlock()
      return hidTransport
    }
    lock.unlock()
    let simulator = self.simulator
    let transport: SimulatorHIDTransport
    do {
      transport = try runBlocking { try await SimulatorHIDTransport.negotiate(for: simulator, requested: nil) }
    } catch {
      throw HelperError.wrap(error, code: "sim_hid_unavailable")
    }
    lock.lock()
    hidTransport = transport
    lock.unlock()
    return transport
  }

  /// 把当前方向下的点换成 HID 用的竖屏点：数字化仪始终按设备竖放的坐标收触点。
  func unrotate(_ point: CGPoint) -> CGPoint {
    let size = portraitPointSize
    switch orientation {
    case .portrait:
      return point
    case .portraitUpsideDown:
      return CGPoint(x: size.width - point.x, y: size.height - point.y)
    case .landscapeRight:
      // 顺时针转过的设备：画面左上角对应竖屏的左下角。
      return CGPoint(x: point.y, y: size.height - point.x)
    case .landscapeLeft:
      return CGPoint(x: size.width - point.y, y: point.x)
    }
  }

  // MARK: - Orientation

  /// 设备可能已被别处（Simulator.app、上一个 helper）转过：读模拟器里的当前方向，变了就通知订阅者并发 `orientation` 事件。
  /// Xcode 27 起问 CoreDevice 的方向服务；更早的运行时读 backboardd 的 notify 状态（值同 UIDeviceOrientation）。
  /// 都读不到时沿用 helper 自己记的方向（起始按竖屏）。
  func syncOrientation() {
    guard let current = readOrientation() else { return }
    lock.lock()
    let changed = current != currentOrientation
    currentOrientation = current
    lock.unlock()
    if changed {
      framebuffer.orientationChanged(current)
      sendEvent("orientation", ["udid": udid, "orientation": current.rawValue])
    }
  }

  private func readOrientation() -> DeviceOrientation? {
    let simulator = self.simulator
    if let current = try? runBlocking({ try await SimulatorOrientationProtocol.read(on: simulator) }) {
      return current
    }
    var state: UInt64 = 0
    do {
      try FBObjCExceptionGuard.guarded {
        try simulator.device.darwinNotificationGetState(&state, name: "com.apple.backboardd.orientation")
      }
    } catch {
      return nil
    }
    switch state {
    case 1: return .portrait
    case 2: return .portraitUpsideDown
    case 3: return .landscapeLeft
    case 4: return .landscapeRight
    default: return nil // 0 unknown, 5/6 face up / down: keep the last known orientation.
    }
  }

  /// 旋转设备（GSEvent 发到 PurpleWorkspacePort），返回新方向。方向在 helper 里记：起始按竖屏算。
  func rotate(_ direction: String) throws -> DeviceOrientation {
    let next = orientation.rotated(direction)
    let purple = self.purple
    do {
      // Purple takes interface-style landscape numbers; BackBoard's physical device convention swaps them.
      try runBlocking { try await purple.sendOrientation(next.hidOrientation.physicalPurpleOrientation) }
    } catch {
      throw HelperError.wrap(error, code: "sim_hid_unavailable")
    }
    lock.lock()
    currentOrientation = next
    lock.unlock()
    framebuffer.orientationChanged(next)
    sendEvent("orientation", ["udid": udid, "orientation": next.rawValue])
    return next
  }

  func close() {
    lock.lock()
    let transport = hidTransport
    hidTransport = nil
    lock.unlock()
    transport?.disconnect()
    framebuffer.close()
  }
}
