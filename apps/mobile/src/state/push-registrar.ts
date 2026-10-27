// 真实环境里的 `PushRegistrar`（push.ts）：系统令牌、`fetch` 到网关、钥匙串里的设备私钥与推送密钥。与电脑列表一起建（registry.tsx），
// 退出电脑时由它请电脑解绑。

import type { ComputerLink } from '../lib/computer-link';
import {
  computerPushKey,
  type DeviceToken,
  PushRegistrar,
  type TokenUnavailable,
} from '../lib/push';
import { deviceToken } from '../lib/push-native';
import { pushRegistrationStore } from '../lib/push-store';
import { loadDeviceKey } from '../lib/storage';

export interface AppPushRegistrar extends PushRegistrar {
  /** 下次重新向系统要令牌（令牌变了、从系统设置回来）。 */
  resetToken(): void;
  /** 系统报来的令牌与上次取到的不同（之前没取到过时不算）。 */
  tokenChanged(token: string): boolean;
}

export function createPushRegistrar(
  link: (name: string) => ComputerLink | undefined,
): AppPushRegistrar {
  let token: Promise<DeviceToken | TokenUnavailable> | undefined;
  let known: string | undefined;
  const registrar = new PushRegistrar({
    deviceToken: () => {
      // 取到令牌就记着；没取到（权限、模拟器）下次再问。
      const current = token ?? deviceToken();
      token = current;
      void current.then((value) => {
        if (typeof value !== 'string') known = value.token;
        else if (token === current) token = undefined;
      });
      return current;
    },
    post: (url, body) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    pushKey: async (computer) => {
      const record = link(computer.name)?.snapshot.record;
      if (record === undefined) throw new Error('unknown computer');
      return computerPushKey(record.hostPublicKey, await loadDeviceKey(record));
    },
    store: pushRegistrationStore,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return Object.assign(registrar, {
    resetToken: () => {
      token = undefined;
    },
    tokenChanged: (next: string) => known !== undefined && next !== known,
  });
}
