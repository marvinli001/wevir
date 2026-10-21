// 听写（0.92.0，Host 功能 `speech`，domain-model §3.42）：客户端录音，把 16 kHz 单声道的 PCM 分段交给 Host，Host 转成文字。转写方
// 由设置 `speechTranscriber` 选：本机模型（Host 按需下载的 SenseVoice，加 Silero VAD 切段，不联网）或某个 Provider 的转写模型
// （`POST <baseURL>/audio/transcriptions`）。打开设置 `speechPolish` 时，转写的文字再交给会话当前的模型修一遍。

import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { SpeechTranscriberSchema } from './entities.js';

/** 录音的采样率：16 kHz、单声道、16 位小端 PCM（`pcm_s16le`）。 */
export const SPEECH_SAMPLE_RATE = 16_000;
/** 一次录音最长几秒；超过时 `speech.append` 回 `INVALID_PARAMS`。 */
export const SPEECH_MAX_SECONDS = 300;
/** 一次录音的字节上限。 */
export const SPEECH_MAX_BYTES = SPEECH_SAMPLE_RATE * 2 * SPEECH_MAX_SECONDS;
/** `speech.append` 一段的字节上限（约 8 秒）。 */
export const SPEECH_CHUNK_MAX_BYTES = 256 * 1024;
/** `speech.append` 的 `data`（base64）的长度上限。 */
export const SPEECH_CHUNK_DATA_MAX_LENGTH = Math.ceil(SPEECH_CHUNK_MAX_BYTES / 3) * 4;
/** 录音多久没有新数据就丢掉（毫秒），连接断了的录音也靠它回收。 */
export const SPEECH_RECORDING_IDLE_MS = 60_000;

export const SpeechRecordingIdSchema = z.string().regex(/^rec_[0-9A-Za-z]{8,64}$/);

/**
 * 本机模型的状态：`unsupported` 是这个平台没有本机识别的运行库；`missing` 没下载；`installing` 下载中（看 `progress`）；`ready`
 * 可用；`failed` 上次下载失败（看 `error`），可以再装。
 */
export const SpeechLocalStateSchema = z.enum([
  'unsupported',
  'missing',
  'installing',
  'ready',
  'failed',
]);
export type SpeechLocalState = z.infer<typeof SpeechLocalStateSchema>;

export const SpeechInstallProgressSchema = z.object({
  phase: z.enum(['downloading', 'extracting', 'verifying']),
  completedBytes: z.int().min(0),
  totalBytes: z.int().min(0).optional(),
});
export type SpeechInstallProgress = z.infer<typeof SpeechInstallProgressSchema>;

export const SpeechLocalStatusSchema = z.object({
  state: SpeechLocalStateSchema,
  /** 模型的名称（产品名，界面原样显示），如 `SenseVoice Small`。 */
  modelName: z.string().min(1),
  /** 要下载的字节数（模型与 VAD 的压缩包）。 */
  downloadBytes: z.int().min(0),
  /** 装好后占的磁盘字节数；`ready` 时有。 */
  installedBytes: z.int().min(0).optional(),
  /** `installing` 时有。 */
  progress: SpeechInstallProgressSchema.optional(),
  /** `failed` 时有：失败原因（给人看）。 */
  error: z.string().optional(),
});
export type SpeechLocalStatus = z.infer<typeof SpeechLocalStatusSchema>;

export const SpeechStatusSchema = z.object({
  local: SpeechLocalStatusSchema,
});
export type SpeechStatus = z.infer<typeof SpeechStatusSchema>;

/** `speech.status` / `speech.install` / `speech.cancelInstall` / `speech.uninstall` 的结果。 */
export const SpeechStatusResultSchema = z.object({ status: SpeechStatusSchema });

/** `speech.begin`：开始一次录音。音频格式固定（`SPEECH_SAMPLE_RATE` 的 `pcm_s16le`）。 */
export const SpeechBeginParamsSchema = z.object({});
export const SpeechBeginResultSchema = z.object({ recordingId: SpeechRecordingIdSchema });

/**
 * `speech.append`：按顺序追加一段 PCM。`offset` 是这段在整次录音里的起始字节，要等于已收到的字节数（防止乱序、重发），不等时回
 * `INVALID_PARAMS`。
 */
export const SpeechAppendParamsSchema = z.object({
  recordingId: SpeechRecordingIdSchema,
  offset: z.int().min(0).max(SPEECH_MAX_BYTES),
  /** base64，解码后是偶数个字节、不超过 `SPEECH_CHUNK_MAX_BYTES`。 */
  data: z.string().min(1).max(SPEECH_CHUNK_DATA_MAX_LENGTH),
});
export const SpeechAppendResultSchema = z.object({
  /** 已收到的字节数。 */
  receivedBytes: z.int().min(0),
});

/**
 * `speech.finish`：结束录音并转写，录音随之删除。给了 `sessionId` 且设置 `speechPolish` 开着时，再用这个会话当前的模型润色；
 * 润色失败或会话忙时返回没润色的文字。
 */
export const SpeechFinishParamsSchema = z.object({
  recordingId: SpeechRecordingIdSchema,
  sessionId: SessionIdSchema.optional(),
});
export const SpeechFinishResultSchema = z.object({
  /** 转出的文字，没听到话时是空串。 */
  text: z.string(),
  /** 这次用的转写方。 */
  transcriber: SpeechTranscriberSchema,
  /** 润色过时为 true。 */
  polished: z.boolean().optional(),
  /** 录音的长度（毫秒）。 */
  durationMs: z.int().min(0),
});

/** `speech.discard`：丢掉录音（不转写）。录音不在了也算成功。 */
export const SpeechDiscardParamsSchema = z.object({ recordingId: SpeechRecordingIdSchema });

/** `speech.changed`：本机模型的状态变了（装、卸、进度）。发给调用过 `speech.*` 的连接。 */
export const SpeechChangedParamsSchema = z.object({ status: SpeechStatusSchema });

/**
 * `SPEECH_FAILED` 的原因：`model_missing` 本机模型没装好；`runtime_missing` 这个平台没有本机识别的运行库；`provider_missing` 设置
 * 指向的 Provider 或转写模型不在了；`provider_error` 转写服务回了错误（`failure` 是归类，同 `provider.test`）；`local_error` 本机识别
 * 出错。
 */
export const SpeechFailureReasonSchema = z.enum([
  'model_missing',
  'runtime_missing',
  'provider_missing',
  'provider_error',
  'local_error',
]);
export type SpeechFailureReason = z.infer<typeof SpeechFailureReasonSchema>;

export const SpeechFailedDataSchema = z.object({
  reason: SpeechFailureReasonSchema,
  /** `provider_error` 时的归类。 */
  failure: z
    .enum(['missing_key', 'auth', 'rate_limited', 'server', 'network', 'timeout', 'protocol'])
    .optional(),
  /** `provider_error` 时服务端的 HTTP 状态码。 */
  httpStatus: z.int().optional(),
});
export type SpeechFailedData = z.infer<typeof SpeechFailedDataSchema>;
