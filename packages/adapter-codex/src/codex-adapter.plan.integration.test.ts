// 计划模式（0.36.0，codex-event-mapping.md §4.10、§6.14）：真实 codex-app-server + 网关 + mock 模型。turn/start 带的协作模式
// 经模型请求里的 `<collaboration_mode>` 开发者消息核对；计划是 `plan` item。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockRequestBody,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 计划模式');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['?'] });
const adapters: CodexAdapter[] = [];

/** Wevir 的 plan-mode.md 的标题（经网关的模型在计划回合里收到它）。 */
const PLAN_HEADING = '# 协作模式：计划';
/** Codex 内置的 default.md 的标题。 */
const DEFAULT_HEADING = '# Collaboration Mode: Default';

const PLAN_REPLY = [
  '看过了 README 与入口。',
  '',
  '<proposed_plan>',
  '# 加一个导出按钮',
  '',
  '## 概述',
  '',
  '- 在工具栏加“导出”',
  '</proposed_plan>',
].join('\n');

async function open(roots?: string[]) {
  const { home, workspace } = dirs.make('plan');
  const adapter = newAdapter({
    home,
    providers: [
      mockProvider(mock, {
        models: [{ id: MOCK_MODEL, contextWindow: 128_000, reasoningEfforts: ['low', 'high'] }],
      }),
    ],
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    reasoningEffort: 'high',
    ...(roots !== undefined && { additionalRoots: roots }),
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId) };
}

async function turn(
  adapter: CodexAdapter,
  id: string,
  text: string,
  events: AgentEvent[],
  mode?: 'plan' | 'default',
): Promise<AgentEvent[]> {
  const from = events.length;
  await adapter.send(id, {
    content: [{ type: 'text', text }],
    ...(mode !== undefined && { collaborationMode: mode }),
  });
  return finishTurn(events, from);
}

/** 请求里的开发者消息，按出现的先后。 */
function developerTexts(body: MockRequestBody | undefined): string[] {
  return (body?.input ?? [])
    .filter((item) => item.type === 'message' && item.role === 'developer')
    .map((item) => JSON.stringify(item.content));
}

/** 请求里最后一条 `<collaboration_mode>` 开发者消息。 */
function lastModeText(body: MockRequestBody | undefined): string | undefined {
  return developerTexts(body)
    .filter((text) => text.includes('<collaboration_mode>'))
    .at(-1);
}

function toolNames(body: MockRequestBody | undefined): string[] {
  const names: string[] = [];
  const walk = (tools: MockRequestBody['tools']) => {
    for (const tool of tools ?? []) {
      if (typeof tool.name === 'string') names.push(tool.name);
      if (Array.isArray(tool.tools)) walk(tool.tools as MockRequestBody['tools']);
    }
  };
  walk(body?.tools);
  return names;
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 计划模式（真实 codex-app-server）',
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

    it('计划回合：带 Wevir 的 plan-mode.md 与会话的档位，<proposed_plan> → plan.proposed，回答里不留计划块', async () => {
      const { adapter, id, events } = await open();
      script = () => ({ text: [PLAN_REPLY.slice(0, 30), PLAN_REPLY.slice(30)] });
      const result = await turn(adapter, id, '加个导出按钮，先出计划', events, 'plan');
      expect(result.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

      const body = mock.requests.at(-1)?.body;
      expect(lastModeText(body)).toContain(PLAN_HEADING);
      // 协作模式的 settings 带会话的模型与档位：计划回合照样是 high。
      expect(body).toMatchObject({ model: MOCK_MODEL, reasoning: { effort: 'high' } });
      // 计划模式里 request_user_input 照常可用（default_mode_request_user_input 之外，计划模式本来就有）。
      expect(toolNames(body)).toContain('request_user_input');

      const plan = result.find(ofType('plan.proposed'));
      expect(plan).toMatchObject({
        type: 'plan.proposed',
        engineSessionId: id,
        text: '# 加一个导出按钮\n\n## 概述\n\n- 在工具栏加“导出”',
      });
      expect(plan?.planId).toMatch(/-plan$/);
      const answer = result.filter(ofType('assistant.message')).map((m) => m.text);
      expect(answer.join('')).toContain('看过了 README 与入口。');
      expect(answer.join('')).not.toContain('<proposed_plan>');
      // 开了实验面之后多出来的通知（计划的增量、thread 设置的回执）不留成 engine.raw。
      const raws = result.filter(ofType('engine.raw')).map((event) => event.method);
      expect(raws).not.toContain('item/plan/delta');
      expect(raws).not.toContain('thread/settings/updated');
    });

    it('计划之后的默认回合：换回 Codex 内置的默认模式说明，不再出计划', async () => {
      const { adapter, id, events } = await open();
      script = () => ({ text: [PLAN_REPLY] });
      await turn(adapter, id, '先出计划', events, 'plan');
      script = () => ({ text: ['开始实施。'] });
      const result = await turn(adapter, id, '实施这个计划', events);
      expect(result.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      const body = mock.requests.at(-1)?.body;
      expect(lastModeText(body)).toContain(DEFAULT_HEADING);
      expect(body).toMatchObject({ reasoning: { effort: 'high' } });
      expect(result.filter(ofType('plan.proposed'))).toEqual([]);
    });

    it('默认模式的会话：第一个回合起就是默认模式说明；计划块不当成计划', async () => {
      const { adapter, id, events } = await open();
      script = () => ({ text: [PLAN_REPLY] });
      const result = await turn(adapter, id, 'hi', events);
      expect(lastModeText(mock.requests.at(-1)?.body)).toContain(DEFAULT_HEADING);
      expect(result.filter(ofType('plan.proposed'))).toEqual([]);
    });

    it('额外目录的 developer instructions 不被协作模式的说明替换', async () => {
      const outside = dirs.make('plan-extra').workspace;
      const { adapter, id, events } = await open([outside]);
      script = () => ({ text: [PLAN_REPLY] });
      await turn(adapter, id, '先出计划', events, 'plan');
      const texts = developerTexts(mock.requests.at(-1)?.body).join('\n');
      expect(texts).toContain(outside);
      expect(texts).toContain(PLAN_HEADING);
    });

    it('计划回合里的提问：request_user_input → question.requested，回答后照样出计划', async () => {
      const { adapter, id, events } = await open();
      script = (view) =>
        view.toolOutputs.length === 0
          ? {
              toolCalls: [
                {
                  kind: 'function',
                  name: 'request_user_input',
                  args: {
                    questions: [
                      {
                        id: 'scope',
                        header: '范围',
                        question: '导出哪些格式？',
                        options: [
                          { label: 'CSV（推荐）', description: '最简单' },
                          { label: 'CSV 与 PDF', description: '多一个依赖' },
                        ],
                      },
                    ],
                  },
                },
              ],
            }
          : { text: [PLAN_REPLY] };
      const from = events.length;
      await adapter.send(id, {
        content: [{ type: 'text', text: '先问清楚再出计划' }],
        collaborationMode: 'plan',
      });
      const asked = await waitForEvent(events, ofType('question.requested'), '提问', from);
      await adapter.respondToQuestion(id, asked.requestId, { scope: ['CSV（推荐）'] });
      const result = await finishTurn(events, from);
      expect(result.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain('CSV（推荐）');
      expect(result.find(ofType('plan.proposed'))?.text).toContain('# 加一个导出按钮');
    });
  },
);
