// 推送载荷的加密（ADR-0017 §6 与补记 6）：Host 与设备各自的 X25519 静态密钥做 DH，经带标签的 HKDF-SHA256 派生这一对专用的推送
// 密钥（不复用 Noise 会话的密钥），ChaChaPoly 加密，信封里带递增计数防重放。Host（Node）与手机（Hermes、iOS 通知扩展）共用这一份；
// 不 import Node 内置模块。向量在 test-vectors/push.json（test-vectors/pushgen.mjs 用 node:crypto 独立实现生成）。

import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NoiseError } from './errors.js';
import { concatBytes, DH_LENGTH, type NoisePrimitives, noblePrimitives } from './primitives.js';

/** 推送载荷的版本标签：HKDF 的 salt 与各处用途前缀的开头。 */
export const PUSH_LABEL = 'wevir-push/1';
/** 信封的版本字节。 */
export const PUSH_ENVELOPE_VERSION = 1;
/** 信封头：版本（1 字节）与计数（8 字节大端）。头也是 AEAD 的附加数据。 */
export const PUSH_HEADER_LENGTH = 9;
const TAG_LENGTH = 16;
/** 明文的上限：加密、base64url 之后仍放得进 APNs / FCM 的 4 KiB 载荷。 */
export const PUSH_MAX_PLAINTEXT_LENGTH = 2048;

const encoder = new TextEncoder();
const KEY_INFO = encoder.encode(`${PUSH_LABEL} payload key`);

/** 一方的私钥、另一方的公钥，加上双方的公钥（按 Host、设备的顺序写进 HKDF 的 info，两边算出同一把密钥）。 */
export interface PushKeyInput {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly hostPublicKey: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly primitives?: NoisePrimitives;
}

/**
 * 这一对 Host 与设备的推送密钥（32 字节）：`HKDF-SHA256(ikm = X25519(私钥, 对方公钥), salt = "wevir-push/1",
 * info = "wevir-push/1 payload key" ‖ Host 公钥 ‖ 设备公钥)`。Host 用自己的私钥与设备公钥，设备用自己的私钥与 Host 公钥。
 * DH 结果全零（低阶点）时报错。
 */
export function derivePushKey(input: PushKeyInput): Uint8Array {
  for (const key of [
    input.secretKey,
    input.publicKey,
    input.hostPublicKey,
    input.devicePublicKey,
  ]) {
    if (key.length !== DH_LENGTH) throw new NoiseError('invalid_key', 'push keys must be 32 bytes');
  }
  const primitives = input.primitives ?? noblePrimitives;
  let shared: Uint8Array;
  try {
    shared = primitives.dh(input.secretKey, input.publicKey);
  } catch {
    throw new NoiseError('invalid_key', 'X25519 failed for the push key');
  }
  if (shared.every((byte) => byte === 0)) {
    throw new NoiseError('invalid_key', 'X25519 result is all zeros');
  }
  return hkdf(
    sha256,
    shared,
    encoder.encode(PUSH_LABEL),
    concatBytes(KEY_INFO, input.hostPublicKey, input.devicePublicKey),
    32,
  );
}

/**
 * 加密一条推送：信封是 `版本 ‖ 计数（8 字节大端）‖ ChaChaPoly(密文 ‖ 16 字节标签)`。nonce 按 Noise 的写法（4 个零字节加计数的
 * 8 字节小端），附加数据是信封头。同一把密钥下计数不能重复：Host 每台设备一个只增不减的计数。
 */
export function sealPushPayload(
  key: Uint8Array,
  counter: number,
  plaintext: Uint8Array,
  primitives: NoisePrimitives = noblePrimitives,
): Uint8Array {
  checkKey(key);
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new NoiseError('nonce_exhausted', `bad push counter ${counter}`);
  }
  if (plaintext.length > PUSH_MAX_PLAINTEXT_LENGTH) {
    throw new NoiseError('frame_too_large', 'push payload is too large');
  }
  const header = pushHeader(counter);
  return concatBytes(header, primitives.encrypt(key, counter, header, plaintext));
}

/** 解开一条推送：版本不认识、长度不对时 `bad_message`，校验失败（密钥不对、被改过）时 `decrypt_failed`。 */
export function openPushPayload(
  key: Uint8Array,
  envelope: Uint8Array,
  primitives: NoisePrimitives = noblePrimitives,
): { counter: number; plaintext: Uint8Array } {
  checkKey(key);
  if (envelope.length < PUSH_HEADER_LENGTH + TAG_LENGTH) {
    throw new NoiseError('bad_message', 'push envelope is too short');
  }
  if (envelope[0] !== PUSH_ENVELOPE_VERSION) {
    throw new NoiseError('bad_message', `unknown push envelope version ${envelope[0]}`);
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, PUSH_HEADER_LENGTH);
  const high = view.getUint32(1, false);
  const low = view.getUint32(5, false);
  if (high >= 2 ** 21) throw new NoiseError('bad_message', 'push counter is out of range');
  const counter = high * 2 ** 32 + low;
  if (counter < 1) throw new NoiseError('bad_message', 'push counter is zero');
  const header = envelope.subarray(0, PUSH_HEADER_LENGTH);
  let plaintext: Uint8Array;
  try {
    plaintext = primitives.decrypt(key, counter, header, envelope.subarray(PUSH_HEADER_LENGTH));
  } catch {
    throw new NoiseError('decrypt_failed', 'push payload failed to decrypt');
  }
  return { counter, plaintext };
}

