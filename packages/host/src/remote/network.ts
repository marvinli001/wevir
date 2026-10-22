import { Resolver } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import type {
  NetworkFamily,
  RemoteInterface,
  RemoteInterfaceRef,
  RemoteSettings,
} from '@wevir/protocol';

/** `os.networkInterfaces()` 的形状，测试注入假的。 */
export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** 一个能监听的地址。 */
export interface RemoteAddress {
  readonly name: string;
  readonly family: NetworkFamily;
  readonly kind: 'lan' | 'tailscale';
  readonly address: string;
}

/**
 * 认出能做远程监听的地址（ADR-0017 §1，security.md 的“远程访问”）。只认两类，其余（回环、链路本地、公网、别的 CGNAT 段）一律不列、
 * 从不监听：
 * - Tailscale：IPv4 在 `100.64.0.0/10`，或 IPv6 在 `fd7a:115c:a1e0::/48`。按地址段认，不按网卡名（macOS 上它也是 `utunN`，编号会变）。
 *   单有 `100.64/10` 也可能是别的 CGNAT 型 VPN，所以设置页列出网卡名与地址让用户确认。
 * - 局域网：IPv4 的私有地址段（`10/8`、`172.16/12`、`192.168/16`），IPv6 的唯一本地地址（`fc00::/7`，Tailscale 那段除外）。
 *   公网地址（包括 IPv6 的全局单播）不算局域网，不监听。
 */
export function classifyAddress(address: string, internal: boolean): 'lan' | 'tailscale' | null {
  if (internal) return null;
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    if (a === 100 && b >= 64 && b < 128) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) return 'lan';
    return null;
  }
  if (isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith('fd7a:115c:a1e0:')) return 'tailscale';
    // fc00::/7：第一组是 fcxx 或 fdxx（四位）。
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return 'lan';
    return null;
  }
  return null;
}

/** 按设置这个地址该不该监听。 */
export function isSelected(
  address: Pick<RemoteAddress, 'name' | 'family' | 'kind'>,
  settings: RemoteSettings | undefined,
): boolean {
  if (settings?.enabled !== true) return false;
  if (address.kind === 'tailscale') return settings.interfaces.tailscale;
  if (!settings.interfaces.lan) return false;
  const only = settings.interfaces.lanInterfaces;
  return only === undefined || only.some((ref) => sameRef(ref, address));
}

/** 全部认出的地址，按网卡名、地址族排序。`classify` 只给测试换（让回环地址算局域网，好在真实 socket 上测）。 */
export function remoteAddresses(
  interfaces: NetworkInterfaces,
  classify: typeof classifyAddress = classifyAddress,
): RemoteAddress[] {
  const addresses: RemoteAddress[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      const kind = classify(info.address, info.internal);
      if (kind === null) continue;
      // Node 18 起 family 是字符串；更早的版本给数字。
      const family: NetworkFamily =
        String(info.family) === '6' || info.family === 'IPv6' ? 'IPv6' : 'IPv4';
      addresses.push({ name, family, kind, address: info.address });
    }
  }
  return addresses.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.family.localeCompare(b.family) ||
      a.address.localeCompare(b.address),
  );
}

/** 设置页列出的网卡：同一网卡同一地址族的地址合成一项。 */
export function describeInterfaces(
  addresses: readonly RemoteAddress[],
  settings: RemoteSettings | undefined,
  listening: ReadonlySet<string>,
): RemoteInterface[] {
  const byRef = new Map<string, RemoteInterface>();
  for (const address of addresses) {
    const key = `${address.name}\u0000${address.family}\u0000${address.kind}`;
    let entry = byRef.get(key);
    if (entry === undefined) {
      entry = {
        name: address.name,
        family: address.family,
        kind: address.kind,
        addresses: [],
        selected: isSelected(address, settings),
        listening: [],
      };
      byRef.set(key, entry);
    }
    entry.addresses.push(address.address);
    if (listening.has(address.address)) entry.listening.push(address.address);
  }
  return [...byRef.values()];
}

function sameRef(
  ref: RemoteInterfaceRef,
  address: Pick<RemoteAddress, 'name' | 'family'>,
): boolean {
  return ref.name === address.name && ref.family === address.family;
}

/** Tailscale 的 MagicDNS 解析器（每台装了 Tailscale 的机器上都在这个地址）。 */
const MAGIC_DNS_SERVER = '100.100.100.100';

/**
 * 查 Tailscale 地址的 MagicDNS 名：向 MagicDNS 解析器反查这个地址（PTR），得到 `<机器>.<tailnet>.ts.net`。Tailscale 没开 MagicDNS、
 * 没在跑或超时时是 undefined。不调 `tailscale` 命令（各平台的路径不同）。
 */
export async function lookupMagicDnsName(
  address: string,
  timeoutMs = 1500,
): Promise<string | undefined> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers([MAGIC_DNS_SERVER]);
  try {
    const [name] = await resolver.reverse(address);
    return name === undefined || name === '' ? undefined : name.replace(/\.$/, '');
  } catch {
    return undefined;
  }
}
