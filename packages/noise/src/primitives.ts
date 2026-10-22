import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NoiseError } from './errors.js';

/** X25519 密钥对，两半都是 32 字节。 */
export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/**
 * Noise 的原语：DH 是 25519，密码是 ChaChaPoly，哈希是 SHA-256。默认用 noble 的纯 JS 实现；手机端要加速时在自己的包里
 * 换一个实现（例如 AEAD 与哈希走原生），同一份状态机不动。
 */
export interface NoisePrimitives {
  generateKeyPair(): KeyPair;
  /** X25519。对方公钥是全零 / 低阶点时应当抛错；状态机另外检查结果是否全零。 */
  dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** ChaCha20-Poly1305，nonce 是 Noise 的 64 位计数器（这里不超过 2^53 - 1），按 Noise 编成 4 个零字节加 8 字节小端。 */
  encrypt(key: Uint8Array, nonce: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** 校验失败时抛错。 */
  decrypt(key: Uint8Array, nonce: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  /** SHA-256。 */
  hash(data: Uint8Array): Uint8Array;
  /** HMAC-SHA256。不给时状态机用 `hash` 自己算。 */
  hmac?(key: Uint8Array, data: Uint8Array): Uint8Array;
}

export const DH_LENGTH = 32;
export const HASH_LENGTH = 32;
const HASH_BLOCK_LENGTH = 64;
// getRandomValues 一次最多 65536 字节（Web Crypto 的规定）。
const RANDOM_CHUNK = 65536;

interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** 随机字节，只用 `globalThis.crypto.getRandomValues`（Node、浏览器都有；Hermes 要先由 expo-crypto 补上）。 */
export function randomBytes(length: number): Uint8Array {
  const crypto = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new NoiseError('no_random', 'globalThis.crypto.getRandomValues is not available');
  }
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += RANDOM_CHUNK) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + RANDOM_CHUNK, length)));
  }
  return out;
}

/** X25519 私钥对应的公钥。 */
export function publicKeyFromSecretKey(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== DH_LENGTH)
    throw new NoiseError('invalid_key', 'X25519 secret key must be 32 bytes');
  return x25519.getPublicKey(secretKey);
}

/** ChaChaPoly 的 96 位 nonce：4 个零字节，后接 64 位计数器的小端表示。 */
export function chachaNonce(nonce: number): Uint8Array {
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw new NoiseError('nonce_exhausted', `bad nonce ${nonce}`);
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint32(4, nonce >>> 0, true);
  view.setUint32(8, Math.floor(nonce / 2 ** 32), true);
  return out;
}

/** 默认原语：`@noble/curves`、`@noble/ciphers`、`@noble/hashes`。noble 自己会拒绝产生全零 DH 结果的公钥。 */
export const noblePrimitives: NoisePrimitives = {
  generateKeyPair() {
    const secretKey = randomBytes(DH_LENGTH);
    return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
  },
  dh: (secretKey, publicKey) => x25519.getSharedSecret(secretKey, publicKey),
  encrypt: (key, nonce, ad, plaintext) =>
    chacha20poly1305(key, chachaNonce(nonce), ad).encrypt(plaintext),
  decrypt: (key, nonce, ad, ciphertext) =>
    chacha20poly1305(key, chachaNonce(nonce), ad).decrypt(ciphertext),
  hash: (data) => sha256(data),
  hmac: (key, data) => hmac(sha256, key, data),
};

/** 新的 X25519 密钥对（Host 与设备的静态密钥），用默认原语生成。 */
export function generateKeyPair(): KeyPair {
  return noblePrimitives.generateKeyPair();
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 长度相同时按字节比较，不提前返回。 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function hmacWith(
  primitives: NoisePrimitives,
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  if (primitives.hmac) return primitives.hmac(key, data);
  const block = key.length > HASH_BLOCK_LENGTH ? primitives.hash(key) : key;
  const inner = new Uint8Array(HASH_BLOCK_LENGTH);
  const outer = new Uint8Array(HASH_BLOCK_LENGTH);
  inner.set(block);
  outer.set(block);
  for (let i = 0; i < HASH_BLOCK_LENGTH; i++) {
    inner[i] = (inner[i] ?? 0) ^ 0x36;
    outer[i] = (outer[i] ?? 0) ^ 0x5c;
  }
  return primitives.hash(concatBytes(outer, primitives.hash(concatBytes(inner, data))));
}
