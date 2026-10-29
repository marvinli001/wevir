// 手机端的存储：
// - 记录（非机密）：App 文稿目录下 `remote-hosts/<名称>.json`，一台电脑一份，格式见 `records.ts`。之后 M2b 的会话缓存另放 SQLite，
//   记录只有几份、要在连上之前读到，放文件够用。
// - 设备私钥：系统钥匙串 / Keystore（expo-secure-store，`WHEN_UNLOCKED_THIS_DEVICE_ONLY`：解锁后才读得到、不随 iCloud 备份或换机迁移）。
//   每台电脑一把，键是 `wevir.device.<路由 ID>`；iOS 上在 App Group 的访问组里（keychain.ts）。私钥不进记录、日志与界面。
// - `host.hello` 的身份（deviceId / clientId）：文稿目录下 `identity.json`，不是机密。
// - 新建会话上次的选择：文稿目录下 `new-session.json`（`NewSessionMemory`），只有 ID 与选项，不是机密。

import { base64urlToBytes, bytesToBase64url } from '@wevir/client-sdk';
import { type KeyPair, publicKeyFromSecretKey } from '@wevir/noise';
import type { ClientIdentity } from '@wevir/protocol';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { DeviceKeyMissingError } from './computer-link';
import type { ComputerStorage } from './computers';
import { IOS_APP_GROUP, KEYCHAIN_SERVICE } from './keychain';
import { isNewSessionMemory, type NewSessionMemory } from './new-session';
import { type ComputerRecord, isComputerRecord, RECORD_NAME_PATTERN } from './records';

const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: KEYCHAIN_SERVICE,
  // iOS：放进与以后的通知服务扩展共有的访问组（keychain.ts）。Android 忽略它。
  ...(Platform.OS === 'ios' && { accessGroup: IOS_APP_GROUP }),
};

function recordsDir(): Directory {
  return new Directory(Paths.document, 'remote-hosts');
}

function recordFile(name: string): File {
  if (!RECORD_NAME_PATTERN.test(name)) throw new Error(`invalid record name: ${name}`);
  return new File(recordsDir(), `${name}.json`);
}

function deviceKeyName(routeId: string): string {
  return `wevir.device.${routeId}`;
}

export const fileStorage: ComputerStorage = {
  async list() {
    const dir = recordsDir();
    if (!dir.exists) return [];
    const records: ComputerRecord[] = [];
    for (const entry of dir.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.json') || entry.name.startsWith('.'))
        continue;
      try {
        const value: unknown = JSON.parse(await entry.text());
        if (isComputerRecord(value)) records.push(value);
        else console.warn(`[wevir] ignoring an invalid computer record: ${entry.name}`);
      } catch {
        console.warn(`[wevir] ignoring an unreadable computer record: ${entry.name}`);
      }
    }
    return records;
  },

  async save(record) {
    const dir = recordsDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    // 先写临时文件再改名，写到一半退出不会留下半份记录。
    const temp = new File(dir, `.${record.name}.tmp`);
    if (temp.exists) temp.delete();
    temp.create();
    await temp.write(`${JSON.stringify(record, null, 2)}\n`);
    await temp.move(recordFile(record.name), { overwrite: true });
  },

  async remove(name) {
    const file = recordFile(name);
    if (file.exists) file.delete();
  },

  async saveKey(routeId, secretKey) {
    await SecureStore.setItemAsync(
      deviceKeyName(routeId),
      bytesToBase64url(secretKey),
      KEY_OPTIONS,
    );
  },

  async deleteKey(routeId) {
    await SecureStore.deleteItemAsync(deviceKeyName(routeId), KEY_OPTIONS);
  },
};

export async function loadDeviceKey(record: ComputerRecord): Promise<KeyPair> {
  const text = await SecureStore.getItemAsync(deviceKeyName(record.routeId), KEY_OPTIONS);
  if (text === null) throw new DeviceKeyMissingError();
  const secretKey = base64urlToBytes(text);
  return { secretKey, publicKey: publicKeyFromSecretKey(secretKey) };
}

let identity: Promise<ClientIdentity> | undefined;

/** `host.hello` 的身份：第一次用时生成并记下，之后不变。 */
export function loadIdentity(): Promise<ClientIdentity> {
  identity ??= (async () => {
    const file = new File(Paths.document, 'identity.json');
    if (file.exists) {
      try {
        const value = JSON.parse(await file.text()) as Partial<ClientIdentity>;
        if (typeof value.deviceId === 'string' && typeof value.clientId === 'string')
          return { clientKind: 'mobile', deviceId: value.deviceId, clientId: value.clientId };
      } catch {
        // 坏了就重建。
      }
    }
    const hex = (n: number) =>
      Array.from(getRandomBytes(n), (b) => b.toString(16).padStart(2, '0')).join('');
    const created: ClientIdentity = {
      clientKind: 'mobile',
      deviceId: `dev-${hex(6)}`,
      clientId: `mobile-${hex(6)}`,
    };
    if (file.exists) file.delete();
    file.create();
    await file.write(JSON.stringify({ deviceId: created.deviceId, clientId: created.clientId }));
    return created;
  })();
  return identity;
}

function newSessionFile(): File {
  return new File(Paths.document, 'new-session.json');
}

/** 新建会话上次的选择；没有或读不了时是空的。 */
export async function loadNewSessionMemory(): Promise<NewSessionMemory> {
  try {
    const file = newSessionFile();
    if (file.exists) {
      const value: unknown = JSON.parse(await file.text());
      if (isNewSessionMemory(value)) return value;
    }
  } catch {
    // 坏了就当没有。
  }
  return { computers: {} };
}

export async function saveNewSessionMemory(memory: NewSessionMemory): Promise<void> {
  const file = newSessionFile();
  if (!file.exists) file.create();
  await file.write(JSON.stringify(memory));
}
