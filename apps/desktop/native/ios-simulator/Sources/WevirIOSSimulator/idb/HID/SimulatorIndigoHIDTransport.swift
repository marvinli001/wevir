/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// 移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，见 LICENSE-facebook-idb.txt）：FBSimulatorControl/HID/SimulatorIndigoHIDTransport.swift。
// 改动：去掉 public / package 与 FBControlCore 的 import；去掉多显示器路由，只打主屏；加了 sendButton(direction:source:)。

import CoreGraphics
@preconcurrency import CoreSimulator
import Foundation

/**
 The legacy HID transport (IndigoHIDRegistrationPort), the default on toolchains that predate `dtuhidd`.
 On later toolchains only the tvOS trackpad still works over it.

 Builds `IndigoMessage` payloads with `SimulatorIndigoHID` and delivers them through the runtime-only
 `SimDeviceLegacyHIDClient` (owned by `SimulatorIndigoHIDClient`). Guest-side:
 `SimHIDVirtualServiceManager` dispatches on eventKind + target. See `Indigo.h` for wire format.

 An `actor`, so sends are serialized by actor isolation (no `@unchecked Sendable`).
 */
actor SimulatorIndigoHIDTransport {

  /// Delivers the built Indigo message bytes to the simulator. `Sendable`, so `disconnect()` can
  /// reach it from a `nonisolated` context.
  private let indigoClient: SimulatorIndigoHIDClient
  /// The Indigo payload builder (touch, button, keyboard).
  private let indigo: SimulatorIndigoHID
  /// The dimensions of the main screen.
  private let mainScreenSize: CGSize
  /// The scale of the main screen.
  private let mainScreenScale: Float
  /// Whether the guest drops legacy input, captured from `Simulator.isLegacyInputSuppressed` when the
  /// transport is built. Touch, button and keyboard sends fail loudly on it rather than reporting
  /// success for input that has no effect; the DTUHID transport is the workaround.
  private let legacyInputSuppressed: Bool
  /// The product family of the target, captured at construction. Touchscreen touches are a no-op on
  /// tvOS (it has no digitizer), so the touch primitives reject `AppleTV` rather than failing silently.
  private let productFamily: ProductFamily

  /// Creates a transport for the provided Simulator, registering a HID client.
  /// Will fail if a HID Port could not be registered for the provided Simulator.
  /// Registration may need to occur prior to booting.
  init(simulator: Simulator) throws {
    self.init(
      indigoClient: try SimulatorIndigoHIDClient(for: simulator.device),
      indigo: try SimulatorIndigoHID(),
      mainScreenSize: simulator.device.deviceType.mainScreenSize,
      mainScreenScale: simulator.device.deviceType.mainScreenScale,
      legacyInputSuppressed: simulator.isLegacyInputSuppressed,
      productFamily: simulator.productFamily)
  }

  init(
    indigoClient: SimulatorIndigoHIDClient,
    indigo: SimulatorIndigoHID,
    mainScreenSize: CGSize,
    mainScreenScale: Float,
    legacyInputSuppressed: Bool,
    productFamily: ProductFamily
  ) {
    self.indigoClient = indigoClient
    self.indigo = indigo
    self.mainScreenSize = mainScreenSize
    self.mainScreenScale = mainScreenScale
    self.legacyInputSuppressed = legacyInputSuppressed
    self.productFamily = productFamily
  }

  // MARK: - Sends

  nonisolated func disconnect() {
    indigoClient.disconnect()
  }

  /// Returns once every message sent so far has been acknowledged, throwing the first delivery failure.
  nonisolated func acknowledged() async throws {
    try await indigoClient.acknowledged()
  }

  func sendTouch(
    direction: SimulatorHIDDirection, x: Double, y: Double, edge: SimulatorHIDEdge
  ) async throws {
    guard productFamily.hasTouchscreen else {
      throw SimulatorHIDError.touchUnsupportedOnAppleTV
    }
    try requireLegacyInput("Touch")
    try await indigoClient.send(
      indigo.touchScreenSize(mainScreenSize, screenScale: mainScreenScale, direction: direction, x: x, y: y, edge: edge))
  }

  func sendTwoFingerTouch(direction: SimulatorHIDDirection, finger1: CGPoint, finger2: CGPoint) async throws {
    guard productFamily.hasTouchscreen else {
      throw SimulatorHIDError.touchUnsupportedOnAppleTV
    }
    try requireLegacyInput("Touch")
    try await indigoClient.send(
      indigo.twoFingerTouchScreenSize(
        mainScreenSize, screenScale: mainScreenScale, direction: direction, finger1: finger1, finger2: finger2))
  }

  /// On Xcode 27 (CoreSimulator-1155.4)+ button and keyboard events deliver byte-correctly but have no
  /// effect, and touch is dropped unpredictably. Nothing observable from here tells a delivered send from
  /// a dropped one, so none is reported as a success.
  private func requireLegacyInput(_ operation: String) throws {
    if legacyInputSuppressed {
      throw SimulatorHIDError.legacyInputSuppressed(operation: operation)
    }
  }

  func sendButton(direction: SimulatorHIDDirection, button: SimulatorHIDButton) async throws {
    try requireLegacyInput("Button")
    try await indigoClient.send(indigo.button(with: direction, button: button))
  }

  func sendButton(direction: SimulatorHIDDirection, source: Int32) async throws {
    try requireLegacyInput("Button")
    try await indigoClient.send(indigo.button(source: source, direction: direction))
  }

  func sendKeyboard(direction: SimulatorHIDDirection, keyCode: UInt32) async throws {
    try requireLegacyInput("Keyboard")
    try await indigoClient.send(indigo.keyboard(with: direction, keyCode: keyCode))
  }

  /// Delivers a Siri Remote focus action as the keyboard usage the tvOS focus engine consumes, which is
  /// the only encoding the legacy path has for it — so it is subject to the same Xcode 27 suppression.
  func sendRemoteButton(direction: SimulatorHIDDirection, button: SimulatorHIDRemoteButton) async throws {
    try await sendKeyboard(direction: direction, keyCode: button.keyboardUsage)
  }

  // No tvOS guard — the trackpad is exactly what Apple TV targets need (unlike the touchscreen). No
  // suppression guard either: the tvOS guest still honours Indigo trackpad events on Xcode 27.
  func sendTrackpad(point: SimulatorTrackpadPoint, phase: SimulatorTrackpadPhase) async throws {
    try await indigoClient.send(indigo.trackpad(point: CGPoint(x: point.x, y: point.y), phase: phase))
  }
}
