// 录制测试样本（src/test-fixtures/app-server/）：真实 codex-app-server + 网关 + mock 模型跑几个场景，本机路径换成占位符。
// 平时跳过；升级 Codex 后重录（可以用 -t 只录其中一组）：
//
//   WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server
//
// - 通知样本 `<场景>.jsonl`：第一行 `{"_meta": …}`（版本、场景、说明），其余每行 `{"method", "params"}`，只含属于该
//   会话（及其子 thread）的通知。映射单元测试（mapping.test.ts）与假的 app-server（fake-app-server.mjs）的输入。
// - 审批对话 `approval-<exec|patch>.jsonl` 与 `approval-<…>.<分支>.jsonl`：同一个场景跑几遍、每遍做不同的决定，
//   前缀（到审批请求为止，请求写成 `{"serverRequest": {"id", "method", "params"}}`）与每个分支在请求之后的部分分开
//   写；thread、回合、item 与请求的 ID 换成 `<thread>`、`<turn>`、`<item:N>`（按首次出现的顺序）、`<request>`，
//   分支之间对得上。假的 app-server 据此回放审批（第 1 层契约）。
// - 错误样本 `errors/turn-*.json`（`turn/completed` 的 failed 参数）与 `errors/resume-*.json`（`thread/resume` 的
//   JSON-RPC 错误）：turn-error.test.ts、resume-error.test.ts 与假的 app-server 用。

