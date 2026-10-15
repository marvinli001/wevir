// OpenCodeAdapter 在假的 opencode 上（test-fixtures/fake-opencode.ts 回放真实录音）：提问、审批的三种回复、子会话、失败、规则集、
// 服务器退出与重起、回合开始前的旧 idle。

import type { AgentEvent } from '@wevir/runtime-adapter';
import { isTurnTerminal } from '@wevir/runtime-adapter';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { childPermissionRules, DECLINE_FEEDBACK, permissionRules } from './permissions.js';
import type { Event, PermissionRuleset } from './sdk.js';
import { type FakeHarness, fakeHarness } from './test-fixtures/harness.js';
import {
  EXTRA_PROMPTS,
  SUBAGENT_APPROVAL_PROMPT,
  SUBAGENT_PROMPT,
} from './test-fixtures/mock-model.js';

const MODEL = 'mock/echo';

let harness: FakeHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function setup(extra: Parameters<typeof fakeHarness>[0] = {}): FakeHarness {
  harness = fakeHarness(extra);
  return harness;
}

/** 收一个会话的事件。 */
function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  void (async () => {
    for await (const event of stream) {
      events.push(event);
      for (const wake of waiters.splice(0)) wake();
    }
    ended = true;
    for (const wake of waiters.splice(0)) wake();
  })();
  const until = async (predicate: (events: AgentEvent[]) => boolean, what: string) => {
    const deadline = Date.now() + 3_000;
    while (!predicate(events)) {
      if (ended || Date.now() > deadline) {
        throw new Error(`没等到${what}（已收到：${events.map((event) => event.type).join(', ')}）`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return {
    events,
    until,
    terminal: () => until((list) => list.some(isTurnTerminal), '回合终结事件'),
    ended: () => ended,
  };
}

async function openSession(h: FakeHarness, extra: Record<string, unknown> = {}) {
  const session = await h.adapter.createSession({
    cwd: h.home,
    providerId: 'opencode',
    modelId: MODEL,
    ...extra,
  });
  return {
    id: session.engineSessionId,
    session,
    log: collect(h.adapter.subscribe(session.engineSessionId)),
  };
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

function calls(h: FakeHarness, method: string) {
  return h.fake.calls.filter((call) => call.method === method).map((call) => call.args);
}

describe('OpenCodeAdapter（假 opencode）', () => {
  it('建会话：带权限模式的规则集，引擎版本是服务器的版本', async () => {
    const h = setup();
    const { session } = await openSession(h, { permissionMode: 'full_access' });
    expect(session.engineVersion).toBe('1.18.34');
    expect(calls(h, 'createSession')[0]?.[0]).toEqual({
      permission: permissionRules('full_access'),
    });
    await openSession(h, { additionalRoots: ['/other/project/'] });
    const rules = (
      calls(h, 'createSession')[1]?.[0] as { permission: PermissionRuleset } | undefined
    )?.permission;
    expect(rules?.at(-1)).toEqual({
      permission: 'external_directory',
      pattern: '/other/project/*',
      action: 'allow',
    });
  });

  it('发消息：带 Wevir 生成的 msg_ ID、拆开的模型与变体', async () => {
    const h = setup();
    const { id, log } = await openSession(h, { reasoningEffort: 'high' });
    await h.adapter.send(id, text('Say hello'));
    await log.terminal();
    const [prompt] = calls(h, 'promptAsync')[0] as [Record<string, unknown>];
    expect(prompt).toMatchObject({
      sessionID: id,
      model: { providerID: 'mock', modelID: 'echo' },
      variant: 'high',
      parts: [{ type: 'text', text: 'Say hello' }],
    });
    expect(prompt.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
    expect(log.events.at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
      stopReason: 'stop',
    });
  });

  it('模型不是 <上游>/<模型> 时报 invalid_input', async () => {
    const h = setup();
    const { session } = await openSession(h);
    await h.adapter.configureSession(session.engineSessionId, { modelId: 'mock/echo' });
    await expect(
      h.adapter.configureSession(session.engineSessionId, { modelId: 'echo' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('换权限模式时立刻更新会话的规则集', async () => {
    const h = setup();
    const { id } = await openSession(h);
    await h.adapter.configureSession(id, { modelId: MODEL, permissionMode: 'auto_review' });
    expect(calls(h, 'updateSession')).toEqual([]);
    await h.adapter.configureSession(id, { modelId: MODEL, permissionMode: 'full_access' });
    expect(calls(h, 'updateSession')).toEqual([
      [id, { permission: permissionRules('full_access') }],
    ]);
  });

  it('提问：question.requested 带问题与选项，回答按问题顺序交回 opencode', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(EXTRA_PROMPTS.question));
    await log.until(
      (events) => events.some((event) => event.type === 'question.requested'),
      '提问',
    );
    const request = log.events.find((event) => event.type === 'question.requested');
    expect(request).toMatchObject({
      questions: [
        {
          id: 'question-0-colour',
          header: 'Colour',
          question: 'Which colour should the button be?',
          options: [
            { label: 'Blue', description: 'The default accent' },
            { label: 'Green', description: 'Matches the logo' },
          ],
          allowOther: true,
        },
      ],
    });
    const requestId = (request as { requestId: string }).requestId;
    await h.adapter.respondToQuestion(id, requestId, { 'question-0-colour': ['Blue'] });
    await log.terminal();
    expect(calls(h, 'replyQuestion')).toEqual([[requestId, [['Blue']]]]);
    expect(log.events.some((event) => event.type === 'question.cancelled')).toBe(false);
    expect(log.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    await expect(h.adapter.respondToQuestion(id, requestId, {})).rejects.toMatchObject({
      code: 'question_not_found',
    });
  });

  it('拒绝并继续：带反馈的 reject，工具失败，回合接着完成', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.approval));
    await log.until(
      (events) => events.some((event) => event.type === 'approval.requested'),
      '审批',
    );
    const request = log.events.find((event) => event.type === 'approval.requested') as {
      requestId: string;
      toolCallId: string;
      options: Array<{ optionId: string }>;
    };
    expect(request.options.map((option) => option.optionId)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
    await h.adapter.respondToApproval(id, request.requestId, { optionId: 'decline' });
    await log.terminal();
    expect(calls(h, 'replyPermission')).toEqual([[request.requestId, 'reject', DECLINE_FEEDBACK]]);
    expect(log.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.finished',
        toolCallId: request.toolCallId,
        status: 'failed',
      }),
    );
    expect(log.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('拒绝并停止：不带反馈的 reject，opencode 停下循环，回合完成', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.approval));
    await log.until(
      (events) => events.some((event) => event.type === 'approval.requested'),
      '审批',
    );
    const request = log.events.find((event) => event.type === 'approval.requested') as {
      requestId: string;
    };
    await h.adapter.respondToApproval(id, request.requestId, { optionId: 'cancel' });
    await log.terminal();
    expect(calls(h, 'replyPermission')).toEqual([[request.requestId, 'reject', undefined]]);
    expect(log.events.filter((event) => event.type === 'assistant.message')).toEqual([]);
    expect(log.events.at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
      stopReason: 'tool-calls',
    });
  });

  it('本会话不再询问：always', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.approval));
    await log.until(
      (events) => events.some((event) => event.type === 'approval.requested'),
      '审批',
    );
    const request = log.events.find((event) => event.type === 'approval.requested') as {
      requestId: string;
    };
    await h.adapter.respondToApproval(id, request.requestId, { optionId: 'acceptForSession' });
    await log.terminal();
    expect(calls(h, 'replyPermission')).toEqual([[request.requestId, 'always', undefined]]);
  });

  it('子会话：父会话的流里报 subagent.started，子会话的流有自己的回合，装上父会话的规则', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.subagent));
    await log.until(
      (events) => events.some((event) => event.type === 'subagent.started'),
      '子会话',
    );
    const started = log.events.find((event) => event.type === 'subagent.started') as {
      childEngineSessionId: string;
      parentToolCallId: string;
    };
    expect(started).toMatchObject({
      title: 'Say hi',
      prompt: SUBAGENT_PROMPT,
      modelId: MODEL,
      role: 'general',
    });
    const toolStart = log.events.findIndex(
      (event) => event.type === 'tool.started' && event.toolCallId === started.parentToolCallId,
    );
    expect(toolStart).toBeGreaterThanOrEqual(0);
    expect(toolStart).toBeLessThan(log.events.indexOf(started as AgentEvent));

    const child = collect(h.adapter.subscribe(started.childEngineSessionId));
    await child.terminal();
    expect(child.events[0]).toMatchObject({
      type: 'turn.started',
      input: [{ type: 'text', text: SUBAGENT_PROMPT }],
    });
    expect(child.events).toContainEqual(
      expect.objectContaining({ type: 'assistant.message', text: 'hi from the subagent' }),
    );
    expect(child.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    await log.terminal();

    // opencode 给子会话的规则（录音里的 session.created）：继承父会话的 external_directory，加上不许再派子 agent。
    const native: PermissionRuleset = [
      { permission: 'external_directory', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
    ];
    const update = calls(h, 'updateSession').find(
      (args) => args[0] === started.childEngineSessionId,
    );
    const installed = (update?.[1] as { permission: PermissionRuleset } | undefined)?.permission;
    expect(installed).toEqual(childPermissionRules(permissionRules('on_request'), native));
    expect(installed).toEqual([
      ...permissionRules('on_request'),
      { permission: 'task', pattern: '*', action: 'deny' },
    ]);
    await expect(h.adapter.send(started.childEngineSessionId, text('hi'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('子会话的审批在子会话的流里，用子会话的 ID 回复', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.subagentApproval));
    await log.until(
      (events) => events.some((event) => event.type === 'subagent.started'),
      '子会话',
    );
    const childId = (
      log.events.find((event) => event.type === 'subagent.started') as {
        childEngineSessionId: string;
      }
    ).childEngineSessionId;
    const child = collect(h.adapter.subscribe(childId));
    await child.until(
      (events) => events.some((event) => event.type === 'approval.requested'),
      '子会话的审批',
    );
    const request = child.events.find((event) => event.type === 'approval.requested') as {
      requestId: string;
      engineSessionId: string;
    };
    expect(request.engineSessionId).toBe(childId);
    expect(child.events[0]).toMatchObject({ input: [{ text: SUBAGENT_APPROVAL_PROMPT }] });
    expect(await h.adapter.listPendingApprovals()).toHaveLength(1);
    await h.adapter.respondToApproval(childId, request.requestId, { optionId: 'accept' });
    await child.terminal();
    await log.terminal();
    expect(log.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('模型服务报错：turn.failed 归为 provider，带 HTTP 状态码', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(EXTRA_PROMPTS.fail));
    await log.terminal();
    expect(log.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: 'mock model rejected the request',
      code: 400,
    });
  });

  it('接受输入之前到的 idle（上一个回合留下的）不结束这个回合', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    h.fake.delayMs = 5;
    h.fake.emit({
      id: 'evt_stale',
      type: 'session.status',
      properties: { sessionID: id, status: { type: 'idle' } },
    } as Event);
    const send = h.adapter.send(id, text('Say hello'));
    h.fake.emit({
      id: 'evt_stale2',
      type: 'session.status',
      properties: { sessionID: id, status: { type: 'idle' } },
    } as Event);
    await send;
    await log.terminal();
    const terminal = log.events.findIndex(isTurnTerminal);
    const message = log.events.findIndex((event) => event.type === 'assistant.message');
    expect(message).toBeGreaterThanOrEqual(0);
    expect(message).toBeLessThan(terminal);
  });

  it('服务器意外退出：挂着的会话以 engine.exited 脱开，恢复时重起服务器', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    expect(h.fake.starts).toBe(1);
    h.fake.crash({ code: 1, signal: null, stderrTail: 'boom' });
    await log.until(
      (events) => events.some((event) => event.type === 'engine.exited'),
      'engine.exited',
    );
    expect(log.events.at(-1)).toMatchObject({
      type: 'engine.exited',
      exitCode: 1,
      stderrTail: 'boom',
    });
    await expect(h.adapter.send(id, text('Say hello'))).rejects.toMatchObject({
      code: 'session_closed',
    });

    await h.adapter.resumeSession(id, { cwd: h.home, providerId: 'opencode', modelId: MODEL });
    expect(h.fake.starts).toBe(2);
    const resumed = collect(h.adapter.subscribe(id));
    await h.adapter.send(id, text('Say hello'));
    await resumed.terminal();
    expect(resumed.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });

  it('恢复：按现在的权限模式重装规则；opencode 没有这个会话时报 session_lost', async () => {
    const h = setup();
    const { id } = await openSession(h);
    await h.adapter.close(id);
    await h.adapter.resumeSession(id, {
      cwd: h.home,
      providerId: 'opencode',
      modelId: MODEL,
      permissionMode: 'full_access',
    });
    expect(calls(h, 'updateSession').at(-1)).toEqual([
      id,
      { permission: permissionRules('full_access') },
    ]);
    await expect(
      h.adapter.resumeSession('ses_missing', {
        cwd: h.home,
        providerId: 'opencode',
        modelId: MODEL,
      }),
    ).rejects.toMatchObject({ code: 'session_lost', lostReason: 'not_found' });
  });

  it('没有会话之后服务器空闲一会儿就停', async () => {
    const h = setup();
    const { id } = await openSession(h);
    expect(h.fake.running).toBe(true);
    await h.adapter.close(id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.fake.running).toBe(false);
  });

  it('没接上游时建会话报 missing_credentials', async () => {
    const h = setup();
    h.fake.providerList = { ...h.fake.providerList, connected: [] };
    await expect(
      h.adapter.createSession({ cwd: h.home, providerId: 'opencode', modelId: MODEL }),
    ).rejects.toMatchObject({ code: 'missing_credentials' });
  });
});
