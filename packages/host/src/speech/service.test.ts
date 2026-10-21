import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HOST_SETTINGS,
  type HostSettings,
  SPEECH_CHUNK_MAX_BYTES,
  type SpeechStatus,
} from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { SpeechModelInstaller, type SpeechModelSpec } from './install.js';
import { SpeechService, type SpeechServiceOptions } from './service.js';

const dirs: string[] = [];
const services: SpeechService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const spec: SpeechModelSpec = {
  key: 'test-model',
  name: 'Test Model',
  assets: [
    { url: 'https://example.com/vad.onnx', sha256: '0'.repeat(64), size: 10, fileName: 'x' },
  ],
  files: { model: 'model.int8.onnx', tokens: 'tokens.txt', vad: 'silero_vad.onnx' },
};

function installer(): SpeechModelInstaller {
  const directory = mkdtempSync(join(tmpdir(), 'wevir-speech-'));
  dirs.push(directory);
  return new SpeechModelInstaller({ directory, spec });
}

function service(
  overrides: Partial<SpeechServiceOptions> & { settings?: () => HostSettings } = {},
): SpeechService {
  const created = new SpeechService({
    installer: installer(),
    local: { transcribe: async () => '本机的结果', unload: () => {} },
    settings: () => DEFAULT_HOST_SETTINGS,
    resolveProvider: async () => undefined,
    ...overrides,
  });
  services.push(created);
  return created;
}

const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');

