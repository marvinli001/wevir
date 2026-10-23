// 线缆协议的公共部分：错误、JSON 行输出、参数读取、fd 3 的二进制帧。

import Foundation

/// 回给 Host 的错误：`code` 是线缆协议的错误码（`sim_*`），`message` 给模型与日志看。
struct HelperError: Error, CustomStringConvertible {
  let code: String
  let message: String

  var description: String { "\(code): \(message)" }

  static func invalid(_ message: String) -> HelperError {
    HelperError(code: "sim_invalid_argument", message: message)
  }

  /// 把移植代码抛出的各类错误归到线缆错误码。
  static func wrap(_ error: Error, code: String) -> HelperError {
    if let error = error as? HelperError { return error }
    let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    return HelperError(code: code, message: message)
  }
}

typealias JSON = [String: Any]

private let writeLock = NSLock()

/// 写一行 JSON 到 stdout（回答与事件共用）。
func send(_ object: JSON) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  data.append(0x0a)
  writeLock.lock()
  FileHandle.standardOutput.write(data)
  writeLock.unlock()
}

func sendEvent(_ name: String, _ fields: JSON = [:]) {
  var object = fields
  object["event"] = name
  send(object)
}

let log = StderrLogger(name: "ios-simulator", enabled: true)

// MARK: - 参数

extension Dictionary where Key == String, Value == Any {
  func string(_ key: String) throws -> String {
    guard let value = self[key] as? String, !value.isEmpty else { throw HelperError.invalid("\(key) is required") }
    return value
  }

  func optionalString(_ key: String) -> String? { self[key] as? String }

  func double(_ key: String) throws -> Double {
    guard let value = optionalDouble(key) else { throw HelperError.invalid("\(key) must be a number") }
    return value
  }

  func optionalDouble(_ key: String) -> Double? {
    guard let number = self[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let value = number.doubleValue
    return value.isFinite ? value : nil
  }

  func optionalBool(_ key: String) -> Bool? {
    guard let number = self[key] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  func array(_ key: String) -> [JSON]? { self[key] as? [JSON] }
}

// MARK: - fd 3 流通道

/// 帧格式：`u32 streamId | u8 kind | u64 ptsMicros | u32 length | bytes`，大端。
enum FrameKind: UInt8 {
  case config = 0
  case keyFrame = 1
  case frame = 2
  case resize = 3
}

/// fd 3 的写端。Host 没给 fd 3（或已关闭）时写入失败，流随之结束。
enum StreamChannel {
  private static let lock = NSLock()
  private static let handle = FileHandle(fileDescriptor: 3, closeOnDealloc: false)

  /// 启动时 fd 3 是否是 Host 给的管道（`stdio: ['pipe','pipe','pipe','pipe']`）。要在加载框架之前求值：
  /// 没给 fd 3 时框架可能打开别的文件占用这个号，不能往里写帧。
  static let isAvailable: Bool = {
    var info = stat()
    guard fstat(3, &info) == 0 else { return false }
    let type = info.st_mode & S_IFMT
    return type == S_IFIFO || type == S_IFSOCK
  }()

  @discardableResult
  static func write(streamId: UInt32, kind: FrameKind, ptsMicros: UInt64, payload: Data) -> Bool {
    var header = Data(capacity: 17)
    withUnsafeBytes(of: streamId.bigEndian) { header.append(contentsOf: $0) }
    header.append(kind.rawValue)
    withUnsafeBytes(of: ptsMicros.bigEndian) { header.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(payload.count).bigEndian) { header.append(contentsOf: $0) }
    lock.lock()
    defer { lock.unlock() }
    do {
      try handle.write(contentsOf: header)
      try handle.write(contentsOf: payload)
      return true
    } catch {
      return false
    }
  }
}
