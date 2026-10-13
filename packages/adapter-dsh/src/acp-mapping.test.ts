// ACP → AgentEvent 的映射，以 T0.3 录制的样本为输入（test-fixtures/acp，来源见同目录 README.md）。
// 每个样本要么在这里有快照测试，要么在 COVERED_ELSEWHERE / EXEMPT 里写明由哪个测试覆盖、或为什么不属于 T3.2；
// 最后一条用例保证新加的样本不会被漏掉。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  type AcpSessionNotification,
  type AcpSessionUpdate,
  isAcpSessionNotification,
  mapAcpUpdate,
  sessionConfigInfo,
} from './acp-mapping.js';
import {
  fixtureFiles,
  readFixture,
  readTranscript,
  replayTranscript,
} from './test-fixtures/acp-fixtures.js';
import { classifyTurnError, type TurnErrorCategory } from './turn-error.js';

const FILES = fixtureFiles();
const UPDATES = FILES.filter((f) => f.startsWith('mock/updates/'));
const TRANSCRIPTS = FILES.filter((f) => f.endsWith('.jsonl'));
const SCENARIOS = FILES.filter(
  (f) => f.startsWith('mock/scenarios/') && Array.isArray(readFixture<Scenario>(f).updates),
);
const TOOL_LIFECYCLES = FILES.filter((f) =>
  /^mock\/permission\/after-.+\.tool-lifecycle\.json$/.test(f),
);
const PROMPT_ERRORS = FILES.filter((f) => f.startsWith('errors/prompt-'));
const SESSION_CONFIGS = [
  'session-new.response.json',
  'session-new.openai-compatible.response.json',
  'session-resume.response.json',
];
const NOT_AN_UPDATE = ['mock/permission/request.json'];

/** 由其他测试文件覆盖的样本。 */
const COVERED_ELSEWHERE: Record<string, string> = {
  'initialize.request.json': 'dsh-process.test.ts：initialize 的 clientCapabilities 为 {}（T3.1）',
  'initialize.response.json': 'dsh-process.test.ts：initialize 的协议版本校验（T3.1）',
  'session-new.request.json': 'dsh-adapter.test.ts：createSession 发出的 session/new 与样本同形',
  'session-close.response.json': 'dsh-adapter.test.ts：close 收到 {} 后结束订阅',
  'errors/close-unknown-session.json':
    'dsh-adapter.test.ts：close 遇到 -32602 unknown session 仍算关闭',
};

/** 不属于 T3.2 的样本，写明原因。 */
const EXEMPT: Record<string, string> = {
  'session-list.response.json': 'Wevir 不用 session/list（ADR-0001 §5 第 2 条）',
  'errors/resume-active-session.json': 'resume 属于 T3.5',
  'errors/resume-cwd-mismatch.json': 'resume 属于 T3.5',
  'errors/session-load-unsupported.json': 'Wevir 不调用 session/load',
  'mock/permission/responses.json': 'request_permission 的回复属于 T3.3',
  'mock/scenarios/F-stream-granularity.summary.json': '计时摘要，不含 ACP 消息（T0.3 §4）',
  'mock/scenarios/H-first-request-after-resume.json':
    'mock Provider 收到的模型请求，不是 ACP 消息（T3.5）',
};

interface Scenario {
  updates?: Array<{ sessionId: string; update: AcpSessionUpdate }>;
}

function map(notification: AcpSessionNotification) {
  const raw: string[] = [];
  const events = mapAcpUpdate(notification, (reason, detail) => raw.push(`${reason}: ${detail}`));
  return { events, raw };
}

const SESSION = 'fixture-session';
const notify = (update: Record<string, unknown>): AcpSessionNotification => ({
  sessionId: SESSION,
  update: update as AcpSessionUpdate,
});

