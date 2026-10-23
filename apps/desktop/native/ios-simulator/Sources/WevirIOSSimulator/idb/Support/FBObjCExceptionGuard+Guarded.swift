/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// 移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，见 LICENSE-facebook-idb.txt）：FBControlCore/Utility/FBObjCExceptionGuard+Guarded.swift。
// 改动：去掉 public / package 与 FBControlCore 的 import，FBControlCoreObjC 换成本包的 ObjCExceptionGuard。

import ObjCExceptionGuard
import Foundation

extension FBObjCExceptionGuard {

  /// Runs `closure` under an Objective-C `@try`/`@catch`. A Swift `Error` thrown by the closure is
  /// rethrown unchanged; an `NSException` is thrown as an `NSError` in `FBObjCExceptionGuardErrorDomain`.
  /// Use wherever Swift messages an Objective-C API that may raise.
  static func guarded<T>(_ closure: () throws -> T) throws -> T {
    // swiftlint:disable:next implicitly_unwrapped_optional
    var capturedResult: T!
    var capturedSwiftError: Error?
    try self.run {
      do {
        capturedResult = try closure()
      } catch {
        capturedSwiftError = error
      }
    }
    if let capturedSwiftError {
      throw capturedSwiftError
    }
    return capturedResult
  }
}
