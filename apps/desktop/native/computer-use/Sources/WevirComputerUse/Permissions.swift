// 屏幕录制与辅助功能两项系统权限：查询与请求。helper 由 Wevir 的主进程拉起，系统把它算在 Wevir.app 上（开发时算在启动
// Electron 的那个应用上），所以这里查到的就是 Wevir 的权限。

import ApplicationServices
import Foundation
import CoreGraphics

enum Permissions {
  static func status() -> JSON {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return [
      "screenRecording": CGPreflightScreenCaptureAccess(),
      "accessibility": AXIsProcessTrusted(),
      "macos": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
    ]
  }

  /// `kind`：`screen_recording` 或 `accessibility`。系统只在第一次请求时弹框，之后要用户自己去系统设置里打开。
  static func request(_ params: JSON) throws -> JSON {
    switch params["kind"] as? String {
    case "screen_recording":
      _ = CGRequestScreenCaptureAccess()
    case "accessibility":
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
    default:
      throw HelperError.invalid("kind must be screen_recording or accessibility")
    }
    return status()
  }

  static func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
      throw HelperError(
        code: "computer_permission_missing",
        message:
          "Wevir does not have the macOS Accessibility permission, so it cannot read app interfaces or send input. Ask the user to allow Wevir in System Settings > Privacy & Security > Accessibility (Wevir Settings > Computer use has a button for it), then try again."
      )
    }
  }

  static func requireScreenRecording() throws {
    guard CGPreflightScreenCaptureAccess() else {
      throw HelperError(
        code: "computer_permission_missing",
        message:
          "Wevir does not have the macOS Screen Recording permission, so it cannot take screenshots. Ask the user to allow Wevir in System Settings > Privacy & Security > Screen & System Audio Recording (Wevir Settings > Computer use has a button for it); macOS may require reopening Wevir afterwards."
      )
    }
  }
}
