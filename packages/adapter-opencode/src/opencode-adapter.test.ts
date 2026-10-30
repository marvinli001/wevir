// OpenCodeAdapter 在假的 opencode 上（test-fixtures/fake-opencode.ts 回放真实录音）：提问、审批的三种回复、子会话、失败、规则集、
// 服务器退出与重起、回合开始前的旧 idle；插话的交接与没用上的插话、标题、支线与补充说明。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { isTurnTerminal } from '@wevir/runtime-adapter';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCodeRuleFiles, STEER_IDLE_GRACE_MS } from './opencode-adapter.js';
import {
  childPermissionRules,
  DECLINE_FEEDBACK,
  engineToolRules,
  permissionRules,
  TITLE_PERMISSION_RULES,
} from './permissions.js';
import type { Event, OpenCodeClient, PermissionRuleset, PromptInput } from './sdk.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import { type FakeHarness, fakeHarness } from './test-fixtures/harness.js';
import {
  EXTRA_PROMPTS,
  MOCK_STRUCTURED_TITLE,
  SUBAGENT_APPROVAL_PROMPT,
  SUBAGENT_PROMPT,
} from './test-fixtures/mock-model.js';
import { TITLE_SESSION_TITLE } from './title.js';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 插话的 promptAsync 换成自己的：`gate` 放行之前不返回；`swallow` 时不交给假 opencode（像 opencode 把它并进了正要结束的那次
 * 运行：存下了，不回答）。要在建会话之前装上。
 */
