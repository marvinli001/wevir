// 听写（Host 功能 `speech`，0.92.0）与 React 无关的部分：录到的 16 kHz 单声道 16 位 PCM 攒成约半秒一块，按顺序 `speech.append`，
// 结束时补上剩下的再 `speech.finish`；错误归类；转写的文字放到光标处。采集在 state/dictation.ts（expo-audio 的 `useAudioStream`）。

import { isRpcError } from '@wevir/client-sdk';
import {
  type MethodParams,
  type MethodResult,
  SPEECH_MAX_BYTES,
  SPEECH_SAMPLE_RATE,
  type SpeechFailureReason,
} from '@wevir/protocol';
import type { MessageKey } from '../i18n';

/** 每块约半秒（16 kHz、16 位，16 000 字节），同桌面。 */
export const DICTATION_CHUNK_BYTES = SPEECH_SAMPLE_RATE;

type SpeechMethod = 'speech.begin' | 'speech.append' | 'speech.finish' | 'speech.discard';

/** 听写要用的连接（`WevirClient.request` 的一部分）。 */
export interface SpeechClient {
  request<M extends SpeechMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
}

/** 一次录音的上传：`push` 收 PCM，攒满一块就按顺序传；`finish` 传完剩下的再转写，`discard` 丢掉。 */
export class DictationUpload {
  readonly #client: SpeechClient;
  readonly #recordingId: string;
  #buffer = new Uint8Array(DICTATION_CHUNK_BYTES);
  #filled = 0;
  #offset = 0;
  #uploads: Promise<void> = Promise.resolve();
  #failure: unknown;
  #closed = false;

  private constructor(client: SpeechClient, recordingId: string) {
    this.#client = client;
    this.#recordingId = recordingId;
  }

  static async begin(client: SpeechClient): Promise<DictationUpload> {
    const { recordingId } = await client.request('speech.begin', {});
    return new DictationUpload(client, recordingId);
  }

  /** 收到的字节数到上限（`SPEECH_MAX_SECONDS`）了：之后的丢掉，界面该结束录音了。 */
  get full(): boolean {
    return this.#offset + this.#filled >= SPEECH_MAX_BYTES;
  }

  /** 上传失败过：之后的 `finish` 抛出这个错误。 */
  get failed(): boolean {
    return this.#failure !== undefined;
  }

  push(pcm: Uint8Array): void {
    if (this.#closed) return;
    let at = 0;
    // 奇数字节截掉最后一个：Host 要偶数个字节（整的 16 位样本）。
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    while (at < usable && !this.full) {
      const room = Math.min(
        DICTATION_CHUNK_BYTES - this.#filled,
        SPEECH_MAX_BYTES - this.#offset - this.#filled,
      );
      const take = Math.min(room, usable - at);
      this.#buffer.set(pcm.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === DICTATION_CHUNK_BYTES) this.#send();
    }
  }

  /** 结束录音并转写；没听到话时是空串。 */
  async finish(sessionId?: string): Promise<string> {
    this.#closed = true;
    if (this.#filled > 0) this.#send();
    await this.#uploads;
    if (this.#failure !== undefined) {
      this.#discard();
      throw this.#failure;
    }
    const result = await this.#client.request('speech.finish', {
      recordingId: this.#recordingId as never,
      ...(sessionId !== undefined && { sessionId: sessionId as never }),
    });
    return result.text.trim();
  }

  discard(): void {
    if (this.#closed && this.#failure === undefined) return;
    this.#closed = true;
    this.#discard();
  }

  #discard(): void {
    void this.#client
      .request('speech.discard', { recordingId: this.#recordingId as never })
      .catch(() => {});
  }

  #send(): void {
    const chunk = this.#buffer.slice(0, this.#filled);
    const offset = this.#offset;
    this.#offset += this.#filled;
    this.#filled = 0;
    this.#uploads = this.#uploads.then(async () => {
      if (this.#failure !== undefined) return;
      try {
        await this.#client.request('speech.append', {
          recordingId: this.#recordingId as never,
          offset,
          data: toBase64(chunk),
        });
      } catch (error) {
        this.#failure = error;
      }
    });
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 标准 base64（带补位）。 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(n >> 18) & 63];
    out += BASE64[(n >> 12) & 63];
    out += b === undefined ? '=' : BASE64[(n >> 6) & 63];
    out += c === undefined ? '=' : BASE64[n & 63];
  }
  return out;
}

const SPEECH_FAILURE_KEYS: Record<SpeechFailureReason, MessageKey> = {
  model_missing: 'dictation.error.modelMissing',
  runtime_missing: 'dictation.error.runtimeMissing',
  provider_missing: 'dictation.error.providerMissing',
  provider_error: 'dictation.error.providerError',
  local_error: 'dictation.error.localError',
};

/** 听写失败的原因 → 界面文字。 */
export function dictationErrorKey(error: unknown): MessageKey {
  if (isRpcError(error, 'SPEECH_FAILED')) {
    const reason = error.data?.reason;
    if (reason !== undefined && reason in SPEECH_FAILURE_KEYS) return SPEECH_FAILURE_KEYS[reason];
  }
  if (isRpcError(error, 'DEVICE_FORBIDDEN')) return 'error.computerOnly';
  return 'dictation.error.failed';
}

/** 转写的文字放到光标处：前后是字母数字时补一个空格（中日韩文字之间不补），同桌面。返回新文字与之后的光标位置。 */
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
