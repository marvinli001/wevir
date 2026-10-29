// 生图（0.139.0）：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock 模型）。Provider 配了图片模型，会话的工具里
// 有 wevir_image_generate、说明里有那一行；mock 模型调它，Host 用 Provider 的 Key 调同一地址的 `/images/generations`（测试里的前置
// 服务回一张 PNG，其余请求转给 mock 模型），事件流里的工具展示是 `image`、结束时带着存好的图片，不请求批准。没有 codex-app-server
// 时跳过。

import { existsSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { SessionId } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[生图 + codex] 跳过：${(error as Error).message}`);
    return false;
  }
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const KEY = 'wevir-mock-key-not-a-secret';

function wevirTool(tools: MockRequestBody['tools'], name: string) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) => t.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(name)) {
      return { name: tool.name };
    }
  }
  return undefined;
}

const seen: { listed?: boolean; instructions?: boolean } = {};

const script: MockScript = (view) => {
  if (!view.lastUserText.includes('[draw]')) return { text: ['好的。'] };
  if (view.toolOutputs.length === 0) {
    const tool = wevirTool(view.body.tools, 'wevir_image_generate');
    seen.listed = tool !== undefined;
    seen.instructions = JSON.stringify(view.body).includes('wevir_image_generate:');
    if (tool === undefined) return { text: ['没有生图工具。'] };
    return {
      toolCalls: [
        {
          kind: 'function',
          name: tool.name,
          ...(tool.namespace !== undefined && { namespace: tool.namespace }),
          args: { prompt: 'a ceramic mug', name: 'mug' },
        },
      ],
    };
  }
  return { text: [`画好了：${view.toolOutputs.at(-1) ?? ''}`] };
};

/** `/images/*` 自己回，其余转给 mock 模型（SSE 原样流过）。 */
async function frontServer(modelBaseURL: string) {
  const target = new URL(modelBaseURL);
  const images: Array<{ url: string; auth: string | undefined; body: string }> = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.includes('/images/')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        images.push({ url: req.url ?? '', auth: req.headers.authorization, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      });
      return;
    }
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: `${target.pathname.replace(/\/$/, '')}${req.url?.replace(/^\/v1/, '') ?? ''}`,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    images,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!binaryAvailable())(
  '生图工具（startHost + 真实 codex-app-server + mock 模型）',
  { timeout: 120_000 },
  () => {
    it('Provider 有图片模型时列出工具，调用后对话里显示生成的图片，不请求批准', async () => {
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const front = await frontServer(model.baseURL);
      cleanups.push(() => front.close());
      const home = join(tempDir(), 'home');
      const host = await startHost({
        home,
        adapter: new CodexRuntime({
          home,
          binary: resolveCodexBinary(),
          clientInfo: { name: 'wevir', version: '0.0.0' },
        }),
        engine: 'codex',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(host.url);
      cleanups.push(() => client.ws.close());
      const hello = await client.hello(info.token as string, undefined, {
        tool_display_image: true,
      });
      expect(hello.result.features).toMatchObject({ image_generation: true });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: front.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        imageModels: [{ id: 'gpt-image-2' }],
        defaultModelId: MOCK_MODEL,
        apiKey: KEY,
      });

      const { session } = await client.request('session.create', { providerId: 'wevir-mock' });
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId: session.id as SessionId,
        sinceSeq: 0,
      });
      const sent = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: '[draw] 画一个杯子' }],
      });
      await client.until(
        () =>
          client
            .events(subscriptionId)
            .find((e) => e.type === 'turn.finished' && e.payload.turnId === sent.turnId),
        'turn.finished',
        90_000,
      );
      expect(seen).toEqual({ listed: true, instructions: true });
      const events = client.events(subscriptionId);
      expect(events.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(front.images).toHaveLength(1);
      expect(front.images[0]?.url).toBe('/v1/images/generations');
      expect(front.images[0]?.auth).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(front.images[0]?.body ?? '{}')).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'a ceramic mug',
      });

      const started = events.find(
        (e) => e.type === 'tool.started' && e.payload.toolName.includes('wevir_image_generate'),
      );
      expect(started?.type === 'tool.started' && started.payload.display).toMatchObject({
        kind: 'image',
        summary: 'a ceramic mug',
      });
      const toolCallId = started?.type === 'tool.started' ? started.payload.toolCallId : '';
      const finished = events.find(
        (e) => e.type === 'tool.finished' && e.payload.toolCallId === toolCallId,
      );
      expect(finished?.type === 'tool.finished' && finished.payload.images).toHaveLength(1);
      const output =
        finished?.type === 'tool.finished' ? (finished.payload.output?.text ?? '') : '';
      expect(output).toContain('Generated 1 image with gpt-image-2');
      expect(output).not.toContain(PNG_BASE64);
      const path = /- (\S+\.png)/.exec(output)?.[1] ?? '';
      expect(path).toContain(join(home, 'generated-images', session.id));
      expect(existsSync(path)).toBe(true);
    });
  },
);
