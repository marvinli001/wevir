// 设备设置：慢动画、硬件 / 软件键盘、前台应用。做法照 facebook/idb FBSimulatorServices/Commands/SimulatorPreferencesCommands.swift
// （提交 14baeffc8f681380527c400a8184512b746ee918，MIT）：慢动画是 Darwin 通知的状态，硬件键盘是 -[SimDevice setHardwareKeyboardEnabled:…]，
// 连硬件键盘时照 Simulator.app 写模拟器里 com.apple.keyboard.preferences 的 AutomaticMinimizationEnabled；屏幕键盘的显示 / 收起
// 用 Simulator.app ⌘K 发的 Indigo 按键（见 Input.toggleSoftwareKeyboard）。

import CoreSimulator
import Foundation
import ObjCExceptionGuard

private let slowAnimationsNotification = "com.apple.UIKit.SimulatorSlowMotionAnimationState"
private let keyboardKeyIdentifiers: Set<String> = ["shift", "delete", "space", "dictation"]

enum DeviceSettings {
  static func slowAnimations(_ session: DeviceSession, params: JSON) throws {
    guard let enabled = params.optionalBool("enabled") else { throw HelperError.invalid("enabled must be a boolean") }
    let device = session.simulator.device
    do {
      try FBObjCExceptionGuard.guarded {
        try device.darwinNotificationSetState(enabled ? 1 : 0, name: slowAnimationsNotification)
        try device.postDarwinNotification(slowAnimationsNotification)
      }
    } catch {
      throw HelperError.wrap(error, code: "sim_unknown_error")
    }
  }

  /// `hardware: bool` 连上 / 断开硬件键盘；`software: show|hide` 在连着硬件键盘时显示 / 收起屏幕键盘。
  static func keyboard(_ session: DeviceSession, params: JSON) throws {
    let hardware = params.optionalBool("hardware")
    let software = params.optionalString("software")
    guard hardware != nil || software != nil else { throw HelperError.invalid("hardware or software is required") }
    if let software, software != "show", software != "hide" {
      throw HelperError.invalid("software must be show or hide")
    }
    if let hardware {
      if hardware {
        // 连上硬件键盘时让屏幕键盘自动收起，与 Simulator.app 一致。
        try setKeyboardPreference(session, minimize: true)
      }
      let device = session.simulator.device
      do {
        try FBObjCExceptionGuard.guarded { try device.setHardwareKeyboardEnabled(hardware, keyboardType: 0) }
      } catch {
        throw HelperError.wrap(error, code: "sim_unknown_error")
      }
    }
    if let software {
      // ⌘K 只会切换，所以先从辅助功能树读屏幕键盘在不在，不一致才切。没有输入焦点时切换不出键盘，照样返回成功。
      if try softwareKeyboardVisible(session) != (software == "show") {
        try Input.toggleSoftwareKeyboard(session)
      }
    }
  }

  /// 屏幕键盘的按键带着与语言无关的标识（`shift`、`delete`、`space`、`dictation`），出现两个以上就当键盘在屏幕上。
  private static func softwareKeyboardVisible(_ session: DeviceSession) throws -> Bool {
    func count(_ node: JSON) -> Int {
      let own = (node["identifier"] as? String).map { keyboardKeyIdentifiers.contains($0) ? 1 : 0 } ?? 0
      return own + ((node["children"] as? [JSON]) ?? []).reduce(0) { $0 + count($1) }
    }
    guard let root = try Accessibility.tree(session, params: [:])["root"] as? JSON else { return false }
    return count(root) >= 2
  }

  private static func setKeyboardPreference(_ session: DeviceSession, minimize: Bool) throws {
    try Simctl.run([
      "spawn", session.udid, "defaults", "write", "com.apple.keyboard.preferences", "AutomaticMinimizationEnabled",
      "-bool", minimize ? "YES" : "NO",
    ])
  }

  /// 前台应用：辅助功能的前台应用元素给出 pid；模拟器里的进程就是本机进程，从可执行文件路径找到 .app 读 bundle id。
  static func foregroundApp(_ session: DeviceSession) throws -> JSON {
    let pid = try Accessibility.frontmostPid(session)
    var result: JSON = ["pid": Int(pid)]
    if let bundleId = bundleIdentifier(pid: pid) {
      result["bundleId"] = bundleId
    }
    return result
  }

  private static func bundleIdentifier(pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    var url = URL(fileURLWithPath: String(cString: buffer))
    while url.path != "/" {
      if url.pathExtension == "app", let bundle = Bundle(url: url) {
        return bundle.bundleIdentifier
      }
      url.deleteLastPathComponent()
    }
    return nil
  }
}

/// 选中 Xcode 里的 simctl（只用在 helper 自己做不了的两件事：模拟器的粘贴板与模拟器里的 defaults）。
enum Simctl {
  @discardableResult
  static func run(_ arguments: [String], input: Data? = nil) throws -> Data {
    guard let developer = PrivateFrameworks.developerDirectory else {
      throw HelperError(code: "sim_framework_missing", message: "No Xcode is selected (xcode-select -p)")
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: developer).appendingPathComponent("usr/bin/simctl")
    process.arguments = arguments
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    let stdin = Pipe()
    process.standardInput = input == nil ? FileHandle.nullDevice : stdin
    do {
      try process.run()
    } catch {
      throw HelperError(code: "sim_unknown_error", message: "Cannot run simctl: \(error.localizedDescription)")
    }
    if let input {
      stdin.fileHandleForWriting.write(input)
      try? stdin.fileHandleForWriting.close()
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let stderr = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let message = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      throw HelperError(code: "sim_unknown_error", message: "simctl \(arguments.first ?? "") failed: \(message)")
    }
    return data
  }

  static func pasteboardCopy(udid: String, text: String) throws {
    try run(["pbcopy", udid], input: Data(text.utf8))
  }
}
