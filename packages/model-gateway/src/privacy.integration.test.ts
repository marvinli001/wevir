import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ModelGatewayOptions, startModelGateway } from './gateway.js';
import { GatewayPrivacyMasker } from './privacy.js';
import { doneItems, postResponses, readEvents } from './test-fixtures/codex.js';
import { startMockChat } from './test-fixtures/mock-chat.js';
import { startMockMessages } from './test-fixtures/mock-messages.js';
import { startMockResponses } from './test-fixtures/mock-responses.js';
import type { Script } from './test-fixtures/model-script.js';
import type { GatewayProvider } from './types.js';
import { prepareUpstream } from './upstream.js';

const key = 'sk-fictional-privacy-key-01234567890123456789';
const known = 'fictional-connector-credential';
const text = `${known} ${key}`;
const body = {
  model: 'wevir-mock',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  stream: true,
  tools: [
    {
      type: 'function',
      name: 'capture',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    },
  ],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gateway(options: ModelGatewayOptions = {}) {
  const logs: unknown[] = [];
  const gw = await startModelGateway({
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    ...options,
  });
  cleanups.push(() => gw.close());
  return { gw, logs };
}

const provider = (
  baseURL: string,
  api: GatewayProvider['api'] = 'openai-responses',
): GatewayProvider => ({
  id: 'mock',
  kind: 'openai-compatible',
  api,
  baseURL,
  displayName: 'Mock',
  apiKey: 'fictional-auth-key',
  models: [{ id: 'wevir-mock' }],
  defaultModelId: 'wevir-mock',
});

describe('网关隐私 HTTP 路径', () => {
  it.each(['openai-responses', 'openai-completions', 'anthropic-messages'] as const)(
    '%s：出站遮蔽，文本和工具参数回填；关闭时正文按原路径发送',
    async (api) => {
      const script: Script = ({ lastUserText }) => {
        const split = lastUserText.indexOf('{{SECRET_') + 12;
        return {
          text: [lastUserText.slice(0, split), lastUserText.slice(split)],
          toolCalls: [{ kind: 'function', name: 'capture', args: { value: lastUserText } }],
        };
      };
      const mock = await (api === 'openai-responses'
        ? startMockResponses(script)
        : api === 'openai-completions'
          ? startMockChat(script)
          : startMockMessages(script));
      cleanups.push(() => mock.close());
      let enabled = true;
      const privacy = new GatewayPrivacyMasker({
        settings: () => ({ enabled }),
        secrets: () => {
          if (!enabled) throw new Error('disabled privacy read secrets');
          return [known];
        },
      });
      const { gw, logs } = await gateway({ privacy });
      const config = provider(mock.baseURL, api);
      gw.setProviders([config]);
      const response = await postResponses(gw.baseURL('mock'), gw.token, body);
      expect(response.status).toBe(200);
      const events = await readEvents(response);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe(text);
      const call = doneItems(events).find((item) => item.type === 'function_call');
      expect(JSON.parse(call?.arguments as string)).toEqual({ value: text });
      const upstream = JSON.stringify(mock.requests[0]?.body);
      expect(upstream).toContain('{{SECRET_');
      expect(upstream).not.toContain(key);
      expect(upstream).not.toContain(known);
      expect(mock.requests[0]?.authorization ?? mock.requests[0]?.apiKey).toContain(config.apiKey);
      expect(JSON.stringify(logs)).not.toContain(key);
      expect(JSON.stringify(logs)).not.toContain(known);
      enabled = false;
      const unmasked = await postResponses(gw.baseURL('mock'), gw.token, body);
      expect(unmasked.status).toBe(200);
      await unmasked.text();
      const prepared = prepareUpstream(config, body);
      expect(prepared.ok).toBe(true);
      if (prepared.ok) expect(mock.requests[1]?.body).toEqual(prepared.payload);
    },
  );

  it('DeepSeek 官方的 Responses 入口共用遮蔽和还原', async () => {
    const mock = await startMockResponses(({ lastUserText }) => ({ text: [lastUserText] }));
    cleanups.push(() => mock.close());
    const { gw } = await gateway({
      deepseekBaseURL: mock.baseURL,
      privacy: new GatewayPrivacyMasker({
        settings: () => ({ enabled: true }),
        secrets: () => [known],
      }),
    });
    gw.setProviders([{ ...provider(mock.baseURL), kind: 'deepseek-official' }]);
    const response = await postResponses(gw.baseURL('mock'), gw.token, body);
    const events = await readEvents(response);
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(text);
    expect(JSON.stringify(mock.requests[0]?.body)).not.toContain(known);
  });

  it('直通 Uint8Array 在关闭时逐字节不变，开启后按 UTF-8 增量解码', async () => {
    let enabled = false;
    const privacy = new GatewayPrivacyMasker({
      settings: () => ({ enabled }),
      secrets: () => [known],
    });
    const raw = `: comment\r\nevent: response.output_text.delta\r\ndata: { "type": "response.output_text.delta", "delta": "中文 ${known}" }\r\n\r\n`;
    let upstreamText = raw;
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      if (enabled) {
        const request = JSON.parse(init?.body as string);
        upstreamText = raw.replace(known, request.input);
      }
      const bytes = new TextEncoder().encode(upstreamText);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const { gw } = await gateway({ privacy, fetch: fakeFetch });
    gw.setProviders([provider('https://mock.invalid/v1')]);
    const off = await postResponses(gw.baseURL('mock'), gw.token, {
      model: 'wevir-mock',
      input: known,
    });
    expect(new Uint8Array(await off.arrayBuffer())).toEqual(new TextEncoder().encode(raw));
    enabled = true;
    const on = await postResponses(gw.baseURL('mock'), gw.token, {
      model: 'wevir-mock',
      input: known,
    });
    expect((await readEvents(on))[0]?.delta).toBe(`中文 ${known}`);
    expect(upstreamText).not.toContain(known);
  });

  it.each(['settings', 'secrets', 'pattern'] as const)(
    '%s 失败不调用任何上游，也不回显密钥',
    async (phase) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const privacy = new GatewayPrivacyMasker({
        settings: () => {
          if (phase === 'settings') throw new Error(key);
          return { enabled: true, excludedPatterns: phase === 'pattern' ? ['['] : [] };
        },
        secrets: () => {
          if (phase === 'secrets') throw new Error(key);
          return [];
        },
      });
      const { gw, logs } = await gateway({ fetch, privacy });
      gw.setProviders([provider('https://mock.invalid/v1')]);
      const response = await postResponses(gw.baseURL('mock'), gw.token, body);
      expect(response.status).toBe(500);
      const error = await response.text();
      expect(error).toContain('privacy_masking_failed');
      expect(error).toContain('隐私遮蔽失败');
      expect(error).not.toContain(key);
      expect(JSON.stringify(logs)).not.toContain(key);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('网关重建复用 Host 的遮蔽实例，占位符不变', async () => {
    const payloads: unknown[] = [];
    const privacy = new GatewayPrivacyMasker({
      settings: () => ({ enabled: true }),
      secrets: () => [],
    });
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      payloads.push(JSON.parse(init?.body as string));
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    for (let i = 0; i < 2; i++) {
      const { gw } = await gateway({ privacy, fetch });
      gw.setProviders([provider('https://mock.invalid/v1')]);
      await (await postResponses(gw.baseURL('mock'), gw.token, body)).text();
      await gw.close();
    }
    expect(payloads[0]).toEqual(payloads[1]);
  });
});
