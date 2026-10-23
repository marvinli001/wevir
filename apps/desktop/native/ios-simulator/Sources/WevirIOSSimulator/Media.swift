// 画面：帧缓冲的订阅（FramebufferHub）、截图、H.264 流（fd 3）与 mp4 录像。

import AVFoundation
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

/// 收帧的一方：流与录像。回调在 hub 的串行队列上来，要快、不阻塞。
protocol FrameConsumer: AnyObject {
  func frameRendered(surface: IOSurface)
  func orientationChanged(_ orientation: DeviceOrientation, surface: IOSurface?)
}

/// 一台设备的主屏帧缓冲：有订阅者时挂着 Framebuffer，记住当前 IOSurface，把每次出帧分发给订阅者。
final class FramebufferHub: @unchecked Sendable {
  private let simulator: Simulator
  private let queue = DispatchQueue(label: "si.wevir.ios-simulator.framebuffer", qos: .userInteractive)
  private var attachment: FramebufferAttachment?
  private var eventTask: Task<Void, Never>?
  private var surface: IOSurface?
  private var consumers: [ObjectIdentifier: FrameConsumer] = [:]
  private var orientation: DeviceOrientation = .portrait
  /// 只为截图挂上的时刻；没有订阅者时 10 秒后摘掉。
  private var idleDetach: DispatchWorkItem?

  init(simulator: Simulator) {
    self.simulator = simulator
  }

  func add(_ consumer: FrameConsumer) throws {
    try queue.sync {
      try attachIfNeeded()
      consumers[ObjectIdentifier(consumer)] = consumer
      idleDetach?.cancel()
      idleDetach = nil
      consumer.orientationChanged(orientation, surface: surface)
      if let surface { consumer.frameRendered(surface: surface) }
    }
  }

  func remove(_ consumer: FrameConsumer) {
    queue.sync {
      consumers[ObjectIdentifier(consumer)] = nil
      scheduleIdleDetach()
    }
  }

  /// 当前画面的 IOSurface；没挂着时先挂上，最多等 `timeout` 秒等第一帧。
  func currentSurface(timeout: TimeInterval = 3) throws -> IOSurface {
    let deadline = Date().addingTimeInterval(timeout)
    try queue.sync {
      try attachIfNeeded()
      scheduleIdleDetach()
    }
    while true {
      if let surface = queue.sync(execute: { self.surface }) { return surface }
      if Date() > deadline {
        throw HelperError(code: "sim_stream_failed", message: "The simulator did not report a framebuffer surface")
      }
      Thread.sleep(forTimeInterval: 0.02)
    }
  }

  func orientationChanged(_ orientation: DeviceOrientation) {
    queue.async {
      self.orientation = orientation
      for consumer in self.consumers.values {
        consumer.orientationChanged(orientation, surface: self.surface)
      }
    }
  }

  func close() {
    queue.sync {
      consumers = [:]
      detach()
    }
  }

  private func attachIfNeeded() throws {
    guard attachment == nil else { return }
    let attachment: FramebufferAttachment
    do {
      attachment = try Framebuffer.mainScreenSurface(for: simulator, logger: simulator.logger).attach()
    } catch {
      throw HelperError.wrap(error, code: "sim_stream_failed")
    }
    self.attachment = attachment
    if let initial = attachment.initialSurface {
      surface = initial
    }
    let queue = self.queue
    eventTask = Task.detached { [weak self] in
      for await event in attachment.events {
        queue.async { self?.handle(event) }
      }
    }
  }

  private func handle(_ event: FramebufferEvent) {
    switch event {
    case let .surfaceChanged(surface):
      self.surface = surface
      if let surface {
        for consumer in consumers.values { consumer.frameRendered(surface: surface) }
      }
    case .frameRendered:
      guard let surface else { return }
      for consumer in consumers.values { consumer.frameRendered(surface: surface) }
    }
  }

