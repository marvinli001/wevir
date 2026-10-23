// 应用与窗口：列出正在运行的应用与它们在屏幕上的窗口、按名字或 bundle ID 找应用、打开或调到前台；以及按应用授权的检查
// （`Gate`）：主进程每个请求都带 `allow`（bundle ID → 档位），动作之前在这里核对动作落到的应用，越权时报错并说明改用什么。

import AppKit
import CoreGraphics
import Foundation

/// 正在运行的应用的基本信息。
struct AppInfo {
  let pid: pid_t
  let bundleId: String?
  let name: String

  var json: JSON {
    var out: JSON = ["pid": Int(pid), "name": name]
    if let bundleId { out["bundleId"] = bundleId }
    return out
  }
}

/// 屏幕上的一个窗口（CGWindowList 的一项）。
struct WindowInfo {
  let windowId: CGWindowID
  let pid: pid_t
  let ownerName: String
  let title: String?
  let bounds: CGRect
  let layer: Int
  let alpha: Double
}

/// helper 的父进程是 Wevir 的主进程：它的窗口不截、不操作。
let wevirPid: pid_t = getppid()

enum Apps {
  static func info(pid: pid_t) -> AppInfo? {
    onMain {
      guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
      return AppInfo(pid: pid, bundleId: app.bundleIdentifier, name: app.localizedName ?? app.bundleIdentifier ?? "pid \(pid)")
    }
  }

  static func frontmost() -> AppInfo? {
    onMain {
      guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
      return AppInfo(
        pid: app.processIdentifier, bundleId: app.bundleIdentifier,
        name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)")
    }
  }

  static func frontmostInfo() -> JSON {
    guard let app = frontmost() else { return [:] }
    var out = app.json
    if app.pid == wevirPid { out["wevir"] = true }
    return out
  }

