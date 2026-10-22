import { type CipherState, MAX_MESSAGE_LENGTH, TAG_LENGTH } from './cipher-state.js';
import { NoiseError } from './errors.js';
import { concatBytes } from './primitives.js';

/** 一条 Noise 传输消息里能放的应用数据：65535 减去 16 字节标签与 1 字节“后面还有”标志。 */
export const MAX_FRAGMENT_LENGTH = MAX_MESSAGE_LENGTH - TAG_LENGTH - 1;
/** 一个应用帧（一个 JSON-RPC 对象）的默认上限，防止对端让这边无限堆积。 */
export const MAX_FRAME_LENGTH = 4 * 1024 * 1024;

const MORE = 1;
const LAST = 0;
const NO_AD = new Uint8Array(0);

/**
 * 把一个应用帧切成若干条 Noise 传输消息（每条不超过 65535 字节），每条明文的首字节是标志：1 表示后面还有，0 表示这是最后一片。
 * 空帧也发一条消息。
 */
export function sealFrame(
  cipher: CipherState,
  frame: Uint8Array,
  maxFrameLength = MAX_FRAME_LENGTH,
): Uint8Array[] {
  if (frame.length > maxFrameLength) {
    throw new NoiseError(
      'frame_too_large',
      `frame of ${frame.length} bytes exceeds ${maxFrameLength}`,
    );
  }
  const messages: Uint8Array[] = [];
  let offset = 0;
  do {
    const piece = frame.subarray(offset, offset + MAX_FRAGMENT_LENGTH);
    offset += piece.length;
    const flag = offset < frame.length ? MORE : LAST;
    messages.push(cipher.encryptWithAd(NO_AD, concatBytes(Uint8Array.of(flag), piece)));
  } while (offset < frame.length);
  return messages;
}

/**
 * 按到达顺序解密传输消息并拼回应用帧。任何一条解密失败、标志不对或帧超过上限，这个对象（与它的 CipherState）就作废，
 * 调用方断开连接。
 */
export class FrameReader {
  readonly #cipher: CipherState;
  readonly #maxFrameLength: number;
  #parts: Uint8Array[] = [];
  #length = 0;
  #failed = false;

  constructor(cipher: CipherState, maxFrameLength = MAX_FRAME_LENGTH) {
    this.#cipher = cipher;
    this.#maxFrameLength = maxFrameLength;
  }

  /** 收到最后一片时返回整帧，否则返回 undefined。 */
  push(message: Uint8Array): Uint8Array | undefined {
    if (this.#failed)
      throw new NoiseError('invalid_state', 'frame reader is unusable after a failure');
    try {
      return this.#push(message);
    } catch (error) {
      this.#failed = true;
      this.#parts = [];
      throw error;
    }
  }

  #push(message: Uint8Array): Uint8Array | undefined {
    const plaintext = this.#cipher.decryptWithAd(NO_AD, message);
    const flag = plaintext[0];
    if (flag !== MORE && flag !== LAST) throw new NoiseError('bad_message', 'bad fragment flag');
    const piece = plaintext.subarray(1);
    this.#length += piece.length;
    if (this.#length > this.#maxFrameLength) {
      throw new NoiseError('frame_too_large', `frame exceeds ${this.#maxFrameLength} bytes`);
    }
    this.#parts.push(piece);
    if (flag === MORE) return undefined;
    const frame = concatBytes(...this.#parts);
    this.#parts = [];
    this.#length = 0;
    return frame;
  }
}
