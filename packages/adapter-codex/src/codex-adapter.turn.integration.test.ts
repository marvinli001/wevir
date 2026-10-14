// 计划、回合失败的归类与会话标题（codex-event-mapping.md §6.1、§6.7、§4.4）：真实 codex-app-server + 网关 + mock 模型。

import type { ProviderConfig } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { PLAN_TOOL_CALL_PREFIX } from './mapping.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 计划、错误与标题');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['?'] });
const adapters: CodexAdapter[] = [];

async function open(
  provider: Partial<ProviderConfig> = {},
  options: Partial<Parameters<typeof newAdapter>[0]> = {},
) {
  const { home, workspace } = dirs.make('turn');
  const logger = collectingLogger();
  const adapter = newAdapter({
    home,
    providers: [{ ...mockProvider(mock), ...provider }],
    logger,
    ...options,
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId), logger };
}

const TITLE_REQUEST = {
  instructions: '你为 Wevir 的会话起标题。只输出 JSON。',
  input: '<user_prompt>\n修一下登录的 500 错误\n</user_prompt>',
  outputSchema: {
    type: 'object',
    properties: { title: { type: 'string' }, description: { type: 'string' } },
    required: ['title', 'description'],
    additionalProperties: false,
  },
};
const TITLE_JSON = '{"title": "排查登录 500 错误", "description": "登录接口返回 500"}';

describe.skipIf(binary === undefined)(
  'CodexAdapter 计划、错误与标题（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => script(view));
    });
    afterEach(async () => {
      script = () => ({ text: ['?'] });
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('计划：update_plan → todo.updated，toolCallId 是 plan:<回合 ID>，状态换成 in_progress', async () => {
      const { adapter, id, events } = await open();
      script = (view) =>
        view.toolOutputs.length > 0
          ? { text: ['好的。'] }
          : {
              toolCalls: [
                {
                  kind: 'function',
                  name: 'update_plan',
                  args: {
                    plan: [
                      { step: '读代码', status: 'completed' },
                      { step: '改', status: 'in_progress' },
                      { step: '测', status: 'pending' },
                    ],
                  },
                },
              ],
            };
      const turn = await runTurn(adapter, id, '做个计划', events);
      const todo = turn.find(ofType('todo.updated'));
      expect(todo?.toolCallId.startsWith(PLAN_TOOL_CALL_PREFIX)).toBe(true);
      expect(todo?.items).toEqual([
        { content: '读代码', status: 'completed' },
        { content: '改', status: 'in_progress' },
        { content: '测', status: 'pending' },
      ]);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('回合失败的归类：没有 Key → missing_credentials；上游 401 → provider（code 401）；上游 400 → provider', async () => {
      let { adapter, id, events } = await open({ apiKey: undefined });
      let turn = await runTurn(adapter, id, 'hi', events);
      expect(turn.at(-1)).toMatchObject({
        type: 'turn.failed',
        category: 'missing_credentials',
        code: 401,
      });

      ({ adapter, id, events } = await open());
      script = () => ({ httpError: { status: 401, message: 'bad key' } });
      turn = await runTurn(adapter, id, 'hi', events);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.failed', category: 'provider', code: 401 });
      expect((turn.at(-1) as { message: string }).message).toContain('bad key');

      script = () => ({ httpError: { status: 400, message: 'bad request' } });
      turn = await runTurn(adapter, id, 'hi', events);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.failed', category: 'provider' });
    });

    it('标题（经网关）：一次不带工具的请求，说明在 instructions，推理档位取最低，返回模型的文本', async () => {
      const { adapter, id } = await open({
        models: [
          { id: MOCK_MODEL, contextWindow: 128_000, reasoningEfforts: ['high', 'low', 'medium'] },
        ],
      });
      script = () => ({ text: [TITLE_JSON.slice(0, 10), TITLE_JSON.slice(10)] });
      const before = mock.requests.length;
      const output = await adapter.generateTitle(id, TITLE_REQUEST);
      expect(output).toBe(TITLE_JSON);
      expect(mock.requests).toHaveLength(before + 1);
      const body = mock.requests.at(-1)?.body;
      expect(body).toMatchObject({
        model: MOCK_MODEL,
        instructions: TITLE_REQUEST.instructions,
        reasoning: { effort: 'low' },
        stream: true,
      });
      expect(body?.tools ?? []).toEqual([]);
      expect(JSON.stringify(body?.input)).toContain('修一下登录的 500 错误');
    });

    it('标题（临时 thread）：ephemeral thread、只读、带 outputSchema，取最终的助手消息；不影响会话', async () => {
      const { adapter, id, events, logger } = await open({}, { titleVia: 'thread' });
      script = () => ({ text: [TITLE_JSON] });
      const output = await adapter.generateTitle(id, TITLE_REQUEST);
      expect(output).toBe(TITLE_JSON);
      const body = mock.requests.at(-1)?.body as Record<string, unknown>;
      expect(JSON.stringify(body.text)).toContain('"json_schema"');
      expect(JSON.stringify(body.input)).toContain('修一下登录的 500 错误');
      // 临时 thread 的通知不进会话，也不当成不认识的 thread 告警。
      expect(events).toEqual([]);
      expect(logger.warnings.filter((w) => w.includes('没有挂着的 thread'))).toEqual([]);
      script = () => ({ text: ['你好'] });
      const turn = await runTurn(adapter, id, 'hi', events);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });
  },
);
