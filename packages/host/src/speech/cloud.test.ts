import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { durationMsOf, joinSegments, pcmToFloat32, pcmToWav } from './audio.js';
import { ProviderTranscriptionError, transcribeWithProvider } from './cloud.js';

interface Received {
  path: string;
  authorization: string | undefined;
  model: string | undefined;
  responseFormat: string | undefined;
  file: Uint8Array | undefined;
  fileType: string | undefined;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** 假的 OpenAI 兼容转写端点：解析 multipart，记下收到的内容，按 `reply` 回答。 */
async function fakeEndpoint(
  reply: (received: Received) => { status: number; body: string },
): Promise<{ baseURL: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const form = await new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': request.headers['content-type'] ?? '' },
      body: new Uint8Array(body),
    }).formData();
    const file = form.get('file');
    const entry: Received = {
      path: request.url ?? '',
      authorization: request.headers.authorization,
      model: form.get('model')?.toString(),
      responseFormat: form.get('response_format')?.toString(),
      file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : undefined,
      fileType: file instanceof Blob ? file.type : undefined,
    };
    received.push(entry);
    const { status, body: text } = reply(entry);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(text);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, received };
}

const pcm = new Uint8Array([0, 0, 0xff, 0x7f, 0x00, 0x80, 0x10, 0x00]);
const signal = () => AbortSignal.timeout(5_000);

describe('transcribeWithProvider', () => {
  it('把 WAV 与模型发到 /audio/transcriptions，带上 Key，返回 text', async () => {
    const { baseURL, received } = await fakeEndpoint(() => ({
      status: 200,
      body: JSON.stringify({ text: '  把测试跑一遍  ' }),
    }));
    const text = await transcribeWithProvider(
      { baseURL: `${baseURL}/`, apiKey: 'test-key', modelId: 'whisper-large-v3-turbo' },
      pcm,
      { signal: signal() },
    );
    expect(text).toBe('把测试跑一遍');
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.path).toBe('/v1/audio/transcriptions');
    expect(request?.authorization).toBe('Bearer test-key');
    expect(request?.model).toBe('whisper-large-v3-turbo');
    expect(request?.responseFormat).toBe('json');
    expect(request?.fileType).toBe('audio/wav');
    expect(request?.file).toEqual(pcmToWav(pcm));
  });

  it('没有 Key 时不带 Authorization（本机的服务）', async () => {
    const { baseURL, received } = await fakeEndpoint(() => ({
      status: 200,
      body: '{"text":"hi"}',
    }));
    await transcribeWithProvider({ baseURL, apiKey: undefined, modelId: 'm' }, pcm, {
      signal: signal(),
    });
    expect(received[0]?.authorization).toBeUndefined();
  });

  it.each([
    [401, 'auth'],
    [429, 'rate_limited'],
    [503, 'server'],
    [400, 'protocol'],
  ] as const)('HTTP %d 归为 %s，错误里没有 Key', async (status, failure) => {
    const { baseURL } = await fakeEndpoint(() => ({
      status,
      body: JSON.stringify({ error: { message: 'Invalid API key test-key' } }),
    }));
    const error = await transcribeWithProvider(
      { baseURL, apiKey: 'sk-secret', modelId: 'm' },
      pcm,
      {
        signal: signal(),
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderTranscriptionError);
    const { data, message } = error as ProviderTranscriptionError;
    expect(data).toEqual({ reason: 'provider_error', failure, httpStatus: status });
    expect(message).not.toContain('sk-secret');
  });

  it('回的不是 { text } 时是 protocol', async () => {
    const { baseURL } = await fakeEndpoint(() => ({ status: 200, body: '<html>' }));
    await expect(
      transcribeWithProvider({ baseURL, apiKey: undefined, modelId: 'm' }, pcm, {
        signal: signal(),
      }),
    ).rejects.toMatchObject({ data: { reason: 'provider_error', failure: 'protocol' } });
  });

  it('连不上时是 network', async () => {
    await expect(
      transcribeWithProvider(
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: undefined, modelId: 'm' },
        pcm,
        {
          signal: signal(),
        },
      ),
    ).rejects.toMatchObject({ data: { reason: 'provider_error', failure: 'network' } });
  });
});

describe('音频', () => {
  it('PCM → Float32 与 WAV 头', () => {
    expect(Array.from(pcmToFloat32(pcm))).toEqual([0, 32767 / 32768, -1, 16 / 32768]);
    const wav = pcmToWav(pcm);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(pcm.byteLength);
    expect(durationMsOf(32_000)).toBe(1000);
  });

  it('接段：中日韩之间直接接，其余隔空格', () => {
    expect(joinSegments(['把测试', '跑一遍。', ''])).toBe('把测试跑一遍。');
    expect(joinSegments(['run the tests', 'then commit'])).toBe('run the tests then commit');
    expect(joinSegments(['打开', 'README'])).toBe('打开 README');
  });
});
