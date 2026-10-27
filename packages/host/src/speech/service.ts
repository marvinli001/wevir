// 听写（0.92.0，Host 功能 `speech`，domain-model §3.42）：`speech.*` 的实现。录音按 `speech.begin` → 若干 `speech.append` →
// `speech.finish` 收进内存（一次最多 `SPEECH_MAX_BYTES`），结束时按设置 `speechTranscriber` 交给本机模型或某个 Provider 的转写模型，
// 打开 `speechPolish` 时再用会话的模型润色。录音不落盘；`SPEECH_RECORDING_IDLE_MS` 没有新数据就丢掉（连接断了的也靠它回收）。

import { randomBytes } from 'node:crypto';
import {
  type HostSettings,
  type MethodParams,
  type MethodResult,
  SPEECH_CHUNK_MAX_BYTES,
  SPEECH_MAX_BYTES,
  SPEECH_RECORDING_IDLE_MS,
  type SpeechFailedData,
  type SpeechInstallProgress,
  type SpeechLocalStatus,
  type SpeechStatus,
  type SpeechTranscriber,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { durationMsOf } from './audio.js';
import {
  ProviderTranscriptionError,
  type ProviderTranscriptionTarget,
  transcribeWithProvider,
  transcriptionTimeoutMs,
} from './cloud.js';
import { downloadBytesOf, SpeechInstallCancelled, type SpeechModelInstaller } from './install.js';
import type { LocalTranscriber } from './local.js';

interface Recording {
  chunks: Buffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface SpeechServiceOptions {
  installer: SpeechModelInstaller;
  /** 本机识别；这个平台没有 sherpa-onnx 的原生包时省略，本机模型的状态是 `unsupported`。 */
  local?: Pick<LocalTranscriber, 'transcribe' | 'unload'>;
  settings: () => HostSettings;
  /** 设置指向的 Provider 的地址、Key 与转写模型；Provider 或模型不在了时 undefined。 */
  resolveProvider: (
    providerId: string,
    modelId: string,
  ) => Promise<ProviderTranscriptionTarget | undefined>;
  /** 用会话的模型润色；没有这项（提示词读不到）时不润色。返回 undefined 表示用原文。 */
  polish?: (sessionId: string, text: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

function failed(message: string, data: SpeechFailedData): HostError {
  return new HostError('SPEECH_FAILED', message, data);
}

export class SpeechService {
  readonly #options: SpeechServiceOptions;
  readonly #listeners = new Set<(status: SpeechStatus) => void>();
  readonly #recordings = new Map<string, Recording>();
  #progress: SpeechInstallProgress | undefined;
  #error: string | undefined;
  #installedBytes: number | undefined;
  /** 启动时正在读磁盘上的状态（`init`）；读完之前的 `install` 等它，免得重下已经装好的模型。 */
  #checking: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SpeechServiceOptions) {
    this.#options = options;
  }

  /** 启动时读一次磁盘上的状态。Host 不等它：读到装好的模型时经 `speech.changed` 通知。 */
  init(): Promise<void> {
    const checking = this.#options.installer.installedBytes().then(
      (bytes) => {
        this.#checking = undefined;
        this.#installedBytes = bytes;
        if (bytes !== undefined) this.#emit();
      },
      (error: unknown) => {
        this.#checking = undefined;
        throw error;
      },
    );
    this.#checking = checking.catch(() => {});
    return checking;
  }

  watch(listener: (status: SpeechStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(): SpeechStatus {
    const { installer } = this.#options;
    const local: SpeechLocalStatus = {
      state: 'missing',
      modelName: installer.spec.name,
      downloadBytes: downloadBytesOf(installer.spec),
    };
    if (this.#options.local === undefined) local.state = 'unsupported';
    else if (installer.installing) {
      local.state = 'installing';
      if (this.#progress !== undefined) local.progress = this.#progress;
    } else if (this.#installedBytes !== undefined) {
      local.state = 'ready';
      local.installedBytes = this.#installedBytes;
    } else if (this.#error !== undefined) {
      local.state = 'failed';
      local.error = this.#error;
    }
    return { local };
  }

  /** `speech.install`：在后台下载本机模型，立即返回（`installing`）；进度与结果经 `speech.changed` 通知。 */
  install(): MethodResult<'speech.install'> {
    const { installer } = this.#options;
    if (this.#options.local === undefined) {
      throw failed('Local speech recognition is not available on this platform.', {
        reason: 'runtime_missing',
      });
    }
    if (this.#checking !== undefined) {
      void this.#checking.then(() => {
        if (!this.#disposed) this.install();
      });
      return { status: this.status() };
    }
    if (!installer.installing && this.#installedBytes === undefined) {
      this.#error = undefined;
      this.#progress = undefined;
      const done = installer.install((progress) => {
        this.#progress = progress;
        this.#emit();
      });
      void done.then(
        async () => {
          this.#progress = undefined;
          this.#installedBytes = await installer.installedBytes();
          this.#emit();
        },
        (error: unknown) => {
          this.#progress = undefined;
          if (!(error instanceof SpeechInstallCancelled)) {
            this.#error = error instanceof Error ? error.message : String(error);
            this.#options.onWarning?.('speech model install failed', { error: this.#error });
          }
          this.#emit();
        },
      );
      this.#emit();
    }
    return { status: this.status() };
  }

  cancelInstall(): MethodResult<'speech.cancelInstall'> {
    this.#options.installer.cancel();
    return { status: this.status() };
  }

  async uninstall(): Promise<MethodResult<'speech.uninstall'>> {
    this.#options.local?.unload();
    await this.#options.installer.uninstall();
    this.#installedBytes = undefined;
    this.#error = undefined;
    this.#progress = undefined;
    this.#emit();
    return { status: this.status() };
  }

  begin(): MethodResult<'speech.begin'> {
    const recordingId = `rec_${randomBytes(12).toString('hex')}`;
    this.#recordings.set(recordingId, {
      chunks: [],
      bytes: 0,
      timer: this.#expire(recordingId),
    });
    return { recordingId };
  }

  append(params: MethodParams<'speech.append'>): MethodResult<'speech.append'> {
    const recording = this.#recording(params.recordingId);
    if (params.offset !== recording.bytes) {
      throw new HostError('INVALID_PARAMS', 'offset does not match the received bytes', {
        issues: [{ path: ['offset'], message: `expected ${recording.bytes}` }],
      });
    }
    const chunk = Buffer.from(params.data, 'base64');
    if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) {
      throw new HostError('INVALID_PARAMS', 'data must be 16-bit PCM', {
        issues: [{ path: ['data'], message: 'odd or empty byte count' }],
      });
    }
    if (
      chunk.byteLength > SPEECH_CHUNK_MAX_BYTES ||
      recording.bytes + chunk.byteLength > SPEECH_MAX_BYTES
    ) {
      throw new HostError('INVALID_PARAMS', 'recording is too long', {
        issues: [{ path: ['data'], message: 'too many bytes' }],
      });
    }
    recording.chunks.push(chunk);
    recording.bytes += chunk.byteLength;
    clearTimeout(recording.timer);
    recording.timer = this.#expire(params.recordingId);
    return { receivedBytes: recording.bytes };
  }

  discard(params: MethodParams<'speech.discard'>): MethodResult<'speech.discard'> {
    const recording = this.#recordings.get(params.recordingId);
    if (recording !== undefined) {
      clearTimeout(recording.timer);
      this.#recordings.delete(params.recordingId);
    }
    return {};
  }

  async finish(params: MethodParams<'speech.finish'>): Promise<MethodResult<'speech.finish'>> {
    const recording = this.#recording(params.recordingId);
    clearTimeout(recording.timer);
    this.#recordings.delete(params.recordingId);
    const pcm = Buffer.concat(recording.chunks, recording.bytes);
    const durationMs = durationMsOf(pcm.byteLength);
    const settings = this.#options.settings();
    const transcriber: SpeechTranscriber = settings.speechTranscriber ?? { kind: 'local' };
    const text = pcm.byteLength === 0 ? '' : await this.#transcribe(transcriber, pcm, durationMs);
    if (text !== '' && params.sessionId !== undefined && settings.speechPolish === true) {
      const polished = await this.#polish(params.sessionId, text);
      if (polished !== undefined)
        return { text: polished, transcriber, polished: true, durationMs };
    }
    return { text, transcriber, durationMs };
  }

  dispose(): void {
    this.#disposed = true;
    this.#options.installer.cancel();
    this.#options.local?.unload();
    for (const recording of this.#recordings.values()) clearTimeout(recording.timer);
    this.#recordings.clear();
    this.#listeners.clear();
  }

  async #transcribe(
    transcriber: SpeechTranscriber,
    pcm: Uint8Array,
    durationMs: number,
  ): Promise<string> {
    if (transcriber.kind === 'local') {
      const local = this.#options.local;
      if (local === undefined) {
        throw failed('Local speech recognition is not available on this platform.', {
          reason: 'runtime_missing',
        });
      }
      let text: string | undefined;
      try {
        text = await local.transcribe(pcm);
      } catch (error) {
        this.#options.onWarning?.('local speech recognition failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw failed('Local speech recognition failed.', { reason: 'local_error' });
      }
      if (text === undefined) {
        throw failed('The local speech model is not installed.', { reason: 'model_missing' });
      }
      return text;
    }
    const target = await this.#options.resolveProvider(transcriber.providerId, transcriber.modelId);
    if (target === undefined) {
      throw failed('The transcription model in Settings no longer exists.', {
        reason: 'provider_missing',
      });
    }
    try {
      return await transcribeWithProvider(target, pcm, {
        signal: AbortSignal.timeout(transcriptionTimeoutMs(durationMs)),
        ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      });
    } catch (error) {
      if (error instanceof ProviderTranscriptionError) throw failed(error.message, error.data);
      throw error;
    }
  }

  async #polish(sessionId: string, text: string): Promise<string | undefined> {
    const polish = this.#options.polish;
    if (polish === undefined) return undefined;
    try {
      return await polish(sessionId, text);
    } catch (error) {
      // 会话不在了等：润色是锦上添花，用原文。
      this.#options.onWarning?.('dictation polish failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  #recording(recordingId: string): Recording {
    const recording = this.#recordings.get(recordingId);
    if (recording === undefined) {
      throw new HostError('INVALID_PARAMS', 'no such recording', {
        issues: [{ path: ['recordingId'], message: 'unknown or expired recording' }],
      });
    }
    return recording;
  }

  #expire(recordingId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.#recordings.delete(recordingId), SPEECH_RECORDING_IDLE_MS);
    timer.unref?.();
    return timer;
  }

  #emit(): void {
    if (this.#disposed) return;
    const status = this.status();
    for (const listener of this.#listeners) listener(status);
  }
}