/** `sealPushPayload` 加 base64url（不带填充）：推送网关的 `payload`。 */
export function sealPushMessage(
  key: Uint8Array,
  counter: number,
  plaintext: Uint8Array,
  primitives?: NoisePrimitives,
): string {
  return toBase64Url(sealPushPayload(key, counter, plaintext, primitives));
}

/** `openPushPayload` 的 base64url 版本。 */
export function openPushMessage(
  key: Uint8Array,
  message: string,
  primitives?: NoisePrimitives,
): { counter: number; plaintext: Uint8Array } {
  return openPushPayload(key, fromBase64Url(message), primitives);
}

/**
 * 交给网关的收起键：`HMAC-SHA256(推送密钥, "wevir-push/1 collapse\n" ‖ 键)` 的前 16 字节（base64url，22 个字符）。同一会话的提醒
 * 互相取代，网关与 APNs / FCM 看不出是哪个会话。
 */
export function pushCollapseKey(key: Uint8Array, collapseKey: string): string {
  checkKey(key);
  const mac = hmac(sha256, key, encoder.encode(`${PUSH_LABEL} collapse\n${collapseKey}`));
  return toBase64Url(mac.subarray(0, 16));
}

/** 重放窗口的默认大小（按计数）：Host 的计数不小于毫秒时间戳，所以约是十分钟。 */
export const PUSH_REPLAY_WINDOW = 10 * 60_000;
const PUSH_REPLAY_MAX_ENTRIES = 1024;

/** `PushReplayGuard` 的状态，可以存起来（例如通知扩展与 App 之间共享），下次接着用。 */
export interface PushReplayState {
  highest: number;
  /** 不收小于它的计数（记满时丢掉的那些）。 */
  floor: number;
  seen: number[];
}

/**
 * 设备端的重放检查（每台电脑一个）：收过的计数不再收，比见过的最大值小一个窗口以上的不收（推送可能乱序到达，所以不要求严格递增）。
 * 只记窗口里的计数，最多 1024 个；记满时丢最小的，并把下沿抬过它，被丢掉的那些之后也不再收。
 */
export class PushReplayGuard {
  readonly #window: number;
  #highest: number;
  #floor: number;
  readonly #seen: Set<number>;

  constructor(options: { window?: number; state?: PushReplayState } = {}) {
    this.#window = options.window ?? PUSH_REPLAY_WINDOW;
    this.#highest = options.state?.highest ?? 0;
    this.#floor = options.state?.floor ?? 0;
    this.#seen = new Set(options.state?.seen ?? []);
  }

  /** 这个计数第一次见、且在窗口里：记下并返回 true。否则返回 false（丢掉这条推送）。 */
  accept(counter: number): boolean {
    if (!Number.isSafeInteger(counter) || counter < 1) return false;
    if (counter < this.#floor || this.#seen.has(counter)) return false;
    if (counter <= this.#highest - this.#window) return false;
    this.#seen.add(counter);
    if (counter > this.#highest) this.#highest = counter;
    const lowest = this.#highest - this.#window;
    for (const entry of this.#seen) if (entry <= lowest) this.#seen.delete(entry);
    while (this.#seen.size > PUSH_REPLAY_MAX_ENTRIES) {
      const min = Math.min(...this.#seen);
      this.#seen.delete(min);
      this.#floor = Math.max(this.#floor, min + 1);
    }
    return true;
  }

  state(): PushReplayState {
    return {
      highest: this.#highest,
      floor: this.#floor,
      seen: [...this.#seen].sort((a, b) => a - b),
    };
  }
}

function pushHeader(counter: number): Uint8Array {
  const header = new Uint8Array(PUSH_HEADER_LENGTH);
  const view = new DataView(header.buffer);
  header[0] = PUSH_ENVELOPE_VERSION;
  view.setUint32(1, Math.floor(counter / 2 ** 32), false);
  view.setUint32(5, counter >>> 0, false);
  return header;
}

function checkKey(key: Uint8Array): void {
  if (key.length !== 32) throw new NoiseError('invalid_key', 'push key must be 32 bytes');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/** base64url，不带填充。 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63];
    out += ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[n & 63];
  }
  return out;
}

/** 读 base64url（不带填充）；有别的字符或长度不可能时 `bad_message`。 */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new NoiseError('bad_message', 'bad base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let offset = 0;
  for (const char of text) {
    const index = LOOKUP.get(char);
    if (index === undefined) throw new NoiseError('bad_message', 'bad base64url character');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (value >> bits) & 0xff;
    }
  }
  return out;
}
