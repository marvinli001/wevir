// 移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，版权见 LICENSE-facebook-idb.txt）：
// FBSimulatorVideo/Encoding/VideoToolboxEncoderSettings.swift、VideoToolboxFramePusher.swift、PixelBufferConverter.swift。
// 改动：只留 H.264（直播用低延迟码控，录像用标准码控）；三个类型合成一个；输出不经 idb 的 EncodedSampleConsumer，
// 直接把 CMSampleBuffer 交给调用方；加了按设备方向旋转（VTPixelRotationSession），idb 的帧缓冲只按竖屏编码。

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

enum VideoEncodeSink {
  case live
  case file
}

struct VideoColorDescription {
  let primaries: String
  let transferFunction: String
  let matrix: String

  /// What the encoder tags the stream with, and what the BGRA→NV12 conversion targets. The simulator
  /// framebuffer is sRGB (see `SurfaceImageGenerator`), so the stream is BT.709 primaries and matrix with
  /// the sRGB transfer function.
  static let sRGB = VideoColorDescription(
    primaries: kCVImageBufferColorPrimaries_ITU_R_709_2 as String,
    transferFunction: kCVImageBufferTransferFunction_sRGB as String,
    matrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2 as String)

  var compressionProperties: [String: Any] {
    [
      kVTCompressionPropertyKey_ColorPrimaries as String: primaries,
      kVTCompressionPropertyKey_TransferFunction as String: transferFunction,
      kVTCompressionPropertyKey_YCbCrMatrix as String: matrix,
    ]
  }

  var pixelTransferDestinationProperties: [String: Any] {
    [
      kVTPixelTransferPropertyKey_DestinationColorPrimaries as String: primaries,
      kVTPixelTransferPropertyKey_DestinationTransferFunction as String: transferFunction,
      kVTPixelTransferPropertyKey_DestinationYCbCrMatrix as String: matrix,
    ]
  }
}

/// One H.264 compression session at a fixed output size. Not thread-safe: the owner encodes from one queue.
final class H264Encoder: @unchecked Sendable {
  static let encoderPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

  let width: Int
  let height: Int
  private let sink: VideoEncodeSink
  private var session: VTCompressionSession?
  private var transferSession: VTPixelTransferSession?
  private var rotationSession: VTPixelRotationSession?
  private var pool: CVPixelBufferPool?
  private var rotationPool: CVPixelBufferPool?
  private let output: (CMSampleBuffer) -> Void

  /// `rotation` is the clockwise angle the framebuffer must turn to stand upright (0, 90, 180, 270);
  /// `width` × `height` is the size after rotating.
  init(
    width: Int, height: Int, rotation: Int, sink: VideoEncodeSink, fps: Double, averageBitRate: Int?,
    output: @escaping (CMSampleBuffer) -> Void
  ) throws {
    self.width = width
    self.height = height
    self.sink = sink
    self.output = output

    var transferSession: VTPixelTransferSession?
    var status = VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &transferSession)
    guard status == noErr, let transferSession else {
      throw HelperError(code: "sim_stream_failed", message: "Failed to create VTPixelTransferSession: \(status)")
    }
    VTSessionSetProperties(
      transferSession, propertyDictionary: VideoColorDescription.sRGB.pixelTransferDestinationProperties as CFDictionary)
    self.transferSession = transferSession
    pool = Self.makePool(width: width, height: height, pixelFormat: Self.encoderPixelFormat)

    if rotation != 0 {
      var rotationSession: VTPixelRotationSession?
      status = VTPixelRotationSessionCreate(kCFAllocatorDefault, &rotationSession)
      guard status == noErr, let rotationSession else {
        throw HelperError(code: "sim_stream_failed", message: "Failed to create VTPixelRotationSession: \(status)")
      }
      let angle: CFString =
        switch rotation {
        case 90: kVTRotation_CW90
        case 180: kVTRotation_180
        default: kVTRotation_CCW90
        }
      VTSessionSetProperty(rotationSession, key: kVTPixelRotationPropertyKey_Rotation, value: angle)
      self.rotationSession = rotationSession
      rotationPool = Self.makePool(width: width, height: height, pixelFormat: kCVPixelFormatType_32BGRA)
    }

    let attributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: Self.encoderPixelFormat,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    var session: VTCompressionSession?
    func create(_ specification: [String: Any]) -> OSStatus {
      VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
        encoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
        compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
    }
    status = create(Self.encoderSpecification(sink))
    if status != noErr {
      // Low-latency rate control and the hardware encoder are preferences; a software session still works.
      status = create([kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true])
    }
    guard status == noErr, let session else {
      throw HelperError(code: "sim_stream_failed", message: "Failed to start the H.264 compression session: \(status)")
    }
    status = VTSessionSetProperties(
      session,
      propertyDictionary: Self.sessionProperties(
        sink: sink, fps: fps, averageBitRate: averageBitRate ?? Self.automaticAverageBitRate(width: width, height: height))
        as CFDictionary)
    guard status == noErr else {
      throw HelperError(code: "sim_stream_failed", message: "Failed to set compression session properties: \(status)")
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    self.session = session
  }

