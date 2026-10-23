// 移植自 facebook/idb FBSimulatorControl/CoreDevice/SimulatorOrientationProtocol.swift（提交
// 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，版权见 LICENSE-facebook-idb.txt）。
// 改动：不经 idb 的 CoreDevice 会话层，直接在 SimulatorXPCChannel 上发一条请求等回复，回复只读方向字段；
// 方向名换成 helper 的 DeviceOrientation。

import Foundation
import XPC

/// Reads the device orientation from the guest's CoreDevice orientation service. Rotations made outside this
/// process (Simulator.app, an earlier helper) are reflected, which a locally tracked orientation is not.
enum SimulatorOrientationProtocol {
  static let service = "com.apple.coredevice.feature.remote.devicecontrol.orientation"

  private enum Request: Encodable {
    case currentOrientation
  }

  static func read(on simulator: Simulator, timeout: DispatchTimeInterval = .seconds(2)) async throws -> DeviceOrientation? {
    let message = try XPCEncoder().encode(
      DTUHIDMessage(messageType: "OrientationRequest", featureIdentifier: service, payload: Request.currentOrientation))
    let channel = SimulatorXPCChannel(
      connection: try simulator.xpc.connect(service), queue: DispatchQueue(label: "si.wevir.ios-simulator.orientation"))
    channel.activate { _ in }
    defer { channel.cancel() }
    let reply = try await channel.request(message, timeout: timeout)
    guard xpc_get_type(reply) == XPC_TYPE_DICTIONARY,
      let value = xpc_dictionary_get_string(reply, "currentDeviceOrientation")
    else { return nil }
    return DeviceOrientation(rawValue: String(cString: value))
  }
}
