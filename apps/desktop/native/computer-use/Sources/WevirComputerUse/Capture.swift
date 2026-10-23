// 截图（ScreenCaptureKit 的 SCScreenshotManager，macOS 14 起）。三种：
// - 整块屏幕：只含批准过的应用的窗口（`pids`），别的应用、Wevir 自己与桌面都不在图里；
// - 一个窗口（`windowId`）：desktopIndependentWindow，被挡住或不在前台也截得到，供按窗口在后台操作；
// - 区域放大（`region`，全局坐标的点；有 `windowId` 时在那个窗口里截）。
// 结果带图像左上角的全局坐标 `originX/originY` 与每点多少像素 `scale`，主进程据此把截图里的像素坐标换成屏幕上的点。

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
  static func screenshot(_ params: JSON) throws -> JSON {
    try Permissions.requireScreenRecording()
    let maxEdge = CGFloat(params["maxEdge"] as? Int ?? 1400)
    let content = try shareableContent()
    let filter: SCContentFilter
    var frame: CGRect  // 截的范围，全局坐标的点
    var pointScale: CGFloat
    var windowId: CGWindowID?

    if let rawWindow = params["windowId"] as? Int {
      let id = CGWindowID(rawWindow)
      guard let window = content.windows.first(where: { $0.windowID == id }) else {
        throw HelperError(
          code: "computer_window_not_found",
          message: "Window \(rawWindow) is not available to capture (closed or minimized). Call computer_list_apps for current windows.")
      }
      let pid = window.owningApplication?.processID ?? 0
      try requireIncluded(pid: pid, params)
      filter = SCContentFilter(desktopIndependentWindow: window)
      frame = window.frame
      pointScale = scaleOfDisplay(containing: window.frame)
      windowId = id
    } else {
      let pids = Set((params["pids"] as? [Int] ?? []).map { pid_t($0) })
      let apps = content.applications.filter { pids.contains($0.processID) && $0.processID != wevirPid }
      guard !apps.isEmpty else {
        throw HelperError(
          code: "computer_not_granted",
          message: "None of the apps approved for this session is running. Open one with computer_open_app first.")
      }
      let display = try pickDisplay(params, content: content, pids: pids)
      filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
      frame = display.frame
      pointScale = scaleOfDisplay(id: display.displayID)
    }

    let configuration = SCStreamConfiguration()
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    var region = frame
    if let raw = params["region"] as? JSON {
      guard let x = number(raw["x"]), let y = number(raw["y"]), let w = number(raw["width"]),
        let h = number(raw["height"]), w >= 1, h >= 1
      else { throw HelperError.invalid("region needs x, y, width and height") }
      region = CGRect(x: x, y: y, width: w, height: h).intersection(frame)
      guard !region.isNull, region.width >= 1, region.height >= 1 else {
        throw HelperError.invalid("region is outside the captured area")
      }
      configuration.sourceRect = CGRect(
        x: region.minX - frame.minX, y: region.minY - frame.minY, width: region.width, height: region.height)
    }
    // 输出的像素：不超过屏幕本身的分辨率，长边不超过 maxEdge。
    let scale = min(pointScale, maxEdge / max(region.width, region.height))
    configuration.width = max(1, Int((region.width * scale).rounded()))
    configuration.height = max(1, Int((region.height * scale).rounded()))

    let image = try capture(filter: filter, configuration: configuration)
    let format = params["format"] as? String == "png" ? "png" : "jpeg"
    let data = try encode(image, format: format)
    var out: JSON = [
      "data": data.base64EncodedString(),
      "mimeType": format == "png" ? "image/png" : "image/jpeg",
      "width": image.width, "height": image.height,
      "originX": Double(region.minX), "originY": Double(region.minY),
      "scale": Double(CGFloat(image.width) / region.width),
    ]
    if let windowId { out["windowId"] = Int(windowId) }
    return out
  }

  private static func number(_ value: Any?) -> CGFloat? {
    (value as? NSNumber).map { CGFloat(truncating: $0) }
  }

  private static func requireIncluded(pid: pid_t, _ params: JSON) throws {
    let pids = Set((params["pids"] as? [Int] ?? []).map { pid_t($0) })
    guard pid != wevirPid, pids.contains(pid) else {
      let name = Apps.info(pid: pid)?.name ?? "That window's app"
      throw HelperError(
        code: "computer_not_granted",
        message: "\(name) is not approved for computer use in this session. Call computer_request_access with it first.")
    }
  }

  /// 给了 `displayId` 用它；否则用最前面那个批准过的应用的窗口所在的屏幕，再不然是主屏幕。
  private static func pickDisplay(_ params: JSON, content: SCShareableContent, pids: Set<pid_t>) throws -> SCDisplay {
    if let raw = params["displayId"] as? Int {
      guard let display = content.displays.first(where: { $0.displayID == CGDirectDisplayID(raw) }) else {
        throw HelperError.invalid("display \(raw) is not connected")
      }
      return display
    }
    if let window = Apps.windows().first(where: { pids.contains($0.pid) && $0.layer == 0 }),
      let display = content.displays.first(where: { $0.frame.contains(CGPoint(x: window.bounds.midX, y: window.bounds.midY)) })
    {
      return display
    }
    let main = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == main }) ?? content.displays.first else {
      throw HelperError(code: "computer_unknown_error", message: "No display is available to capture.")
    }
    return display
  }

  private static func scaleOfDisplay(id: CGDirectDisplayID) -> CGFloat {
    onMain {
      NSScreen.screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
      }?.backingScaleFactor ?? 2
    }
  }

  private static func scaleOfDisplay(containing rect: CGRect) -> CGFloat {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 8)
    let center = CGPoint(x: rect.midX, y: rect.midY)
    guard CGGetDisplaysWithPoint(center, 8, &ids, &count) == .success, count > 0 else { return 2 }
    return scaleOfDisplay(id: ids[0])
  }

  static func shareableContent() throws -> SCShareableContent {
    let done = DispatchSemaphore(value: 0)
    var result: SCShareableContent?
    var failure: Error?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
      result = content
      failure = error
      done.signal()
    }
    if done.wait(timeout: .now() + 10) == .timedOut {
      throw HelperError(code: "computer_timeout", message: "Listing windows to capture took longer than 10 s.")
    }
    guard let result else {
      throw HelperError(
        code: "computer_permission_missing",
        message: "macOS refused screen capture: \(failure?.localizedDescription ?? "unknown error"). Wevir may need the Screen Recording permission.")
    }
    return result
  }

  private static func capture(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> CGImage {
    let done = DispatchSemaphore(value: 0)
    var result: CGImage?
    var failure: Error?
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
      result = image
      failure = error
      done.signal()
    }
    if done.wait(timeout: .now() + 10) == .timedOut {
      throw HelperError(code: "computer_timeout", message: "The screenshot took longer than 10 s.")
    }
    guard let result else {
      throw HelperError(
        code: "computer_unknown_error", message: "The screenshot failed: \(failure?.localizedDescription ?? "unknown error").")
    }
    return result
  }

  private static func encode(_ image: CGImage, format: String) throws -> Data {
    let data = NSMutableData()
    let type = (format == "png" ? UTType.png : UTType.jpeg).identifier as CFString
    guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
      throw HelperError(code: "computer_unknown_error", message: "Could not encode the screenshot.")
    }
    let options = [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
    CGImageDestinationAddImage(destination, image, format == "png" ? nil : options)
    guard CGImageDestinationFinalize(destination) else {
      throw HelperError(code: "computer_unknown_error", message: "Could not encode the screenshot.")
    }
    return data as Data
  }
}
