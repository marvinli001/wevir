import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { PROACTIVE_SUBAGENTS_TOOL_HINT } from './config.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 主动派子智能体（Host 设置 `proactiveSubagents`）：真实 Codex + 模拟模型，看发给模型的请求。开着时 `spawn_agent` 的说明里没有
// “用户明确要求才派”的限制、换成 Wevir 的提示，开发者说明里多一节做法；关着时保持 Codex 的原样。网关 Provider 默认开工具搜索，
// `spawn_agent` 是延迟加载的：模拟模型先用 `tool_search` 把它搜出来，说明在搜索结果里。

const binary = codexBinaryOrSkip('proactive subagents');
const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
let mock: MockModel;

const RESTRICTION = 'Do not spawn sub-agents unless';
const SECTION = '## 主动派子智能体';

/** 发给模型的全部请求（首个请求带开发者说明，搜索之后的请求带 `spawn_agent` 的说明）。 */
async function requests(label: string, proactiveSubagents: boolean): Promise<string> {
  const { home, workspace } = dirs.make(label);
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const before = mock.requests.length;
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    ...(proactiveSubagents && { proactiveSubagents }),
  });
  const turn = await runTurn(
    adapter,
    engineSessionId,
    'hi',
    collectEvents(adapter, engineSessionId),
  );
  expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  const bodies = mock.requests.slice(before).map((entry) => entry.body);
  expect(bodies).toHaveLength(2);
  return JSON.stringify(bodies);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter proactive subagents',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) =>
        view.toolOutputs.length === 0
          ? {
              toolCalls: [
                {
                  kind: 'function' as const,
                  name: 'tool_search',
                  args: { query: 'spawn_agent sub-agent', limit: 5 },
                },
              ],
            }
          : { text: ['ok'] },
      );
    });
    afterAll(async () => {
      await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
      await mock?.close();
      dirs.cleanup();
    });

    it('replaces the explicit-request restriction and adds the developer section', async () => {
      const body = await requests('on', true);
      expect(body).toContain('spawn_agent');
      expect(body).toContain(PROACTIVE_SUBAGENTS_TOOL_HINT);
      expect(body).not.toContain(RESTRICTION);
      expect(body).toContain(SECTION);
    });

    it("keeps Codex's restriction when the setting is off", async () => {
      const body = await requests('off', false);
      expect(body).toContain('spawn_agent');
      expect(body).toContain(RESTRICTION);
      expect(body).not.toContain(SECTION);
    });
  },
);
