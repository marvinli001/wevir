import { BlockList, isIP } from 'node:net';

// `web_fetch` 不去的地址（docs/architecture/web-tools.md §4）：本机、局域网、链路本地、运营商级 NAT、组播与保留地址。抓取由 Host
// 进程发出，不受 Codex 沙箱的网络限制，也不经审批；放开这些地址，网页里的一段提示词就能让模型去读本机的开发服务器、路由器
// 管理页或云主机的元数据接口（SSRF）。本机的服务请让模型用命令（`curl`），那条路走沙箱与审批。
//
// 198.18.0.0/15（基准测试网段）不拦：Clash / mihomo / Surge 的 fake-ip 模式把每个域名都解析到这里，拦了就等于在开着代理的电脑上
// 什么都抓不了。它不是局域网地址，真实的服务不在那里。

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // “这个网络”，0.0.0.0 在多数系统上连到本机
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // 运营商级 NAT；Tailscale 等也用它
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // 链路本地，含云主机的元数据接口 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留，含广播 255.255.255.255
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // ULA
  ['fe80::', 10], // 链路本地
  ['fec0::', 10], // 已废弃的站点本地
  ['ff00::', 8], // 组播
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** IPv6 里嵌着的 IPv4：IPv4 映射（`::ffff:a.b.c.d`）与已废弃的 IPv4 兼容（`::a.b.c.d`）地址按里面的 IPv4 判断。 */
function embeddedIPv4(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  // `::ffff:7f00:1` 这种十六进制写法（URL 解析后的形式）。
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return undefined;
}

/** 这个 IP 地址（字面量）是不是 `web_fetch` 不去的地址。不是 IP 的字符串返回 false。 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const version = isIP(bare);
  if (version === 4) return BLOCKED.check(bare, 'ipv4');
  if (version !== 6) return false;
  const v4 = embeddedIPv4(bare);
  if (v4 !== undefined && isIP(v4) === 4) return BLOCKED.check(v4, 'ipv4');
  return BLOCKED.check(bare, 'ipv6');
}

/** 主机名本身就指向本机：`localhost` 与 `*.localhost`（RFC 6761），不等 DNS。 */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}
