import { NoiseError } from './errors.js';
import type { NoisePrimitives } from './primitives.js';

/** Noise 单条消息的上限（含 16 字节标签）。 */
export const MAX_MESSAGE_LENGTH = 65535;
export const TAG_LENGTH = 16;
/**
 * nonce 用 JS 的 number，到 2^53 - 1 就报错（Noise 自己保留的是 2^64 - 1）。每条连接都重新握手、不做 rekey，
 * 实际用不到这么多。
 */
export const MAX_NONCE = Number.MAX_SAFE_INTEGER;

/**
 * Noise 的 CipherState：一把密钥与隐式递增的 nonce。传输阶段每个方向一个（`HandshakeState.split()` 给出）。
 * 解密失败一次后这个对象就作废，之后的调用都抛 `invalid_state`：远程连接遇到解密失败就断开，不尝试重同步。
 */
export class CipherState {
  readonly #primitives: NoisePrimitives;
  readonly #key: Uint8Array | undefined;
  #nonce: number;
  #failed = false;

  /** `nonce` 只给测试用（检查 nonce 用尽）。 */
  constructor(primitives: NoisePrimitives, key?: Uint8Array, nonce = 0) {
    if (key !== undefined && key.length !== 32)
      throw new NoiseError('invalid_key', 'cipher key must be 32 bytes');
    this.#primitives = primitives;
    this.#key = key;
    this.#nonce = nonce;
  }

  get hasKey(): boolean {
    return this.#key !== undefined;
  }

  /** 下一条消息用的 nonce。 */
  get nonce(): number {
    return this.#nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.#checkUsable();
    if (this.#key === undefined) return plaintext;
    if (plaintext.length > MAX_MESSAGE_LENGTH - TAG_LENGTH) {
      throw new NoiseError(
        'bad_message',
        `plaintext of ${plaintext.length} bytes exceeds one Noise message`,
      );
    }
    const ciphertext = this.#primitives.encrypt(this.#key, this.#nonce, ad, plaintext);
    this.#nonce++;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.#checkUsable();
    if (this.#key === undefined) return ciphertext;
    if (ciphertext.length < TAG_LENGTH || ciphertext.length > MAX_MESSAGE_LENGTH) {
      this.#failed = true;
      throw new NoiseError('bad_message', `ciphertext of ${ciphertext.length} bytes`);
    }
    let plaintext: Uint8Array;
    try {
      plaintext = this.#primitives.decrypt(this.#key, this.#nonce, ad, ciphertext);
    } catch {
      this.#failed = true;
      throw new NoiseError('decrypt_failed', 'message authentication failed');
    }
    this.#nonce++;
    return plaintext;
  }

  #checkUsable(): void {
    if (this.#failed)
      throw new NoiseError('invalid_state', 'cipher state is unusable after a failure');
    if (this.#key !== undefined && this.#nonce >= MAX_NONCE) {
      throw new NoiseError('nonce_exhausted', 'nonce exhausted; reconnect with a new handshake');
    }
  }
}
