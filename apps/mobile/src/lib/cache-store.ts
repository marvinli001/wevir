// 缓存库的打开与密钥（真机）：expo-sqlite 编进 SQLCipher（app.config.ts 的 `useSQLCipher`），每台电脑一个库 `cache-<路由 ID>.db`，
// 整库用 SQLCipher 4 的默认算法（AES-256-CBC、每页 HMAC-SHA512）加密。密钥是 32 字节随机数，放系统钥匙串 / Keystore
// （expo-secure-store，`WHEN_UNLOCKED_THIS_DEVICE_ONLY`：解锁后才读得到、不随备份与换机迁移），键 `wevir.cache.<路由 ID>`，
// 以原始密钥（`x'…'`）交给 SQLCipher，不经口令派生。库文件在 App 的 SQLite 目录（iOS 文稿目录下）；随备份走的只有密文。
//
// 打开前先核对 SQLCipher 真的在（`PRAGMA cipher_version`），不在就不建缓存，绝不写明文。钥匙串里没有密钥（被清空、从备份恢复）
// 或密钥对不上时删掉旧库重建：缓存随时可以丢。

import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { ComputerCache } from './cache';

const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'wevir.cache',
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function keyName(routeId: string): string {
  return `wevir.cache.${routeId}`;
}

function databaseName(routeId: string): string {
  return `cache-${routeId}.db`;
}

async function cacheKey(routeId: string): Promise<{ hex: string; created: boolean }> {
  const stored = await SecureStore.getItemAsync(keyName(routeId), KEY_OPTIONS);
  if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) return { hex: stored, created: false };
  const created = hex(getRandomBytes(32));
  await SecureStore.setItemAsync(keyName(routeId), created, KEY_OPTIONS);
  return { hex: created, created: true };
}

async function unlock(db: SQLiteDatabase, key: string): Promise<boolean> {
  await db.execAsync(`PRAGMA key = "x'${key}'"`);
  const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
  if (!cipher?.cipher_version) throw new Error('SQLCipher is not available; the cache stays off');
  try {
    await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
    return true;
  } catch {
    return false;
  }
}

/** 打开这台电脑的缓存库；密钥不对或新建了密钥时先删旧库。 */
export async function openComputerCache(routeId: string): Promise<ComputerCache> {
  const name = databaseName(routeId);
  const { hex: key, created } = await cacheKey(routeId);
  if (created) await deleteDatabaseAsync(name).catch(() => {});
  let db = await openDatabaseAsync(name);
  if (!(await unlock(db, key))) {
    await db.closeAsync();
    await deleteDatabaseAsync(name);
    db = await openDatabaseAsync(name);
    if (!(await unlock(db, key))) throw new Error('could not open the cache database');
  }
  return ComputerCache.open(db);
}

/** 退出这台电脑：删库与密钥。 */
export async function deleteComputerCache(routeId: string): Promise<void> {
  await deleteDatabaseAsync(databaseName(routeId)).catch(() => {});
  await SecureStore.deleteItemAsync(keyName(routeId), KEY_OPTIONS);
}
