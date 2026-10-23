// iOS 模拟器 helper 的入口：Host 拉起它（sandbox-exec 里），每行一个 JSON 请求 `{ id, cmd, udid?, ... }`，每行回一个
// `{ id, ok, result | error }`；另有不带 id 的事件 `{ event }`（`ready`、`stream_ended`、`orientation`）。视频帧走 fd 3。
// 同一台设备的命令在那台设备的串行队列上逐个执行（输入的先后与请求一致），不同设备、不涉及设备的命令互不等待。
// stdin 关闭（Host 退出）时退出。

import Foundation

private let work = DispatchQueue(label: "si.wevir.ios-simulator.work", attributes: .concurrent)
private let streamsLock = NSLock()
private var streams: [UInt32: StreamSession] = [:]
private var recordings: [String: Recording] = [:]
private var nextStreamId: UInt32 = 1

private func handle(_ line: Data) {
  guard let object = (try? JSONSerialization.jsonObject(with: line)) as? JSON, let id = object["id"] else { return }
  let cmd = object["cmd"] as? String ?? ""
  let reply: (Result<JSON, Error>) -> Void = { result in
    switch result {
    case let .success(value):
      send(["id": id, "ok": true, "result": value])
    case let .failure(error as HelperError):
      send(["id": id, "ok": false, "error": ["code": error.code, "message": error.message]])
    case let .failure(error):
      send(["id": id, "ok": false, "error": ["code": "sim_unknown_error", "message": String(describing: error)]])
    }
  }
  // 设备命令进那台设备的队列；流、录像的停止与关键帧不排在输入后面。
  let queue: DispatchQueue
  switch cmd {
  case "stream_stop", "keyframe", "record_stop":
    queue = work
  default:
    if let udid = object["udid"] as? String, !udid.isEmpty, let session = try? SimulatorRegistry.shared.session(udid) {
      queue = session.queue
    } else {
      queue = work
    }
  }
  queue.async {
    reply(Result { try dispatch(cmd: cmd, params: object) })
  }
}

private func session(_ params: JSON) throws -> DeviceSession {
  try SimulatorRegistry.shared.session(try params.string("udid"))
}

private func dispatch(cmd: String, params: JSON) throws -> JSON {
  switch cmd {
  case "describe_device":
    let session = try session(params)
    session.syncOrientation()
    return ["screen": session.screen, "orientation": session.orientation.rawValue]
  case "stream_start":
    let session = try session(params)
    let codec = params.optionalString("codec") ?? "h264"
    guard codec == "h264" else { throw HelperError.invalid("codec \(codec) is not supported") }
    guard StreamChannel.isAvailable else {
      throw HelperError(code: "sim_stream_failed", message: "fd 3 is not open for the video stream")
    }
    let fps = min(max(params.optionalDouble("fps") ?? 60, 1), 60)
    let maxBitrate = params.optionalDouble("maxBitrate").map { Int($0) }
    streamsLock.lock()
    let id = nextStreamId
    nextStreamId += 1
    streamsLock.unlock()
    session.syncOrientation()
    let stream = StreamSession(id: id, session: session, fps: fps, maxBitrate: maxBitrate)
    try stream.start()
    streamsLock.lock()
    streams[id] = stream
    streamsLock.unlock()
    return ["streamId": id]
  case "stream_stop":
    let stream = try takeStream(params)
    stream.stop()
    return [:]
  case "keyframe":
    guard let id = params.optionalDouble("streamId").map({ UInt32($0) }) else { throw HelperError.invalid("streamId is required") }
    streamsLock.lock()
    let stream = streams[id]
    streamsLock.unlock()
    guard let stream else { throw HelperError.invalid("no stream \(id)") }
    stream.requestKeyFrame()
    return [:]
  case "screenshot":
    let session = try session(params)
    session.syncOrientation()
    return try Screenshot.capture(session, params: params)
  case "record_start":
    let session = try session(params)
    let path = try params.string("path")
    let id = "rec_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    let recording = Recording(id: id, path: path, session: session)
    try recording.start()
    streamsLock.lock()
    recordings[id] = recording
    streamsLock.unlock()
    return ["recordingId": id]
  case "record_stop":
    let id = try params.string("recordingId")
    streamsLock.lock()
    let recording = recordings.removeValue(forKey: id)
    streamsLock.unlock()
    guard let recording else { throw HelperError.invalid("no recording \(id)") }
    return try recording.stop()
  case "tap":
    try Input.tap(try session(params), params: params)
    return [:]
  case "touch":
    try Input.touch(try session(params), params: params)
    return [:]
  case "touch_raw":
    try Input.touchRaw(try session(params), params: params)
    return [:]
  case "text":
    try Input.text(try session(params), params: params)
    return [:]
  case "key":
    try Input.key(try session(params), params: params)
    return [:]
  case "button":
    try Input.button(try session(params), params: params)
    return [:]
  case "rotate":
    let direction = try params.string("direction")
    guard direction == "left" || direction == "right" else { throw HelperError.invalid("direction must be left or right") }
    let session = try session(params)
    let orientation = try session.rotate(direction)
    return ["orientation": orientation.rawValue, "screen": session.screen]
  case "set_keyboard":
    try DeviceSettings.keyboard(try session(params), params: params)
    return [:]
  case "slow_animations":
    try DeviceSettings.slowAnimations(try session(params), params: params)
    return [:]
  case "ax_tree":
    return try Accessibility.tree(try session(params), params: params)
  case "foreground_app":
    return try DeviceSettings.foregroundApp(try session(params))
  default:
    throw HelperError.invalid("unknown cmd \(cmd)")
  }
}

private func takeStream(_ params: JSON) throws -> StreamSession {
  guard let id = params.optionalDouble("streamId").map({ UInt32($0) }) else { throw HelperError.invalid("streamId is required") }
  streamsLock.lock()
  defer { streamsLock.unlock() }
  guard let stream = streams.removeValue(forKey: id) else { throw HelperError.invalid("no stream \(id)") }
  return stream
}

/// 流因编码失败或 fd 3 关闭自己结束时，从表里拿掉。
func forgetStream(_ id: UInt32) {
  streamsLock.lock()
  streams[id] = nil
  streamsLock.unlock()
}

// fd 3 的读端关了时写入返回 EPIPE，不要因 SIGPIPE 退出。
signal(SIGPIPE, SIG_IGN)
_ = StreamChannel.isAvailable

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
      handle(Data(line))
    }
  }
}

var ready: JSON = ["version": "1"]
do {
  try SimulatorRegistry.shared.prepare()
  let registry = SimulatorRegistry.shared
  if let xcode = registry.xcodeVersion { ready["xcode"] = xcode }
  if let coreSimulator = registry.coreSimulatorVersion { ready["coreSimulator"] = coreSimulator }
  ready["hidTransport"] =
    SimulatorHIDTransportSelection.defaultTransport(coreSimulatorVersion: registry.coreSimulatorVersion) == .dtuhid
    ? "dtuhid" : "indigo"
} catch let error as HelperError {
  // 框架加载失败也发 ready，带上原因；之后的设备命令都回 sim_framework_missing。
  ready["error"] = ["code": error.code, "message": error.message]
} catch {
  ready["error"] = ["code": "sim_framework_missing", "message": String(describing: error)]
}
sendEvent("ready", ready)
RunLoop.main.run()
