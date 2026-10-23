// swift-tools-version:5.9
// iOS 模拟器的 macOS helper：Host 拉起它（在 sandbox-exec 里），经 stdin / stdout 的 JSON 行交换请求与回答，
// 视频帧走 fd 3。取帧、HID 输入、旋转、辅助功能树用 Xcode 的私有框架，做法移植自 facebook/idb 的 FBSimulatorControl（MIT）。
// PrivateHeaders/ 是 idb 声明的私有框架头文件与 TBD 桩（原样拷贝）；CoreSimulator 与 AccessibilityPlatformTranslation 弱链接，
// SimulatorKit 运行时 dlopen。Info.plist 嵌进可执行文件（__TEXT,__info_plist），好让 helper 有自己的 bundle id：
// Metal 的着色器缓存因此落在每用户缓存目录里 helper 自己那一格，sandbox 描述文件只放行那一格。
import Foundation
import PackageDescription

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let headers = "\(root)/PrivateHeaders"
let privateModules = ["CoreSimulator", "CoreSimDeviceIO", "SimulatorApp", "AccessibilityPlatformTranslation"]

let package = Package(
  name: "wevir-ios-simulator",
  platforms: [.macOS(.v14)],
  targets: [
    .target(
      name: "ObjCExceptionGuard",
      path: "Sources/ObjCExceptionGuard"
    ),
    .executableTarget(
      name: "wevir-ios-simulator",
      dependencies: ["ObjCExceptionGuard"],
      path: "Sources/WevirIOSSimulator",
      swiftSettings: [
        .unsafeFlags(
          ["-Xcc", "-isystem", "-Xcc", headers]
            + privateModules.flatMap { ["-Xcc", "-fmodule-map-file=\(headers)/\($0)/module.modulemap"] }
        )
      ],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-weak_library", "-Xlinker", "\(headers)/CoreSimulator/CoreSimulator.tbd",
          "-Xlinker", "-weak_library", "-Xlinker",
          "\(headers)/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd",
          "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "\(root)/Info.plist",
        ])
      ]
    ),
  ]
)
