// 本机识别（0.92.0）：sherpa-onnx 的 Node 绑定（`sherpa-onnx-node`，Apache-2.0，Host 的可选依赖，原生模块按平台在
// `sherpa-onnx-<平台>-<架构>` 包里）。Silero VAD 先把录音切成说话的段（去掉静音、过长的段按 `maxSpeechDuration` 再切），每段交给
// SenseVoice 的离线识别。识别器第一次用时加载（约半秒、三百来 MB 内存），闲置一段时间后放掉。识别走 `decodeAsync`，不堵 Host 的事件循环。

import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { SPEECH_SAMPLE_RATE } from '@wevir/protocol';
import { joinSegments, pcmToFloat32 } from './audio.js';
import type { SpeechModelPaths } from './install.js';

/** 用到的 `sherpa-onnx-node` 的那一部分（包里只有 JSDoc 类型）。 */
interface OfflineStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
}
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
}
interface Vad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}
export interface SherpaModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<OfflineRecognizer> };
  Vad: new (config: unknown, bufferSizeInSeconds: number) => Vad;
}

/**
 * 加载 `sherpa-onnx-node`；这个平台没有它的原生包（或加载失败）时 undefined。它是 CommonJS，用 createRequire 加载：打成 bundle 后
 * 从 bundle 所在处找 `node_modules/`（安装包里是 `host/node_modules/`，stage-resources 的 ON_DISK_PACKAGES）。
 */
export function loadSherpa(
  onWarning?: (message: string, fields?: Record<string, unknown>) => void,
): SherpaModule | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require('sherpa-onnx-node') as SherpaModule;
  } catch (error) {
    onWarning?.('local speech recognition is unavailable', {
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    });
    return undefined;
  }
}

/** VAD 的窗口（Silero 在 16 kHz 下是 512 个采样）。 */
const VAD_WINDOW = 512;
/** 一段最长几秒：SenseVoice 一次处理太长的音频会变慢、变差，VAD 到这个长度就切开。 */
const MAX_SEGMENT_SECONDS = 20;
/** 闲置多久放掉识别器。 */
const IDLE_UNLOAD_MS = 10 * 60_000;

export class LocalTranscriber {
  readonly #sherpa: SherpaModule;
  readonly #paths: () => Promise<SpeechModelPaths | undefined>;
  #recognizer: { paths: SpeechModelPaths; ready: Promise<OfflineRecognizer> } | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** 同一时刻只识别一次：识别器不是线程安全的，几次录音排队。 */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(sherpa: SherpaModule, paths: () => Promise<SpeechModelPaths | undefined>) {
    this.#sherpa = sherpa;
    this.#paths = paths;
  }

  /** 转写一段 PCM。模型没装时返回 undefined。 */
  transcribe(pcm: Uint8Array): Promise<string | undefined> {
    const run = this.#queue.then(() => this.#transcribe(pcm));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** 放掉识别器（卸载模型、Host 退出时）。 */
  unload(): void {
    clearTimeout(this.#idle);
    this.#idle = undefined;
    this.#recognizer = undefined;
  }

  async #transcribe(pcm: Uint8Array): Promise<string | undefined> {
    const paths = await this.#paths();
    if (paths === undefined) return undefined;
    const recognizer = await this.#load(paths);
    const segments = this.#segments(pcmToFloat32(pcm), paths);
    const texts: string[] = [];
    for (const samples of segments) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEECH_SAMPLE_RATE });
      texts.push((await recognizer.decodeAsync(stream)).text);
    }
    this.#armIdle();
    return joinSegments(texts);
  }

  #load(paths: SpeechModelPaths): Promise<OfflineRecognizer> {
    if (this.#recognizer?.paths.dir === paths.dir) return this.#recognizer.ready;
    const ready = this.#sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: paths.model, language: '', useInverseTextNormalization: 1 },
        tokens: paths.tokens,
        numThreads: threads(),
        provider: 'cpu',
        debug: 0,
      },
    });
    const entry = { paths, ready };
    this.#recognizer = entry;
    // 加载失败时不留着失败的 Promise，下次再试。
    ready.catch(() => {
      if (this.#recognizer === entry) this.#recognizer = undefined;
    });
    return ready;
  }

  /** VAD 切出说话的段。 */
  #segments(samples: Float32Array, paths: SpeechModelPaths): Float32Array[] {
    const seconds = samples.length / SPEECH_SAMPLE_RATE;
    const vad = new this.#sherpa.Vad(
      {
        sileroVad: {
          model: paths.vad,
          threshold: 0.5,
          minSpeechDuration: 0.2,
          minSilenceDuration: 0.5,
          windowSize: VAD_WINDOW,
          maxSpeechDuration: MAX_SEGMENT_SECONDS,
        },
        sampleRate: SPEECH_SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      Math.ceil(seconds) + 1,
    );
    const segments: Float32Array[] = [];
    const drain = () => {
      while (!vad.isEmpty()) {
        // 不用外部缓冲：VAD 弹出后那块内存会被复用。
        segments.push(vad.front(false).samples);
        vad.pop();
      }
    };
    for (let i = 0; i < samples.length; i += VAD_WINDOW) {
      const window = samples.subarray(i, i + VAD_WINDOW);
      if (window.length < VAD_WINDOW) {
        const padded = new Float32Array(VAD_WINDOW);
        padded.set(window);
        vad.acceptWaveform(padded);
      } else {
        vad.acceptWaveform(window);
      }
      drain();
    }
    vad.flush();
    drain();
    return segments;
  }

  #armIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
    this.#idle.unref?.();
  }
}

function threads(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}
