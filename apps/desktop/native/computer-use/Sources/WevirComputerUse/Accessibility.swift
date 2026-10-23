// 辅助功能树：读一个应用（或它的一个窗口）的界面结构，按角色与文字找元素。元素给 `@a12` 这样的引用，按调用方的
// `scope`（Wevir 会话）分开记；同一个应用再读一次树时它之前的引用作废，找元素得到的引用接着编号。

import AppKit
import ApplicationServices
import Foundation

struct ElementRef {
  let pid: pid_t
  let element: AXUIElement
}

/// 一个元素读出来的属性。
struct ElementInfo {
  var role = ""
  var subrole: String?
  var title: String?
  var label: String?
  var value: String?
  var placeholder: String?
  var identifier: String?
  var frame: CGRect?
  var enabled = true
  var focused = false
  var selected = false
  var children: [AXUIElement] = []

  /// 给模型看的名字：标题、说明或占位文字。
  var name: String? {
    for candidate in [title, label, placeholder] {
      if let candidate, !candidate.isEmpty { return candidate }
    }
    return nil
  }

  var isBareContainer: Bool {
    let containers: Set<String> = [
      "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXList",
      "AXOutline", "AXTable", "AXRow", "AXCell", "AXColumn", "AXBrowser", "AXTabGroup",
    ]
    return containers.contains(role) && name == nil && (value ?? "").isEmpty && identifier == nil
  }
}

enum Accessibility {
  private static let lock = NSLock()
  private static var refs: [String: [Int: ElementRef]] = [:]
  private static var counters: [String: Int] = [:]

  static func forget(_ params: JSON) -> JSON {
    let scope = params["scope"] as? String ?? ""
    lock.lock()
    refs.removeValue(forKey: scope)
    counters.removeValue(forKey: scope)
    lock.unlock()
    return [:]
  }

  private static func remember(_ element: AXUIElement, pid: pid_t, scope: String) -> String {
    lock.lock()
    defer { lock.unlock() }
    let next = (counters[scope] ?? 0) + 1
    counters[scope] = next
    refs[scope, default: [:]][next] = ElementRef(pid: pid, element: element)
    return "@a\(next)"
  }

  private static func reset(pid: pid_t, scope: String) {
    lock.lock()
    refs[scope] = refs[scope]?.filter { $0.value.pid != pid }
    lock.unlock()
  }

  static func lookup(_ ref: String, scope: String) throws -> ElementRef {
    guard ref.hasPrefix("@a"), let number = Int(ref.dropFirst(2)) else {
      throw HelperError.invalid("ref must look like @a12")
    }
    lock.lock()
    let found = refs[scope]?[number]
    lock.unlock()
    guard let found else {
      throw HelperError(
        code: "computer_stale_ref",
        message: "\(ref) is not a current element ref. Refs come from the latest computer_ax_tree or computer_ax_find of that app; read the tree again.")
    }
    return found
  }

