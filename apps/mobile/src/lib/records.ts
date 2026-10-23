// 手机记着的电脑（配对过的 Host）。一台电脑一份记录，字段与 CLI 的 `remote-hosts/<名称>.json` 相同（ADR-0017 补记 3），只是
// 设备私钥不在记录里：私钥放系统钥匙串 / Keystore（`storage.ts`），记录里没有任何机密。另有手机才有的 `removedAt`。
// 这里只有纯逻辑，不 import React Native，Vitest 直接测。

import type { RemoteHostPayload } from '@wevir/protocol';
import { PublicKeySchema, RelayUrlSchema } from '@wevir/protocol';

/** 名称：小写字母、数字与连字符，以字母或数字开头（同 CLI）。记录的文件名与路由里的参数都用它。 */
export const RECORD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 一个直连候选地址（Host 在握手里给的，或配对链接里的）。 */
export interface StoredCandidate {
  kind?: 'lan' | 'tailscale';
  host: string;
  port: number;
}

export type RouteKind = 'direct' | 'relay';

export interface ComputerRecord {
  version: 1;
  name: string;
  /** 那台电脑报的名称。 */
  hostName?: string;
  hostPublicKey: string;
  routeId: string;
  candidates: StoredCandidate[];
  /** 上次直连胜出的地址。 */
  lastAddress?: { host: string; port: number };
  /** 那台电脑开了中继时的地址：配对链接里的 `relay`，之后按握手负载的 `relayUrl` 更新。 */
  relayUrl?: string;
  /** 上次连上走的是直连还是中继。 */
  lastRoute?: RouteKind;
  pairedAt: string;
  lastConnectedAt?: string;
  /** 那台电脑移除了这台设备的时刻（关闭码 4007，或 IK 握手被拒）。之后不再自动连，只能重新配对。 */
  removedAt?: string;
}

function isCandidate(value: unknown): value is StoredCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.host === 'string' &&
    c.host !== '' &&
    Number.isInteger(c.port) &&
    (c.kind === undefined || c.kind === 'lan' || c.kind === 'tailscale')
  );
}

/** 读进来的 JSON 是不是一份记录。 */
export function isComputerRecord(value: unknown): value is ComputerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.name === 'string' &&
    RECORD_NAME_PATTERN.test(r.name) &&
    (r.hostName === undefined || typeof r.hostName === 'string') &&
    PublicKeySchema.safeParse(r.hostPublicKey).success &&
    PublicKeySchema.safeParse(r.routeId).success &&
    Array.isArray(r.candidates) &&
    r.candidates.every(isCandidate) &&
    (r.lastAddress === undefined || isCandidate(r.lastAddress)) &&
    (r.relayUrl === undefined || RelayUrlSchema.safeParse(r.relayUrl).success) &&
    (r.lastRoute === undefined || r.lastRoute === 'direct' || r.lastRoute === 'relay') &&
    typeof r.pairedAt === 'string' &&
    (r.lastConnectedAt === undefined || typeof r.lastConnectedAt === 'string') &&
    (r.removedAt === undefined || typeof r.removedAt === 'string')
  );
}

/** 从电脑名称推一个记录名称：`Marvin's MacBook Pro` → `marvins-macbook-pro`；推不出时用 `computer`（同 CLI）。 */
export function slugifyHostName(hostName: string | undefined): string {
  const slug = (hostName ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return RECORD_NAME_PATTERN.test(slug) ? slug : 'computer';
}

/** `base` 没被占用就用它，否则依次试 `base-2`、`base-3`…（同 CLI）。 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, 32 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * 能用的直连地址：去掉回环与链路本地（mDNS 回答里常带着它们，Host 并不监听，Spike §8.5），IPv6 去掉方括号与 zone。
 */
export function usableAddress(address: string): string | undefined {
  const host = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (host === '' || host === 'localhost') return undefined;
  if (/^127\./.test(host) || host === '::1' || /^169\.254\./.test(host)) return undefined;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return undefined;
  return host;
}

/** 每次连接要试的直连地址：上次胜出的在前，然后是记下的候选，去重。 */
export function knownCandidates(
  record: Pick<ComputerRecord, 'candidates' | 'lastAddress'>,
): StoredCandidate[] {
  const seen = new Set<string>();
  const out: StoredCandidate[] = [];
  for (const candidate of [
    ...(record.lastAddress ? [record.lastAddress] : []),
    ...record.candidates,
  ]) {
    const key = `${candidate.host}|${candidate.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/**
 * 握手负载里的中继地址记回记录：有就用它；没有时只在直连连上时删掉（那台电脑关了中继）。经中继连上时负载总带着地址，这里只防
 * 万一，不因为一次没带就丢掉唯一的退路（同 CLI 的 `nextRelayUrl`）。
 */
export function nextRelayUrl(
  record: Pick<ComputerRecord, 'relayUrl'>,
  route: RouteKind,
  relayUrl: string | undefined,
): string | undefined {
  if (relayUrl !== undefined) return relayUrl;
  return route === 'direct' ? undefined : record.relayUrl;
}

export interface ConnectedInfo {
  route: RouteKind;
  /** 直连胜出的地址；经中继时没有。 */
  address?: { host: string; port: number };
  host: RemoteHostPayload;
}

/** 一次握手成功之后的记录：电脑名称、最新候选地址、胜出的地址与路径；清掉 `removedAt`。 */
export function recordAfterConnect(
  record: ComputerRecord,
  info: ConnectedInfo,
  now: Date,
): ComputerRecord {
  const {
    relayUrl: _relay,
    removedAt: _removed,
    lastAddress: previousAddress,
    hostName: previousName,
    ...rest
  } = record;
  const relayUrl = nextRelayUrl(record, info.route, info.host.relayUrl);
  const lastAddress = info.address ?? previousAddress;
  const hostName = info.host.hostName ?? previousName;
  return {
    ...rest,
    ...(hostName !== undefined && { hostName }),
    candidates: info.host.candidates.length > 0 ? info.host.candidates : record.candidates,
    ...(lastAddress !== undefined && {
      lastAddress: { host: lastAddress.host, port: lastAddress.port },
    }),
    ...(relayUrl !== undefined && { relayUrl }),
    lastRoute: info.route,
    lastConnectedAt: now.toISOString(),
  };
}

/** 显示用的名称：电脑报的名称，没有时用记录名称。 */
export function displayName(record: Pick<ComputerRecord, 'hostName' | 'name'>): string {
  return record.hostName?.trim() || record.name;
}
