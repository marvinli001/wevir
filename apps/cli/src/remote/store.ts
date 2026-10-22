// CLI 记着的远程电脑（配对过的 Host）：数据目录下 `remote-hosts/<名称>.json`，一台电脑一份，含这台设备给它的 Noise 私钥，所以目录
// 0700、文件 0600。私钥只在这里，不进日志、不打印。

import { chmod, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesToBase64url } from '@wevir/client-sdk';
import { generateKeyPair, type KeyPair, publicKeyFromSecretKey } from '@wevir/noise';
import { PublicKeySchema, RelayUrlSchema } from '@wevir/protocol';
import { CliError } from '../errors.js';
import { t } from '../i18n/index.js';

export const REMOTE_HOSTS_DIR = 'remote-hosts';

/** 名称：小写字母、数字与连字符，以字母或数字开头。`--remote <名称>` 与文件名都用它。 */
export const REMOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 一个直连候选地址（Host 在握手里给的，或配对链接里的）。 */
export interface StoredCandidate {
  kind?: 'lan' | 'tailscale';
  host: string;
  port: number;
}

export interface RemoteHostRecord {
  version: 1;
  name: string;
  /** 那台电脑报的名称。 */
  hostName?: string;
  hostPublicKey: string;
  routeId: string;
  /** 这台设备给那台电脑的 Noise 私钥（X25519，base64url）。公钥由它算出。 */
  deviceSecretKey: string;
  candidates: StoredCandidate[];
  /** 上次直连胜出的地址。 */
  lastAddress?: { host: string; port: number };
  /** 那台电脑开了中继时的地址：配对链接里的 `relay`，之后按握手负载的 `relayUrl` 更新。 */
  relayUrl?: string;
  /** 上次连上走的是直连还是中继。 */
  lastRoute?: 'direct' | 'relay';
  pairedAt: string;
  lastConnectedAt?: string;
}

export function remoteHostsDir(home: string): string {
  return join(home, REMOTE_HOSTS_DIR);
}

function recordPath(home: string, name: string): string {
  return join(remoteHostsDir(home), `${name}.json`);
}

export function newDeviceKeys(): KeyPair {
  return generateKeyPair();
}

export function deviceKeys(record: RemoteHostRecord): KeyPair {
  const secretKey = new Uint8Array(Buffer.from(record.deviceSecretKey, 'base64url'));
  return { secretKey, publicKey: publicKeyFromSecretKey(secretKey) };
}

export function encodeSecretKey(keys: KeyPair): string {
  return bytesToBase64url(keys.secretKey);
}

/** 读全部记录，按名称排序。坏掉的文件报错（带路径），不悄悄跳过。 */
export async function listRemoteHosts(home: string): Promise<RemoteHostRecord[]> {
  let names: string[];
  try {
    names = await readdir(remoteHostsDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: RemoteHostRecord[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    records.push(await readRecord(join(remoteHostsDir(home), file)));
  }
  return records;
}

export async function findRemoteHost(
  home: string,
  name: string,
): Promise<RemoteHostRecord | undefined> {
  if (!REMOTE_NAME_PATTERN.test(name)) return undefined;
  return readRecord(recordPath(home, name), true);
}

async function readRecord(path: string): Promise<RemoteHostRecord>;
async function readRecord(path: string, missingOk: true): Promise<RemoteHostRecord | undefined>;
async function readRecord(path: string, missingOk = false): Promise<RemoteHostRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (missingOk && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CliError(t('remote.storeUnreadable', { path }));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!isRecord(value)) {
    throw new CliError(t('remote.storeInvalid', { path }), t('remote.storeInvalid.hint'));
  }
  return value;
}

function isRecord(value: unknown): value is RemoteHostRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.name === 'string' &&
    REMOTE_NAME_PATTERN.test(r.name) &&
    PublicKeySchema.safeParse(r.hostPublicKey).success &&
    PublicKeySchema.safeParse(r.routeId).success &&
    PublicKeySchema.safeParse(r.deviceSecretKey).success &&
    Array.isArray(r.candidates) &&
    r.candidates.every(
      (c: unknown) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as StoredCandidate).host === 'string' &&
        Number.isInteger((c as StoredCandidate).port),
    ) &&
    (r.relayUrl === undefined || RelayUrlSchema.safeParse(r.relayUrl).success) &&
    (r.lastRoute === undefined || r.lastRoute === 'direct' || r.lastRoute === 'relay') &&
    typeof r.pairedAt === 'string'
  );
}

/** 写入（覆盖同名的）：先写同目录的临时文件（0600）再改名，写到一半断电不会留下半个文件。 */
export async function saveRemoteHost(home: string, record: RemoteHostRecord): Promise<void> {
  const dir = remoteHostsDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = recordPath(home, record.name);
  const temp = join(dir, `.${record.name}.${process.pid}.tmp`);
  const file = await open(temp, 'w', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function removeRemoteHost(home: string, name: string): Promise<void> {
  await rm(recordPath(home, name), { force: true });
}

/** 从电脑名称推一个记录名称：`Marvin's MacBook Pro` → `marvins-macbook-pro`；推不出时用 `computer`。 */
export function slugifyHostName(hostName: string | undefined): string {
  const slug = (hostName ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return REMOTE_NAME_PATTERN.test(slug) ? slug : 'computer';
}

/** `base` 没被占用就用它，否则依次试 `base-2`、`base-3`…；`taken` 是已有的名称。 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(name)) return name;
  }
}
