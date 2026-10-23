/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// 移植自 facebook/idb（提交 14baeffc8f681380527c400a8184512b746ee918，MIT 许可证，见 LICENSE-facebook-idb.txt）：FBControlCore/Utility/SymbolLoading.swift。
// 改动：去掉 public。

import Foundation

/// Resolves a symbol in an opened image, trapping when it is not there.
///
/// Callers reinterpret the result as a function pointer, so a name that does not resolve would
/// otherwise put a null pointer in a call table to be crashed through at some later call.
func symbolFromHandle(_ handle: UnsafeMutableRawPointer, _ name: String) -> UnsafeMutableRawPointer {
  guard let symbol = symbolFromHandleIfPresent(handle, name) else {
    preconditionFailure("\(name) could not be located")
  }
  return symbol
}

/// Resolves a symbol in an opened image, returning nil when it is not there.
func symbolFromHandleIfPresent(_ handle: UnsafeMutableRawPointer, _ name: String) -> UnsafeMutableRawPointer? {
  dlsym(handle, name)
}

extension Bundle {

  /// Opens the bundle's executable and returns its handle.
  ///
  /// The bundle must already be loaded — a bundle NSBundle does not consider loaded is a caller
  /// that skipped `WeakFramework`, not a condition to recover from.
  func dlopenExecutablePath() -> UnsafeMutableRawPointer {
    precondition(isLoaded, "\(self) is not loaded")
    guard let path = executablePath else {
      preconditionFailure("\(self) has no executable path")
    }
    guard let handle = dlopen(path, RTLD_LAZY) else {
      preconditionFailure("\(self) dlopen handle from \(path) could not be obtained")
    }
    return handle
  }
}