import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, isAdapterError } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from '../codex-adapter.js';
import { CodexRpcError } from '../codex-process.js';
import { CODEX_VERSION } from '../paths.js';
import { escalatedCommand } from './contract.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './harness.js';
import {
  MOCK_MODEL,
  MOCK_PATCH,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './mock-model.js';
import { makeOutsideDir } from './outside-dir.js';

const RECORD = process.env.WEVIR_RECORD_CODEX === '1';
const OUT_DIR = join(import.meta.dirname, 'app-server');

interface Scenario {
  name: string;
  description: string;
  prompt: string;
  script: MockScript;
  /** 发出回合之后做什么（取消等）。 */
  during?: (adapter: CodexAdapter, sessionId: string, events: AgentEvent[]) => Promise<void>;
  /** 回合结束后再等一会儿（子 thread 的通知）。 */
  settleMs?: number;
  files?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'stream',
    description:
      '一问一答：推理增量 → 文本增量 → 已提交的 reasoning 与 agentMessage → 用量 → turn/completed',
    prompt: 'Say hello',
    script: () => ({
      reasoning: ['The user ', 'greets me.'],
      text: ['Hello', ' from', ' the mock.'],
      delayMs: 5,
    }),
  },
  {
    name: 'tool-read',
    description: '只读命令：exec_command `cat README.md`，commandActions 为 read',
    prompt: 'Read the readme',
    files: { 'README.md': 'hello readme\n' },
    script: (view) =>
      view.toolOutputs.length > 0
        ? { text: ['The readme says hello.'] }
        : {
            toolCalls: [{ kind: 'function', name: 'exec_command', args: { cmd: 'cat README.md' } }],
          },
  },
  {
    name: 'tool-search',
    description:
      '搜索与列目录：exec_command `rg -n hello` 与 `ls`，commandActions 为 search / listFiles',
    prompt: 'Find hello',
    files: { 'notes.txt': 'say hello\n' },
    script: (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Found it.'] }
        : {
            toolCalls: [
              { kind: 'function', name: 'exec_command', args: { cmd: 'grep -rn hello .' } },
              { kind: 'function', name: 'exec_command', args: { cmd: 'ls' } },
            ],
          },
  },
  {
    name: 'tool-shell',
    description: '普通命令：分几次输出，有 item/commandExecution/outputDelta',
    prompt: 'Count to three',
    script: (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Counted.'] }
        : {
            toolCalls: [
              {
                kind: 'function',
                name: 'exec_command',
                args: { cmd: 'for i in 1 2 3; do echo line $i; sleep 0.2; done' },
              },
            ],
          },
  },
  {
    name: 'apply-patch',
    description: '工作区内的补丁：apply_patch 新建文件，fileChange item（不需要审批）',
    prompt: 'Create a file',
    script: (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Created wevir-mock.txt.'] }
        : { toolCalls: [{ kind: 'custom', name: 'apply_patch', input: MOCK_PATCH }] },
  },
  {
    name: 'upstream-error',
    description: '上游 HTTP 400：error（willRetry false）→ turn/completed failed',
    prompt: 'Fail please',
    script: () => ({ httpError: { status: 400, message: 'mock upstream rejected the request' } }),
  },
  {
    name: 'cancel',
    description:
      '流式中途 turn/interrupt：已发出的增量没有 item/completed，turn/completed interrupted',
    prompt: 'Write a long answer',
    script: () => ({
      text: Array.from({ length: 40 }, (_, i) => `chunk ${i} `),
      delayMs: 100,
    }),
    during: async (adapter, sessionId, events) => {
      const deadline = Date.now() + 15_000;
      while (!events.some((event) => event.type === 'assistant.delta')) {
        if (Date.now() > deadline) throw new Error('没等到增量');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await adapter.cancel(sessionId);
    },
  },
  {
    name: 'plan',
    description: '计划：模型调 update_plan，turn/plan/updated 没有对应的 item',
    prompt: 'Make a plan',
    script: (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Planned.'] }
        : {
            toolCalls: [
              {
                kind: 'function',
                name: 'update_plan',
                args: {
                  explanation: 'Three steps',
                  plan: [
                    { step: 'Read the code', status: 'completed' },
                    { step: 'Write the fix', status: 'in_progress' },
                    { step: 'Run the tests', status: 'pending' },
                  ],
                },
              },
            ],
          },
  },
  {
    name: 'subagent',
    description:
      '子 agent：父 thread 调 multi_agent_v1.spawn_agent、不等它就结束回合，子 thread 的通知推到同一连接（R4 起按子会话上报）',
    prompt: 'Spawn a helper',
    settleMs: 3000,
    script: (view) => {
      if (view.lastUserText.startsWith('Helper task')) return { text: ['Helper', ' done.'] };
      if (view.toolOutputs.length > 0) return { text: ['Spawned the helper.'] };
      return {
        toolCalls: [
          {
            kind: 'function',
            namespace: 'multi_agent_v1',
            name: 'spawn_agent',
            args: { message: 'Helper task\nSay that you are done.' },
          },
        ],
      };
    },
  },
  {
    name: 'subagent-wait',
    description:
      '子 agent：spawn → wait（与 Spike 的 subagent 场景相同），父回合等子 thread 的回合结束（wait 的 agentsStates 带子 agent 的回答）再回答',
    prompt: 'Spawn a helper and wait',
    settleMs: 1000,
    script: (view) => {
      if (view.lastUserText.startsWith('Helper task')) return { text: ['Helper', ' done.'] };
      if (view.toolOutputs.length === 0) {
        return {
          toolCalls: [
            {
              kind: 'function',
              namespace: 'multi_agent_v1',
              name: 'spawn_agent',
              args: { message: 'Helper task\nSay that you are done.' },
            },
          ],
        };
      }
      if (view.toolOutputs.length === 1) {
        const id = /"(?:agent_id|id)"\s*:\s*"([^"]+)"/.exec(view.toolOutputs[0] ?? '')?.[1];
        return {
          toolCalls: [
            {
              kind: 'function',
              namespace: 'multi_agent_v1',
              name: 'wait_agent',
              args: { targets: [id], timeout_ms: 30000 },
            },
          ],
        };
      }
      return { text: ['The helper is done.'] };
    },
  },
];

const binary = RECORD ? codexBinaryOrSkip('record-app-server') : undefined;
const dirs = new TempDirs();
// 用 -t 只录其中一组时，别的 describe 的 afterAll 不跑，在这里统一清理。
afterAll(() => dirs.cleanup());

describe.skipIf(!RECORD || binary === undefined)('录制 codex-app-server 通知样本', () => {
  let mock: MockModel;
  let script: MockScript = () => ({ text: ['?'] });

  beforeAll(async () => {
    mock = await startMockModel((view) => script(view));
    mkdirSync(OUT_DIR, { recursive: true });
  });
  afterAll(async () => {
    await mock?.close();
    dirs.cleanup();
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, { timeout: 60_000 }, async () => {
      const { home, workspace } = dirs.make(`record-${scenario.name}`);
      for (const [name, content] of Object.entries(scenario.files ?? {})) {
        writeFileSync(join(workspace, name), content);
      }
      script = scenario.script;
      const notifications: Array<{ method: string; params: unknown }> = [];
      const adapter = newAdapter({
        home,
        providers: [mockProvider(mock)],
        onRawNotification: (method, params) => notifications.push({ method, params }),
      });
      try {
        const { engineSessionId } = await adapter.createSession({
          cwd: workspace,
          providerId: 'mock',
          modelId: MOCK_MODEL,
        });
        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const event of adapter.subscribe(engineSessionId)) {
            events.push(event);
            if (event.type === 'turn.settled' || event.type === 'turn.failed') return;
          }
        })();
        await adapter.send(engineSessionId, { content: [{ type: 'text', text: scenario.prompt }] });
        await scenario.during?.(adapter, engineSessionId, events);
        await done;
        if (scenario.settleMs)
          await new Promise((resolve) => setTimeout(resolve, scenario.settleMs));

        const threads = new Set([engineSessionId, ...childThreads(notifications)]);
        const lines = notifications
          .filter(({ params }) => threads.has(threadOf(params) ?? ''))
          .map((n) => JSON.stringify(n));
        const meta = {
          _meta: {
            recordedBy:
              'packages/adapter-codex/src/test-fixtures/record-app-server.test.ts（WEVIR_RECORD_CODEX=1）',
            codex: CODEX_VERSION,
            scenario: scenario.name,
            description: scenario.description,
            prompt: scenario.prompt,
          },
        };
        const text = sanitize([JSON.stringify(meta), ...lines].join('\n'), { home, workspace });
        writeFileSync(join(OUT_DIR, `${scenario.name}.jsonl`), `${text}\n`);
      } finally {
        await adapter.dispose();
      }
    });
  }
});

