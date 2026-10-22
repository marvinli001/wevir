import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NoiseError } from './errors.js';
import { concatBytes, DH_LENGTH } from './primitives.js';

/** 远程访问协议的版本标签，写在每次握手的 prologue 开头。 */
export const REMOTE_PROTOCOL_VERSION = 'wevir-remote/1';

const PSK_LABEL = `${REMOTE_PROTOCOL_VERSION} pairing psk`;
const MAX_ROUTE_ID_LENGTH = 0xffff;

export interface RemoteRouteIds {
  /** Host 的路由 ID。 */
  readonly host: string;
  /** 设备的路由 ID（有的话）。 */
  readonly device?: string;
}

/**
 * 握手的 prologue：`wevir-remote/1`、一个零字节，然后是 Host 与设备的路由 ID，各自前面带 2 字节大端长度（没有设备路由 ID
 * 时长度为 0）。中继改动路由会让握手失败。
 */
export function remotePrologue(routeIds: RemoteRouteIds): Uint8Array {
  const encoder = new TextEncoder();
  return concatBytes(
    encoder.encode(REMOTE_PROTOCOL_VERSION),
    Uint8Array.of(0),
    lengthPrefixed(encoder.encode(routeIds.host)),
    lengthPrefixed(encoder.encode(routeIds.device ?? '')),
  );
}

/**
 * 配对用的 32 字节 PSK：HKDF-SHA256，输入是配对秘密（二维码里的随机秘密，或手输短码的 UTF-8），salt 是 Host 静态公钥，
 * info 是 `wevir-remote/1 pairing psk`。PSK 绑定了 Host 公钥：拿二维码里的公钥派生，Host 换了公钥握手就失败。
 */
export function derivePairingPsk(pairingSecret: Uint8Array, hostStaticKey: Uint8Array): Uint8Array {
  if (pairingSecret.length === 0) throw new NoiseError('invalid_key', 'pairing secret is empty');
  if (hostStaticKey.length !== DH_LENGTH)
    throw new NoiseError('invalid_key', 'host static key must be 32 bytes');
  return hkdf(sha256, pairingSecret, hostStaticKey, new TextEncoder().encode(PSK_LABEL), 32);
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_ROUTE_ID_LENGTH)
    throw new NoiseError('bad_message', 'route id is too long');
  return concatBytes(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
}
