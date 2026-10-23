// 移植的 idb 代码（idb/ 目录）依赖 FBControlCore 与 FBSimulatorControl 的少数类型；这里用最小的实现顶替，名字与签名照
// facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT）里的同名类型，好让移植文件尽量保持原样。
// 不带 FBControlCore 本身：它的日志、事件、目标状态机这些 helper 用不上。

import CoreSimulator
import Foundation

// MARK: - Logging（FBControlCore/Logging 的最小替身：只写 stderr）

protocol ControlCoreLogger: Sendable {
  var name: String? { get }
  func log(_ message: String)
  func info() -> any ControlCoreLogger
  func debug() -> any ControlCoreLogger
  func withName(_ name: String) -> any ControlCoreLogger
}

struct StderrLogger: ControlCoreLogger {
  let name: String?
  let enabled: Bool

  func log(_ message: String) {
    guard enabled else { return }
    let line = "[\(name ?? "ios-simulator")] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
  }

  func info() -> any ControlCoreLogger { self }

  /// debug 级别默认不输出；`WEVIR_IOS_SIMULATOR_DEBUG=1` 时输出。
  func debug() -> any ControlCoreLogger {
    StderrLogger(name: name, enabled: enabled && ProcessInfo.processInfo.environment["WEVIR_IOS_SIMULATOR_DEBUG"] == "1")
  }

  func withName(_ name: String) -> any ControlCoreLogger { StderrLogger(name: name, enabled: enabled) }
}

enum ControlCoreGlobalConfiguration {
  static let defaultLogger: any ControlCoreLogger = StderrLogger(name: nil, enabled: true)
}

enum CollectionInformation {
  static func oneLineDescription(from values: [Any]) -> String {
    "[" + values.map { String(describing: $0) }.joined(separator: ", ") + "]"
  }
}

// MARK: - Target state（FBControlCore 的 TargetState，取值与 -[SimDevice state] 相同）

enum TargetState: UInt, Sendable {
  case creating = 0
  case shutdown = 1
  case booting = 2
  case booted = 3
  case shuttingDown = 4
  case dfu = 5
  case recovery = 6
  case restoring = 7
  case unknown = 99

  var stateString: String {
    switch self {
    case .creating: "Creating"
    case .shutdown: "Shutdown"
    case .booting: "Booting"
    case .booted: "Booted"
    case .shuttingDown: "Shutting Down"
    case .dfu: "DFU"
    case .recovery: "Recovery"
    case .restoring: "Restoring"
    case .unknown: "Unknown"
    }
  }
}

enum ProductFamily: Sendable {
  case iPhone
  case iPad
  case appleTV
  case appleWatch
  case vision
  case unknown

  /// `-[SimDeviceType productFamilyID]`：1 iPhone、2 iPad、3 Apple TV、4 Apple Watch、7 Vision。
  init(productFamilyID: Int32) {
    switch productFamilyID {
    case 1: self = .iPhone
    case 2: self = .iPad
    case 3: self = .appleTV
    case 4: self = .appleWatch
    case 7: self = .vision
    default: self = .unknown
    }
  }
}

enum WeakTargetError: Error, LocalizedError {
  case simulator

  var errorDescription: String? { "The simulator has been released" }
}

// MARK: - Simulator（FBSimulatorControl 的 Simulator 只取移植代码用到的几个成员）

final class Simulator: @unchecked Sendable {
  let device: SimDevice
  let logger: any ControlCoreLogger
  let productFamily: ProductFamily
  let workQueue = DispatchQueue(label: "si.wevir.ios-simulator.simulator")

  init(device: SimDevice, logger: any ControlCoreLogger) {
    self.device = device
    self.logger = logger
    self.productFamily = ProductFamily(productFamilyID: device.deviceType?.productFamilyID ?? 0)
  }

  var udid: String { device.udid.uuidString }

  var state: TargetState { TargetState(rawValue: UInt(device.state)) ?? .unknown }

  var xpc: SimulatorXPCConnector { SimulatorXPCConnector.simulator(self) }
}

/// FBControlCore/Async/AsyncPolling 的替身：每 100 毫秒在 `queue` 上求一次 `condition`，为真时返回，超时抛错。
func pollUntilTrue(on queue: DispatchQueue, timeout: TimeInterval = 120, _ condition: @escaping () -> Bool) async throws {
  let deadline = Date().addingTimeInterval(timeout)
  while true {
    if await queue.perform(condition) { return }
    if Date() > deadline { throw HelperError(code: "sim_timeout", message: "Timed out waiting for the simulator") }
    try await Task.sleep(nanoseconds: 100_000_000)
  }
}

// MARK: - Framework loading（FBControlCore 的 WeakFramework / FrameworkLoader 的最小替身）

protocol FrameworkLoading {
  func loadPrivateFrameworks(_ logger: (any ControlCoreLogger)?) throws
}

enum SimulatorControlFrameworkLoader {
  static let essentialFrameworks: any FrameworkLoading = PrivateFrameworks.coreSimulator
  static let xcodeFrameworks: any FrameworkLoading = PrivateFrameworks.simulatorKit
  static let accessibilityFrameworks: any FrameworkLoading = PrivateFrameworks.accessibilityPlatformTranslation
}

enum PrivateFrameworks: FrameworkLoading {
  case coreSimulator
  case simulatorKit
  case accessibilityPlatformTranslation

  /// 选中的 Xcode 的 Developer 目录：`DEVELOPER_DIR`，否则 `xcode-select -p`。
  static let developerDirectory: String? = {
    if let path = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !path.isEmpty {
      return path
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    process.waitUntilExit()
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return process.terminationStatus == 0 && !output.isEmpty ? output : nil
  }()

  var path: String? {
    switch self {
    case .coreSimulator:
      return "/Library/Developer/PrivateFrameworks/CoreSimulator.framework"
    case .accessibilityPlatformTranslation:
      return "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework"
    case .simulatorKit:
      // Xcode 27 把 SimulatorKit 从 Contents/Developer/Library/PrivateFrameworks 移到了 Contents/SharedFrameworks。
      guard let developer = Self.developerDirectory else { return nil }
      let shared = ((developer as NSString).appendingPathComponent("../SharedFrameworks/SimulatorKit.framework") as NSString)
        .standardizingPath
      if FileManager.default.fileExists(atPath: shared) { return shared }
      return (developer as NSString).appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework")
    }
  }

  func loadPrivateFrameworks(_ logger: (any ControlCoreLogger)?) throws {
    guard let path, let bundle = Bundle(path: path) else {
      throw HelperError(code: "sim_framework_missing", message: "\(self) is not installed (is Xcode selected?)")
    }
    if bundle.isLoaded { return }
    do {
      try bundle.loadAndReturnError()
    } catch {
      throw HelperError(code: "sim_framework_missing", message: "Failed to load \(path): \(error.localizedDescription)")
    }
    logger?.debug().log("Loaded \(path)")
  }
}