interface Conversation {
  name: string;
  description: string;
  /** 每遍在审批请求之后做什么：选项的 optionId，或 interrupt（审批挂起时取消）。 */
  branches: string[];
  prompt: (outside: string) => string;
  script: (outside: string) => MockScript;
}

const CONVERSATIONS: Conversation[] = [
  {
    name: 'approval-exec',
    description:
      '命令审批：模型带 require_escalated 调 exec_command 在工作区外 touch，item/started 之后是审批请求；分支是四个决定与审批挂起时 turn/interrupt',
    branches: ['accept', 'decline', 'cancel', 'interrupt'],
    prompt: (outside) => `[wevir:APPROVAL] touch ${outside}`,
    script: (outside) => (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Done: ', (view.toolOutputs.at(-1) ?? '').slice(0, 40)] }
        : { toolCalls: [escalatedCommand(`touch ${join(outside, 'approval.txt')}`)] },
  },
  {
    name: 'approval-patch',
    description:
      '补丁审批：apply_patch 新建工作区外的文件，fileChange 的 item/started 之后是审批请求（不带补丁内容）；分支是同意与“告诉它换个做法”',
    branches: ['accept', 'cancel'],
    prompt: (outside) => `[wevir:PATCH] ${outside}`,
    script: (outside) => (view) =>
      view.toolOutputs.length > 0
        ? { text: ['Patched.'] }
        : {
            toolCalls: [
              {
                kind: 'custom',
                name: 'apply_patch',
                input: [
                  '*** Begin Patch',
                  `*** Add File: ${join(outside, 'approval.txt')}`,
                  '+outside',
                  '*** End Patch',
                ].join('\n'),
              },
            ],
          },
  },
];

describe.skipIf(!RECORD || binary === undefined)('录制审批对话', () => {
  for (const conversation of CONVERSATIONS) {
    it(conversation.name, { timeout: 120_000 }, async () => {
      const outside = makeOutsideDir(`record-${conversation.name}`);
      const mock = await startMockModel(conversation.script(outside.dir));
      let prefix: string[] | undefined;
      try {
        for (const branch of conversation.branches) {
          const { home, workspace } = dirs.make(`record-${conversation.name}-${branch}`);
          const lines: Array<Record<string, unknown>> = [];
          const adapter = newAdapter({
            home,
            providers: [mockProvider(mock)],
            onRawNotification: (method, params) => lines.push({ method, params }),
            onRawServerRequest: (request) => lines.push({ serverRequest: request }),
          });
          try {
            const { engineSessionId } = await adapter.createSession({
              cwd: workspace,
              providerId: 'mock',
              modelId: MOCK_MODEL,
            });
            const events: AgentEvent[] = [];
            const done = (async () => {
              for await (const event of adapter.subscribe(engineSessionId)) {
                events.push(event);
                if (event.type === 'turn.settled' || event.type === 'turn.failed') return;
              }
            })();
            await adapter.send(engineSessionId, {
              content: [{ type: 'text', text: conversation.prompt(outside.dir) }],
            });
            const request = await waitForEvent(events, 'approval.requested');
            if (branch === 'interrupt') await adapter.cancel(engineSessionId);
            else
              await adapter.respondToApproval(engineSessionId, request.requestId, {
                optionId: branch,
              });
            await done;
            // 回合在审批未决时中断：serverRequest/resolved 在 turn/completed 之后才到。
            await new Promise((resolve) => setTimeout(resolve, 500));
            const own = lines.filter(
              (line) =>
                threadOf(line.params ?? (line.serverRequest as { params?: unknown })?.params) ===
                engineSessionId,
            );
            const normalized = normalizeIds(own, engineSessionId).map((line) =>
              sanitize(JSON.stringify(line), { home, workspace, outside: outside.dir }),
            );
            const split = normalized.findIndex((line) => line.startsWith('{"serverRequest"'));
            expect(split).toBeGreaterThanOrEqual(0);
            prefix ??= normalized.slice(0, split + 1);
            const meta = (part: string) =>
              JSON.stringify({
                _meta: {
                  recordedBy:
                    'packages/adapter-codex/src/test-fixtures/record-app-server.test.ts（WEVIR_RECORD_CODEX=1）',
                  codex: CODEX_VERSION,
                  scenario: conversation.name,
                  part,
                  description: conversation.description,
                },
              });
            writeFileSync(
              join(OUT_DIR, `${conversation.name}.${branch}.jsonl`),
              `${[meta(`审批请求之后：${branch}`), ...normalized.slice(split + 1)].join('\n')}\n`,
            );
          } finally {
            await adapter.dispose();
          }
        }
        writeFileSync(
          join(OUT_DIR, `${conversation.name}.jsonl`),
          `${[
            JSON.stringify({
              _meta: {
                recordedBy:
                  'packages/adapter-codex/src/test-fixtures/record-app-server.test.ts（WEVIR_RECORD_CODEX=1）',
                codex: CODEX_VERSION,
                scenario: conversation.name,
                part: '到审批请求为止',
                description: conversation.description,
                branches: conversation.branches,
              },
            }),
            ...(prefix ?? []),
          ].join('\n')}\n`,
        );
      } finally {
        await mock.close();
        outside.remove();
      }
    });
  }
});

interface TurnErrorCase {
  name: string;
  description: string;
  script?: MockScript;
  provider?: (mock: MockModel) => Partial<ReturnType<typeof mockProvider>>;
}

const TURN_ERRORS: TurnErrorCase[] = [
  {
    name: 'turn-401',
    description: '上游 401：httpConnectionFailed（401）',
    script: () => ({ httpError: { status: 401, message: 'mock: invalid api key' } }),
  },
  {
    name: 'turn-429',
    description: '上游 429：重试用完，responseTooManyFailedAttempts（429）',
    script: () => ({ httpError: { status: 429, message: 'mock: rate limited' } }),
  },
  {
    name: 'turn-500',
    description: '上游 500：internalServerError，Codex 换成自己的说明',
    script: () => ({ httpError: { status: 500, message: 'mock: server error' } }),
  },
  {
    name: 'turn-400',
    description: '上游 400：other，原文是上游的错误体',
    script: () => ({ httpError: { status: 400, message: 'mock: bad request' } }),
  },
  {
    name: 'turn-missing-key',
    description: 'Provider 没有 Key：网关回 401（wevir gateway: Provider … 没有 API Key）',
    provider: () => ({ apiKey: undefined }),
  },
  {
    name: 'turn-unreachable',
    description: '连不上上游：网关回 502（wevir gateway: 连不上上游）',
    provider: () => ({ baseURL: 'http://127.0.0.1:9/v1' }),
  },
];

describe.skipIf(!RECORD || binary === undefined)('录制错误样本', () => {
  const ERRORS_DIR = join(OUT_DIR, 'errors');

  for (const errorCase of TURN_ERRORS) {
    it(errorCase.name, { timeout: 60_000 }, async () => {
      mkdirSync(ERRORS_DIR, { recursive: true });
      const mock = await startMockModel(errorCase.script ?? (() => ({ text: ['?'] })));
      const { home, workspace } = dirs.make(`record-${errorCase.name}`);
      let completed: unknown;
      const adapter = newAdapter({
        home,
        providers: [{ ...mockProvider(mock), ...errorCase.provider?.(mock) }],
        onRawNotification: (method, params) => {
          if (method === 'turn/completed') completed = params;
        },
      });
      try {
        const { engineSessionId } = await adapter.createSession({
          cwd: workspace,
          providerId: 'mock',
          modelId: MOCK_MODEL,
        });
        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const event of adapter.subscribe(engineSessionId)) {
            events.push(event);
            if (event.type === 'turn.settled' || event.type === 'turn.failed') return;
          }
        })();
        await adapter.send(engineSessionId, { content: [{ type: 'text', text: 'Fail please' }] });
        await done;
        const params = normalizeIds([{ params: completed }], engineSessionId)[0]?.params;
        const text = sanitize(
          JSON.stringify(
            {
              _meta: {
                codex: CODEX_VERSION,
                case: errorCase.name,
                description: errorCase.description,
              },
              params,
            },
            null,
            2,
          ),
          { home, workspace },
        ).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
        writeFileSync(join(ERRORS_DIR, `${errorCase.name}.json`), `${text}\n`);
      } finally {
        await adapter.dispose();
        await mock.close();
      }
    });
  }

  it('resume', { timeout: 60_000 }, async () => {
    mkdirSync(ERRORS_DIR, { recursive: true });
    const mock = await startMockModel(() => ({ text: ['hi'] }));
    const { home, workspace } = dirs.make('record-resume');
    const config = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
    const write = (name: string, description: string, error: unknown) => {
      expect(isAdapterError(error)).toBe(true);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(CodexRpcError);
      const { code, rpcMessage } = cause as CodexRpcError;
      const text = sanitize(
        JSON.stringify(
          { _meta: { codex: CODEX_VERSION, case: name, description }, code, message: rpcMessage },
          null,
          2,
        ),
        { home, workspace },
      );
      writeFileSync(join(ERRORS_DIR, `${name}.json`), `${text}\n`);
    };
    let adapter = newAdapter({ home, providers: [mockProvider(mock)] });
    try {
      write(
        'resume-invalid-id',
        '不是 Codex 的 thread ID',
        await adapter.resumeSession('not-a-codex-thread', config).catch((e: unknown) => e),
      );
      write(
        'resume-not-found',
        'CODEX_HOME 里没有这个 thread 的 rollout',
        await adapter
          .resumeSession('019a0000-0000-7000-8000-000000000000', config)
          .catch((e: unknown) => e),
      );
      // 对话过一个回合（rollout 写下了），关掉进程，把 rollout 清空，再在新进程上恢复。
      const { engineSessionId } = await adapter.createSession(config);
      const done = (async () => {
        for await (const event of adapter.subscribe(engineSessionId)) {
          if (event.type === 'turn.settled' || event.type === 'turn.failed') return;
        }
      })();
      await adapter.send(engineSessionId, { content: [{ type: 'text', text: 'hi' }] });
      await done;
      await adapter.dispose();
      const rollout = findFiles(join(home, 'engines', 'codex', 'sessions')).find((file) =>
        file.includes(engineSessionId),
      );
      expect(rollout).toBeDefined();
      writeFileSync(rollout as string, '');
      adapter = newAdapter({ home, providers: [mockProvider(mock)] });
      const corrupted = await adapter
        .resumeSession(engineSessionId, config)
        .catch((e: unknown) => e);
      write('resume-corrupted', 'rollout 被清空：读不出会话的元数据', corrupted);
    } finally {
      await adapter.dispose();
      await mock.close();
    }
  });
});

