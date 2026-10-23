// mDNS 回答（react-native-zeroconf 解析出的服务）→ 局域网里的一个 Wevir Host。纯逻辑，Vitest 测。

import { PublicKeySchema, REMOTE_MDNS_TXT_VERSION } from '@wevir/protocol';
import type { DiscoveredHost } from './pairing';

export interface ResolvedService {
  name: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}

/** TXT 的 `v` 不对、`rid` / `pk` 不是 32 字节公钥、没有端口时不是 Wevir（或是别的版本）。 */
export function toDiscoveredHost(service: ResolvedService): DiscoveredHost | undefined {
  const txt = service.txt ?? {};
  if (txt.v !== REMOTE_MDNS_TXT_VERSION) return undefined;
  const routeId = txt.rid;
  const hostPublicKey = txt.pk;
  if (
    !PublicKeySchema.safeParse(routeId).success ||
    !PublicKeySchema.safeParse(hostPublicKey).success
  )
    return undefined;
  if (!Number.isInteger(service.port) || service.port <= 0 || service.port > 65_535)
    return undefined;
  return {
    routeId: routeId as string,
    hostPublicKey: hostPublicKey as string,
    port: service.port,
    addresses: [...new Set(service.addresses ?? [])],
  };
}

/** 同一台电脑的两次回答合并地址；没有新东西时返回 `undefined`。 */
export function mergeDiscovered(
  before: DiscoveredHost | undefined,
  next: DiscoveredHost,
): DiscoveredHost | undefined {
  if (before === undefined) return next;
  const addresses = [...new Set([...before.addresses, ...next.addresses])];
  if (
    before.port === next.port &&
    before.hostPublicKey === next.hostPublicKey &&
    addresses.length === before.addresses.length
  )
    return undefined;
  return { ...next, addresses };
}
