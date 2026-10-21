// 听写（0.92.0）与 React 无关的部分：采样转换、分段、错误归类、把转写的文字放进输入框。采集与上传在 use-dictation.ts。

import { isRpcError } from '@wevir/client-sdk';
import { SPEECH_SAMPLE_RATE, type SpeechFailureReason } from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** 每段上传约半秒（16 kHz、16 位，16 000 字节）。 */
export const DICTATION_CHUNK_BYTES = SPEECH_SAMPLE_RATE;
/** 按下不到这么久就松开算“点一下”：开始录音，再点一下结束（照 Claude Code 的 tap 模式）；按住超过它，松开即结束。 */
export const DICTATION_HOLD_MS = 300;

/** 波形最多留这么多格（50 ms 一格，12 秒）：够铺满最宽的输入框。 */
export const DICTATION_LEVELS_MAX = 240;

/** [-1, 1] 的 Float32 → 16 位整数 PCM（截到范围内）。 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** 把一段段 PCM 攒成 `size` 字节一块（小端，浏览器所在平台都是小端）。 */
export class PcmChunker {
  readonly #size: number;
  #buffer: Uint8Array;
  #filled = 0;

  constructor(size: number = DICTATION_CHUNK_BYTES) {
    this.#size = size;
    this.#buffer = new Uint8Array(size);
  }

  /** 加一段，返回攒满的块。 */
  push(pcm: Int16Array): Uint8Array[] {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const full: Uint8Array[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(this.#size - this.#filled, bytes.byteLength - offset);
      this.#buffer.set(bytes.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === this.#size) {
        full.push(this.#buffer);
        this.#buffer = new Uint8Array(this.#size);
        this.#filled = 0;
      }
    }
    return full;
  }

  /** 剩下没攒满的部分；没有时 undefined。 */
  flush(): Uint8Array | undefined {
    if (this.#filled === 0) return undefined;
    const rest = this.#buffer.slice(0, this.#filled);
    this.#filled = 0;
    return rest;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 一段音频的音量（均方根开方后放大，0–1），给录音时的波形用：说话声在 0.3–0.9，安静时接近 0。 */
export function levelOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)) * 1.6);
}

const SPEECH_FAILURE_KEYS: Record<SpeechFailureReason, PlainMessageKey> = {
  model_missing: 'dictation.error.modelMissing',
  runtime_missing: 'dictation.error.runtimeMissing',
  provider_missing: 'dictation.error.providerMissing',
  provider_error: 'dictation.error.providerError',
  local_error: 'dictation.error.localError',
};

/** 听写失败的原因 → 界面文字的 key。`getUserMedia` 的错误按名字认：没授权、没有麦克风。 */
export function dictationErrorKey(error: unknown): PlainMessageKey {
  if (isRpcError(error, 'SPEECH_FAILED')) {
    const reason = error.data?.reason;
    if (reason !== undefined && reason in SPEECH_FAILURE_KEYS) return SPEECH_FAILURE_KEYS[reason];
  }
  const name = (error as { name?: unknown } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'dictation.error.micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'dictation.error.noMic';
  return 'dictation.error.failed';
}

/**
 * 转写的文字放到光标处：前后是字母数字时补一个空格（中日韩文字之间不补）。返回新文字与之后的光标位置。
 */
export function insertDictation(
  text: string,
  cursor: number,
  transcript: string,
): { text: string; cursor: number } {
  const at = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const spaceBefore = /[\p{L}\p{N}.,!?;:]$/u.test(before) && /^[A-Za-z0-9]/.test(transcript);
  const spaceAfter = /[A-Za-z0-9.,!?]$/.test(transcript) && /^[\p{L}\p{N}]/u.test(after);
  const inserted = `${spaceBefore ? ' ' : ''}${transcript}${spaceAfter ? ' ' : ''}`;
  return { text: before + inserted + after, cursor: at + inserted.length };
}
