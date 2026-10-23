// 电脑操作（0.112.0）的 macOS helper 的入口：桌面端主进程拉起它（所以系统的屏幕录制与辅助功能权限算在 Wevir.app 上），
// 每行一个 JSON 请求 `{ id, op, params }`，每行回一个 `{ id, ok, result | error }`；另有不带 id 的事件 `{ event }`（`ready`、
// 用户按了 Esc 的 `escape`）。stdin 关闭（主进程退出）时退出。请求在一个串行队列里逐个执行；主线程跑 RunLoop，供 Esc 的事件
// 监听与 NSWorkspace 的状态更新用。

import AppKit
import Foundation

/// 回给主进程的错误：`code` 是协议的 `COMPUTER_ERROR_CODES` 之一，`message` 给模型看。
struct HelperError: Error {
  let code: String
  let message: String

  static func invalid(_ message: String) -> HelperError {
    HelperError(code: "computer_invalid_argument", message: message)
  }
}

typealias JSON = [String: Any]

private let writeLock = NSLock()

func send(_ object: JSON) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  data.append(0x0a)
  writeLock.lock()
  FileHandle.standardOutput.write(data)
  writeLock.unlock()
}

/// 在主线程上取值（NSWorkspace、NSPasteboard 这类状态在主线程上更新）。
func onMain<T>(_ body: () throws -> T) rethrows -> T {
  if Thread.isMainThread { return try body() }
  return try DispatchQueue.main.sync(execute: body)
}

private let work = DispatchQueue(label: "si.wevir.computer-use.work")

private func handle(_ line: Data) {
  guard let object = (try? JSONSerialization.jsonObject(with: line)) as? JSON,
    let id = object["id"]
  else { return }
  let op = object["op"] as? String ?? ""
  let params = object["params"] as? JSON ?? [:]
  do {
    let result = try dispatch(op: op, params: params)
    send(["id": id, "ok": true, "result": result])
  } catch let error as HelperError {
    send(["id": id, "ok": false, "error": ["code": error.code, "message": error.message]])
  } catch {
    send([
      "id": id, "ok": false,
      "error": ["code": "computer_unknown_error", "message": String(describing: error)],
    ])
  }
}

private func dispatch(op: String, params: JSON) throws -> JSON {
  switch op {
  case "status": return Permissions.status()
  case "request_permission": return try Permissions.request(params)
  case "list_apps": return try Apps.list(params)
  case "resolve_apps": return try Apps.resolve(params)
  case "open_app": return try Apps.open(params)
  case "frontmost": return Apps.frontmostInfo()
  case "screenshot": return try Capture.screenshot(params)
  case "ax_tree": return try Accessibility.tree(params)
  case "ax_find": return try Accessibility.find(params)
  case "forget_scope": return Accessibility.forget(params)
  case "click": return try Input.click(params)
  case "type": return try Input.type(params)
  case "key": return try Input.key(params)
  case "scroll": return try Input.scroll(params)
  case "drag": return try Input.drag(params)
  case "set_value": return try Input.setValue(params)
  case "clipboard_read": return try Clipboard.read(params)
  case "clipboard_write": return try Clipboard.write(params)
  case "watch_escape": return try EscapeWatch.set(params)
  default: throw HelperError.invalid("unknown op \(op)")
  }
}

Thread.detachNewThread {
  var buffer = Data()
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { exit(0) }
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0a) {
      let line = buffer[buffer.startIndex..<newline]
      buffer.removeSubrange(buffer.startIndex...newline)
      if line.isEmpty { continue }
      let copy = Data(line)
      work.async { handle(copy) }
    }
  }
}

let version = ProcessInfo.processInfo.operatingSystemVersion
send([
  "event": "ready",
  "macos": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
  "pid": Int(getpid()),
])
RunLoop.main.run()