async function waitForEvent<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Promise<Extract<AgentEvent, { type: T }>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = events.find((event) => event.type === type);
    if (found) return found as Extract<AgentEvent, { type: T }>;
    if (Date.now() > deadline) throw new Error(`没等到 ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function findFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? findFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * 审批对话的 ID 换成占位符：thread → `<thread>`，回合 → `<turn>`，item（`item.id`、`itemId`）→ `<item:N>`（按首次出现
 * 的顺序），服务端请求的 id 与 `serverRequest/resolved` 的 requestId → `<request>`。同一场景的几遍里顺序一样，分支对得上。
 */
function normalizeIds<T extends Record<string, unknown>>(lines: T[], threadId: string): T[] {
  const turns = new Map<string, string>();
  const items = new Map<string, string>();
  const requests = new Set<unknown>();
  const visit = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) out[k] = visit(v, k);
      if (key === 'serverRequest' && 'id' in record) {
        requests.add(record.id);
        out.id = '<request>';
      }
      if (
        (key === 'item' || key === undefined) &&
        typeof record.type === 'string' &&
        typeof record.id === 'string' &&
        record.type !== 'message'
      ) {
        out.id = itemId(record.id);
      }
      if (key === 'turn' && typeof record.id === 'string') out.id = turnId(record.id);
      return out;
    }
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    if (key === 'threadId' && value === threadId) return '<thread>';
    if ((key === 'turnId' || key === 'rootTurnId') && typeof value === 'string')
      return turnId(value);
    if (key === 'itemId' && typeof value === 'string') return itemId(value);
    if (key === 'requestId' && requests.has(value)) return '<request>';
    return value;
  };
  const turnId = (id: string) => {
    if (!turns.has(id)) turns.set(id, turns.size === 0 ? '<turn>' : `<turn:${turns.size + 1}>`);
    return turns.get(id) as string;
  };
  const itemId = (id: string) => {
    if (!items.has(id)) items.set(id, `<item:${items.size + 1}>`);
    return items.get(id) as string;
  };
  return lines.map((line) => visit(line) as T);
}

function threadOf(params: unknown): string | undefined {
  const id = (params as { threadId?: unknown } | null)?.threadId;
  return typeof id === 'string' ? id : undefined;
}

function childThreads(notifications: ReadonlyArray<{ params: unknown }>): string[] {
  return notifications.flatMap(({ params }) => {
    const item = (params as { item?: { type?: unknown; receiverThreadIds?: unknown } } | null)
      ?.item;
    return item?.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : [];
  });
}

/** 本机路径换成占位符：工作区、工作区外的目录、数据目录（含 CODEX_HOME）、家目录、临时目录。长的先换。 */
function sanitize(
  text: string,
  paths: { home: string; workspace: string; outside?: string },
): string {
  const pairs: Array<[string, string]> = [
    ...(paths.outside === undefined ? [] : [[paths.outside, '<outside>'] as [string, string]]),
    [paths.workspace, '<workspace>'],
    [paths.home, '<data>'],
    [homedir(), '<home>'],
    [tmpdir(), '<tmp>'],
    [realpathSync(tmpdir()), '<tmp>'],
  ];
  let out = text;
  for (const [from, to] of pairs.sort(([a], [b]) => b.length - a.length)) {
    out = out.replaceAll(from, to).replaceAll(JSON.stringify(from).slice(1, -1), to);
  }
  return out;
}