  private func scheduleIdleDetach() {
    guard consumers.isEmpty else { return }
    idleDetach?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self, self.consumers.isEmpty else { return }
      self.detach()
    }
    idleDetach = item
    queue.asyncAfter(deadline: .now() + 10, execute: item)
  }

  private func detach() {
    attachment?.cancel()
    attachment = nil
    eventTask?.cancel()
    eventTask = nil
    surface = nil
  }
}

/// 帧缓冲转到设备方向要顺时针转的角度。帧缓冲按设备竖放的方向出图，横屏时 iOS 只是把内容画成横的。
func uprightRotation(for orientation: DeviceOrientation) -> Int {
  switch orientation {
  case .portrait: 0
  case .landscapeRight: 90
  case .portraitUpsideDown: 180
  case .landscapeLeft: 270
  }
}

private func rotatedSize(width: Int, height: Int, rotation: Int) -> (Int, Int) {
  rotation == 90 || rotation == 270 ? (height, width) : (width, height)
}

// MARK: - Screenshot

enum Screenshot {
  /// `format` png|jpeg，`quality` 0–1（jpeg），`scale` 相对点尺寸（1 = 点，2 = 两倍），默认 1；
  /// 给了 `path` 就写文件并回 `path`，否则回 `base64`。
  static func capture(_ session: DeviceSession, params: JSON) throws -> JSON {
    let format = params.optionalString("format") ?? "png"
    guard format == "png" || format == "jpeg" else { throw HelperError.invalid("format must be png or jpeg") }
    let scale = params.optionalDouble("scale") ?? 1
    guard scale > 0, scale <= 4 else { throw HelperError.invalid("scale must be in (0, 4]") }
    let surface = try session.framebuffer.currentSurface()
    let rotation = uprightRotation(for: session.orientation)
    let generator = SurfaceImageGenerator(logger: nil)
    generator.updateSurface(surface)
    let deviceScale = session.scale
    guard
      let rendered = try generator.image(outputSize: { source in
        CGSize(width: source.width / deviceScale * scale, height: source.height / deviceScale * scale)
      })
    else {
      throw HelperError(code: "sim_stream_failed", message: "Failed to render the framebuffer")
    }
    let image = rotation == 0 ? rendered.image : rotate(rendered.image, by: rotation)
    let type = format == "png" ? UTType.png : UTType.jpeg
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
      throw HelperError(code: "sim_unknown_error", message: "Failed to create the image encoder")
    }
    var options: [CFString: Any] = [:]
    if format == "jpeg" { options[kCGImageDestinationLossyCompressionQuality] = params.optionalDouble("quality") ?? 0.85 }
    CGImageDestinationAddImage(destination, image, options as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw HelperError(code: "sim_unknown_error", message: "Failed to encode the screenshot")
    }
    var result: JSON = ["width": image.width, "height": image.height]
    if let path = params.optionalString("path"), !path.isEmpty {
      do {
        try (data as Data).write(to: URL(fileURLWithPath: path), options: .atomic)
      } catch {
        throw HelperError(code: "sim_invalid_argument", message: "Cannot write \(path): \(error.localizedDescription)")
      }
      result["path"] = path
    } else {
      result["base64"] = (data as Data).base64EncodedString()
    }
    return result
  }

  private static func rotate(_ image: CGImage, by rotation: Int) -> CGImage {
    // EXIF orientations: 6 = rotate 90° clockwise to display, 3 = 180°, 8 = 90° counter-clockwise.
    let exif: Int32 = rotation == 90 ? 6 : rotation == 180 ? 3 : 8
    let oriented = CIImage(cgImage: image).oriented(forExifOrientation: exif)
    let context = CIContext(options: nil)
    return context.createCGImage(oriented, from: oriented.extent) ?? image
  }
}

// MARK: - Stream

