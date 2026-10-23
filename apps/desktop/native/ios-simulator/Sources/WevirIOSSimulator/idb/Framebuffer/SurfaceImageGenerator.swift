/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// 移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，见 LICENSE-facebook-idb.txt）：FBSimulatorControl/Framebuffer/SurfaceImageGenerator.swift。
// 改动：去掉 public / package 与 FBControlCore 的 import；image 只按输出尺寸缩放，不带 ScreenshotConfiguration。

import CoreImage
import Foundation
import IOSurface

/// A render of a simulator surface, and the size of the surface it was cut from.
struct SurfaceImage: Sendable {
  let image: CGImage
  /// The surface's size in pixels, before any crop or scale was applied.
  let sourceSize: CGSize
}

/// Renders the latest simulator IOSurface to a `CGImage`. Not thread-safe by itself: it is owned and
/// confined by the `SimulatorImage` actor, which serializes `updateSurface` and `image()`.
final class SurfaceImageGenerator {

  private static let screenshotColorSpace = CGColorSpace(name: CGColorSpace.sRGB)
  private let logger: (any ControlCoreLogger)?
  /// Created once and reused across renders: CIContext construction is expensive (it builds a GPU
  /// pipeline) and the context carries no per-image state.
  private let context = CIContext(options: nil)

  private var surface: IOSurface?

  init(logger: (any ControlCoreLogger)?) {
    self.logger = logger
  }

  deinit {
    surface?.decrementUseCount()
  }

  /// Renders the whole surface at its native resolution.
  /// The current surface rendered at `outputSize` (pixels), or at its own size when nil. Nil when no
  /// surface has been mounted yet.
  func image(outputSize: ((CGSize) -> CGSize)? = nil) throws -> SurfaceImage? {
    guard let surface = self.surface else {
      return nil
    }
    guard let colorSpace = Self.screenshotColorSpace else {
      throw HelperError(code: "sim_unknown_error", message: "Could not create the sRGB color space")
    }
    // CoreSimulator screenshots interpret framebuffer samples as sRGB, even when the surface is tagged P3.
    let source = CIImage(ioSurface: unsafeBitCast(surface, to: IOSurfaceRef.self), options: [.colorSpace: colorSpace])
    let sourceSize = source.extent.size
    let size = outputSize?(sourceSize) ?? sourceSize
    guard let image = render(source, outputSize: CGSize(width: size.width.rounded(), height: size.height.rounded())) else {
      return nil
    }
    return SurfaceImage(image: image, sourceSize: sourceSize)
  }

  // MARK: - Rendering

  /// Scales `source` to `outputSize`, then reads the result out at exactly that size.
  private func render(_ source: CIImage, outputSize: CGSize) -> CGImage? {
    var image = source
    // Move the region to the origin, so that neither the scale below nor the read-out at the end has
    // to account for where in the surface it came from.
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    if image.extent.size != outputSize {
      guard let scaled = Self.scaled(image, from: image.extent.size, to: outputSize) else {
        return nil
      }
      image = scaled
    }
    // Read out the requested size rather than the extent. Each side has already been rounded to a
    // whole pixel, and the filter only reproduces that to within floating point.
    return context.createCGImage(image, from: CGRect(origin: .zero, size: outputSize))
  }

  /// Both sizes are guarded: a zero side would become an infinite/NaN scale the filter accepts silently.
  private static func scaled(_ image: CIImage, from size: CGSize, to outputSize: CGSize) -> CIImage? {
    guard size.width > 0, size.height > 0, outputSize.width > 0, outputSize.height > 0,
      let filter = CIFilter(name: "CILanczosScaleTransform")
    else {
      return nil
    }
    // The filter scales y by `inputScale` and x by `inputScale * inputAspectRatio`. Both are derived
    // from the planned output size rather than taken from the plan's scale factor, so the extent
    // lands on the whole pixels the plan already committed to instead of half a pixel either side.
    let yScale = outputSize.height / size.height
    filter.setValue(image, forKey: kCIInputImageKey)
    filter.setValue(yScale, forKey: "inputScale")
    filter.setValue((outputSize.width / size.width) / yScale, forKey: "inputAspectRatio")
    return filter.outputImage
  }

  func updateSurface(_ surface: IOSurface?) {
    if let oldSurface = self.surface {
      logger?.debug().log("Removing old surface \(oldSurface)")
      oldSurface.decrementUseCount()
      self.surface = nil
    }
    if let surface {
      surface.incrementUseCount()
      logger?.debug().log("Received IOSurface from Framebuffer Service \(surface)")
      self.surface = surface
    }
  }
}
