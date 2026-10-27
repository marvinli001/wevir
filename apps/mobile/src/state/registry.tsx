// 全 App 共用的电脑列表：一个 `ComputerRegistry`（真实的存储、网络与 mDNS），跟着 `AppState` 在前台连、进后台断。

import { generateKeyPair } from '@wevir/noise';
import { DEVICE_NAME_MAX_LENGTH } from '@wevir/protocol';
import * as Device from 'expo-device';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState, Platform } from 'react-native';
import { cacheProvider } from '../lib/cache';
import { deleteComputerCache, openComputerCache } from '../lib/cache-store';
import type { LinkSnapshot } from '../lib/computer-link';
import { ComputerRegistry } from '../lib/computers';
import { browseWevirHosts } from '../lib/mdns';
import type { PairingEnvironment } from '../lib/pairing';
import {
  type NativeWebSocketConstructor,
  type RemoteDeps,
  remoteConnect,
  remotePair,
  withNativeOrigin,
} from '../lib/remote';
import { fileStorage, loadDeviceKey, loadIdentity } from '../lib/storage';

const remoteDeps: RemoteDeps = {
  // React Native 自带的 WebSocket（iOS 的 SocketRocket、Android 的 OkHttp），`binaryType = 'arraybuffer'` 由 client-sdk 设。
  WebSocket: withNativeOrigin(globalThis.WebSocket as unknown as NativeWebSocketConstructor),
  browse: browseWevirHosts,
  identity: loadIdentity,
};

function createRegistry(): ComputerRegistry {
  return new ComputerRegistry(fileStorage, {
    cache: cacheProvider({
      open: openComputerCache,
      remove: deleteComputerCache,
      warn: (message, error) => console.warn(`[wevir] ${message}`, error),
    }),
    connect: remoteConnect(remoteDeps, loadDeviceKey),
    now: () => new Date(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

const RegistryContext = createContext<ComputerRegistry | undefined>(undefined);

export function RegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  useEffect(() => {
    let disposed = false;
    registry
      .load()
      .catch((error: unknown) => console.warn('[wevir] could not read the computer records', error))
      .finally(() => {
        if (!disposed) registry.setActive(AppState.currentState !== 'background');
      });
    // 只在真正进后台时断开：系统弹窗（本地网络、相机权限）会让 App 短暂 inactive。
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') registry.setActive(true);
      else if (state === 'background') registry.setActive(false);
    });
    return () => {
      disposed = true;
      subscription.remove();
      registry.setActive(false);
    };
  }, [registry]);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useRegistry(): ComputerRegistry {
  const registry = useContext(RegistryContext);
  if (registry === undefined) throw new Error('useRegistry outside RegistryProvider');
  return registry;
}

export function useComputers(): { loaded: boolean; computers: readonly LinkSnapshot[] } {
  const registry = useRegistry();
  const computers = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.snapshots,
  );
  return { loaded: registry.loaded, computers };
}

export function useComputer(name: string): LinkSnapshot | undefined {
  const { computers } = useComputers();
  return computers.find((c) => c.record.name === name);
}

/** 配对用的环境：真实的 mDNS 与网络，设备名称与平台由界面给。 */
export function pairingEnvironment(deviceName: string): PairingEnvironment {
  return {
    browse: browseWevirHosts,
    pair: remotePair(remoteDeps, {
      name: deviceName,
      platform: Platform.OS === 'android' ? 'android' : 'ios',
    }),
    generateKeyPair,
    now: () => new Date(),
  };
}

/** 设备名称的初值：系统设备名，没有时用机型。 */
export function defaultDeviceName(): string {
  const name = (Device.deviceName ?? Device.modelName ?? 'Wevir Mobile').trim();
  return (name === '' ? 'Wevir Mobile' : name).slice(0, DEVICE_NAME_MAX_LENGTH);
}