describe('mock/updates：每类 session/update 一个样本', () => {
  it.each(UPDATES)('%s', (file) => {
    const params = readFixture(file);
    expect(isAcpSessionNotification(params)).toBe(true);
    const { events, raw } = map(params as AcpSessionNotification);
    expect(raw).toEqual([]);
    expect(events).toMatchSnapshot();
  });

  it('agent_message_chunk 是一条已提交消息，replaces 留给会话队列填', () => {
    const [event] = map(readFixture('mock/updates/agent_message_chunk.json')).events;
    expect(event).toEqual({
      type: 'assistant.message',
      engineSessionId: 'a96a4101-fee3-411e-b638-d9e25710d351',
      messageId: '4fd1bb9d-29ad-4122-85a9-8e7ed07a9a0c',
      text: '已把 total=15 写入 summary.md，暗号也记住了。',
      replaces: [],
    });
  });

  it('tool_call：title 是工具名，展示类型按工具名取，rawInput 原样作 input', () => {
    const [event] = map(readFixture('mock/updates/tool_call.json')).events;
    expect(event).toMatchObject({
      type: 'tool.started',
      toolCallId: 'call_mv4pwxip_0',
      toolName: 'read',
      display: { kind: 'read', summary: 'input.csv', paths: ['input.csv'] },
      input: { file_path: 'input.csv' },
    });
  });

  it('tool_call_update：completed / failed 都是 tool.finished，结果原文作 output', () => {
    const failed = map(readFixture('mock/updates/tool_call_update.failed.json')).events;
    expect(failed).toEqual([
      expect.objectContaining({
        type: 'tool.finished',
        status: 'failed',
        output: expect.stringMatching(/^Error: \[sandbox: file access denied/),
      }),
    ]);
  });

  it('usage_update：used / size 改名为 contextUsed / contextSize', () => {
    expect(map(readFixture('mock/updates/usage_update.json')).events).toEqual([
      {
        type: 'usage.updated',
        engineSessionId: 'a96a4101-fee3-411e-b638-d9e25710d351',
        contextUsed: 5768,
        contextSize: 262144,
      },
    ]);
  });
});

describe('transcripts：按 DshAdapter 的路径回放完整录制', () => {
  it.each(TRANSCRIPTS)('%s', async (file) => {
    const { events, warnings } = await replayTranscript(readTranscript(file));
    expect(warnings).toEqual([]);
    for (const list of Object.values(events)) expectTurnOrder(list);
    expect(events).toMatchSnapshot();
  });

  it('E2：取消时补发的半段消息照常是 assistant.message，回合以 cancelled 结算', async () => {
    const { events } = await replayTranscript(
      readTranscript('mock/transcripts/E2-cancel-during-generation.jsonl'),
    );
    const list = Object.values(events)[0] as AgentEvent[];
    expect(list.map((e) => e.type)).toEqual(['assistant.message', 'turn.settled']);
    expect(list[1]).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
  });

  it('todo-subagent：todo_write 之后紧跟完整的 todo 列表，subagent 按子 agent 展示', async () => {
    const { events } = await replayTranscript(
      readTranscript('mock/transcripts/todo-subagent.jsonl'),
    );
    const list = Object.values(events)[0] as AgentEvent[];
    const todos = list.filter((e) => e.type === 'todo.updated');
    expect(todos).toEqual([
      expect.objectContaining({
        toolCallId: 'call_mv4pxc1e_0',
        items: [
          { content: '读取 input.csv', status: 'in_progress' },
          { content: '统计数据行数', status: 'pending' },
          { content: '写入 rows.txt', status: 'pending' },
        ],
      }),
      expect.objectContaining({ toolCallId: 'call_mv4pxc6w_0' }),
    ]);
    const started = list.findIndex(
      (e) => e.type === 'tool.started' && e.toolCallId === 'call_mv4pxc1e_0',
    );
    expect(list[started + 1]?.type).toBe('todo.updated');
    expect(list.find((e) => e.type === 'tool.started' && e.toolName === 'subagent')).toMatchObject({
      display: { kind: 'sub_agent', summary: '统计数据行数' },
    });
  });

  it('concurrency：三个会话交错的更新各归各的会话', async () => {
    const { events } = await replayTranscript(readTranscript('mock/transcripts/concurrency.jsonl'));
    expect(Object.keys(events)).toHaveLength(3);
    for (const list of Object.values(events)) {
      expect(list.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    }
  });
});

describe('scenarios：场景摘要里的更新与 transcript 是同一批帧', () => {
  it.each(SCENARIOS)('%s', async (file) => {
    const scenario = readFixture<Scenario>(file);
    const mapped = (scenario.updates ?? []).flatMap((u) => map(u).events);
    expect(mapped).toMatchSnapshot();
    const transcript = file.replace('/scenarios/', '/transcripts/').replace(/\.json$/, 'l');
    if (FILES.includes(transcript)) {
      const { events } = await replayTranscript(readTranscript(transcript));
      const replayed = Object.values(events)
        .flat()
        .filter((e) => !isTurnTerminal(e));
      expect(mapped).toEqual(replayed);
    }
  });
});

describe('permission：审批前后两次工具调用的完整生命周期', () => {
  it.each(TOOL_LIFECYCLES)('%s', (file) => {
    const calls = readFixture<Array<{ toolCallId: string; updates: AcpSessionUpdate[] }>>(file);
    const mapped = calls.map((call) => call.updates.flatMap((u) => map(notify(u)).events));
    expect(mapped).toMatchSnapshot();
    // 第一次是沙箱拒绝，第二次带 sandbox_permissions 升级重试（T0.3 §5.3）。
    expect(mapped[0]?.at(-1)).toMatchObject({ type: 'tool.finished', status: 'failed' });
    expect(mapped[1]?.[0]).toMatchObject({
      type: 'tool.started',
      toolName: 'write',
      display: { kind: 'write' },
      input: expect.objectContaining({ sandbox_permissions: 'danger-full-access' }),
    });
  });

  it.each(NOT_AN_UPDATE)(
    '%s 不是 session/update，不会被当作会话更新路由（审批属于 T3.3）',
    (file) => {
      expect(isAcpSessionNotification(readFixture(file))).toBe(false);
    },
  );
});

describe('errors：session/prompt 的 -32603 按前缀归类，保留原文', () => {
  const EXPECTED: Record<string, TurnErrorCategory> = {
    'errors/prompt-missing-key.deepseek-official.json': 'missing_credentials',
    'errors/prompt-missing-key.openai-compatible.json': 'missing_credentials',
    'errors/prompt-provider-401.openai-compatible.json': 'provider',
    'errors/prompt-provider-429.openai-compatible.json': 'provider',
    'errors/prompt-provider-500.openai-compatible.json': 'provider',
    'errors/prompt-provider-connection.openai-compatible.json': 'provider',
    // llm-deepseek 把 Provider 的错误消息原样放在 turn failed 后面，没有可依赖的前缀。
    'errors/prompt-provider-401.deepseek-official.json': 'unknown',
  };

  it('每个 prompt 错误样本都有预期类别', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(PROMPT_ERRORS);
  });

  it.each(PROMPT_ERRORS)('%s', (file) => {
    const { error } = readFixture<{ error: { message: string; code: number } }>(file);
    const classified = classifyTurnError(error);
    expect(classified).toEqual({ category: EXPECTED[file], message: error.message, code: -32603 });
    expect(classified).toMatchSnapshot();
  });
});

describe('session/new 与 session/resume 的 configOptions', () => {
  it.each(SESSION_CONFIGS)('%s', (file) => {
    const { result } = readFixture<{ result: { configOptions: unknown } }>(file);
    expect(sessionConfigInfo(result.configOptions)).toMatchSnapshot();
  });

  it('dsh 的 model 值是 JSON 编码的 [provider, model]', () => {
    const { result } = readFixture<{ result: { configOptions: unknown } }>(
      'session-new.response.json',
    );
    expect(sessionConfigInfo(result.configOptions)).toEqual({
      modelId: 'deepseek-v4-flash',
      reasoningEffort: 'high',
    });
  });
});

describe('不认识的内容映射为 engine.raw，原样保留', () => {
  it('dsh 0.2.1-alpha.2 不发的类型：engine.raw，params 是整条通知', () => {
    const notification = notify({ sessionUpdate: 'plan', entries: [{ content: 'x' }] });
    const { events, raw } = map(notification);
    expect(events).toEqual([
      {
        type: 'engine.raw',
        engineSessionId: SESSION,
        protocol: 'acp',
        method: 'session/update',
        kind: 'plan',
        params: notification,
      },
    ]);
    expect(raw).toEqual(['unknown_type: plan']);
  });

  it('config_option_update：认识的类型，v0 有意保留为 engine.raw，不算异常', () => {
    const { events, raw } = map(
      notify({ sessionUpdate: 'config_option_update', configOptions: [] }),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'engine.raw', kind: 'config_option_update' }),
    ]);
    expect(raw).toEqual(['by_design: config_option_update']);
  });

  it('认识的类型但字段不合预期：图片消息、缺 messageId、坏的 usage', () => {
    for (const update of [
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm',
        content: { type: 'image', data: 'AA==', mimeType: 'image/png' },
      },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } },
      { sessionUpdate: 'usage_update', used: -1, size: 10 },
      { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'read', status: 'weird' },
    ]) {
      const { events, raw } = map(notify(update));
      expect(events).toEqual([
        expect.objectContaining({ type: 'engine.raw', kind: update.sessionUpdate }),
      ]);
      expect(raw).toEqual([expect.stringMatching(/^unexpected_fields: /)]);
    }
  });

  it('工具结果里有非文本内容：文本照常进 output，整条另发 engine.raw', () => {
    const notification = notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: 'a.txt', newText: 'b' },
      ],
    });
    const { events, raw } = map(notification);
    expect(events).toEqual([
      {
        type: 'tool.finished',
        engineSessionId: SESSION,
        toolCallId: 'c',
        status: 'completed',
        output: 'ok',
      },
      expect.objectContaining({ type: 'engine.raw', params: notification }),
    ]);
    expect(raw).toHaveLength(1);
  });

  it('非终态的 tool_call_update 是 tool.updated；带 title 时重新计算展示类型', () => {
    expect(
      map(
        notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c',
          status: 'in_progress',
          title: 'bash',
          rawInput: { command: 'ls -la' },
        }),
      ).events,
    ).toEqual([
      {
        type: 'tool.updated',
        engineSessionId: SESSION,
        toolCallId: 'c',
        display: { kind: 'shell', command: 'ls -la', summary: 'ls -la' },
        input: { command: 'ls -la' },
      },
    ]);
  });

  it('tool_call 直接带终态（ACP 允许，dsh 不发）：tool.started 后紧跟 tool.finished', () => {
    const types = map(
      notify({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'grep', status: 'completed' }),
    ).events.map((e) => e.type);
    expect(types).toEqual(['tool.started', 'tool.finished']);
  });
});

it('每个样本都有对应的测试，或写明由别处覆盖、为什么不属于 T3.2', () => {
  const tested = new Set([
    ...UPDATES,
    ...TRANSCRIPTS,
    ...SCENARIOS,
    ...TOOL_LIFECYCLES,
    ...PROMPT_ERRORS,
    ...SESSION_CONFIGS,
    ...NOT_AN_UPDATE,
  ]);
  const accounted = [...tested, ...Object.keys(COVERED_ELSEWHERE), ...Object.keys(EXEMPT)].sort();
  expect(accounted).toEqual(FILES);
  for (const reference of Object.values(COVERED_ELSEWHERE)) {
    const testFile = reference.split('：')[0] as string;
    expect(existsSync(fileURLToPath(new URL(`./${testFile}`, import.meta.url)))).toBe(true);
  }
});

/** 每个回合恰好一个终结事件，且在该回合的其他事件之后；回合之外只有 engine.raw 与 usage。 */
function expectTurnOrder(events: AgentEvent[]): void {
  let open = false;
  for (const event of events) {
    if (isTurnTerminal(event)) {
      open = false;
    } else if (event.type !== 'engine.raw' && event.type !== 'usage.updated') {
      open = true;
    }
  }
  expect(open).toBe(false);
}
