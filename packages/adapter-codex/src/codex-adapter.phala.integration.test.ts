// 真实 codex-app-server + 本机网关的错误透传；不访问 RedPill / Phala，也不证明真实服务可用。
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';

const binary = codexBinaryOrSkip('RedPill / Phala 路由错误');
const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
  dirs.cleanup();
});

describe.skipIf(binary === undefined)(
  'RedPill / Phala 错误穿过 Codex 到达会话',
  { timeout: 60_000 },
  () => {
    it.each([
      {
        status: 404,
        type: 'not_found_error',
        message: 'No provider can serve this model under the routing constraints',
        code: 'phala_no_route',
      },
      {
        status: 503,
        type: 'service_unavailable',
        message:
          'upstream verification failed: no attested upstream available for model z-ai/glm-5.3',
        code: 'phala_attestation_unavailable',
      },
    ])('$status 的标记保留到 turn.failed', async ({ status, type, message, code }) => {
      const { home, workspace } = dirs.make('phala-routing');
      const key = 'phala-mock-credential';
      let requests = 0;
      const efforts: unknown[] = [];
      const adapter = newAdapter({
        home,
        providers: [
          {
            id: 'redpill',
            kind: 'openai-compatible',
            displayName: 'RedPill mock',
            api: 'openai-responses',
            baseURL: 'https://api.redpill.ai/v1',
            models: [{ id: 'openai/gpt-5.5' }],
            defaultModelId: 'openai/gpt-5.5',
            apiKey: key,
          },
        ],
        gateway: {
          fetch: async (_url, init) => {
            requests++;
            const body = JSON.parse(String(init?.body)) as { reasoning?: { effort?: unknown } };
            efforts.push(body.reasoning?.effort);
            return new Response(
              JSON.stringify({ error: { type, message: `${message}; key=${key}` } }),
              { status },
            );
          },
        },
      });
      adapters.push(adapter);
      const { engineSessionId } = await adapter.createSession({
        cwd: workspace,
        providerId: 'redpill',
        modelId: 'openai/gpt-5.5',
      });
      const events = collectEvents(adapter, engineSessionId);
      const turn = await runTurn(adapter, engineSessionId, 'hi', events);
      const failed = turn.at(-1);
      expect(requests).toBeGreaterThan(0);
      expect(efforts.every((effort) => effort === undefined)).toBe(true);
      expect(failed).toMatchObject({ type: 'turn.failed', category: 'provider', code: status });
      if (failed?.type !== 'turn.failed') throw new Error('没有回合错误');
      expect(failed.message).toContain(`[${code}]`);
      expect(failed.message).toContain('key=***');
      expect(failed.message).not.toContain(key);
    });
  },
);