  static func appElement(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.5)
    return app
  }

  // MARK: 读属性

  private static let attributes = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXPlaceholderValueAttribute, kAXIdentifierAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXChildrenAttribute,
  ] as [CFString]

  static func read(_ element: AXUIElement) -> ElementInfo {
    var info = ElementInfo()
    var raw: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, [], &raw) == .success,
      let values = raw as? [AnyObject], values.count == attributes.count
    else { return info }
    func string(_ index: Int) -> String? {
      let value = values[index]
      if let text = value as? String { return text }
      if let number = value as? NSNumber, CFGetTypeID(value) != AXValueGetTypeID() { return number.stringValue }
      return nil
    }
    func bool(_ index: Int) -> Bool? { (values[index] as? NSNumber).map(\.boolValue) }
    info.role = string(0) ?? ""
    info.subrole = string(1)
    info.title = string(2)
    info.label = string(3)
    info.value = string(4)
    info.placeholder = string(5)
    info.identifier = string(6)
    var position = CGPoint.zero
    var size = CGSize.zero
    if CFGetTypeID(values[7]) == AXValueGetTypeID(), CFGetTypeID(values[8]) == AXValueGetTypeID() {
      let positionValue = values[7] as! AXValue  // swiftlint:disable:this force_cast
      let sizeValue = values[8] as! AXValue  // swiftlint:disable:this force_cast
      if AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size) {
        info.frame = CGRect(origin: position, size: size)
      }
    }
    info.enabled = bool(9) ?? true
    info.focused = bool(10) ?? false
    info.selected = bool(11) ?? false
    info.children = values[12] as? [AXUIElement] ?? []
    return info
  }

  static func frame(of element: AXUIElement) -> CGRect? { read(element).frame }

  // MARK: 树

  /// 应用的窗口；给了 `windowId` 时只要和它对得上（位置与大小相同）的那个。
  private static func windows(pid: pid_t, windowId: Int?) throws -> [AXUIElement] {
    let app = appElement(pid)
    var raw: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw)
    if status == .apiDisabled { try Permissions.requireAccessibility() }
    let all = raw as? [AXUIElement] ?? []
    guard let windowId else { return all }
    guard let target = Apps.window(id: CGWindowID(windowId)) else {
      throw HelperError(code: "computer_window_not_found", message: "Window \(windowId) is not open.")
    }
    let matched = all.filter { element in
      guard let frame = frame(of: element) else { return false }
      return abs(frame.minX - target.bounds.minX) < 2 && abs(frame.minY - target.bounds.minY) < 2
        && abs(frame.width - target.bounds.width) < 2 && abs(frame.height - target.bounds.height) < 2
    }
    guard !matched.isEmpty else {
      throw HelperError(
        code: "computer_window_not_found",
        message: "Window \(windowId) has no accessibility counterpart (it may be on another Space or not standard). Read the whole app instead.")
    }
    return matched
  }

  static func tree(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    guard let rawPid = params["pid"] as? Int else { throw HelperError.invalid("pid is required") }
    let pid = pid_t(rawPid)
    let scope = params["scope"] as? String ?? ""
    let maxNodes = min(params["maxNodes"] as? Int ?? 250, 2000)
    let maxDepth = min(params["maxDepth"] as? Int ?? 25, 60)
    let maxBytes = params["maxBytes"] as? Int ?? 7000
    let roots = try windows(pid: pid, windowId: params["windowId"] as? Int)
    reset(pid: pid, scope: scope)

    var lines: [String] = []
    var bytes = 0
    var printed = 0
    var visited = 0
    var truncated = false
    func walk(_ element: AXUIElement, depth: Int, indent: Int) {
      if truncated { return }
      visited += 1
      if visited > maxNodes * 8 {
        truncated = true
        return
      }
      let info = read(element)
      var nextIndent = indent
      if !info.isBareContainer || depth == 0 {
        if printed >= maxNodes || bytes >= maxBytes {
          truncated = true
          return
        }
        let ref = remember(element, pid: pid, scope: scope)
        let line = String(repeating: "  ", count: indent) + format(info, ref: ref)
        lines.append(line)
        bytes += line.utf8.count + 1
        printed += 1
        nextIndent = indent + 1
      }
      guard depth < maxDepth else { return }
      for child in info.children { walk(child, depth: depth + 1, indent: nextIndent) }
    }
    for root in roots { walk(root, depth: 0, indent: 0) }
    if roots.isEmpty { lines.append("(no windows)") }
    return ["text": lines.joined(separator: "\n"), "elements": printed, "truncated": truncated]
  }

  /// 按角色与文字找元素（广度优先，最多看 4000 个）。
  static func find(_ params: JSON) throws -> JSON {
    try Permissions.requireAccessibility()
    guard let rawPid = params["pid"] as? Int else { throw HelperError.invalid("pid is required") }
    let pid = pid_t(rawPid)
    let scope = params["scope"] as? String ?? ""
    let text = (params["text"] as? String)?.lowercased()
    let role = (params["role"] as? String).map { $0.hasPrefix("AX") ? $0.lowercased() : "ax\($0.lowercased())" }
    guard text != nil || role != nil else { throw HelperError.invalid("give text, role or both") }
    let maxResults = min(params["maxResults"] as? Int ?? 20, 100)
    var queue = try windows(pid: pid, windowId: params["windowId"] as? Int)
    var lines: [String] = []
    var visited = 0
    var total = 0
    while !queue.isEmpty, visited < 4000 {
      let element = queue.removeFirst()
      visited += 1
      let info = read(element)
      queue.append(contentsOf: info.children)
      if let role, info.role.lowercased() != role, (info.subrole?.lowercased() ?? "") != role { continue }
      if let text {
        let haystack = [info.title, info.label, info.value, info.placeholder, info.identifier]
          .compactMap { $0?.lowercased() }
        if !haystack.contains(where: { $0.contains(text) }) { continue }
      }
      total += 1
      if lines.count < maxResults {
        lines.append(format(info, ref: remember(element, pid: pid, scope: scope)))
      }
    }
    return ["text": lines.joined(separator: "\n"), "matches": total, "shown": lines.count, "complete": queue.isEmpty]
  }

  /// 一行：`button "Save" @a3 (412,88 60x22) value="…" focused`。坐标是屏幕上的点。
  static func format(_ info: ElementInfo, ref: String) -> String {
    var role = info.role.hasPrefix("AX") ? String(info.role.dropFirst(2)) : info.role
    if role.isEmpty { role = "element" }
    role = role.prefix(1).lowercased() + role.dropFirst()
    var parts = [role]
    if let subrole = info.subrole, subrole.hasPrefix("AX"), !["AXStandardWindow"].contains(subrole) {
      parts[0] += "/" + subrole.dropFirst(2)
    }
    if let name = info.name { parts.append(quote(name, limit: 80)) }
    parts.append(ref)
    if let frame = info.frame {
      parts.append("(\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height)))")
    }
    if let value = info.value, !value.isEmpty, value != info.name { parts.append("value=" + quote(value, limit: 160)) }
    if let identifier = info.identifier, info.name == nil { parts.append("id=" + quote(identifier, limit: 60)) }
    if !info.enabled { parts.append("disabled") }
    if info.focused { parts.append("focused") }
    if info.selected { parts.append("selected") }
    return parts.joined(separator: " ")
  }

  private static func quote(_ text: String, limit: Int) -> String {
    let flat = text.replacingOccurrences(of: "\n", with: "\\n")
    let cut = flat.count > limit ? String(flat.prefix(limit)) + "…" : flat
    return "\"\(cut.replacingOccurrences(of: "\"", with: "\\\""))\""
  }
}