  /// 屏幕上的窗口，从前到后。
  static func windows(onScreenOnly: Bool = true) -> [WindowInfo] {
    let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly] : [.optionAll]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
      return []
    }
    return list.compactMap { entry in
      guard let number = entry[kCGWindowNumber as String] as? Int,
        let pid = entry[kCGWindowOwnerPID as String] as? Int,
        let boundsDict = entry[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
      else { return nil }
      return WindowInfo(
        windowId: CGWindowID(number), pid: pid_t(pid),
        ownerName: entry[kCGWindowOwnerName as String] as? String ?? "",
        title: entry[kCGWindowName as String] as? String,
        bounds: bounds,
        layer: entry[kCGWindowLayer as String] as? Int ?? 0,
        alpha: entry[kCGWindowAlpha as String] as? Double ?? 1)
    }
  }

  static func window(id: CGWindowID) -> WindowInfo? {
    windows(onScreenOnly: false).first { $0.windowId == id }
  }

  /// 这个点上最前面的窗口（全局坐标，单位是点）；`ignore` 里的窗口（Wevir 的提示条，鼠标会穿过它）跳过。
  static func window(at point: CGPoint, ignore: Set<CGWindowID>) -> WindowInfo? {
    windows().first { window in
      !ignore.contains(window.windowId) && window.alpha > 0 && window.bounds.contains(point)
    }
  }

  static func list(_ params: JSON) throws -> JSON {
    let all = windows()
    let apps: [JSON] = onMain {
      NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && $0.processIdentifier != wevirPid }
        .map { app in
          let pid = app.processIdentifier
          var entry: JSON = [
            "pid": Int(pid),
            "name": app.localizedName ?? app.bundleIdentifier ?? "pid \(pid)",
            "active": app.isActive,
            "hidden": app.isHidden,
          ]
          if let id = app.bundleIdentifier { entry["bundleId"] = id }
          entry["windows"] = all.filter { $0.pid == pid && $0.layer == 0 }.map { window -> JSON in
            var out: JSON = [
              "windowId": Int(window.windowId),
              "x": Int(window.bounds.minX), "y": Int(window.bounds.minY),
              "width": Int(window.bounds.width), "height": Int(window.bounds.height),
            ]
            if let title = window.title, !title.isEmpty { out["title"] = title }
            return out
          }
          return entry
        }
        .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }
    return ["apps": apps]
  }

  /// 按名字或 bundle ID 找应用（正在运行的、装在常见位置的），给出 bundle ID、显示名、是不是浏览器与它的分类。
  static func resolve(_ params: JSON) throws -> JSON {
    guard let names = params["names"] as? [String], !names.isEmpty else {
      throw HelperError.invalid("names must be a non-empty array")
    }
    let browsers: Set<String> = onMain {
      guard let url = URL(string: "https://example.com") else { return [] }
      return Set(
        NSWorkspace.shared.urlsForApplications(toOpen: url).compactMap { Bundle(url: $0)?.bundleIdentifier })
    }
    let results: [JSON] = names.map { query in
      guard let found = locate(query) else { return ["query": query] }
      var out: JSON = [
        "query": query, "bundleId": found.bundleId, "name": found.name, "path": found.path,
        "running": found.running, "browser": browsers.contains(found.bundleId),
      ]
      if let category = found.category { out["category"] = category }
      return out
    }
    return ["apps": results]
  }

  private struct Located {
    let bundleId: String
    let name: String
    let path: String
    let running: Bool
    let category: String?
  }

  private static func locate(_ query: String) -> Located? {
    let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
    let stripped = wanted.hasSuffix(".app") ? String(wanted.dropLast(4)) : wanted
    let running: NSRunningApplication? = onMain {
      NSWorkspace.shared.runningApplications.first { app in
        app.bundleIdentifier?.lowercased() == wanted || app.localizedName?.lowercased() == stripped
          || app.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == stripped
      }
    }
    if let running, let url = running.bundleURL, let id = running.bundleIdentifier {
      return describe(url: url, bundleId: id, running: true)
    }
    if let url = onMain({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) }),
      let bundle = Bundle(url: url), let id = bundle.bundleIdentifier
    {
      return describe(url: url, bundleId: id, running: false)
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let roots = [
      "/Applications", "/System/Applications", "/System/Applications/Utilities",
      "/Applications/Utilities", "\(home)/Applications",
    ]
    let paths = roots.flatMap { root in
      ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [])
        .filter { $0.hasSuffix(".app") }.map { "\(root)/\($0)" }
    }
    // 先比文件名与当前语言的显示名，再比各语言的本地化名（“备忘录”找得到 Notes）。
    let byName = paths.first { path in
      let display = FileManager.default.displayName(atPath: path).lowercased()
      let base = (path as NSString).lastPathComponent.dropLast(4).lowercased()
      return base == stripped || display == stripped || display == "\(stripped).app"
    }
    if let path = byName ?? paths.first(where: { localizedNames(path: $0).contains(stripped) }),
      let id = Bundle(path: path)?.bundleIdentifier
    {
      return describe(url: URL(fileURLWithPath: path), bundleId: id, running: false)
    }
    return nil
  }

  /// 应用在各语言里的名字（InfoPlist.loctable，或各 .lproj 的 InfoPlist.strings 里的 CFBundleDisplayName / CFBundleName），小写。
  private static func localizedNames(path: String) -> Set<String> {
    let resources = "\(path)/Contents/Resources"
    var tables: [[String: Any]] = []
    if let data = FileManager.default.contents(atPath: "\(resources)/InfoPlist.loctable"),
      let loctable = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    {
      tables = loctable.values.compactMap { $0 as? [String: Any] }
    } else if let entries = try? FileManager.default.contentsOfDirectory(atPath: resources) {
      tables = entries.filter { $0.hasSuffix(".lproj") }.compactMap {
        NSDictionary(contentsOfFile: "\(resources)/\($0)/InfoPlist.strings") as? [String: Any]
      }
    }
    var names = Set<String>()
    for table in tables {
      for key in ["CFBundleDisplayName", "CFBundleName"] {
        if let name = table[key] as? String { names.insert(name.lowercased()) }
      }
    }
    return names
  }

  private static func describe(url: URL, bundleId: String, running: Bool) -> Located {
    let bundle = Bundle(url: url)
    var name = FileManager.default.displayName(atPath: url.path)
    if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
    return Located(
      bundleId: bundleId, name: name, path: url.path, running: running,
      category: bundle?.infoDictionary?["LSApplicationCategoryType"] as? String)
  }

  /// 打开应用，已经开着的调到前台。`bundleId` 必须在 `allow` 里（任何档位都可以：调到前台算只读的动作）。
  static func open(_ params: JSON) throws -> JSON {
    guard let bundleId = params["bundleId"] as? String else { throw HelperError.invalid("bundleId is required") }
    let allow = Gate.allowMap(params)
    guard allow[bundleId] != nil else {
      throw HelperError(
        code: "computer_not_granted",
        message: "\(bundleId) is not approved for computer use in this session. Call computer_request_access with it first.")
    }
    guard let url = onMain({ NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) }) else {
      throw HelperError(code: "computer_app_not_found", message: "No app with bundle ID \(bundleId) is installed.")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    let done = DispatchSemaphore(value: 0)
    var failure: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
      failure = error
      done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut {
      throw HelperError(code: "computer_timeout", message: "\(bundleId) did not open within 15 s.")
    }
    if let failure {
      throw HelperError(code: "computer_unknown_error", message: "Could not open \(bundleId): \(failure.localizedDescription)")
    }
    // 等它真的到前台（最多 2 秒），结果里给出现在最前面的应用。macOS 14 起后台进程的激活请求会被系统忽略（协作式激活），
    // 已经在运行的应用这时不会到前台；改用辅助功能把它设为最前（AXFrontmost），再不行就请它自己激活。
    for attempt in 0..<20 {
      if frontmost()?.bundleId == bundleId { break }
      if attempt == 3 {
        onMain {
          guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return }
          AXUIElementSetAttributeValue(
            AXUIElementCreateApplication(app.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
          app.activate(options: [.activateAllWindows])
        }
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    return ["frontmost": frontmostInfo()]
  }
}

/// 一个动作需要的档位。
enum ActionKind {
  /// 不带修饰键的左键单击、双击。
  case leftClick
  /// 右键、中键、带修饰键的点击、拖拽。
  case pointer
  case scroll
  case keyboard
  /// 设值、往元素里写文字。
  case value

  var allowedInClickTier: Bool { self == .leftClick || self == .scroll }
}

enum Gate {
  static func allowMap(_ params: JSON) -> [String: String] {
    params["allow"] as? [String: String] ?? [:]
  }

  static func ignoredWindows(_ params: JSON) -> Set<CGWindowID> {
    Set((params["ignoreWindowIds"] as? [Int] ?? []).map { CGWindowID($0) })
  }

  /// 核对动作落到的应用：没批准、档位不够、是 Wevir 自己时抛错。
  static func check(_ app: AppInfo, _ action: ActionKind, allow: [String: String]) throws {
    if app.pid == wevirPid {
      throw HelperError(
        code: "computer_denied",
        message:
          "That is Wevir's own window. Computer use never operates Wevir itself; use the wevir_* tools for Wevir, or bring the target app forward with computer_open_app first.")
    }
    guard let bundleId = app.bundleId, let tier = allow[bundleId] else {
      throw HelperError(
        code: "computer_not_granted",
        message:
          "\(app.name)\(app.bundleId.map { " (\($0))" } ?? "") is not approved for computer use in this session, so the action was blocked. Call computer_request_access with it if the task needs it.")
    }
    switch tier {
    case "full":
      return
    case "click" where action.allowedInClickTier:
      return
    case "click":
      throw HelperError(
        code: "computer_tier_denied",
        message:
          "\(app.name) is a terminal or IDE, approved for left clicks and scrolling only: typing, key presses, right clicks, modifier clicks, drags and setting values are blocked. Run commands with your shell tool and edit files with your file tools instead.")
    default:
      throw HelperError(
        code: "computer_tier_denied",
        message:
          "\(app.name) is a browser, approved read-only: screenshots and reading work, but clicks, scrolling and typing are blocked. Use the Wevir browser tools (browser_*) or the Chrome tools to act on web pages.")
    }
  }

  /// 点、滚、拖落到的应用。先用辅助功能问这个点上是哪个应用的元素（和鼠标事件的命中一致）：窗口列表里有铺满全屏、
  /// 看不见也不接鼠标的系统窗口（程序坞的、截屏界面的），按列表找会算错。问不到时再看普通窗口（第 0 层）。
  /// 菜单栏与状态栏算最前面的应用；程序坞与桌面算访达。
  static func target(at point: CGPoint, ignore: Set<CGWindowID>) -> AppInfo? {
    var element: AXUIElement?
    var hitPid: pid_t = 0
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element)
      == .success, let element, AXUIElementGetPid(element, &hitPid) == .success
    {
      return resolve(pid: hitPid)
    }
    let normal = Apps.windows().first { window in
      window.layer == 0 && !ignore.contains(window.windowId) && window.alpha > 0 && window.bounds.contains(point)
    }
    guard let normal else {
      // 第 0 层没有窗口：菜单栏一带算最前面的应用，其余是桌面。
      let menuBar = Apps.windows().contains { $0.layer > 0 && $0.ownerName == "Window Server" && $0.bounds.contains(point) }
      return menuBar ? Apps.frontmost() : finder()
    }
    return resolve(pid: normal.pid)
  }

  private static func resolve(pid: pid_t) -> AppInfo? {
    guard let app = Apps.info(pid: pid), let id = app.bundleId else { return Apps.frontmost() }
    if id == "com.apple.dock" { return finder() ?? app }
    let regular = onMain {
      NSRunningApplication(processIdentifier: pid)?.activationPolicy == .regular
    }
    // 状态栏图标、控制中心这类不是普通应用的进程：算最前面的应用（同菜单栏）。
    return regular ? app : Apps.frontmost()
  }

  private static func finder() -> AppInfo? {
    onMain {
      guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first
      else { return nil }
      return AppInfo(pid: app.processIdentifier, bundleId: "com.apple.finder", name: app.localizedName ?? "Finder")
    }
  }

  /// 键盘落到的应用：给了 `pid`（在后台发给它）时是它，否则是最前面的应用。
  static func keyboardTarget(_ params: JSON) throws -> (AppInfo, background: Bool) {
    let front = Apps.frontmost()
    if let raw = params["pid"] as? Int {
      let pid = pid_t(raw)
      guard let app = Apps.info(pid: pid) else {
        throw HelperError(code: "computer_app_not_found", message: "The target app (pid \(raw)) is no longer running.")
      }
      return (app, front?.pid != pid)
    }
    guard let front else {
      throw HelperError(code: "computer_app_not_found", message: "No app is in front to receive the keys.")
    }
    return (front, false)
  }
}
