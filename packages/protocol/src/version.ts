import { z } from 'zod';

/**
 * Host API 协议版本（semver，只用 `主.次.修订` 三段，不带预发布标签）。
 *
 * 兼容规则（docs/architecture/host-api.md「兼容规则」）：
 * - 主版本不同即不兼容，Host 拒绝 `host.hello`（`INCOMPATIBLE_PROTOCOL`）。
 * - 同一主版本内，次版本只增不减、向后兼容：新 Host 能服务旧客户端，旧 Host 能解析新客户端的请求
 *   （新字段一律 optional）。
 * - 修订号只用于文档与 schema 的修正，不改变线缆形状。
 */
export const PROTOCOL_VERSION = '0.97.0';

/** Host 仍接受的最低客户端协议版本。与 `PROTOCOL_VERSION` 主版本相同。 */
export const MIN_PROTOCOL_VERSION = '0.1.0';

export const ProtocolVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export interface ParsedProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseProtocolVersion(version: string): ParsedProtocolVersion | null {
  if (!ProtocolVersionSchema.safeParse(version).success) return null;
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return { major, minor, patch };
}

export function compareProtocolVersions(a: string, b: string): number {
  const pa = parseProtocolVersion(a);
  const pb = parseProtocolVersion(b);
  if (!pa || !pb) throw new Error(`invalid protocol version: ${!pa ? a : b}`);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

export type ProtocolNegotiation =
  | { ok: true; protocolVersion: string }
  | { ok: false; reason: 'invalid_version' | 'major_mismatch' | 'below_minimum' };

/**
 * `host.hello` 的版本协商：主版本必须相同，客户端版本不得低于 `minProtocolVersion`；
 * 协商结果取双方中较低的版本，双方都按它理解线缆。
 */
export function negotiateProtocolVersion(
  clientVersion: string,
  hostVersion: string = PROTOCOL_VERSION,
  minProtocolVersion: string = MIN_PROTOCOL_VERSION,
): ProtocolNegotiation {
  const client = parseProtocolVersion(clientVersion);
  const host = parseProtocolVersion(hostVersion);
  if (!client || !host) return { ok: false, reason: 'invalid_version' };
  if (client.major !== host.major) return { ok: false, reason: 'major_mismatch' };
  if (compareProtocolVersions(clientVersion, minProtocolVersion) < 0) {
    return { ok: false, reason: 'below_minimum' };
  }
  const protocolVersion =
    compareProtocolVersions(clientVersion, hostVersion) <= 0 ? clientVersion : hostVersion;
  return { ok: true, protocolVersion };
}
