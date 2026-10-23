// 剪贴板的文字。主进程只在会话批准过至少一个应用时才转来这两个请求。

import AppKit

enum Clipboard {
  static func read(_ params: JSON) throws -> JSON {
    let text: String? = onMain { NSPasteboard.general.string(forType: .string) }
    guard let text else { return ["empty": true] }
    let limit = params["maxLength"] as? Int ?? 20000
    return ["text": String(text.prefix(limit)), "length": text.count]
  }

  static func write(_ params: JSON) throws -> JSON {
    guard let text = params["text"] as? String else { throw HelperError.invalid("text is required") }
    onMain {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }
    return ["length": text.count]
  }
}