  deinit {
    invalidate()
  }

  func invalidate() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
      self.session = nil
    }
    if let transferSession { VTPixelTransferSessionInvalidate(transferSession) }
    if let rotationSession { VTPixelRotationSessionInvalidate(rotationSession) }
    transferSession = nil
    rotationSession = nil
  }

  /// Copies the framebuffer into an encoder-owned NV12 buffer (rotating it upright on the way), so the simulator
  /// can keep drawing into its surface while the frame is encoded.
  func convert(_ surface: IOSurface) -> CVPixelBuffer? {
    var unmanaged: Unmanaged<CVPixelBuffer>?
    guard CVPixelBufferCreateWithIOSurface(nil, surface, nil, &unmanaged) == kCVReturnSuccess,
      var source = unmanaged?.takeRetainedValue()
    else { return nil }
    if let rotationSession, let rotationPool {
      var rotated: CVPixelBuffer?
      guard CVPixelBufferPoolCreatePixelBuffer(nil, rotationPool, &rotated) == kCVReturnSuccess, let rotated,
        VTPixelRotationSessionRotateImage(rotationSession, source, rotated) == noErr
      else { return nil }
      source = rotated
    }
    guard let pool, let transferSession else { return nil }
    var destination: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &destination) == kCVReturnSuccess, let destination,
      VTPixelTransferSessionTransferImage(transferSession, from: source, to: destination) == noErr
    else { return nil }
    return destination
  }

  func encode(_ buffer: CVPixelBuffer, time: CMTime, forceKeyFrame: Bool) throws {
    guard let session else {
      throw HelperError(code: "sim_stream_failed", message: "The compression session is closed")
    }
    let properties: CFDictionary? =
      forceKeyFrame ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil
    let output = self.output
    let status = VTCompressionSessionEncodeFrame(
      session, imageBuffer: buffer, presentationTimeStamp: time, duration: .invalid, frameProperties: properties,
      infoFlagsOut: nil
    ) { status, flags, sample in
      guard status == noErr, !flags.contains(.frameDropped), let sample else { return }
      output(sample)
    }
    if status != noErr {
      throw HelperError(code: "sim_stream_failed", message: "Failed to encode a frame: \(status)")
    }
  }

  func completeFrames() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    }
  }

  // MARK: - Settings

  private static func makePool(width: Int, height: Int, pixelFormat: OSType) -> CVPixelBufferPool? {
    let bufferAttributes: [String: Any] = [
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
      kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
    ]
    let poolAttributes: [String: Any] = [
      kCVPixelBufferPoolMinimumBufferCountKey as String: 4,
      kCVPixelBufferPoolAllocationThresholdKey as String: 16,
    ]
    var pool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(nil, poolAttributes as CFDictionary, bufferAttributes as CFDictionary, &pool)
    return pool
  }

  private static func encoderSpecification(_ sink: VideoEncodeSink) -> [String: Any] {
    switch sink {
    case .live:
      return [
        kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
        kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true,
      ]
    case .file:
      return [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true]
    }
  }

  /// The automatic rate control: about 4 bits per pixel per second, which keeps text on the simulator screen
  /// legible at its native resolution.
  static func automaticAverageBitRate(width: Int, height: Int) -> Int {
    width * height * 4
  }

  private static func sessionProperties(sink: VideoEncodeSink, fps: Double, averageBitRate: Int) -> [String: Any] {
    var properties: [String: Any] = [
      kVTCompressionPropertyKey_RealTime as String: true,
      // A keyframe at least every two seconds, so a lost frame or a late subscriber recovers quickly.
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration as String: 2.0,
      kVTCompressionPropertyKey_ExpectedFrameRate as String: fps,
      kVTCompressionPropertyKey_AllowFrameReordering as String: false,
      kVTCompressionPropertyKey_AverageBitRate as String: averageBitRate,
      // Bursts up to 1.5× the average over any one second.
      kVTCompressionPropertyKey_DataRateLimits as String: [averageBitRate * 3 / 16, 1],
      kVTCompressionPropertyKey_ProfileLevel as String: kVTProfileLevel_H264_High_AutoLevel as String,
      kVTCompressionPropertyKey_H264EntropyMode as String: kVTH264EntropyMode_CABAC as String,
    ]
    if case .live = sink {
      properties[kVTCompressionPropertyKey_MaxFrameDelayCount as String] = 0
    }
    properties.merge(VideoColorDescription.sRGB.compressionProperties) { _, color in color }
    return properties
  }
}
