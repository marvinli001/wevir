// 真实 `opencode` 上的契约：用户装的 opencode（或 WEVIR_TEST_OPENCODE_BIN 指的那一个）+ 本机假模型（test-fixtures/mock-model.ts），
// 不用订阅、不联网。opencode 的数据、配置、缓存都在临时目录里，不碰用户自己的登录与会话。平时跳过；要跑时：
//
//   WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN="$(which opencode)" \
//     pnpm vitest run --project adapter-opencode contract.real
//
// 用订阅真跑一个回合的步骤见 docs/architecture/opencode-event-mapping.md §8。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { DEFAULT_CONTRACT_PROMPTS, runAdapterContract } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import {
  isolatedOpenCodeEnv,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  MOCK_STRUCTURED_TITLE,
  type MockModel,
  STRUCTURED_OUTPUT_TOOL,
  startMockModel,
} from './test-fixtures/mock-model.js';

const ENABLED = process.env.WEVIR_TEST_OPENCODE === '1';
const BIN = process.env.WEVIR_TEST_OPENCODE_BIN;

const root = ENABLED ? realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-contract-'))) : '';
const workspace = join(root, 'workspace');
let model: MockModel | undefined;

beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'hello.txt'), 'wevir fixture\n');
  model = await startMockModel();
});

afterAll(async () => {
  if (!ENABLED) return;
  await model?.close();
  rmSync(root, { recursive: true, force: true });
});

