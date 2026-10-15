// 建议的后续任务（0.16.0，U23，codex-event-mapping.md §6.8）：真实 codex-app-server + 网关 + mock 模型。Wevir 的本机 MCP
// 服务登记在 config.toml，模型看得到 `suggest_tasks`，调用不问用户，完成后报 `tasks.suggested`；`injectNote` 补进 thread 的
// 说明在下一次请求里。二进制不在时跳过。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { SUGGEST_TASKS_SERVER, SUGGEST_TASKS_TOOL } from './suggest-tasks.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockRequestBody,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 建议的后续任务');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

const TASKS = [
  {
    title: '补齐导出接口的测试',
    prompt: '给 src/export.ts 的导出函数补单元测试并跑通。',
    reason: '没有覆盖',
  },
  { title: 'Update the README', prompt: 'Document the new export flags in README.md.' },
];

/** 请求里发给模型的工具：顶层的名字，以及命名空间里的 `<namespace>/<名字>`。 */
function toolNames(tools: MockRequestBody['tools']): string[] {
  return (tools ?? []).flatMap((tool) =>
    tool.type === 'namespace'
      ? ((tool.tools ?? []) as Array<{ name?: string }>).map((t) => `${tool.name}/${t.name}`)
      : [tool.name ?? tool.type],
  );
}

/** 找到 Wevir 的 MCP 工具：命名空间或顶层的名字里带 `suggest_tasks`。 */
function suggestTool(tools: MockRequestBody['tools']): { name: string; namespace?: string } {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) =>
        t.name?.includes(SUGGEST_TASKS_TOOL),
      );
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.includes(SUGGEST_TASKS_TOOL)) {
      return { name: tool.name };
    }
  }
  throw new Error(`请求里没有 ${SUGGEST_TASKS_TOOL}：${toolNames(tools).join(', ')}`);
}

const script: MockScript = (view) => {
  if (view.toolOutputs.length > 0) return { text: ['已经建议了。'] };
  if (view.lastUserText.includes('[suggest]')) {
    const tool = suggestTool(view.body.tools);
    return {
      toolCalls: [
        {
          kind: 'function',
          name: tool.name,
          ...(tool.namespace !== undefined && { namespace: tool.namespace }),
          args: { tasks: TASKS },
        },
      ],
    };
  }
  return { text: ['你好。'] };
};

async function open() {
  const { home, workspace } = dirs.make('tasks');
  const logger = collectingLogger();
  const adapter = newAdapter({ home, providers: [mockProvider(mock)], logger });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId), logger };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return finishTurn(events, from);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 建议的后续任务（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('模型看得到 suggest_tasks，调用不问用户；工具完成后报 tasks.suggested', async () => {
      const { adapter, id, events } = await open();
      const turn = await run(adapter, id, events, '[suggest]');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      // 模型看到的是命名空间 mcp__wevir_tasks 里的 suggest_tasks；MCP 服务正常启动不出 engine.raw。
      expect(toolNames(mock.requests[0]?.body.tools)).toContain(
        `mcp__${SUGGEST_TASKS_SERVER}/${SUGGEST_TASKS_TOOL}`,
      );
      expect(turn.some((e) => e.type === 'engine.raw')).toBe(false);
      expect(turn.find(ofType('tool.started'))).toMatchObject({
        toolName: 'mcp__wevir_tasks__suggest_tasks',
      });
      const finished = turn.find(ofType('tool.finished'));
      expect(finished).toMatchObject({ status: 'completed' });
      const suggested = turn.find(ofType('tasks.suggested'));
      expect(suggested).toEqual({
        type: 'tasks.suggested',
        engineSessionId: id,
        toolCallId: finished?.toolCallId,
        tasks: TASKS,
      });
      expect(turn.indexOf(suggested as AgentEvent)).toBe(turn.indexOf(finished as AgentEvent) + 1);
      // 工具的回答回到了模型。
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain(
        'Showed 2 suggested task(s)',
      );
    });

    it('injectNote：补进 thread 的说明不开回合，下一次请求里有它', async () => {
      const { adapter, id, events } = await open();
      await run(adapter, id, events, '你好');
      const before = events.length;
      await adapter.injectNote(id, 'NOTE-FROM-WEVIR: the task finished.');
      expect(events.slice(before).some((e) => e.type === 'turn.started')).toBe(false);
      await run(adapter, id, events, '再说一句');
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain(
        'NOTE-FROM-WEVIR: the task finished.',
      );
    });
  },
);