/// 一路 H.264 流：帧缓冲每出一帧就编码（不超过 `fps`），编好的帧按线缆格式写到 fd 3。画面不动时不出帧。
final class StreamSession: FrameConsumer, @unchecked Sendable {
  let id: UInt32
  let session: DeviceSession
  private let fps: Double
  private let maxBitrate: Int?
  private let queue = DispatchQueue(label: "si.wevir.ios-simulator.stream", qos: .userInteractive)
  private var encoder: H264Encoder?
  private var encoderRotation = -1
  private var surface: IOSurface?
  private var orientation: DeviceOrientation = .portrait
  private var lastEncode: TimeInterval = 0
  private var pendingEncode = false
  private var forceKeyFrame = true
  private var lastConfig: Data?
  private let startUptime = ProcessInfo.processInfo.systemUptime
  private var stopped = false
  // 码率与帧率统计（stderr 每 5 秒一行，冒烟测试读它）。
  private var statFrames = 0
  private var statBytes = 0
  private var statStart = ProcessInfo.processInfo.systemUptime

  init(id: UInt32, session: DeviceSession, fps: Double, maxBitrate: Int?) {
    self.id = id
    self.session = session
    self.fps = fps
    self.maxBitrate = maxBitrate
  }

  func start() throws {
    try session.framebuffer.add(self)
  }

  /// Host 要求停流（`stream_stop`）。
  func stop() {
    session.framebuffer.remove(self)
    queue.sync { finish() }
  }

  /// 流自己结束（编码失败、fd 3 关了）：在流的队列上调，发 `stream_ended`。
  private func end(reason: String) {
    guard !stopped else { return }
    finish()
    forgetStream(id)
    let hub = session.framebuffer
    DispatchQueue.global().async { hub.remove(self) }
    sendEvent("stream_ended", ["udid": session.udid, "streamId": id, "reason": reason])
  }

  private func finish() {
    stopped = true
    encoder?.invalidate()
    encoder = nil
  }

  /// 下一帧强制为关键帧（并重发配置）；画面不动时立即用当前画面编一帧。
  func requestKeyFrame() {
    queue.async {
      self.forceKeyFrame = true
      self.lastConfig = nil
      self.encodeNow()
    }
  }

  func frameRendered(surface: IOSurface) {
    queue.async {
      self.surface = surface
      self.scheduleEncode()
    }
  }

  func orientationChanged(_ orientation: DeviceOrientation, surface: IOSurface?) {
    queue.async {
      self.orientation = orientation
      if let surface { self.surface = surface }
      self.forceKeyFrame = true
      self.scheduleEncode()
    }
  }

  private func scheduleEncode() {
    guard !stopped, !pendingEncode else { return }
    let interval = 1 / fps
    let now = ProcessInfo.processInfo.systemUptime
    let wait = lastEncode + interval - now
    if wait <= 0 {
      encodeNow()
    } else {
      // 节流：这一帧推迟到下一个时隙，期间到达的帧并进这一帧，最后一帧总会编出来。
      pendingEncode = true
      queue.asyncAfter(deadline: .now() + wait) {
        self.pendingEncode = false
        self.encodeNow()
      }
    }
  }

  private func encodeNow() {
    guard !stopped, let surface else { return }
    let rotation = uprightRotation(for: orientation)
    do {
      if encoder == nil || rotation != encoderRotation || encoder.map({ !matches($0, surface, rotation) }) == true {
        try rebuildEncoder(surface: surface, rotation: rotation)
      }
      guard let encoder, let buffer = encoder.convert(surface) else { return }
      let now = ProcessInfo.processInfo.systemUptime
      lastEncode = now
      let time = CMTime(value: CMTimeValue((now - startUptime) * 1_000_000), timescale: 1_000_000)
      try encoder.encode(buffer, time: time, forceKeyFrame: forceKeyFrame)
      forceKeyFrame = false
    } catch {
      log.log("stream \(id): \(error)")
      end(reason: "encoder_failed")
    }
  }