if (ENABLED) {
  runAdapterContract(
    () => {
      if (model === undefined) throw new Error('mock model not started');
      return new OpenCodeAdapter({
        home: join(root, 'home'),
        env: {
          ...isolatedOpenCodeEnv(root, model.baseUrl),
          ...(BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
        },
        idleTtlMs: 1_000,
      });
    },
    {
      incrementalStream: true,
      toolCalls: true,
      approvals: true,
      resume: true,
      concurrentSessions: true,
      subagents: true,
      steer: true,
    },
    {
      name: 'OpenCodeAdapter 契约（真实 opencode + 假模型）',
      sessionConfig: () => ({
        cwd: workspace,
        providerId: 'opencode',
        modelId: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
      }),
      waitTimeoutMs: 20_000,
      testTimeoutMs: 60_000,
      simulateEngineExit: async (adapter) => {
        const pid = adapter.serverPid;
        if (pid === undefined) throw new Error('the OpenCode server is not running');
        process.kill(-pid, 'SIGKILL');
      },
      resourcesReleased: (adapter) => adapter.serverPid === undefined,
    },
  );
}

const MODEL = `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`;
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

function newAdapter(name: string): OpenCodeAdapter {
  if (model === undefined) throw new Error('mock model not started');
  return new OpenCodeAdapter({
    home: join(root, name),
    env: {
      ...isolatedOpenCodeEnv(root, model.baseUrl),
      ...(BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
    },
  });
}

/** 一个会话的事件，`until` 等到满足条件。 */
function watch(adapter: OpenCodeAdapter, id: string) {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of adapter.subscribe(id)) events.push(event);
  })();
  const until = async (predicate: (list: AgentEvent[]) => boolean, from = 0) => {
    const deadline = Date.now() + 20_000;
    while (!predicate(events.slice(from))) {
      if (Date.now() > deadline) {
        throw new Error(`timed out (${events.map((event) => event.type).join(', ')})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const turn = async (prompt: string) => {
    const from = events.length;
    await adapter.send(id, text(prompt));
    await until((list) => list.some(isTurnTerminal), from);
    return events.slice(from);
  };
  return { events, until, turn };
}

/** 假模型收到的请求里各条消息的角色与文本。 */
function transcript(index: number): string[] {
  const request = model?.requests[index] as
    | { messages?: Array<{ role: string; content?: unknown }> }
    | undefined;
  return (request?.messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}: ${JSON.stringify(message.content)}`);
}

/** 最后一条用户消息含 `needle` 的那个请求。 */
function requestFor(needle: string, from = 0): number {
  for (let index = (model?.requests.length ?? 0) - 1; index >= from; index -= 1) {
    const last = transcript(index)
      .filter((line) => line.startsWith('user: '))
      .at(-1);
    if (last?.includes(needle)) return index;
  }
  throw new Error(`no request for ${needle}`);
}

describe.skipIf(!ENABLED)('OpenCodeAdapter（真实 opencode + 假模型）', { timeout: 60_000 }, () => {
  it('标题：经 StructuredOutput 交出 JSON，说明接在系统提示后面', async () => {
    const adapter = newAdapter('home-title');
    try {
      const session = await adapter.createSession({
        cwd: workspace,
        providerId: 'opencode',
        modelId: MODEL,
      });
      const from = model?.requests.length ?? 0;
      const title = await adapter.generateTitle(session.engineSessionId, {
        instructions: 'You write Wevir titles.',
        input: '<user_prompt>fix the login bug</user_prompt>',
        outputSchema: {
          type: 'object',
          properties: { title: { type: 'string' }, description: { type: 'string' } },
          required: ['title', 'description'],
        },
      });
      expect(JSON.parse(title)).toEqual(MOCK_STRUCTURED_TITLE);
      const requests = model?.requests.slice(from) as Array<Record<string, unknown>>;
      // 只有标题这一个请求（给了标题的临时会话 opencode 不再生成标题）。
      expect(requests).toHaveLength(1);
      expect(requests[0]?.tool_choice).toBe('required');
      expect(
        ((requests[0]?.tools ?? []) as Array<{ function: { name: string } }>).map(
          (tool) => tool.function.name,
        ),
      ).toEqual([STRUCTURED_OUTPUT_TOOL]);
      expect(JSON.stringify(requests[0]?.messages)).toContain('You write Wevir titles.');
    } finally {
      await adapter.dispose();
    }
  });

  it('支线：带主线到最近一个完成的回合为止的历史与边界消息，主线不受影响', async () => {
    const adapter = newAdapter('home-side');
    try {
      const config = { cwd: workspace, providerId: 'opencode', modelId: MODEL };
      const main = await adapter.createSession(config);
      const mainLog = watch(adapter, main.engineSessionId);
      await mainLog.turn(DEFAULT_CONTRACT_PROMPTS.plain);
      // 主线的第二个回合进行中分出支线：不含这个回合。
      const from = mainLog.events.length;
      await adapter.send(main.engineSessionId, text(DEFAULT_CONTRACT_PROMPTS.slow));
      await mainLog.until((list) => list.some((event) => event.type === 'assistant.delta'), from);
      const side = await adapter.fork(main.engineSessionId, config);
      await adapter.cancel(main.engineSessionId);
      const sideLog = watch(adapter, side.engineSessionId);
      const sideTurn = await sideLog.turn('Side question');
      expect(sideTurn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      const sideRequest = transcript(requestFor('Side question'));
      const joined = sideRequest.join('\n');
      expect(joined).toContain(DEFAULT_CONTRACT_PROMPTS.plain);
      expect(joined).toContain('Hello from the mock model.');
      expect(joined).not.toContain(DEFAULT_CONTRACT_PROMPTS.slow);
      const boundary = sideRequest.findIndex((line) =>
        line.includes('Side conversation starts here'),
      );
      expect(boundary).toBeGreaterThan(
        sideRequest.findIndex((line) => line.includes('Hello from the mock model.')),
      );
      expect(boundary).toBeLessThan(sideRequest.length - 1);
      expect(SIDE_BOUNDARY_NOTE).toContain('Side conversation starts here');

      await mainLog.turn('Main again');
      const mainRequest = transcript(requestFor('Main again')).join('\n');
      expect(mainRequest).not.toContain('Side question');
      expect(mainRequest).not.toContain('Side conversation starts here');
    } finally {
      await adapter.dispose();
    }
  });

  it('补充说明：不开回合，下一次请求里有它；回合中补的等到回合之后', async () => {
    const adapter = newAdapter('home-note');
    try {
      const session = await adapter.createSession({
        cwd: workspace,
        providerId: 'opencode',
        modelId: MODEL,
      });
      const id = session.engineSessionId;
      const log = watch(adapter, id);
      const before = model?.requests.length ?? 0;
      await adapter.injectNote(id, 'Note one for the model.');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(model?.requests.length).toBe(before);
      expect(log.events).toEqual([]);

      const from = log.events.length;
      await adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.slow));
      await log.until((list) => list.some((event) => event.type === 'assistant.delta'), from);
      await adapter.injectNote(id, 'Note two for the model.');
      await adapter.cancel(id);
      const requestsAfterCancel = model?.requests.length ?? 0;
      await log.turn('After the notes');
      const lines = transcript(requestFor('After the notes', requestsAfterCancel));
      const one = lines.findIndex((line) => line.includes('Note one for the model.'));
      const two = lines.findIndex((line) => line.includes('Note two for the model.'));
      expect(one).toBeGreaterThanOrEqual(0);
      expect(two).toBeGreaterThan(one);
      expect(two).toBeLessThan(lines.length - 1);
    } finally {
      await adapter.dispose();
    }
  });

  it('插话之后取消：没用上的插话不留在 opencode 的历史里', async () => {
    const adapter = newAdapter('home-steer-cancel');
    try {
      const session = await adapter.createSession({
        cwd: workspace,
        providerId: 'opencode',
        modelId: MODEL,
      });
      const id = session.engineSessionId;
      const log = watch(adapter, id);
      await adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.slow));
      await log.until((list) => list.some((event) => event.type === 'assistant.delta'));
      await adapter.steer(id, 'steer-1', text(DEFAULT_CONTRACT_PROMPTS.steer));
      await adapter.cancel(id);
      expect(log.events.some((event) => event.type === 'turn.steered')).toBe(false);
      const from = model?.requests.length ?? 0;
      await log.turn('After the cancel');
      const lines = transcript(requestFor('After the cancel', from)).join('\n');
      expect(lines).toContain(DEFAULT_CONTRACT_PROMPTS.slow);
      expect(lines).not.toContain(DEFAULT_CONTRACT_PROMPTS.steer);
    } finally {
      await adapter.dispose();
    }
  });

  it('格式正确但不存在的会话恢复时报 session_lost', async () => {
    if (model === undefined) throw new Error('mock model not started');
    const adapter = new OpenCodeAdapter({
      home: join(root, 'home-lost'),
      env: {
        ...isolatedOpenCodeEnv(root, model.baseUrl),
        ...(BIN !== undefined && { [OPENCODE_BIN_ENV]: BIN }),
      },
    });
    try {
      await expect(
        adapter.resumeSession('ses_ffffffffffffffffffffffffff', {
          cwd: workspace,
          providerId: 'opencode',
          modelId: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
        }),
      ).rejects.toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
    } finally {
      await adapter.dispose();
    }
  });
});
