// Provider 的转写模型（0.92.0）：OpenAI 兼容的 `POST <baseURL>/audio/transcriptions`（multipart：`file` 是 WAV，`model`，
// `response_format=json`），回 `{ text }`。OpenAI、Groq 等都是这个形状。Key 只放进 Authorization 头，不进日志与错误信息。

import type { SpeechFailedData } from '@wevir/protocol';
import { pcmToWav } from './audio.js';

export interface ProviderTranscriptionTarget {
  baseURL: string;
  apiKey: string | undefined;
  modelId: string;
}

/** 转写服务出错：`data` 进 `SPEECH_FAILED`，`message` 给人看（不含 Key）。 */
export class ProviderTranscriptionError extends Error {
  override readonly name = 'ProviderTranscriptionError';
  readonly data: SpeechFailedData;
  constructor(message: string, data: SpeechFailedData) {
    super(message);
    this.data = data;
  }
}

/** 等服务端的时限：基础一分钟，录音每一分钟再加半分钟。 */
export function transcriptionTimeoutMs(durationMs: number): number {
  return 60_000 + Math.ceil(durationMs / 60_000) * 30_000;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function transcribeWithProvider(
  target: ProviderTranscriptionTarget,
  pcm: Uint8Array,
  options: { signal: AbortSignal; fetch?: typeof fetch },
): Promise<string> {
  const url = `${target.baseURL.replace(/\/+$/u, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', target.modelId);
  form.append('response_format', 'json');
  const headers: Record<string, string> = {};
  if (target.apiKey !== undefined) headers.authorization = `Bearer ${target.apiKey}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers,
      body: form,
      redirect: 'error',
      signal: options.signal,
    });
  } catch {
    const timeout =
      options.signal.aborted &&
      (options.signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
    throw new ProviderTranscriptionError(
      timeout
        ? 'The transcription service did not answer in time.'
        : `Could not reach the transcription service (${hostOf(url)}).`,
      { reason: 'provider_error', failure: timeout ? 'timeout' : 'network' },
    );
  }
  const body = await readLimited(response);
  if (!response.ok) {
    const failure =
      response.status === 401 || response.status === 403
        ? 'auth'
        : response.status === 429
          ? 'rate_limited'
          : response.status >= 500
            ? 'server'
            : 'protocol';
    throw new ProviderTranscriptionError(
      `The transcription service answered ${response.status}${detailOf(body)}.`,
      { reason: 'provider_error', failure, httpStatus: response.status },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const text = (parsed as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') {
    throw new ProviderTranscriptionError('The transcription service returned no text.', {
      reason: 'provider_error',
      failure: 'protocol',
      httpStatus: response.status,
    });
  }
  return text.trim();
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 服务端错误里的一句说明（OpenAI 的 `{ error: { message } }`），最多 200 个字符。 */
function detailOf(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message.trim() !== '') {
      return `: ${message.trim().slice(0, 200)}`;
    }
  } catch {}
  return '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
