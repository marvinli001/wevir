// 录制映射单元测试的输入（src/test-fixtures/app-server/*.jsonl）：真实 codex-app-server + 网关 + mock 模型跑几个场景，
// 把属于该会话（及其子 thread）的原始通知按到达顺序写成 JSONL，本机路径换成占位符。平时跳过；升级 Codex 后重录：
//
//   WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server
//
// 每个文件第一行是 `{"_meta": …}`（版本、场景、说明），其余每行 `{"method", "params"}`。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { CodexAdapter } from '../codex-adapter.js';
import { CODEX_VERSION } from '../paths.js';
import { codexBinaryOrSkip, newAdapter, TempDirs } from './harness.js';
import {
  MOCK_MODEL,
  MOCK_PATCH,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './mock-model.js';

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
    name: 'subagent',
    description:
      '子 agent：父 thread 调 multi_agent_v1.spawn_agent，子 thread 的通知推到同一连接（R2 按 engine.raw 挂在父会话上）',
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
];

const binary = RECORD ? codexBinaryOrSkip('record-app-server') : undefined;
const dirs = new TempDirs();

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

/** 本机路径换成占位符：工作区、数据目录（含 CODEX_HOME）、家目录、临时目录。长的先换。 */
function sanitize(text: string, paths: { home: string; workspace: string }): string {
  const pairs: Array<[string, string]> = [
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