  private func matches(_ encoder: H264Encoder, _ surface: IOSurface, _ rotation: Int) -> Bool {
    let (width, height) = rotatedSize(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), rotation: rotation)
    return encoder.width == width && encoder.height == height
  }

  private func rebuildEncoder(surface: IOSurface, rotation: Int) throws {
    let hadEncoder = encoder != nil
    encoder?.invalidate()
    let (width, height) = rotatedSize(width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), rotation: rotation)
    let id = self.id
    let startTime = startUptime
    encoder = try H264Encoder(
      width: width, height: height, rotation: rotation, sink: .live, fps: fps, averageBitRate: maxBitrate
    ) { [weak self] sample in
      self?.emit(sample, startTime: startTime)
    }
    encoderRotation = rotation
    forceKeyFrame = true
    lastConfig = nil
    if hadEncoder {
      let resize: JSON = ["width": width, "height": height, "orientation": orientation.rawValue]
      let payload = (try? JSONSerialization.data(withJSONObject: resize)) ?? Data()
      let pts = UInt64(max(0, ProcessInfo.processInfo.systemUptime - startTime) * 1_000_000)
      if !StreamChannel.write(streamId: id, kind: .resize, ptsMicros: pts, payload: payload) {
        queue.async { self.end(reason: "stream_channel_closed") }
      }
    }
  }

  /// 编码器回调（VideoToolbox 的线程）：先在配置变了时发 avcC，再发帧（AVCC 长度前缀的 NAL 单元）。
  private func emit(_ sample: CMSampleBuffer, startTime: TimeInterval) {
    guard let data = Self.payload(of: sample) else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    let micros = pts.isValid ? UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000) : 0
    let keyFrame = Self.isKeyFrame(sample)
    queue.async {
      guard !self.stopped else { return }
      var ok = true
      if keyFrame, let config = Self.avcC(of: sample), config != self.lastConfig {
        self.lastConfig = config
        ok = StreamChannel.write(streamId: self.id, kind: .config, ptsMicros: micros, payload: config)
      }
      ok = ok && StreamChannel.write(streamId: self.id, kind: keyFrame ? .keyFrame : .frame, ptsMicros: micros, payload: data)
      if !ok {
        self.end(reason: "stream_channel_closed")
        return
      }
      self.recordStats(bytes: data.count)
    }
  }

  private func recordStats(bytes: Int) {
    statFrames += 1
    statBytes += bytes
    let now = ProcessInfo.processInfo.systemUptime
    if now - statStart >= 5 {
      let seconds = now - statStart
      log.log(
        String(
          format: "stream %u: %.1f fps, %.2f Mbit/s", id, Double(statFrames) / seconds,
          Double(statBytes) * 8 / seconds / 1_000_000))
      statFrames = 0
      statBytes = 0
      statStart = now
    }
  }

  static func isKeyFrame(_ sample: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
      let first = attachments.first
    else { return true }
    return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
  }

  static func avcC(of sample: CMSampleBuffer) -> Data? {
    guard let format = CMSampleBufferGetFormatDescription(sample),
      let atoms = CMFormatDescriptionGetExtension(
        format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any]
    else { return nil }
    return atoms["avcC"] as? Data
  }

  static func payload(of sample: CMSampleBuffer) -> Data? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let length = CMBlockBufferGetDataLength(block)
    var data = Data(count: length)
    let status = data.withUnsafeMutableBytes { buffer in
      CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: buffer.baseAddress!)
    }
    return status == kCMBlockBufferNoErr ? data : nil
  }
}

// MARK: - Recording

/// 录 mp4：同一个编码器（标准码控），H.264 直通写进 AVAssetWriter。画面不动时不出帧，停止时补一帧让时长对上。
final class Recording: FrameConsumer, @unchecked Sendable {
  let id: String
  let path: String
  let session: DeviceSession
  private let queue = DispatchQueue(label: "si.wevir.ios-simulator.recording")
  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var encoder: H264Encoder?
  private var encoderRotation = -1
  private var surface: IOSurface?
  private var orientation: DeviceOrientation = .portrait
  private var lastBuffer: CVPixelBuffer?
  private var lastEncode: TimeInterval = 0
  private var pending = false
  private let startUptime = ProcessInfo.processInfo.systemUptime
  private var failure: Error?
  private static let fps = 60.0

  init(id: String, path: String, session: DeviceSession) {
    self.id = id
    self.path = path
    self.session = session
  }

