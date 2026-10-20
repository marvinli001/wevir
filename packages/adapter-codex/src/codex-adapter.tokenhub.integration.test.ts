// 真实锁定 Codex + 本机 mock：核对普通 Responses、Hy3 / Hy4 的档位 与 custom 摊平后的 apply_patch，未访问腾讯云。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import { startMockModel } from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('TokenHub Responses');
const dirs = new TempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.cleanup();
});

describe.skipIf(binary === undefined)(
  'TokenHub Responses 经真实 Codex',
  { timeout: 60_000 },
  () => {
    it.each([
      { model: 'hy3', effort: 'off', wireEffort: 'none' },
      { model: 'hy3', effort: 'low', wireEffort: 'low' },
      { model: 'hy3', effort: 'high', wireEffort: 'high' },
      { model: 'hy4-preview', effort: 'off', wireEffort: 'none' },
      { model: 'hy4-preview', effort: 'high', wireEffort: 'high' },
    ])('$model / $effort 使用函数工具改文件并回放结果', async ({ model, effort, wireEffort }) => {
      const contextWindow = model === 'hy3' ? 262144 : 1000000;
      const efforts = model === 'hy3' ? ['off', 'low', 'high'] : ['off', 'high'];
      const { home, workspace } = dirs.make('tokenhub');
      const patch = '*** Begin Patch\n*** Add File: tokenhub.txt\n+TokenHub mock\n*** End Patch';
      const mock = await startMockModel((view) => {
        if (
          view.body.tools?.some((tool) => tool.type !== 'function') ||
          view.body.input.some((item) => item.type === 'additional_tools')
        ) {
          return { httpError: { status: 400, message: 'mock requires ordinary function tools' } };
        }
        const reasoning = effort === 'high' ? { reasoning: ['先用补丁修改文件。'] } : {};
        return view.toolOutputs.length === 0
          ? {
              ...reasoning,
              toolCalls: [{ kind: 'function', name: 'apply_patch', args: { input: patch } }],
            }
          : { ...reasoning, text: ['文件已创建。'] };
      });
      cleanups.push(() => mock.close());
      const adapter = newAdapter({
        home,
        providers: [
          {
            id: 'tencent',
            kind: 'openai-compatible',
            displayName: 'TokenHub mock',
            api: 'openai-responses',
            baseURL: 'https://tokenhub.tencentcloudmaas.com/v1',
            apiKey: 'tokenhub-mock-not-a-real-key',
            models: [
              {
                id: model,
                contextWindow,
                reasoningEfforts: efforts,
              },
            ],
            defaultModelId: model,
          },
        ],
        gateway: {
          fetch: async (url, init) => {
            expect(String(url)).toBe('https://tokenhub.tencentcloudmaas.com/v1/responses');
            return fetch(`${mock.baseURL}/responses`, init);
          },
        },
      });
      cleanups.push(() => adapter.dispose());
      const { engineSessionId } = await adapter.createSession({
        cwd: workspace,
        providerId: 'tencent',
        modelId: model,
        reasoningEffort: effort,
        permissionMode: 'full_access',
      });
      const catalog = JSON.parse(readFileSync(adapter.paths.catalogFile, 'utf8')) as {
        models: Array<Record<string, unknown>>;
      };
      expect(catalog.models[0]).toMatchObject({
        slug: model,
        apply_patch_tool_type: 'freeform',
        context_window: contextWindow,
        input_modalities: ['text'],
        supported_reasoning_levels: efforts.map((effort) => ({
          effort: effort === 'off' ? 'none' : effort,
        })),
      });
      expect(catalog.models[0]).not.toHaveProperty('use_responses_lite');
      const events = collectEvents(adapter, engineSessionId);
      const turn = await runTurn(
        adapter,
        engineSessionId,
        '用 apply_patch 创建 tokenhub.txt。',
        events,
      );
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(readFileSync(join(workspace, 'tokenhub.txt'), 'utf8')).toBe('TokenHub mock\n');
      expect(mock.requests).toHaveLength(2);
      for (const request of mock.requests) {
        expect(request.body.reasoning).toMatchObject({ effort: wireEffort });
        expect(request.body.reasoning).not.toHaveProperty('context');
        expect(request.headers['x-openai-internal-codex-responses-lite']).toBeUndefined();
        expect(request.body.input.some((item) => item.type === 'additional_tools')).toBe(false);
        expect(request.body.tools?.find((tool) => tool.name === 'apply_patch')).toMatchObject({
          type: 'function',
          parameters: { required: ['input'] },
        });
      }
      const history = mock.requests[1]?.body.input ?? [];
      expect(history.some((item) => item.type === 'custom_tool_call')).toBe(false);
      expect(history.find((item) => item.type === 'function_call')).toMatchObject({
        name: 'apply_patch',
        arguments: JSON.stringify({ input: patch }),
      });
      expect(history.some((item) => item.type === 'function_call_output')).toBe(true);
      if (effort === 'high') {
        expect(history.find((item) => item.type === 'reasoning')).toMatchObject({
          content: [{ type: 'reasoning_text', text: '先用补丁修改文件。' }],
        });
      }
    });
  },
);
