// 推送在手机上存的东西（push.ts 的文件头说为什么）：
// - 推送密钥：钥匙串 / Keystore，服务名 `wevir.push`，键 `wevir.push.<路由 ID>`，值是 32 字节的 base64url。“首次解锁后可读、仅本机”
//   （`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`），锁屏时 iOS 的通知服务扩展也读得到；iOS 上与设备私钥同在 App Group 的访问组。
// - 共享目录（iOS 是 App Group `group.si.wevir.mobile` 的容器，扩展读写；Android 是文稿目录，后台任务读写）下的 `push/`：
//   `computers.json`（扩展要逐台试的电脑与锁屏设置，不是机密）、`replay.json`（每台电脑的重放状态）。
// - 文稿目录下的 `push-registrations.json`：每台电脑登记过的令牌（`<平台>:<令牌>`），只给 App 判断要不要重登。
//
// 扩展照 expo-secure-store 的写法查推送密钥（keychain.ts 的说明，服务名换成 `wevir.push:no-auth`），文件格式见
// plugins/notification-service/NotificationService.swift。

import { base64urlToBytes, bytesToBase64url } from '@wevir/client-sdk';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { IOS_APP_GROUP } from './keychain';
import type { PushKeyEntry, PushRegistrationStore, PushReplayStates } from './push';

/** 推送密钥的钥匙串服务名（expo-secure-store 的 `keychainService`）。 */
export const PUSH_KEYCHAIN_SERVICE = 'wevir.push';

const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: PUSH_KEYCHAIN_SERVICE,
  ...(Platform.OS === 'ios' && { accessGroup: IOS_APP_GROUP }),
};

function pushKeyName(routeId: string): string {
  return `wevir.push.${routeId}`;
}

/** 扩展 / 后台任务要的电脑清单与设置（`push/computers.json`）。 */
export interface PushSharedState {
  version: 1;
  /** 锁屏时只显示“需要处理”。 */
  hideOnLockScreen: boolean;
  computers: Array<{ name: string; routeId: string }>;
}

const EMPTY_SHARED: PushSharedState = { version: 1, hideOnLockScreen: false, computers: [] };

function sharedDir(): Directory {
  if (Platform.OS === 'ios') {
    const container = Paths.appleSharedContainers[IOS_APP_GROUP];
    if (container !== undefined) return new Directory(container, 'push');
  }
  return new Directory(Paths.document, 'push');
}

async function readJson<T>(file: File, fallback: T): Promise<T> {
  if (!file.exists) return fallback;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return fallback;
  }
}

/** 先写临时文件再改名：扩展可能正同时读。 */
async function writeJson(file: File, value: unknown): Promise<void> {
  const dir = file.parentDirectory;
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const temp = new File(dir, `.${file.name}.tmp`);
  if (temp.exists) temp.delete();
  temp.create();
  await temp.write(JSON.stringify(value));
  await temp.move(file, { overwrite: true });
}

export async function readSharedState(): Promise<PushSharedState> {
  const value = await readJson<Partial<PushSharedState>>(
    new File(sharedDir(), 'computers.json'),
    EMPTY_SHARED,
  );
  return {
    version: 1,
    hideOnLockScreen: value.hideOnLockScreen === true,
    computers: Array.isArray(value.computers)
      ? value.computers.filter(
          (c): c is { name: string; routeId: string } =>
            typeof c?.name === 'string' && typeof c.routeId === 'string',
        )
      : [],
  };
}

export async function writeSharedState(state: PushSharedState): Promise<void> {
  await writeJson(new File(sharedDir(), 'computers.json'), state);
}

export async function readReplayStates(): Promise<PushReplayStates> {
  return readJson<PushReplayStates>(new File(sharedDir(), 'replay.json'), {});
}

export async function writeReplayStates(states: PushReplayStates): Promise<void> {
  await writeJson(new File(sharedDir(), 'replay.json'), states);
}

/** 共享清单里每台电脑的推送密钥（Android 的后台任务解密用；读不到密钥的跳过）。 */
export async function loadPushKeys(state: PushSharedState): Promise<PushKeyEntry[]> {
  const entries: PushKeyEntry[] = [];
  for (const computer of state.computers) {
    const text = await SecureStore.getItemAsync(pushKeyName(computer.routeId), KEY_OPTIONS).catch(
      () => null,
    );
    if (text === null) continue;
    try {
      entries.push({ ...computer, key: base64urlToBytes(text) });
    } catch {
      // 坏了的跳过；下次前台登记时重写。
    }
  }
  return entries;
}

function registrationsFile(): File {
  return new File(Paths.document, 'push-registrations.json');
}

export const pushRegistrationStore: PushRegistrationStore = {
  async registration(routeId) {
    const all = await readJson<Record<string, string>>(registrationsFile(), {});
    return typeof all[routeId] === 'string' ? all[routeId] : undefined;
  },
  async setRegistration(routeId, value) {
    const all = await readJson<Record<string, string>>(registrationsFile(), {});
    if (value === undefined) {
      if (!(routeId in all)) return;
      delete all[routeId];
    } else {
      if (all[routeId] === value) return;
      all[routeId] = value;
    }
    await writeJson(registrationsFile(), all);
  },
  async saveKey(routeId, key) {
    await SecureStore.setItemAsync(pushKeyName(routeId), bytesToBase64url(key), KEY_OPTIONS);
  },
  async deleteKey(routeId) {
    await SecureStore.deleteItemAsync(pushKeyName(routeId), KEY_OPTIONS);
  },
};