  func start() throws {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)
    do {
      writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    } catch {
      throw HelperError(code: "sim_invalid_argument", message: "Cannot record to \(path): \(error.localizedDescription)")
    }
    try session.framebuffer.add(self)
  }

  func stop() throws -> JSON {
    session.framebuffer.remove(self)
    let durationMs = Int((ProcessInfo.processInfo.systemUptime - startUptime) * 1000)
    let done = DispatchSemaphore(value: 0)
    var result: Result<Void, Error> = .success(())
    queue.async {
      // 停止时刻补一帧最后的画面，文件时长才等于录制时长。
      if let encoder = self.encoder, let last = self.lastBuffer {
        try? encoder.encode(last, time: self.time(ProcessInfo.processInfo.systemUptime), forceKeyFrame: false)
      }
      self.encoder?.completeFrames()
      self.queue.async {
        guard let writer = self.writer, let input = self.input, writer.status == .writing else {
          result = .failure(
            self.failure
              ?? HelperError(code: "sim_stream_failed", message: "No frame was recorded"))
          self.writer?.cancelWriting()
          done.signal()
          return
        }
        input.markAsFinished()
        writer.finishWriting {
          if writer.status != .completed {
            result = .failure(
              HelperError(code: "sim_stream_failed", message: writer.error?.localizedDescription ?? "Failed to finish the recording"))
          }
          done.signal()
        }
      }
    }
    done.wait()
    queue.sync {
      encoder?.invalidate()
      encoder = nil
    }
    try result.get()
    return ["path": path, "durationMs": durationMs]
  }

  func frameRendered(surface: IOSurface) {
    queue.async {
      self.surface = surface
      self.schedule()
    }
  }

  func orientationChanged(_ orientation: DeviceOrientation, surface: IOSurface?) {
    queue.async {
      self.orientation = orientation
      if let surface { self.surface = surface }
      self.schedule()
    }
  }

  private func time(_ uptime: TimeInterval) -> CMTime {
    CMTime(value: CMTimeValue((uptime - startUptime) * 1_000_000), timescale: 1_000_000)
  }

  private func schedule() {
    guard !pending else { return }
    let wait = lastEncode + 1 / Self.fps - ProcessInfo.processInfo.systemUptime
    if wait <= 0 {
      encodeNow()
    } else {
      pending = true
      queue.asyncAfter(deadline: .now() + wait) {
        self.pending = false
        self.encodeNow()
      }
    }
  }

  private func encodeNow() {
    guard failure == nil, let surface else { return }
    let rotation = uprightRotation(for: orientation)
    do {
      if encoder == nil {
        // mp4 里只有一路固定尺寸的视频：录制中途旋转时按开始时的尺寸继续（画面被缩放进去）。
        let (width, height) = rotatedSize(
          width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), rotation: rotation)
        encoder = try H264Encoder(
          width: width, height: height, rotation: rotation, sink: .file, fps: Self.fps, averageBitRate: nil
        ) { [weak self] sample in
          self?.append(sample)
        }
        encoderRotation = rotation
      }
      guard let encoder, let buffer = encoder.convert(surface) else { return }
      lastBuffer = buffer
      let now = ProcessInfo.processInfo.systemUptime
      lastEncode = now
      try encoder.encode(buffer, time: time(now), forceKeyFrame: false)
    } catch {
      failure = error
    }
  }

  /// 编码器回调：第一帧到来时按它的格式建写入端（直通，不再转码）。
  private func append(_ sample: CMSampleBuffer) {
    queue.async {
      guard let writer = self.writer else { return }
      if self.input == nil {
        let input = AVAssetWriterInput(
          mediaType: .video, outputSettings: nil, sourceFormatHint: CMSampleBufferGetFormatDescription(sample))
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
          self.failure = HelperError(code: "sim_stream_failed", message: "The recording cannot take an H.264 track")
          return
        }
        writer.add(input)
        self.input = input
        guard writer.startWriting() else {
          self.failure = HelperError(
            code: "sim_stream_failed", message: writer.error?.localizedDescription ?? "Failed to start the recording")
          return
        }
        writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sample))
      }
      guard let input = self.input, input.isReadyForMoreMediaData, writer.status == .writing else { return }
      input.append(sample)
    }
  }
}
