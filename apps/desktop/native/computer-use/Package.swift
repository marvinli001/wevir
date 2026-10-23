// swift-tools-version:5.9
// 电脑操作（0.114.0）的 macOS helper：桌面端主进程拉起它，经 stdin / stdout 的 JSON 行交换请求与回答。
// 截图用 ScreenCaptureKit，界面结构用辅助功能（AX），输入用 CGEvent；不依赖第三方包。
import PackageDescription

let package = Package(
  name: "wevir-computer-use",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "wevir-computer-use",
      path: "Sources/WevirComputerUse"
    )
  ]
)