describe('SpeechService', () => {
  it('录音分段收进来，结束时交给本机识别', async () => {
    const seen: number[] = [];
    const speech = service({
      local: {
        transcribe: async (pcm) => {
          seen.push(pcm.byteLength);
          return '把测试跑一遍';
        },
        unload: () => {},
      },
    });
    const { recordingId } = speech.begin();
    expect(speech.append({ recordingId, offset: 0, data: b64(16_000) })).toEqual({
      receivedBytes: 16_000,
    });
    speech.append({ recordingId, offset: 16_000, data: b64(16_000) });
    const result = await speech.finish({ recordingId });
    expect(result).toEqual({
      text: '把测试跑一遍',
      transcriber: { kind: 'local' },
      durationMs: 1000,
    });
    expect(seen).toEqual([32_000]);
    // 录音用过就没了。
    await expect(speech.finish({ recordingId })).rejects.toSatisfy((e) =>
      isHostError(e, 'INVALID_PARAMS'),
    );
  });

  it('offset 对不上、奇数字节、超长都拒绝', () => {
    const speech = service();
    const { recordingId } = speech.begin();
    expect(() => speech.append({ recordingId, offset: 4, data: b64(4) })).toThrow(/offset/);
    expect(() => speech.append({ recordingId, offset: 0, data: b64(3) })).toThrow(/PCM/);
    expect(() =>
      speech.append({ recordingId, offset: 0, data: b64(SPEECH_CHUNK_MAX_BYTES + 2) }),
    ).toThrow(/too long/);
  });

  it('没有录到声音时是空串，不调识别', async () => {
    let called = false;
    const speech = service({
      local: {
        transcribe: async () => {
          called = true;
          return 'x';
        },
        unload: () => {},
      },
    });
    const { recordingId } = speech.begin();
    expect((await speech.finish({ recordingId })).text).toBe('');
    expect(called).toBe(false);
  });

  it('本机模型没装时是 model_missing，平台不支持时是 runtime_missing', async () => {
    const missing = service({ local: { transcribe: async () => undefined, unload: () => {} } });
    const a = missing.begin().recordingId;
    missing.append({ recordingId: a, offset: 0, data: b64(4) });
    await expect(missing.finish({ recordingId: a })).rejects.toMatchObject({
      code: 'SPEECH_FAILED',
      data: { reason: 'model_missing' },
    });

    const { local: _, ...withoutLocal } = {
      installer: installer(),
      local: undefined,
      settings: () => DEFAULT_HOST_SETTINGS,
      resolveProvider: async () => undefined,
    };
    const unsupported = new SpeechService(withoutLocal);
    services.push(unsupported);
    expect(unsupported.status().local.state).toBe('unsupported');
    const b = unsupported.begin().recordingId;
    unsupported.append({ recordingId: b, offset: 0, data: b64(4) });
    await expect(unsupported.finish({ recordingId: b })).rejects.toMatchObject({
      data: { reason: 'runtime_missing' },
    });
    expect(() => unsupported.install()).toThrow(/not available/);
  });

  it('设置指向的 Provider 不在了时是 provider_missing', async () => {
    const speech = service({
      settings: () => ({
        ...DEFAULT_HOST_SETTINGS,
        speechTranscriber: { kind: 'provider', providerId: 'groq', modelId: 'whisper' },
      }),
    });
    const { recordingId } = speech.begin();
    speech.append({ recordingId, offset: 0, data: b64(4) });
    await expect(speech.finish({ recordingId })).rejects.toMatchObject({
      code: 'SPEECH_FAILED',
      data: { reason: 'provider_missing' },
    });
  });

  it('Provider 的转写：经 fetch 发到它的地址', async () => {
    const urls: string[] = [];
    const speech = service({
      settings: () => ({
        ...DEFAULT_HOST_SETTINGS,
        speechTranscriber: { kind: 'provider', providerId: 'groq', modelId: 'whisper' },
      }),
      resolveProvider: async (providerId, modelId) =>
        providerId === 'groq' && modelId === 'whisper'
          ? { baseURL: 'https://api.example/v1', apiKey: 'k', modelId }
          : undefined,
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response('{"text":"云端的结果"}');
      }) as typeof fetch,
    });
    const { recordingId } = speech.begin();
    speech.append({ recordingId, offset: 0, data: b64(4) });
    expect(await speech.finish({ recordingId })).toMatchObject({
      text: '云端的结果',
      transcriber: { kind: 'provider', providerId: 'groq', modelId: 'whisper' },
    });
    expect(urls).toEqual(['https://api.example/v1/audio/transcriptions']);
  });

  it('润色：设置开着、给了会话时用润色的结果；失败或没开时用原文', async () => {
    let polishOn = true;
    const polished: string[] = [];
    const speech = service({
      settings: () => ({ ...DEFAULT_HOST_SETTINGS, speechPolish: polishOn }),
      polish: async (sessionId, text) => {
        polished.push(`${sessionId}:${text}`);
        if (sessionId === 'ses_fail') throw new Error('boom');
        return `${text}。`;
      },
    });
    const run = async (sessionId?: `ses_${string}`) => {
      const { recordingId } = speech.begin();
      speech.append({ recordingId, offset: 0, data: b64(4) });
      return speech.finish({ recordingId, ...(sessionId !== undefined && { sessionId }) });
    };
    expect(await run('ses_a')).toMatchObject({ text: '本机的结果。', polished: true });
    expect(await run('ses_fail')).toEqual(
      expect.not.objectContaining({ polished: expect.anything() }),
    );
    expect((await run()).polished).toBeUndefined();
    polishOn = false;
    expect((await run('ses_a')).text).toBe('本机的结果');
    expect(polished).toEqual(['ses_a:本机的结果', 'ses_fail:本机的结果']);
  });

  it('状态：没装是 missing，装失败是 failed 带原因，经 watch 通知', async () => {
    const speech = service({
      installer: new SpeechModelInstaller({
        directory: (() => {
          const dir = mkdtempSync(join(tmpdir(), 'wevir-speech-'));
          dirs.push(dir);
          return dir;
        })(),
        spec,
        fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      }),
    });
    await speech.init();
    expect(speech.status()).toEqual({
      local: { state: 'missing', modelName: 'Test Model', downloadBytes: 10 },
    });
    const changes: SpeechStatus[] = [];
    const finished = new Promise<void>((resolve) => {
      speech.watch((status) => {
        changes.push(status);
        if (status.local.state === 'failed') resolve();
      });
    });
    expect(speech.install().status.local.state).toBe('installing');
    await finished;
    expect(speech.status().local).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/500/),
    });
    expect(changes[0]?.local.state).toBe('installing');
  });
});