function interceptSteer(h: FakeHarness, options: { gate?: Promise<void>; swallow?: boolean }) {
  const seen: PromptInput[] = [];
  const connect = h.fake.connect.bind(h.fake);
  h.fake.connect = (input) => {
    const client = connect(input);
    const intercepted: OpenCodeClient = {
      ...client,
      promptAsync: async (body, signal) => {
        const first = body.parts[0];
        if (first?.type !== 'text' || first.text !== DEFAULT_CONTRACT_PROMPTS.steer) {
          return client.promptAsync(body, signal);
        }
        seen.push(body);
        await options.gate;
        if (options.swallow === true) {
          h.fake.calls.push({ method: 'promptAsync', args: [body] });
          return;
        }
        return client.promptAsync(body, signal);
      },
    };
    return intercepted;
  };
  return seen;
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

  it('角色关掉的引擎工具：建会话的规则集末尾是这些类别的 deny，完全访问也盖不过', async () => {
    const h = setup();
    expect(h.adapter.engineToolEnforcement).toEqual({ classes: ['read', 'edit', 'shell', 'web'] });
    await openSession(h, {
      permissionMode: 'full_access',
      engineTools: { denied: ['edit'], deniedNames: [] },
    });
    expect(calls(h, 'createSession')[0]?.[0]).toEqual({
      permission: [...permissionRules('full_access'), ...engineToolRules(['edit'])],
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

  it('规则文件（0.68.0）：Host 补的每次作为 system 带上，换模型后照旧；没有时不带', async () => {
    const h = setup();
    const plain = await openSession(h);
    await h.adapter.send(plain.id, text('one'));
    await plain.log.terminal();
    const { id, log } = await openSession(h, { ruleInstructions: '# Rules\nUse tabs.' });
    await h.adapter.configureSession(id, { modelId: MODEL, reasoningEffort: 'high' });
    await h.adapter.send(id, text('two'));
    await log.terminal();
    const prompts = calls(h, 'promptAsync').map((args) => args[0] as Record<string, unknown>);
    expect(prompts[0]).not.toHaveProperty('system');
    expect(prompts[1]).toMatchObject({ system: '# Rules\nUse tabs.', variant: 'high' });
  });

  it('规则文件（0.68.0）：读哪些照 OpenCode 的 CLAUDE.md 后备与环境变量', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wevir-oc-rules-'));
    try {
      expect(await openCodeRuleFiles({ HOME: home })).toEqual({
        user: ['claude'],
        project: ['agents'],
        projectFallback: ['claude'],
        imports: false,
        instructions: true,
      });
      mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
      writeFileSync(join(home, '.config', 'opencode', 'AGENTS.md'), 'own');
      expect((await openCodeRuleFiles({ HOME: home })).user).toEqual([]);
      const off = await openCodeRuleFiles({ HOME: home, OPENCODE_DISABLE_CLAUDE_CODE: '1' });
      expect(off.projectFallback).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  it('上游报 429：先重读账号的用量（之后的 idle 不按完成结算），再报 turn.failed 带 usageLimit；别的错误不重读', async () => {
    const h = setup();
    const fail = h.fake.recordings.find((recording) => recording.name === 'fail');
    const error = fail?.lines.find((line) => line.event?.type === 'session.error')?.event as
      | { properties: { error: { data: { statusCode: number; message: string } } } }
      | undefined;
    if (error === undefined) throw new Error('fail 录音里没有 session.error');
    error.properties.error.data.statusCode = 429;
    error.properties.error.data.message = 'Rate limit exceeded';
    const { id, log } = await openSession(h);
    let release: () => void = () => {};
    const refresh = vi.spyOn(h.adapter.accounts, 'refreshUsage').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await h.adapter.send(id, text(EXTRA_PROMPTS.fail));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith('opencode'));
    // 录音里 session.error 之后紧跟 idle：重读完成之前回合不结束。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      log.events.some((event) => event.type === 'turn.failed' || event.type === 'turn.settled'),
    ).toBe(false);
    release();
    await log.terminal();
    expect(log.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      message: 'Rate limit exceeded',
      code: 429,
      usageLimit: {},
    });

    error.properties.error.data.statusCode = 400;
    const from = log.events.length;
    await h.adapter.send(id, text(EXTRA_PROMPTS.fail));
    await vi.waitFor(() =>
      expect(log.events.slice(from).some((event) => event.type === 'turn.failed')).toBe(true),
    );
    expect(log.events.at(-1)).not.toHaveProperty('usageLimit');
    expect(refresh).toHaveBeenCalledTimes(1);
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

describe('OpenCodeAdapter 的插话、标题、支线与补充说明（假 opencode）', () => {
  it('插话交接期间到的 idle 先压着；opencode 为它另起循环时报 turn.steered，回合只结算一次', async () => {
    const h = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steers = interceptSteer(h, { gate });
    const { id, log } = await openSession(h);
    h.fake.delayMs = 5;
    await h.adapter.send(id, text('Say hello'));
    await log.until((events) => events.some((event) => event.type === 'assistant.delta'), '增量');
    const steering = h.adapter.steer(id, 'steer-1', text(DEFAULT_CONTRACT_PROMPTS.steer));
    // 第一段回放走完（idle），插话还没交出去。
    while (h.fake.sessions.get(id)?.status !== 'idle') await sleep(5);
    await sleep(50);
    expect(log.events.some(isTurnTerminal)).toBe(false);
    release();
    await steering;
    await log.terminal();
    const steered = log.events.findIndex((event) => event.type === 'turn.steered');
    expect(log.events[steered]).toMatchObject({ steerId: 'steer-1' });
    expect(log.events.slice(steered).some((event) => event.type === 'assistant.message')).toBe(
      true,
    );
    expect(log.events.filter(isTurnTerminal)).toEqual([
      expect.objectContaining({ type: 'turn.settled', outcome: 'completed' }),
    ]);
    // 插话用会话的模型，带自己的消息 ID。
    expect(steers[0]).toMatchObject({
      sessionID: id,
      model: { providerID: 'mock', modelID: 'echo' },
    });
    expect(steers[0]?.messageID).not.toBe(
      (calls(h, 'promptAsync')[0]?.[0] as PromptInput | undefined)?.messageID,
    );
  });

  it('opencode 没回答插话（并进了正要结束的运行）：问过 session.status 后结算，下一次发送前删掉它', async () => {
    const h = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steers = interceptSteer(h, { gate, swallow: true });
    const { id, log } = await openSession(h);
    h.fake.delayMs = 5;
    await h.adapter.send(id, text('Say hello'));
    await log.until((events) => events.some((event) => event.type === 'assistant.delta'), '增量');
    const steering = h.adapter.steer(id, 'steer-1', text(DEFAULT_CONTRACT_PROMPTS.steer));
    while (h.fake.sessions.get(id)?.status !== 'idle') await sleep(5);
    release();
    await steering;
    await sleep(STEER_IDLE_GRACE_MS / 2);
    expect(log.events.some(isTurnTerminal)).toBe(false);
    await log.terminal();
    expect(log.events.some((event) => event.type === 'turn.steered')).toBe(false);
    expect(calls(h, 'status').length).toBeGreaterThan(0);

    const from = h.fake.calls.length;
    await h.adapter.send(id, text('Say hello'));
    const after = h.fake.calls.slice(from).map((call) => call.method);
    expect(after.indexOf('deleteMessage')).toBeLessThan(after.indexOf('promptAsync'));
    expect(calls(h, 'deleteMessage')).toEqual([[id, steers[0]?.messageID]]);
  });

  it('插话之后取消：没用上的插话下一次发送前删掉；取消中的回合不收插话', async () => {
    const h = setup();
    const steers = interceptSteer(h, { swallow: true });
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.slow));
    await log.until((events) => events.some((event) => event.type === 'assistant.delta'), '增量');
    await h.adapter.steer(id, 'steer-1', text(DEFAULT_CONTRACT_PROMPTS.steer));
    const cancelling = h.adapter.cancel(id);
    await expect(
      h.adapter.steer(id, 'steer-2', text(DEFAULT_CONTRACT_PROMPTS.steer)),
    ).rejects.toMatchObject({ code: 'steer_rejected' });
    await cancelling;
    expect(log.events.filter(isTurnTerminal)).toEqual([
      expect.objectContaining({ type: 'turn.settled', outcome: 'cancelled' }),
    ]);
    expect(log.events.some((event) => event.type === 'turn.steered')).toBe(false);
    await h.adapter.send(id, text('Say hello'));
    expect(calls(h, 'deleteMessage')).toEqual([[id, steers[0]?.messageID]]);
  });

  it('子会话不能插话；不认识的会话报 session_not_found', async () => {
    const h = setup();
    await expect(h.adapter.steer('ses_unknown', 'steer-1', text('x'))).rejects.toMatchObject({
      code: 'session_not_found',
    });
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.subagent));
    await log.until(
      (events) => events.some((event) => event.type === 'subagent.started'),
      'subagent.started',
    );
    const started = log.events.find((event) => event.type === 'subagent.started') as Extract<
      AgentEvent,
      { type: 'subagent.started' }
    >;
    await expect(
      h.adapter.steer(started.childEngineSessionId, 'steer-1', text('x')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await log.terminal();
  });

  it('标题：临时会话（只留 StructuredOutput）、说明作 system、json_schema、最低的变体，用完删掉', async () => {
    const h = setup();
    const { id } = await openSession(h, { reasoningEffort: 'high' });
    const request = {
      instructions: 'You write titles.',
      input: '<user_prompt>fix the login bug</user_prompt>',
      outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    };
    await expect(h.adapter.generateTitle(id, request)).resolves.toBe(
      JSON.stringify(MOCK_STRUCTURED_TITLE),
    );
    const created = calls(h, 'createSession').at(-1)?.[0];
    expect(created).toEqual({
      title: TITLE_SESSION_TITLE,
      permission: [...TITLE_PERMISSION_RULES],
    });
    const [prompt] = calls(h, 'prompt').at(-1) as [Record<string, unknown>];
    const temp = prompt.sessionID as string;
    expect(temp).not.toBe(id);
    expect(prompt).toEqual({
      sessionID: temp,
      model: { providerID: 'mock', modelID: 'echo' },
      variant: 'low',
      system: request.instructions,
      format: { type: 'json_schema', schema: request.outputSchema },
      parts: [{ type: 'text', text: request.input }],
    });
    expect(calls(h, 'deleteSession')).toEqual([[temp]]);
    expect(h.fake.sessions.has(temp)).toBe(false);
  });

  it('标题：模型没走 StructuredOutput 时交出它的文本；其他错误报 engine_unavailable，照样删掉临时会话', async () => {
    const h = setup();
    const { id } = await openSession(h);
    const request = { instructions: 'i', input: 'x', outputSchema: { type: 'object' } };
    h.fake.titleReply = {
      text: '{"title":"Fix login","description":"d"}',
      error: {
        name: 'StructuredOutputError',
        data: { message: 'Model did not produce structured output', retries: 0 },
      },
    };
    await expect(h.adapter.generateTitle(id, request)).resolves.toBe(
      '{"title":"Fix login","description":"d"}',
    );
    h.fake.titleReply = {
      error: { name: 'APIError', data: { message: 'upstream is down', isRetryable: false } },
    };
    await expect(h.adapter.generateTitle(id, request)).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('upstream is down'),
    });
    h.fake.titleReply = {};
    await expect(h.adapter.generateTitle(id, request)).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('empty output'),
    });
    expect(calls(h, 'deleteSession')).toHaveLength(3);
    await expect(h.adapter.generateTitle('ses_unknown', request)).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('标题：Host 中止时停下并删掉临时会话', async () => {
    const h = setup();
    const { id } = await openSession(h);
    h.fake.holdPrompt = true;
    const controller = new AbortController();
    const title = h.adapter.generateTitle(id, {
      instructions: 'i',
      input: 'x',
      outputSchema: { type: 'object' },
      signal: controller.signal,
    });
    while (calls(h, 'prompt').length === 0) await sleep(5);
    controller.abort();
    await expect(title).rejects.toMatchObject({ code: 'engine_unavailable' });
    const temp = (calls(h, 'prompt')[0]?.[0] as { sessionID: string } | undefined)?.sessionID;
    expect(calls(h, 'abort')).toContainEqual([temp]);
    expect(calls(h, 'deleteSession')).toEqual([[temp]]);
  });

  it('支线：没有完成的回合时报 invalid_input；之后 fork 整个会话，装支线的规则，补边界消息', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    const config = { cwd: h.home, providerId: 'opencode', modelId: MODEL };
    await expect(h.adapter.fork(id, config)).rejects.toMatchObject({ code: 'invalid_input' });
    await h.adapter.send(id, text('Say hello'));
    await log.terminal();

    const side = await h.adapter.fork(id, { ...config, permissionMode: 'full_access' });
    expect(side.engineSessionId).not.toBe(id);
    expect(calls(h, 'forkSession')).toEqual([[id, undefined]]);
    expect(calls(h, 'updateSession').at(-1)).toEqual([
      side.engineSessionId,
      { permission: permissionRules('full_access') },
    ]);
    expect(h.fake.notes.get(side.engineSessionId)).toEqual([SIDE_BOUNDARY_NOTE]);
    expect(h.fake.notes.has(id)).toBe(false);

    const sideLog = collect(h.adapter.subscribe(side.engineSessionId));
    await h.adapter.send(side.engineSessionId, text('Say hello'));
    await sideLog.terminal();
    expect(sideLog.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    // 支线自己也能再分。
    await expect(h.adapter.fork(side.engineSessionId, config)).resolves.toMatchObject({
      modelId: MODEL,
    });
  });

  it('支线：回合进行中只分到之前完成的回合（边界是进行中回合的用户消息）', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.send(id, text('Say hello'));
    await log.terminal();
    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.slow));
    await log.until(
      (events) => events.filter((event) => event.type === 'assistant.delta').length > 2,
      '第二个回合的增量',
    );
    await h.adapter.fork(id, { cwd: h.home, providerId: 'opencode', modelId: MODEL });
    const running = (calls(h, 'promptAsync')[1]?.[0] as PromptInput | undefined)?.messageID;
    expect(calls(h, 'forkSession')).toEqual([[id, running]]);
    await h.adapter.cancel(id);
  });

  it('补充说明：空闲时立刻以 noReply 写进去；回合进行中留到下一次发送之前', async () => {
    const h = setup();
    const { id, log } = await openSession(h);
    await h.adapter.injectNote(id, 'first note');
    expect(h.fake.notes.get(id)).toEqual(['first note']);
    expect(calls(h, 'prompt').at(-1)?.[0]).toMatchObject({
      sessionID: id,
      noReply: true,
      model: { providerID: 'mock', modelID: 'echo' },
      parts: [{ type: 'text', text: 'first note' }],
    });

    await h.adapter.send(id, text(DEFAULT_CONTRACT_PROMPTS.slow));
    await log.until((events) => events.some((event) => event.type === 'assistant.delta'), '增量');
    await h.adapter.injectNote(id, 'second note');
    expect(h.fake.notes.get(id)).toEqual(['first note']);
    await h.adapter.cancel(id);
    const from = h.fake.calls.length;
    await h.adapter.send(id, text('Say hello'));
    expect(h.fake.notes.get(id)).toEqual(['first note', 'second note']);
    const after = h.fake.calls.slice(from).map((call) => call.method);
    expect(after.indexOf('prompt')).toBeLessThan(after.indexOf('promptAsync'));
  });
});
