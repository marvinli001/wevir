import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovalRequest,
  ClientIdentity,
  SessionId,
  SessionState,
  TurnId,
  UserContentPart,
  UserQuestion,
  WevirEvent,
  WevirEventOf,
  WevirEventType,
} from '@wevir/protocol';
import {
  AdapterError,
  type AgentEvent,
  EventHub,
  type TitleRequest,
  type UsageRecordedEvent,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import type { Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRuleService } from './approval-rules/service.js';
import { HostError } from './errors.js';
import { EventStore } from './event-store.js';
import { defaultOptionOf, SessionManager, type SessionManagerOptions } from './session-manager.js';
import { SESSION_TRANSITIONS } from './snapshot.js';
import { useStorages, useTempDir } from './test-utils.js';

const T0 = '2026-10-13T00:00:00.000Z';
const desktop: ClientIdentity = { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' };
const cli: ClientIdentity = { deviceId: 'dev-mac', clientId: 'cli-1', clientKind: 'cli' };

/** 各用例实际走过的状态转换 `from→to:reason`，最后一个用例核对它覆盖了 §4.1 的全表。 */
const seenTransitions = new Set<string>();

const tempDir = useTempDir();
const storages = useStorages();

interface Harness {
  dataDir: string;
  workspaceDir: string;
  storage: Storage;
  events: EventStore;
  adapter: EchoAdapter;
  manager: SessionManager;
  /** 两个组件的 onError；用例结束时必须为空，预期的错误由用例自己取走。 */
  errors: unknown[];
}

const live: Harness[] = [];
let harnessCount = 0;

// 注册在 useStorages 之后：after 钩子按注册的逆序执行，先停管理器和引擎，再关数据库。
afterEach(async () => {
  for (const h of live.splice(0)) {
    await Promise.race([h.manager.dispose(), delay(200)]);
    await h.adapter.dispose();
    for (const record of h.storage.sessions.list({
      includeRemovedWorkspaces: true,
      includeChildren: true,
    })) {
      for (const e of h.events.readSince(record.id as SessionId, 0)) {
        if (e.type === 'session.state_changed') {
          seenTransitions.add(`${e.payload.from}→${e.payload.to}:${e.payload.reason}`);
        }
      }
    }
    h.events.close();
    expect(h.errors).toEqual([]);
  }
});

function setup(
  options: {
    adapter?: EchoAdapter;
    dataDir?: string;
    manager?: Partial<SessionManagerOptions>;
    seed?: boolean;
  } = {},
): Harness {
  harnessCount += 1;
  const dataDir = options.dataDir ?? join(tempDir(), `data-${harnessCount}`);
  const workspaceDir = join(tempDir(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const storage = storages.open(dataDir);
  if (options.seed ?? true) {
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: realpathSync(workspaceDir),
      displayName: 'workspace',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  const events = new EventStore({ storage, deltaWindowMs: 5, onError });
  const adapter = options.adapter ?? new EchoAdapter({ stepDelayMs: 1 });
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    onError,
    ...options.manager,
  });
  const h = { dataDir, workspaceDir, storage, events, adapter, manager, errors };
  live.push(h);
  return h;
}

/**
 * 模拟 Host 被杀后重启：旧管理器不再消费引擎事件、不写任何事件（命令可能还挂着），换一个数据库连接
 * 和新的管理器，然后启动对账。默认换一个新的引擎（旧引擎随 Host 一起消失）。
 */
function restart(h: Harness, adapter = new EchoAdapter({ stepDelayMs: 1 })) {
  void h.manager.dispose();
  const next = setup({ adapter, dataDir: h.dataDir, seed: false });
  return { h: next, report: next.manager.recover() };
}

async function create(h: Harness): Promise<SessionId> {
  const session = await h.manager.create({ workspaceId: 'ws_1', providerId: 'deepseek-official' });
  return session.id;
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }];
}

function send(h: Harness, sessionId: SessionId, value: string, clientMessageId?: string) {
  return h.manager.send(
    { sessionId, content: text(value), ...(clientMessageId !== undefined && { clientMessageId }) },
    cli,
  );
}

function all(h: Harness, sessionId: SessionId): WevirEvent[] {
  return h.events.readSince(sessionId, 0);
}

function ofType<T extends WevirEventType>(
  h: Harness,
  sessionId: SessionId,
  type: T,
): WevirEventOf<T>[] {
  return all(h, sessionId).filter((e): e is WevirEventOf<T> => e.type === type);
}

/** 状态转换序列，形如 `idle→running:turn_started`。 */
function transitions(h: Harness, sessionId: SessionId): string[] {
  return ofType(h, sessionId, 'session.state_changed').map(
    (e) => `${e.payload.from}→${e.payload.to}:${e.payload.reason}`,
  );
}

/** `afterSeq` 之后的事件类型，增量合并成一个 `assistant.delta*`，便于比对顺序。 */
function typesAfter(h: Harness, sessionId: SessionId, afterSeq: number): string[] {
  const result: string[] = [];
  for (const e of h.events.readSince(sessionId, afterSeq)) {
    const label = e.type === 'assistant.delta' ? 'assistant.delta*' : e.type;
    if (label === 'assistant.delta*' && result.at(-1) === label) continue;
    result.push(label);
  }
  return result;
}

function state(h: Harness, sessionId: SessionId): SessionState {
  return snapshot(h, sessionId).session.state;
}

function snapshot(h: Harness, sessionId: SessionId) {
  const s = h.events.snapshot(sessionId);
  if (!s) throw new Error(`no session ${sessionId}`);
  return s;
}

function lastSeq(h: Harness, sessionId: SessionId): number {
  return snapshot(h, sessionId).session.lastSeq;
}

async function waitForState(h: Harness, sessionId: SessionId, expected: SessionState) {
  await vi.waitFor(() => expect(state(h, sessionId)).toBe(expected), {
    timeout: 2000,
    interval: 5,
  });
}

async function waitForApproval(h: Harness, sessionId: SessionId): Promise<ApprovalRequest> {
  await waitForState(h, sessionId, 'awaiting_approval');
  const [approval] = snapshot(h, sessionId).pendingApprovals;
  if (!approval) throw new Error('no pending approval');
  return approval;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function turnOf(result: { turnId?: TurnId }): TurnId {
  if (result.turnId === undefined) throw new Error('no turn started');
  return result.turnId;
}

function never(): Promise<never> {
  return new Promise(() => {});
}

describe('SessionManager：建会话（#1）', () => {
  it('先建引擎会话再写 session.created，映射存进 sessions 表', async () => {
    const h = setup();
    const session = await h.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      reasoningEffort: 'high',
    });

    expect(session).toMatchObject({
      workspaceId: 'ws_1',
      cwd: realpathSync(h.workspaceDir),
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      reasoningEffort: 'high',
      state: 'idle',
      lastSeq: 1,
      title: '',
    });
    expect(session.id).toMatch(/^ses_[0-9A-Z]{26}$/);
    expect(all(h, session.id).map((e) => e.type)).toEqual(['session.created']);
    const record = h.storage.sessions.getByEngineSessionId('echo', session.engine.sessionId);
    expect(record?.id).toBe(session.id);
  });

  it('工作区、Provider 不存在或目录不可用时不建会话', async () => {
    const h = setup();
    await expect(
      h.manager.create({ workspaceId: 'ws_nope', providerId: 'deepseek-official' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    await expect(
      h.manager.create({ workspaceId: 'ws_1', providerId: 'nope' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });

    rmSync(h.workspaceDir, { recursive: true });
    await expect(
      h.manager.create({ workspaceId: 'ws_1', providerId: 'deepseek-official' }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_INVALID',
      data: { reason: 'not_found' },
    });
    expect(h.storage.sessions.list()).toEqual([]);
  });

  it('引擎建会话失败时返回 ENGINE_ERROR，不建会话', async () => {
    const h = setup();
    vi.spyOn(h.adapter, 'createSession').mockRejectedValueOnce(
      new AdapterError('engine_unavailable', 'engine failed to start'),
    );
    await expect(
      h.manager.create({ workspaceId: 'ws_1', providerId: 'deepseek-official' }),
    ).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'unknown', message: 'engine failed to start' },
    });
    expect(h.storage.sessions.list()).toEqual([]);
  });
});

describe('SessionManager：回合', () => {
  it('别的会话发来的消息交给引擎时包进 <relayed_message>，事件里存原文', async () => {
    const h = setup();
    const id = await create(h);
    const other = await create(h);
    const sent = vi.spyOn(h.adapter, 'send');
    await h.manager.send({ sessionId: id, content: text('run the tests') }, cli, {
      from: { sessionId: other, kind: 'message' },
    });
    await waitForState(h, id, 'idle');
    const input = sent.mock.calls[0]?.[1];
    expect(input?.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          new RegExp(
            `^<relayed_message id="([0-9a-f]{12})" trust="relay" kind="message" from="session ${other}">\\nrun the tests\\n</relayed_message id="\\1">$`,
          ),
        ),
      },
    ]);
    expect(ofType(h, id, 'user.message')[0]?.payload.content).toEqual(text('run the tests'));
  });

  it('粘贴的段落（0.90.0）交给引擎时包进 <pasted_content>，事件里存原文与标记', async () => {
    const h = setup();
    const id = await create(h);
    const sent = vi.spyOn(h.adapter, 'send');
    const content = [
      { type: 'text' as const, text: '这段日志为什么失败' },
      { type: 'text' as const, text: 'Error: ENOENT', pasted: true as const },
    ];
    await h.manager.send({ sessionId: id, content }, cli);
    await waitForState(h, id, 'idle');
    expect(sent.mock.calls[0]?.[1].content).toEqual([
      { type: 'text', text: '这段日志为什么失败' },
      {
        type: 'text',
        text: expect.stringMatching(
          /^<pasted_content id="([0-9a-f]{12})">\nError: ENOENT\n<\/pasted_content id="\1">$/,
        ),
      },
    ]);
    expect(ofType(h, id, 'user.message')[0]?.payload.content).toEqual(content);
    // 截断的标题只取自己写的话。
    expect(ofType(h, id, 'session.title_changed')[0]?.payload.title).toBe('这段日志为什么失败');
  });

  it('#2 #6：发送、流式输出、结算；首个回合写标题', async () => {
    const h = setup();
    const id = await create(h);
    const result = await send(h, id, '  Say\n hello  ');

    expect(result.turnId).toMatch(/^trn_/);
    expect(typesAfter(h, id, 1).slice(0, 4)).toEqual([
      'user.message',
      'turn.started',
      'session.title_changed',
      'session.state_changed',
    ]);
    expect(result.seq).toBe(2);
    await waitForState(h, id, 'idle');

    expect(typesAfter(h, id, 5)).toEqual([
      'assistant.delta*',
      'assistant.stream_ended',
      'assistant.message',
      'usage.updated',
      'turn.finished',
      'session.state_changed',
    ]);
    expect(transitions(h, id)).toEqual(['idle→running:turn_started', 'running→idle:turn_finished']);
    expect(snapshot(h, id).session.title).toBe('Say hello');

    // 已提交消息替换的增量块换成了 Host 的 StreamId。
    const deltas = ofType(h, id, 'assistant.delta');
    const [message] = ofType(h, id, 'assistant.message');
    expect(deltas.map((e) => e.payload.text).join('')).toBe('Echo:   Say\n hello  ');
    expect(message?.payload.replaces).toEqual([
      { streamId: deltas[0]?.payload.streamId, blockIndex: 0 },
    ]);
    expect(deltas[0]?.payload.streamId).toMatch(/^stm_/);
    expect(ofType(h, id, 'turn.finished')[0]?.payload).toMatchObject({
      turnId: result.turnId,
      outcome: 'completed',
      engineStopReason: 'end_turn',
    });
    expect(ofType(h, id, 'user.message')[0]?.payload.sentBy).toEqual(cli);

    // 第二个回合不改标题。
    await send(h, id, 'again');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'session.title_changed')).toHaveLength(1);
  });

  it('标题截取前 50 个字符', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, '写'.repeat(80));
    await waitForState(h, id, 'idle');
    expect(snapshot(h, id).session.title).toBe('写'.repeat(50));
  });

  it('#7：回合失败写 engine.error（非致命），回到 idle', async () => {
    const h = setup();
    const id = await create(h);
    const { turnId } = await send(h, id, 'please fail');
    await waitForState(h, id, 'idle');

    expect(ofType(h, id, 'engine.error')[0]?.payload).toMatchObject({
      category: 'unknown',
      fatal: false,
      code: -32603,
      turnId,
    });
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('failed');
    expect(snapshot(h, id).session.lastError?.category).toBe('unknown');
    expect(transitions(h, id)).toEqual(['idle→running:turn_started', 'running→idle:turn_finished']);
  });

  it('工具调用、思考照写；回合结束时未收尾的工具补 unknown', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'think, then call a tool');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'tool.finished').map((e) => e.payload.status)).toEqual(['completed']);
    expect(ofType(h, id, 'assistant.thought')).toHaveLength(1);

    // 引擎漏发 tool.finished：Host 在 turn.finished 前补一条 unknown。
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementationOnce((engineSessionId) =>
      dropToolFinished(subscribe(engineSessionId)),
    );
    const id2 = await create(h);
    await send(h, id2, 'call a tool');
    await waitForState(h, id2, 'idle');
    const finished = ofType(h, id2, 'tool.finished');
    expect(finished.map((e) => [e.payload.status, e.source])).toEqual([['unknown', 'host']]);
    const turnFinished = ofType(h, id2, 'turn.finished')[0];
    expect(finished[0]?.seq).toBeLessThan(turnFinished?.seq ?? 0);
  });
});

describe('SessionManager：SESSION_BUSY 与 INVALID_STATE', () => {
  it('活动中 send 返回 SESSION_BUSY 和当前状态，不排队、不发给引擎', async () => {
    const h = setup();
    const id = await create(h);
    const { turnId } = await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const sendSpy = vi.spyOn(h.adapter, 'send');
    const before = lastSeq(h, id);

    const error = await send(h, id, 'next').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({
      code: 'SESSION_BUSY',
      data: { state: 'awaiting_approval', activeTurn: { turnId } },
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(lastSeq(h, id)).toBe(before);
  });

  it('running 与 cancelling 同样是 SESSION_BUSY', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 20 }) });
    const id = await create(h);
    await send(h, id, 'a long enough message to keep the turn running');
    await expect(send(h, id, 'next')).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      data: { state: 'running' },
    });

    const h2 = setup({ manager: { cancelTimeoutMs: 200 } });
    const id2 = await create(h2);
    await send(h2, id2, 'please approve');
    await waitForApproval(h2, id2);
    vi.spyOn(h2.adapter, 'cancel').mockReturnValueOnce(never());
    const cancelling = h2.manager.cancel(id2);
    await waitForState(h2, id2, 'cancelling');
    await expect(send(h2, id2, 'next')).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      data: { state: 'cancelling' },
    });
    await cancelling;
    await h.manager.cancel(id);
  });

  it('error / closed 时 send 返回 INVALID_STATE；cancel 是无操作', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.close(id);
    const before = lastSeq(h, id);
    await expect(send(h, id, 'hi')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      data: { state: 'closed' },
    });
    await h.manager.cancel(id);
    await h.manager.close(id);
    expect(lastSeq(h, id)).toBe(before);

    const id2 = await create(h);
    await h.adapter.simulateEngineExit();
    await waitForState(h, id2, 'error');
    await expect(send(h, id2, 'hi')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      data: { state: 'error' },
    });
  });

  it('idle 时 cancel 成功、无操作；不存在的会话返回 SESSION_NOT_FOUND', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.cancel(id);
    expect(lastSeq(h, id)).toBe(1);
    await expect(h.manager.cancel('ses_NOPE')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(send(h, 'ses_NOPE', 'hi')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});

describe('SessionManager：审批', () => {
  it('#3 #4：请求带详情，批准后先写 approval.resolved 再放出暂扣的工具结果', async () => {
    const h = setup();
    const id = await create(h);
    // 引擎回复后拖一会儿才返回，确保工具结果在提交期间就到了 Host。
    const respond = h.adapter.respondToApproval.bind(h.adapter);
    vi.spyOn(h.adapter, 'respondToApproval').mockImplementation(async (...args) => {
      await respond(...args);
      await delay(30);
    });
    const { turnId } = await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);

    expect(approval).toMatchObject({
      id: expect.stringMatching(/^apr_/),
      sessionId: id,
      turnId,
      status: 'pending',
      options: [
        { optionId: 'allow-once', kind: 'allow_once', category: 'allow' },
        { optionId: 'reject-once', kind: 'reject_once', category: 'reject' },
      ],
      detail: {
        toolName: 'echo_write',
        display: { kind: 'write', paths: ['/outside-workspace/echo.txt'] },
        input: { file_path: '/outside-workspace/echo.txt' },
      },
    });
    expect(h.storage.approvals.get(approval.id)?.status).toBe('pending');

    const result = await h.manager.respondToApproval(
      { approvalId: approval.id, optionId: 'allow-once' },
      desktop,
    );
    expect(result).toEqual({
      approvalId: approval.id,
      status: 'approved',
      resolution: { reason: 'user', optionId: 'allow-once', decidedBy: desktop },
    });
    await waitForState(h, id, 'idle');

    const requested = ofType(h, id, 'approval.requested')[0];
    expect(typesAfter(h, id, requested?.seq ?? 0).slice(0, 4)).toEqual([
      'session.state_changed', // running→awaiting_approval
      'approval.resolved',
      'session.state_changed', // awaiting_approval→running
      'tool.finished',
    ]);
    expect(ofType(h, id, 'tool.finished').at(-1)?.payload.status).toBe('completed');
    expect(transitions(h, id)).toEqual([
      'idle→running:turn_started',
      'running→awaiting_approval:approval_requested',
      'awaiting_approval→running:approvals_settled',
      'running→idle:turn_finished',
    ]);
    expect(h.storage.approvals.get(approval.id)).toMatchObject({
      status: 'approved',
      resolution: { reason: 'user', optionId: 'allow-once', decidedBy: desktop },
    });
  });

  it('拒绝：审批 denied，工具 failed，回合照常结束', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    const result = await h.manager.respondToApproval(
      { approvalId: approval.id, optionId: 'reject-once' },
      cli,
    );
    expect(result.status).toBe('denied');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'tool.finished').at(-1)?.payload.status).toBe('failed');
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('completed');
  });

  it('两个客户端同时审批：一个生效，另一个 ALREADY_DECIDED 并拿到既有决定', async () => {
    const h = setup();
    const id = await create(h);
    const respondSpy = vi.spyOn(h.adapter, 'respondToApproval');
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);

    const [first, second] = await Promise.allSettled([
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, cli),
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'reject-once' }, desktop),
    ]);
    expect(first).toEqual({
      status: 'fulfilled',
      value: {
        approvalId: approval.id,
        status: 'approved',
        resolution: { reason: 'user', optionId: 'allow-once', decidedBy: cli },
      },
    });
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toMatchObject({
      code: 'ALREADY_DECIDED',
      data: {
        approvalId: approval.id,
        status: 'approved',
        resolution: { reason: 'user', optionId: 'allow-once', decidedBy: cli },
      },
    });
    expect(respondSpy).toHaveBeenCalledTimes(1);
    expect(ofType(h, id, 'approval.resolved')).toHaveLength(1);
    await waitForState(h, id, 'idle');
  });

  it('选项不在列表里返回 INVALID_PARAMS，审批不变；不存在的审批返回 APPROVAL_NOT_FOUND', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-always' }, cli),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.storage.approvals.get(approval.id)?.status).toBe('pending');
    await expect(
      h.manager.respondToApproval({ approvalId: 'apr_NOPE', optionId: 'allow-once' }, cli),
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' });
    await h.manager.cancel(id);
  });

  it('引擎侧已结束的审批（approval_not_found）：放出暂扣事件后返回 ALREADY_DECIDED', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    // 引擎在 Host 提交前自己结掉了审批（回合被引擎侧取消）。
    vi.spyOn(h.adapter, 'respondToApproval').mockImplementationOnce(async (engineSessionId) => {
      await h.adapter.cancel(engineSessionId);
      await delay(10);
      throw new AdapterError('approval_not_found', 'no pending approval');
    });
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, cli),
    ).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      data: { status: 'cancelled', resolution: { reason: 'turn_cancelled' } },
    });
    await waitForState(h, id, 'idle');
  });
});

describe('SessionManager：应用级工具替用户答应审批（autoAllow）', () => {
  it('autoAllow 认的调用：不写审批，引擎按允许继续；不认或出错时照常问', async () => {
    const seen: Array<{ toolName: string; input?: unknown }> = [];
    const h = setup({
      manager: {
        appTools: {
          grant: () => undefined,
          autoAllow: (_sessionId, tool) => {
            seen.push(tool);
            return tool.toolName === 'echo_write';
          },
        },
      },
    });
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'approval.requested')).toEqual([]);
    expect(ofType(h, id, 'tool.finished').map((event) => event.payload.status)).toContain(
      'completed',
    );
    expect(seen[0]?.toolName).toBe('echo_write');
    expect(seen[0]?.input).toBeDefined();

    const throwing = setup({
      manager: {
        appTools: {
          grant: () => undefined,
          autoAllow: () => {
            throw new Error('boom');
          },
        },
      },
    });
    const other = await create(throwing);
    await send(throwing, other, 'please approve');
    const approval = await waitForApproval(throwing, other);
    expect(approval.toolCallId).toBeDefined();
    throwing.errors.splice(0);
    await throwing.manager.cancel(other);
  });
});

/** echo 的 `approve` 换成一条命令审批：`approve: <命令>` 里冒号之后是命令（模拟 Codex 等引擎的命令审批）。 */
class ShellEchoAdapter extends EchoAdapter {
  override subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const source = super.subscribe(engineSessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.type === 'tool.started' && event.toolName === 'echo_write') {
            const content = String((event.input as { content?: string }).content ?? '');
            const command = content.slice(content.indexOf(':') + 1).trim();
            yield {
              ...event,
              toolName: 'exec_command',
              display: { kind: 'shell', summary: command, command },
              input: { command },
            };
          } else {
            yield event;
          }
        }
      },
    };
  }
}

describe('SessionManager：审批规则（0.80.0）', () => {
  function setupRules() {
    let rules: ApprovalRuleService | undefined;
    const service = () => rules as ApprovalRuleService;
    const h = setup({
      adapter: new ShellEchoAdapter({ stepDelayMs: 1 }),
      manager: {
        approvalRules: {
          match: (...args) => service().match(...args),
          propose: (...args) => service().propose(...args),
          remember: (...args) => service().remember(...args),
          recordUse: (...args) => service().recordUse(...args),
        },
      },
    });
    rules = new ApprovalRuleService({ storage: h.storage });
    return { h, rules };
  }

  it('没有规则时提议前缀；选总是允许（项目）后加规则，下一次同前缀的命令由 Host 允许', async () => {
    const { h, rules } = setupRules();
    const id = await create(h);
    await send(h, id, 'approve: git status --short');
    const approval = await waitForApproval(h, id);
    expect(approval.proposedRule).toEqual({ prefixes: [['git', 'status']] });

    const result = await h.manager.respondToApproval(
      { approvalId: approval.id, optionId: 'allow-once', remember: 'project' },
      desktop,
    );
    const [rule] = rules.list();
    expect(rule).toMatchObject({
      workspaceId: 'ws_1',
      prefix: ['git', 'status'],
      source: 'approval',
      sourceSessionId: id,
      sourceApprovalId: approval.id,
      useCount: 0,
    });
    expect(result.resolution).toEqual({
      reason: 'user',
      optionId: 'allow-once',
      decidedBy: desktop,
      ruleIds: [rule?.id],
    });
    await waitForState(h, id, 'idle');

    await send(h, id, "approve: bash -lc 'git status && git status -s'");
    await vi.waitFor(() => expect(ofType(h, id, 'approval.resolved')).toHaveLength(2));
    await waitForState(h, id, 'idle');
    const auto = ofType(h, id, 'approval.resolved')[1];
    expect(auto?.payload).toMatchObject({
      status: 'approved',
      resolution: { reason: 'rule', optionId: 'allow-once', ruleIds: [rule?.id] },
    });
    expect(auto?.payload.resolution.decidedBy).toBeUndefined();
    expect(ofType(h, id, 'approval.requested')[1]?.payload.approval.proposedRule).toBeUndefined();
    expect(ofType(h, id, 'tool.finished').at(-1)?.payload.status).toBe('completed');
    await vi.waitFor(() => expect(rules.list()[0]?.useCount).toBe(1));
    expect(h.errors).toEqual([]);
  });

  it('只覆盖一部分、带展开或重定向的命令照常问；规则删了之后也照常问', async () => {
    const { h, rules } = setupRules();
    const rule = rules.add(['git', 'status']);
    const id = await create(h);
    for (const command of ['git status; rm -rf build', 'git status > /tmp/x', 'git status $(id)']) {
      await send(h, id, `approve: ${command}`);
      const approval = await waitForApproval(h, id);
      expect(approval.proposedRule, command).toBeUndefined();
      await h.manager.respondToApproval(
        { approvalId: approval.id, optionId: 'reject-once' },
        desktop,
      );
      await waitForState(h, id, 'idle');
    }
    expect(rules.delete(rule.id)).toBe(true);
    await send(h, id, 'approve: git status');
    const approval = await waitForApproval(h, id);
    expect(approval.proposedRule).toEqual({ prefixes: [['git', 'status']] });
  });

  it('remember 要有提议、要选允许类选项', async () => {
    const { h } = setupRules();
    const id = await create(h);
    await send(h, id, 'approve: rm -rf build');
    const approval = await waitForApproval(h, id);
    expect(approval.proposedRule).toBeUndefined();
    await expect(
      h.manager.respondToApproval(
        { approvalId: approval.id, optionId: 'allow-once', remember: 'global' },
        desktop,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(snapshot(h, id).pendingApprovals).toHaveLength(1);
  });
});
describe('SessionManager：取消与关闭', () => {
  it('#5 #8：取消时未决审批结为 cancelled，失败的工具记为 cancelled', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);

    await h.manager.cancel(id);
    // cancel 返回时回合已经结算。
    expect(state(h, id)).toBe('idle');
    expect(ofType(h, id, 'approval.resolved')[0]?.payload).toEqual({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'turn_cancelled' },
    });
    expect(h.storage.approvals.get(approval.id)?.status).toBe('cancelled');
    expect(transitions(h, id)).toEqual([
      'idle→running:turn_started',
      'running→awaiting_approval:approval_requested',
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    const tool = ofType(h, id, 'tool.finished')[0];
    expect(tool?.payload).toMatchObject({
      status: 'cancelled',
      output: { text: expect.any(String) },
    });
    expect(tool?.source).toBe('engine');
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('cancelled');

    // 审批已结为 cancelled，之后的响应拿到 ALREADY_DECIDED。
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, cli),
    ).rejects.toMatchObject({ code: 'ALREADY_DECIDED', data: { status: 'cancelled' } });
  });

  it('#5 #8：生成中取消，已生成的半段作为已提交消息补发', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 5, chunkSize: 1 }) });
    const id = await create(h);
    await send(h, id, 'a reply long enough to be cut off midway');
    await vi.waitFor(() => expect(ofType(h, id, 'assistant.delta').length).toBeGreaterThan(0));
    await h.manager.cancel(id);

    expect(transitions(h, id)).toEqual([
      'idle→running:turn_started',
      'running→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    const message = ofType(h, id, 'assistant.message')[0];
    expect(message?.payload.text.length).toBeGreaterThan(0);
    expect(message?.payload.text.length).toBeLessThan(
      'Echo: a reply long enough to be cut off midway'.length,
    );
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('cancelled');
  });

  it('#9：引擎报 cancel_unconfirmed 时转 error', async () => {
    const h = setup();
    const id = await create(h);
    const { turnId } = await send(h, id, 'please approve');
    await waitForApproval(h, id);
    vi.spyOn(h.adapter, 'cancel').mockRejectedValueOnce(
      new AdapterError('cancel_unconfirmed', 'still running'),
    );
    await h.manager.cancel(id);

    expect(state(h, id)).toBe('error');
    expect(transitions(h, id).slice(-2)).toEqual([
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→error:cancel_unconfirmed',
    ]);
    expect(ofType(h, id, 'engine.error')[0]?.payload).toMatchObject({
      category: 'cancel_unconfirmed',
      fatal: true,
      turnId,
    });
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('interrupted');
    // echo_write 在等审批，没有收尾：补 unknown。
    expect(ofType(h, id, 'tool.finished').map((e) => e.payload.status)).toEqual(['unknown']);
  });

  it('#9：超过 cancelTimeoutMs 仍未结算时转 error', async () => {
    const h = setup({ manager: { cancelTimeoutMs: 50 } });
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    vi.spyOn(h.adapter, 'cancel').mockReturnValueOnce(never());
    const started = Date.now();
    await h.manager.cancel(id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(state(h, id)).toBe('error');
    expect(ofType(h, id, 'engine.error')[0]?.payload.category).toBe('cancel_unconfirmed');
  });

  it('#13：idle 与 error 时关闭；引擎关闭失败不阻止关闭', async () => {
    const h = setup();
    const id = await create(h);
    const closeSpy = vi.spyOn(h.adapter, 'close');
    await h.manager.close(id);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(transitions(h, id)).toEqual(['idle→closed:closed']);

    const id2 = await create(h);
    closeSpy.mockRejectedValueOnce(new AdapterError('session_not_found', 'unknown session'));
    await h.manager.close(id2);
    expect(state(h, id2)).toBe('closed');
    expect(ofType(h, id2, 'engine.error')[0]?.payload).toMatchObject({
      category: 'session_unavailable',
      fatal: false,
      message: 'unknown session',
    });

    const id3 = await create(h);
    await h.adapter.simulateEngineExit();
    await waitForState(h, id3, 'error');
    await h.manager.close(id3);
    expect(transitions(h, id3)).toEqual(['idle→error:engine_exited', 'error→closed:closed']);
  });

  it('#14：活动中关闭，先取消（审批原因 session_closed）再关闭', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    await h.manager.close(id);

    expect(transitions(h, id)).toEqual([
      'idle→running:turn_started',
      'running→awaiting_approval:approval_requested',
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
      'idle→closed:closed',
    ]);
    expect(ofType(h, id, 'approval.resolved')[0]?.payload).toMatchObject({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'session_closed' },
    });
  });

  it('#14：取消无法确认时仍然关闭', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    vi.spyOn(h.adapter, 'cancel').mockRejectedValueOnce(
      new AdapterError('cancel_unconfirmed', 'still running'),
    );
    await h.manager.close(id);
    expect(transitions(h, id).slice(-3)).toEqual([
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→error:cancel_unconfirmed',
      'error→closed:closed',
    ]);
  });
});

describe('SessionManager：Host 优雅退出', () => {
  it('shutdown()：新命令返回 HOST_SHUTTING_DOWN；活动回合按 #5 #8 取消，未决审批结为 cancelled（host_shutdown）；idle 的会话不动', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 5, chunkSize: 1 }) });
    const waiting = await create(h);
    const generating = await create(h);
    const quiet = await create(h);
    await send(h, waiting, 'please approve');
    const approval = await waitForApproval(h, waiting);
    await send(h, generating, 'a long reply that is still being generated');
    await vi.waitFor(() =>
      expect(ofType(h, generating, 'assistant.delta').length).toBeGreaterThan(0),
    );

    const stopping = h.manager.shutdown();
    // 重复调用等同一次退出，不会提前 dispose、打断正在进行的取消。
    expect(h.manager.shutdown()).toBe(stopping);
    // 取消还在进行时到达的命令也被拒绝。
    await expect(send(h, quiet, 'hi')).rejects.toMatchObject({ code: 'HOST_SHUTTING_DOWN' });
    await expect(h.manager.cancel(quiet)).rejects.toMatchObject({ code: 'HOST_SHUTTING_DOWN' });
    await stopping;

    expect(ofType(h, waiting, 'approval.resolved')[0]?.payload).toEqual({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'host_shutdown' },
    });
    expect(transitions(h, waiting)).toEqual([
      'idle→running:turn_started',
      'running→awaiting_approval:approval_requested',
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    expect(transitions(h, generating)).toEqual([
      'idle→running:turn_started',
      'running→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    for (const id of [waiting, generating]) {
      expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('cancelled');
    }
    expect(transitions(h, quiet)).toEqual([]);
    expect(h.storage.approvals.get(approval.id)?.status).toBe('cancelled');
    // 已经 dispose：之后的调用同样被拒，重复调用无操作。
    await expect(send(h, waiting, 'again')).rejects.toMatchObject({ code: 'HOST_SHUTTING_DOWN' });
    await h.manager.shutdown();

    // 重启后不需要对账：会话都已回到 idle，审批已结清。
    const { report } = restart(h);
    expect(report).toEqual({ expiredApprovals: 0, interruptedSessions: [], unknownSends: 0 });
  });
});

describe('SessionManager：恢复会话（#12）', () => {
  it('error 与 closed 时 resume 回到 idle，之后能继续对话', async () => {
    const h = setup();
    const id = await create(h);
    await h.adapter.simulateEngineExit();
    await waitForState(h, id, 'error');
    const resumed = await h.manager.resume(id);
    expect(resumed.state).toBe('idle');
    await send(h, id, 'hello again');
    await waitForState(h, id, 'idle');

    await h.manager.close(id);
    await h.manager.resume(id);
    await send(h, id, 'and again');
    await waitForState(h, id, 'idle');
    expect(transitions(h, id)).toEqual([
      'idle→error:engine_exited',
      'error→idle:resumed',
      'idle→running:turn_started',
      'running→idle:turn_finished',
      'idle→closed:closed',
      'closed→idle:resumed',
      'idle→running:turn_started',
      'running→idle:turn_finished',
    ]);
    // 回合内容只出现一份：resume 后没有重复订阅。
    expect(ofType(h, id, 'assistant.message')).toHaveLength(2);
  });

  it('活动或 idle 时 resume 成功、无操作', async () => {
    const h = setup();
    const id = await create(h);
    expect((await h.manager.resume(id)).state).toBe('idle');
    expect(lastSeq(h, id)).toBe(1);
  });

  it('引擎拒绝时追加 engine.error、状态不变，返回 ENGINE_ERROR；Provider 已删除返回 PROVIDER_NOT_FOUND', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.close(id);
    vi.spyOn(h.adapter, 'resumeSession').mockRejectedValueOnce(
      new AdapterError('session_unavailable', 'session cwd does not match'),
    );
    await expect(h.manager.resume(id)).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'session_unavailable', message: 'session cwd does not match' },
    });
    expect(state(h, id)).toBe('closed');
    expect(ofType(h, id, 'engine.error')[0]?.payload).toMatchObject({
      category: 'session_unavailable',
      fatal: false,
    });

    h.storage.providers.delete('deepseek-official');
    await expect(h.manager.resume(id)).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
  });
});

describe('SessionManager：引擎会话恢复与只读（T3.5）', () => {
  it('建会话与恢复都记下引擎版本：resume 写 session.resumed 再转 idle；自动 resume 的 session.resumed 在 user.message 之前', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 1, engineVersion: '9.9.9' }) });
    const id = await create(h);
    expect(ofType(h, id, 'session.created')[0]?.payload.engineVersion).toBe('9.9.9');

    await h.manager.close(id);
    let before = lastSeq(h, id);
    await h.manager.resume(id);
    expect(typesAfter(h, id, before)).toEqual(['session.resumed', 'session.state_changed']);
    expect(ofType(h, id, 'session.resumed')[0]?.payload).toEqual({ engineVersion: '9.9.9' });

    // Host 重启，引擎（同一个 EchoAdapter）还认识这个会话：send 前自动 resume。
    const { h: next } = restart(h, h.adapter);
    before = lastSeq(next, id);
    await send(next, id, 'after restart');
    await waitForState(next, id, 'idle');
    expect(typesAfter(next, id, before).slice(0, 3)).toEqual([
      'session.resumed',
      'user.message',
      'turn.started',
    ]);
    expect(ofType(next, id, 'session.resumed')).toHaveLength(2);
  });

  it('Host 重启后引擎会话没了：会话只读、给出原因；历史、标题、列表仍从事件库读；send 返回 INVALID_STATE 带原因', async () => {
    const old = setup();
    const id = await create(old);
    await send(old, id, 'hello before restart');
    await waitForState(old, id, 'idle');
    const history = all(old, id);
    const title = snapshot(old, id).session.title;

    const { h } = restart(old);
    // 重启后、恢复之前：快照与历史都来自事件库，不依赖引擎。
    expect(all(h, id)).toEqual(history);
    expect(snapshot(h, id).session).toMatchObject({ state: 'idle', title });

    await expect(send(h, id, 'are you there?')).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    const readOnly = snapshot(h, id).session.readOnly;
    expect(readOnly).toEqual({
      reason: 'engine_session_not_found',
      message: expect.stringContaining('session is not resumable'),
      since: ofType(h, id, 'session.read_only')[0]?.ts,
    });
    expect(state(h, id)).toBe('error');
    expect(all(h, id).slice(0, history.length)).toEqual(history);
    expect(snapshot(h, id).session.title).toBe(title);
    expect(
      h.storage.sessions
        .list({})
        .map((r) => h.events.snapshot(r.id as SessionId)?.session.readOnly),
    ).toEqual([readOnly]);

    // 只读时 send：INVALID_STATE，data 带原因，不发给引擎、不写事件。
    const seq = lastSeq(h, id);
    const resume = vi.spyOn(h.adapter, 'resumeSession');
    await expect(send(h, id, 'again')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      data: { state: 'error', readOnly },
    });
    expect(resume).not.toHaveBeenCalled();
    expect(lastSeq(h, id)).toBe(seq);

    // resume 仍会重试引擎；同一原因不重复写 session.read_only。
    await expect(h.manager.resume(id)).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(typesAfter(h, id, seq)).toEqual(['engine.error']);
    expect(ofType(h, id, 'session.read_only')).toHaveLength(1);

    // 引擎数据找回来了：resume 成功即解除只读。
    resume.mockResolvedValueOnce({ engineSessionId: 'restored' });
    vi.spyOn(h.adapter, 'subscribe').mockReturnValueOnce({
      [Symbol.asyncIterator]: () => ({ next: never }),
    });
    expect(await h.manager.resume(id)).toMatchObject({ state: 'idle' });
    expect(snapshot(h, id).session.readOnly).toBeUndefined();
  });

  it('closed 的会话恢复时引擎读不了它的日志：写 session.read_only（incompatible），仍是 closed', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.close(id);
    const message =
      'session/resume 失败：Internal error: session "x" uses log format v5, but this harness reads only v4';
    vi.spyOn(h.adapter, 'resumeSession').mockRejectedValueOnce(
      new AdapterError('session_lost', message, { lostReason: 'incompatible' }),
    );
    await expect(h.manager.resume(id)).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'session_unavailable', message },
    });
    expect(state(h, id)).toBe('closed');
    expect(ofType(h, id, 'session.read_only')[0]?.payload).toEqual({
      reason: 'engine_session_incompatible',
      message,
    });
    expect(ofType(h, id, 'engine.error').at(-1)?.payload.fatal).toBe(false);
  });

  it('工作区目录不在了：resume 与 send 前的自动 resume 返回 WORKSPACE_PATH_INVALID，不问引擎、不写事件', async () => {
    const old = setup();
    const closed = await create(old);
    const idle = await create(old);
    await old.manager.close(closed);
    const { h } = restart(old);
    rmSync(h.workspaceDir, { recursive: true });
    const resume = vi.spyOn(h.adapter, 'resumeSession');
    const seqs = [lastSeq(h, closed), lastSeq(h, idle)];

    await expect(h.manager.resume(closed)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_INVALID',
      data: { reason: 'not_found' },
    });
    await expect(send(h, idle, 'hi')).rejects.toMatchObject({ code: 'WORKSPACE_PATH_INVALID' });
    expect(resume).not.toHaveBeenCalled();
    expect([lastSeq(h, closed), lastSeq(h, idle)]).toEqual(seqs);
    expect(state(h, idle)).toBe('idle');
  });

  it('引擎为确认不了的取消重启（cancel_unconfirmed）：会话 error，消息提示 resume', async () => {
    const h = setup();
    const id = await create(h);
    await h.adapter.simulateEngineExit({ signal: null, reason: 'cancel_unconfirmed' });
    await waitForState(h, id, 'error');
    expect(ofType(h, id, 'engine.error').at(-1)?.payload).toMatchObject({
      category: 'engine_exited',
      message: expect.stringContaining('cancellation could not be confirmed; resume the session'),
    });
    await h.manager.resume(id);
    expect(state(h, id)).toBe('idle');
  });
});

describe('SessionManager：clientMessageId', () => {
  it('同一 ID 重发返回原结果、不再发给引擎，不论会话现在处于什么状态', async () => {
    const h = setup();
    const id = await create(h);
    const sendSpy = vi.spyOn(h.adapter, 'send');
    const first = await send(h, id, 'please approve', 'msg-1');
    await waitForApproval(h, id);

    // 会话忙，但重发排在状态检查之前，拿到原结果而不是 SESSION_BUSY。
    expect(await send(h, id, 'please approve', 'msg-1')).toEqual(first);
    await h.manager.cancel(id);
    expect(await send(h, id, 'please approve', 'msg-1')).toEqual(first);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(ofType(h, id, 'user.message')).toHaveLength(1);
    expect(ofType(h, id, 'user.message')[0]?.payload.clientMessageId).toBe('msg-1');
    expect(h.storage.sendReceipts.get(id, 'msg-1')).toMatchObject({
      status: 'confirmed',
      turnId: first.turnId,
      seq: first.seq,
    });
  });

  it('同一 ID、不同内容返回 CLIENT_MESSAGE_CONFLICT', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'hello', 'msg-1');
    await waitForState(h, id, 'idle');
    const before = lastSeq(h, id);
    await expect(send(h, id, 'goodbye', 'msg-1')).rejects.toMatchObject({
      code: 'CLIENT_MESSAGE_CONFLICT',
      data: { clientMessageId: 'msg-1' },
    });
    expect(lastSeq(h, id)).toBe(before);
    // 另一个会话里同一个 ID 不冲突。
    const id2 = await create(h);
    await send(h, id2, 'goodbye', 'msg-1');
    await waitForState(h, id2, 'idle');
  });

  it('并发重发只发给引擎一次', async () => {
    const h = setup();
    const id = await create(h);
    const sendSpy = vi.spyOn(h.adapter, 'send');
    const results = await Promise.all([
      send(h, id, 'hi', 'msg-1'),
      send(h, id, 'hi', 'msg-1'),
      send(h, id, 'hi', 'msg-1'),
    ]);
    expect(new Set(results.map((r) => r.turnId)).size).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    await waitForState(h, id, 'idle');
  });
});

describe('SessionManager：引擎异常（#10）', () => {
  it('等审批时引擎退出：审批结为 cancelled（engine_exited），回合 interrupted，会话 error，历史保留', async () => {
    const h = setup();
    const id = await create(h);
    const { turnId } = await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    const before = all(h, id);

    await h.adapter.simulateEngineExit({ exitCode: 1, signal: null, stderrTail: 'boom' });
    await waitForState(h, id, 'error');

    expect(all(h, id).slice(0, before.length)).toEqual(before);
    expect(typesAfter(h, id, before.length)).toEqual([
      'approval.resolved',
      'tool.finished',
      'turn.finished',
      'engine.error',
      'session.state_changed',
    ]);
    expect(ofType(h, id, 'approval.resolved')[0]?.payload).toEqual({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'engine_exited' },
    });
    expect(ofType(h, id, 'engine.error')[0]?.payload).toEqual({
      category: 'engine_exited',
      message: 'engine exited with code 1\nboom',
      fatal: true,
      turnId,
    });
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('interrupted');
    expect(transitions(h, id).at(-1)).toBe('awaiting_approval→error:engine_exited');
    expect(snapshot(h, id).session.lastError?.category).toBe('engine_exited');
  });

  it('适配器为应用新的 Provider 配置重启引擎（config_changed）：会话 error，消息提示 resume，之后能继续', async () => {
    const h = setup();
    const id = await create(h);
    await h.adapter.simulateEngineExit({ exitCode: null, signal: null, reason: 'config_changed' });
    await waitForState(h, id, 'error');
    expect(ofType(h, id, 'engine.error')[0]?.payload).toEqual({
      category: 'engine_exited',
      message: 'engine restarted to apply provider changes; resume the session to continue',
      fatal: true,
    });
    await h.manager.resume(id);
    await send(h, id, 'hello again');
    await waitForState(h, id, 'idle');
  });

  it('生成中、回合之间、取消中引擎退出都转 error', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 5, chunkSize: 1 }) });
    const running = await create(h);
    const idle = await create(h);
    await send(h, running, 'a reply that takes a while to generate');
    await vi.waitFor(() => expect(ofType(h, running, 'assistant.delta').length).toBeGreaterThan(0));
    await h.adapter.simulateEngineExit();
    await waitForState(h, running, 'error');
    await waitForState(h, idle, 'error');
    expect(transitions(h, running).at(-1)).toBe('running→error:engine_exited');
    expect(transitions(h, idle)).toEqual(['idle→error:engine_exited']);
    expect(ofType(h, idle, 'engine.error')[0]?.payload).not.toHaveProperty('turnId');

    // 取消挂起时引擎退出：取消随之结束。
    const h2 = setup();
    const cancelling = await create(h2);
    await send(h2, cancelling, 'please approve');
    await waitForApproval(h2, cancelling);
    vi.spyOn(h2.adapter, 'cancel').mockReturnValueOnce(never());
    const cancel = h2.manager.cancel(cancelling);
    await waitForState(h2, cancelling, 'cancelling');
    await h2.adapter.simulateEngineExit();
    await cancel;
    expect(transitions(h2, cancelling).at(-1)).toBe('cancelling→error:engine_exited');
  });

  it('适配器 send 抛错：会话转 error，本次仍返回已接受的回合', async () => {
    const h = setup();
    const id = await create(h);
    vi.spyOn(h.adapter, 'send').mockRejectedValueOnce(
      new AdapterError('engine_unavailable', 'stdin closed'),
    );
    const result = await send(h, id, 'hello', 'msg-1');
    expect(result).toEqual({ turnId: expect.stringMatching(/^trn_/), seq: 2 });
    expect(state(h, id)).toBe('error');
    expect(ofType(h, id, 'user.message')).toHaveLength(1);
    expect(ofType(h, id, 'engine.error')[0]?.payload).toMatchObject({
      category: 'unknown',
      message: 'stdin closed',
      fatal: true,
      turnId: result.turnId,
    });
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('interrupted');
    expect(transitions(h, id)).toEqual([
      'idle→running:turn_started',
      'running→error:engine_exited',
    ]);
    // 回执保持 accepted（引擎没有确认），重发仍返回原结果。
    expect(h.storage.sendReceipts.get(id, 'msg-1')?.status).toBe('accepted');
    expect(await send(h, id, 'hello', 'msg-1')).toEqual(result);

    await h.manager.resume(id);
    await send(h, id, 'hello again');
    await waitForState(h, id, 'idle');
  });

  it('事件流中断或意外结束：会话转 error', async () => {
    const h = setup();
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementationOnce((engineSessionId) =>
      breakAfter(subscribe(engineSessionId), 2),
    );
    const id = await create(h);
    await send(h, id, 'hello');
    await waitForState(h, id, 'error');
    expect(ofType(h, id, 'engine.error')[0]?.payload).toMatchObject({
      category: 'unknown',
      message: 'engine event stream failed: pipe broken',
      fatal: true,
    });
    expect(transitions(h, id).at(-1)).toBe('running→error:engine_exited');

    vi.spyOn(h.adapter, 'subscribe').mockImplementationOnce(() => endImmediately());
    const id2 = await create(h);
    await waitForState(h, id2, 'error');
    expect(ofType(h, id2, 'engine.error')[0]?.payload.message).toBe(
      'engine event stream ended unexpectedly',
    );
  });

  it('适配器回复审批失败：会话转 error，审批结为 cancelled，本次返回 ALREADY_DECIDED', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    vi.spyOn(h.adapter, 'respondToApproval').mockRejectedValueOnce(
      new AdapterError('engine_unavailable', 'stdin closed'),
    );
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, cli),
    ).rejects.toMatchObject({
      code: 'ALREADY_DECIDED',
      data: { status: 'cancelled', resolution: { reason: 'engine_exited' } },
    });
    expect(state(h, id)).toBe('error');
    expect(transitions(h, id).at(-1)).toBe('awaiting_approval→error:engine_exited');
  });
});

describe('SessionManager：Host 启动对账（#15、#11）', () => {
  it('未决审批结为 expired，活动会话修正为 idle，已接受未确认的发送标为 unknown 且不重发', async () => {
    const old = setup();
    // A：等审批。
    const a = await create(old);
    await send(old, a, 'please approve');
    const approval = await waitForApproval(old, a);
    // B：引擎一直没确认收到（send 挂起）。
    const b = await create(old);
    vi.spyOn(old.adapter, 'send').mockReturnValueOnce(never());
    const pendingSend = send(old, b, 'hello', 'msg-b');
    await waitForState(old, b, 'running');
    // C：取消挂起。
    const c = await create(old);
    await send(old, c, 'please approve');
    await waitForApproval(old, c);
    vi.spyOn(old.adapter, 'cancel').mockReturnValueOnce(never());
    void old.manager.cancel(c);
    await waitForState(old, c, 'cancelling');
    // D：idle，不需要修正。
    const d = await create(old);
    const bTurn = snapshot(old, b).session.activeTurn;
    const bMessage = ofType(old, b, 'user.message')[0];
    expect(old.storage.sendReceipts.get(b, 'msg-b')?.status).toBe('accepted');
    void pendingSend;

    const { h, report } = restart(old);
    expect(report).toEqual({
      expiredApprovals: 1,
      interruptedSessions: expect.arrayContaining([a, b, c]),
      unknownSends: 1,
    });
    expect(report.interruptedSessions).toHaveLength(3);

    expect(transitions(h, a).at(-1)).toBe('awaiting_approval→idle:host_restarted');
    expect(transitions(h, b).at(-1)).toBe('running→idle:host_restarted');
    expect(transitions(h, c).at(-1)).toBe('cancelling→idle:host_restarted');
    expect(transitions(h, d)).toEqual([]);
    expect(ofType(h, a, 'approval.resolved')[0]?.payload).toEqual({
      approvalId: approval.id,
      status: 'expired',
      resolution: { reason: 'host_restarted' },
    });
    expect(h.storage.approvals.get(approval.id)?.status).toBe('expired');
    expect(h.storage.approvals.listPending()).toEqual([]);
    for (const id of [a, b, c]) {
      expect(state(h, id)).toBe('idle');
      expect(ofType(h, id, 'turn.finished').at(-1)?.payload.outcome).toBe('interrupted');
    }
    // A 的 echo_write 在等审批：补 unknown。
    expect(ofType(h, a, 'tool.finished').map((e) => e.payload.status)).toEqual(['unknown']);
    expect(h.storage.sendReceipts.get(b, 'msg-b')?.status).toBe('unknown');

    // 重发结果未知的消息：返回原结果，不自动重发给引擎。
    const sendSpy = vi.spyOn(h.adapter, 'send');
    expect(await send(h, b, 'hello', 'msg-b')).toEqual({
      turnId: bTurn?.turnId,
      seq: bMessage?.seq,
    });
    expect(sendSpy).not.toHaveBeenCalled();

    // 新引擎不认识旧会话：send 前的自动 resume 失败（#11），不写 user.message；引擎会话没了，会话只读（T3.5）。
    const before = lastSeq(h, d);
    await expect(send(h, d, 'hi')).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'session_unavailable' },
    });
    expect(typesAfter(h, d, before)).toEqual([
      'engine.error',
      'session.state_changed',
      'session.read_only',
    ]);
    expect(transitions(h, d)).toEqual(['idle→error:resume_failed']);
    expect(ofType(h, d, 'engine.error')[0]?.payload.fatal).toBe(true);
    expect(snapshot(h, d).session.readOnly?.reason).toBe('engine_session_not_found');

    // 再启动一次没有需要修正的东西。
    const again = restart(h).report;
    expect(again).toEqual({ expiredApprovals: 0, interruptedSessions: [], unknownSends: 0 });
  });

  it('引擎会话仍在时 send 前自动 resume，对客户端透明', async () => {
    const old = setup();
    const id = await create(old);
    await send(old, id, 'hello');
    await waitForState(old, id, 'idle');
    // Host 重启，引擎（同一个 EchoAdapter）还认识这个会话。
    const { h } = restart(old, old.adapter);
    const resume = vi.spyOn(h.adapter, 'resumeSession');
    await send(h, id, 'after restart');
    await waitForState(h, id, 'idle');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(ofType(h, id, 'assistant.message')).toHaveLength(2);
    expect(transitions(h, id).slice(-2)).toEqual([
      'idle→running:turn_started',
      'running→idle:turn_finished',
    ]);
  });
});

describe('SessionManager：会话标题（R3）', () => {
  const TITLE = '{"title": "“打个招呼。”", "description": "第一条消息是问候"}';

  function withTitles(output: () => Promise<string>) {
    const warnings: string[] = [];
    const h = setup({
      manager: {
        titleInstructions: '起标题',
        onWarning: (message) => warnings.push(message),
      },
    });
    const calls: Array<{ engineSessionId: string; input: string; instructions: string }> = [];
    Object.assign(h.adapter, {
      generateTitle: (
        engineSessionId: string,
        request: { input: string; instructions: string },
      ) => {
        calls.push({ engineSessionId, input: request.input, instructions: request.instructions });
        return output();
      },
    });
    return { h, calls, warnings };
  }

  it('第一个回合开始后用会话的模型生成标题：先写截断的，再写 generated（去掉引号与结尾标点，带检索摘要）', async () => {
    const { h, calls, warnings } = withTitles(async () => TITLE);
    const id = await create(h);
    await send(h, id, '  你好 <b>&\n 世界 ');
    await waitForState(h, id, 'idle');
    await vi.waitFor(() => expect(snapshot(h, id).session.titleSource).toBe('generated'));
    expect(ofType(h, id, 'session.title_changed').map((e) => e.payload)).toEqual([
      { title: '你好 <b>& 世界', source: 'first_prompt' },
      { title: '打个招呼', source: 'generated', description: '第一条消息是问候' },
    ]);
    expect(snapshot(h, id).session.title).toBe('打个招呼');
    expect(calls).toEqual([
      {
        engineSessionId: snapshot(h, id).session.engine.sessionId,
        instructions: '起标题',
        input: '<user_prompt>\n你好 &lt;b&gt;&amp;\n 世界\n</user_prompt>',
      },
    ]);
    // 之后的回合不再生成。
    await send(h, id, 'again');
    await waitForState(h, id, 'idle');
    expect(calls).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('生成标题的请求用量也交给 onUsage：输入减去缓存，ID 每次不同', async () => {
    const onUsage = vi.fn();
    const h = setup({ manager: { titleInstructions: '起标题', onUsage } });
    Object.assign(h.adapter, {
      generateTitle: async (_id: string, request: TitleRequest) => {
        request.onUsage?.({
          inputTokens: 1200,
          outputTokens: 40,
          cacheReadTokens: 1000,
          reasoningTokens: 10,
          model: 'deepseek-chat-0927',
        });
        return TITLE;
      },
    });
    const id = await create(h);
    await send(h, id, 'hello');
    await vi.waitFor(() => expect(snapshot(h, id).session.titleSource).toBe('generated'));
    const side = onUsage.mock.calls.filter(
      ([, event]) => (event as UsageRecordedEvent).model === 'deepseek-chat-0927',
    );
    expect(side).toEqual([
      [
        { sessionId: id, providerId: 'deepseek-official', modelId: 'deepseek-chat' },
        {
          type: 'usage.recorded',
          engineSessionId: snapshot(h, id).session.engine.sessionId,
          requestId: expect.stringMatching(/^req_/),
          model: 'deepseek-chat-0927',
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 1000,
          reasoningTokens: 10,
        },
      ],
    ]);
  });

  it('输出解析不了或请求失败：保留截断的标题，记告警', async () => {
    const { h, warnings } = withTitles(async () => '我觉得标题应该是……');
    const id = await create(h);
    await send(h, id, 'hello');
    await vi.waitFor(() => expect(warnings).not.toHaveLength(0));
    expect(warnings[0]).toContain('无法解析');
    expect(snapshot(h, id).session).toMatchObject({ title: 'hello', titleSource: 'first_prompt' });

    const failing = withTitles(() => Promise.reject(new AdapterError('engine_unavailable', '502')));
    const id2 = await create(failing.h);
    await send(failing.h, id2, 'hello');
    await vi.waitFor(() => expect(failing.warnings).not.toHaveLength(0));
    expect(failing.warnings[0]).toContain('生成会话标题失败');
    await waitForState(failing.h, id2, 'idle');
    expect(snapshot(failing.h, id2).session.titleSource).toBe('first_prompt');
  });

  it('第一次请求失败：之后的回合正常结束时再试一次，只试一次；引擎不支持的不再试', async () => {
    let attempts = 0;
    const { h, calls } = withTitles(async () => {
      attempts += 1;
      if (attempts === 1) throw new AdapterError('engine_unavailable', '60000 ms 内没有结果');
      return TITLE;
    });
    const id = await create(h);
    await send(h, id, 'hello');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await waitForState(h, id, 'idle');
    // 失败可能晚于第一个回合结束：那就由下一个回合补上。
    await send(h, id, 'again');
    await waitForState(h, id, 'idle');
    await vi.waitFor(() => expect(snapshot(h, id).session.titleSource).toBe('generated'));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input).toBe('<user_prompt>\nhello\n</user_prompt>');
    await send(h, id, 'third');
    await waitForState(h, id, 'idle');
    expect(calls).toHaveLength(2);

    const unsupported = withTitles(() =>
      Promise.reject(
        new AdapterError('invalid_input', 'the x engine does not support generateTitle'),
      ),
    );
    const id2 = await create(unsupported.h);
    await send(unsupported.h, id2, 'hello');
    await vi.waitFor(() => expect(unsupported.warnings).toHaveLength(1));
    await waitForState(unsupported.h, id2, 'idle');
    await send(unsupported.h, id2, 'again');
    await waitForState(unsupported.h, id2, 'idle');
    await delay(20);
    expect(unsupported.calls).toHaveLength(1);
  });

  it('等结果期间标题已经不是截断的那个（用户改过名）：不覆盖', async () => {
    let resolve!: (text: string) => void;
    const { h } = withTitles(() => new Promise<string>((r) => (resolve = r)));
    const id = await create(h);
    await send(h, id, 'hello');
    await waitForState(h, id, 'idle');
    h.events.append(id, {
      type: 'session.title_changed',
      source: 'host',
      payload: { title: '我的名字', source: 'user' },
    });
    resolve(TITLE);
    await delay(20);
    expect(snapshot(h, id).session).toMatchObject({ title: '我的名字', titleSource: 'user' });
    expect(ofType(h, id, 'session.title_changed')).toHaveLength(2);
  });

  it('请求几乎只是链接：先查链接，页面标题与开头一段作为 <link_context> 交给模型；查不到的不带', async () => {
    const lookups: string[] = [];
    const h = setup({
      manager: {
        titleInstructions: '起标题',
        lookupLink: async (url) => {
          lookups.push(url);
          return url.endsWith('/57')
            ? { url, title: 'Retry uploads on 503', excerpt: 'Uploads now retry.' }
            : undefined;
        },
      },
    });
    const inputs: string[] = [];
    Object.assign(h.adapter, {
      generateTitle: async (_id: string, request: { input: string }) => {
        inputs.push(request.input);
        return TITLE;
      },
    });
    const id = await create(h);
    await send(h, id, '看下 https://github.com/acme/app/pull/57 和 https://down.example/x');
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(lookups).toEqual(['https://github.com/acme/app/pull/57', 'https://down.example/x']);
    expect(inputs[0]).toContain(
      '<link_context>\n<link url="https://github.com/acme/app/pull/57" title="Retry uploads on 503">\nUploads now retry.\n</link>\n</link_context>',
    );
    expect(inputs[0]).not.toContain('down.example/x"');

    // 请求本身说清了主题：不查。
    const id2 = await create(h);
    await send(
      h,
      id2,
      '把 session-manager 里生成标题的超时从六十秒改成三十秒，参考 https://x.example/doc 这篇',
    );
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(lookups).toHaveLength(2);
  });

  it('没有提示词或适配器不实现 generateTitle：只有截断的标题', async () => {
    const h = setup();
    const spy = vi.fn(async () => TITLE);
    Object.assign(h.adapter, { generateTitle: spy });
    const id = await create(h);
    await send(h, id, 'hello');
    await waitForState(h, id, 'idle');
    expect(spy).not.toHaveBeenCalled();
    expect(snapshot(h, id).session.titleSource).toBe('first_prompt');
  });
});

describe('SessionManager：回合进行中发消息（R11）', () => {
  function deliver(
    h: Harness,
    sessionId: SessionId,
    value: string,
    delivery: 'steer' | 'queue',
    clientMessageId?: string,
  ) {
    return h.manager.send(
      {
        sessionId,
        content: text(value),
        delivery,
        ...(clientMessageId !== undefined && { clientMessageId }),
      },
      desktop,
    );
  }

  async function approve(h: Harness, sessionId: SessionId) {
    const approval = await waitForApproval(h, sessionId);
    await h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, cli);
  }

  /** 回合 `turnId` 里的 user.steered 与助手消息，按顺序。 */
  function turnStory(h: Harness, sessionId: SessionId, turnId: string | undefined): string[] {
    return all(h, sessionId).flatMap((e) => {
      if (e.type === 'user.steered' && e.payload.turnId === turnId) {
        return [`steer:${textOf(e.payload.content)}`];
      }
      if (e.type === 'assistant.message' && e.payload.turnId === turnId) return [e.payload.text];
      return [];
    });
  }

  function userMessages(h: Harness, sessionId: SessionId): string[] {
    return ofType(h, sessionId, 'user.message').map((e) => textOf(e.payload.content));
  }

  it('空闲时带 delivery 照常开始回合', async () => {
    const h = setup();
    const id = await create(h);
    const result = await deliver(h, id, 'hello', 'steer');
    expect(result).toEqual({ turnId: expect.stringMatching(/^trn_/), seq: expect.any(Number) });
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'pending.added')).toEqual([]);
  });

  it('插话：交给引擎，这一步之后进了同一个回合（user.steered），模型接着回答', async () => {
    const h = setup();
    const id = await create(h);
    const steer = vi.spyOn(h.adapter, 'steer');
    const { turnId } = await send(h, id, 'please approve');
    await waitForApproval(h, id);

    const result = await deliver(h, id, 'also check tests', 'steer', 'msg-steer');
    expect(result).toEqual({ pendingId: expect.stringMatching(/^pnd_/), seq: expect.any(Number) });
    const pendingId = result.pendingId as NonNullable<typeof result.pendingId>;
    expect(steer).toHaveBeenCalledWith(expect.any(String), pendingId, {
      content: text('also check tests'),
    });
    expect(snapshot(h, id).pendingMessages).toEqual([
      expect.objectContaining({ id: pendingId, delivery: 'steer', status: 'waiting' }),
    ]);
    // 交出去的插话不能再改、不能删。
    await expect(
      h.manager.updatePending({ sessionId: id, pendingId, content: text('x') }),
    ).rejects.toMatchObject({
      code: 'PENDING_NOT_EDITABLE',
      data: { pendingId, status: 'waiting', delivery: 'steer' },
    });
    expect(() => h.manager.cancelPending({ sessionId: id, pendingId })).toThrow(
      expect.objectContaining({ code: 'PENDING_NOT_EDITABLE' }),
    );
    // 同一 clientMessageId 重发返回原结果。
    expect(await deliver(h, id, 'also check tests', 'steer', 'msg-steer')).toEqual(result);

    await approve(h, id);
    await waitForState(h, id, 'idle');
    expect(turnStory(h, id, turnId)).toEqual([
      'Echo: please approve',
      'steer:also check tests',
      'Echo: also check tests',
    ]);
    const [steered] = ofType(h, id, 'user.steered');
    expect(steered?.payload).toEqual({
      turnId,
      pendingId,
      clientMessageId: 'msg-steer',
      content: text('also check tests'),
      sentBy: desktop,
    });
    expect(h.events.pending(id, pendingId)).toMatchObject({ status: 'inserted', turnId });
    expect(snapshot(h, id).pendingMessages).toBeUndefined();
    expect(ofType(h, id, 'turn.started')).toHaveLength(1);
  });

  it('插话被引擎拒绝：改为排队（rejected），回合完成后作为下一个回合发出', async () => {
    const h = setup();
    const id = await create(h);
    vi.spyOn(h.adapter, 'steer').mockRejectedValueOnce(
      new AdapterError('steer_rejected', 'cannot steer a review turn'),
    );
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const { pendingId } = await deliver(h, id, 'then commit', 'steer');
    expect(snapshot(h, id).pendingMessages).toEqual([
      expect.objectContaining({
        id: pendingId,
        delivery: 'queue',
        status: 'waiting',
        fallback: { reason: 'rejected', message: 'cannot steer a review turn' },
      }),
    ]);

    await approve(h, id);
    await vi.waitFor(() => expect(ofType(h, id, 'turn.finished')).toHaveLength(2), {
      timeout: 2000,
      interval: 5,
    });
    await waitForState(h, id, 'idle');
    expect(userMessages(h, id)).toEqual(['please approve', 'then commit']);
    const [, queued] = ofType(h, id, 'user.message');
    expect(queued?.payload).toMatchObject({ pendingId, sentBy: desktop });
    expect(h.events.pending(id, pendingId as NonNullable<typeof pendingId>)).toMatchObject({
      status: 'sent',
      turnId: queued?.payload.turnId,
    });
    expect(ofType(h, id, 'user.steered')).toEqual([]);
  });

  it('引擎不能插话（不实现 steer）：一律排队（unsupported）', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 1 });
    Object.defineProperty(adapter, 'steer', { value: undefined });
    const h = setup({ adapter });
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const { pendingId } = await deliver(h, id, 'later', 'steer');
    expect(h.events.pending(id, pendingId as NonNullable<typeof pendingId>)).toMatchObject({
      delivery: 'queue',
      status: 'waiting',
      fallback: { reason: 'unsupported' },
    });
    // 改成插话同样做不到，保持排队。
    const updated = await h.manager.updatePending({
      sessionId: id,
      pendingId: pendingId as NonNullable<typeof pendingId>,
      delivery: 'steer',
    });
    expect(updated).toMatchObject({ delivery: 'queue', fallback: { reason: 'unsupported' } });
    await approve(h, id);
    await vi.waitFor(() => expect(userMessages(h, id)).toEqual(['please approve', 'later']), {
      timeout: 2000,
      interval: 5,
    });
  });

  it('排队：回合完成后按加入的先后逐条发出；不带 delivery 的旧客户端仍是 SESSION_BUSY', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const first = await deliver(h, id, 'first', 'queue');
    const second = await deliver(h, id, 'second', 'queue');
    await expect(send(h, id, 'old client')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    // 排队的可以改内容。
    await h.manager.updatePending({
      sessionId: id,
      pendingId: second.pendingId as NonNullable<typeof second.pendingId>,
      content: text('second, edited'),
    });
    expect(snapshot(h, id).pendingMessages?.map((p) => textOf(p.content))).toEqual([
      'first',
      'second, edited',
    ]);

    await approve(h, id);
    await vi.waitFor(() => expect(ofType(h, id, 'turn.finished')).toHaveLength(3), {
      timeout: 3000,
      interval: 5,
    });
    await waitForState(h, id, 'idle');
    expect(userMessages(h, id)).toEqual(['please approve', 'first', 'second, edited']);
    expect(ofType(h, id, 'user.message').map((e) => e.payload.pendingId)).toEqual([
      undefined,
      first.pendingId,
      second.pendingId,
    ]);
    expect(snapshot(h, id).pendingMessages).toBeUndefined();
  });

  it('取消回合：等待中的暂停，没插进去的插话改为排队并暂停；继续发送后逐条发出', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const queued = await deliver(h, id, 'queued', 'queue');
    const steered = await deliver(h, id, 'steered', 'steer');
    await h.manager.cancel(id);
    expect(state(h, id)).toBe('idle');
    expect(snapshot(h, id).pendingMessages).toEqual([
      expect.objectContaining({ id: queued.pendingId, delivery: 'queue', status: 'held' }),
      expect.objectContaining({
        id: steered.pendingId,
        delivery: 'queue',
        status: 'held',
        fallback: { reason: 'turn_ended' },
      }),
    ]);
    // 暂停的不会自己发出；暂停的可以改内容、不能改成插话、可以删。
    await delay(20);
    expect(userMessages(h, id)).toEqual(['please approve']);
    const steeredId = steered.pendingId as NonNullable<typeof steered.pendingId>;
    await expect(
      h.manager.updatePending({ sessionId: id, pendingId: steeredId, delivery: 'steer' }),
    ).rejects.toMatchObject({ code: 'PENDING_NOT_EDITABLE', data: { status: 'held' } });
    await h.manager.updatePending({
      sessionId: id,
      pendingId: steeredId,
      content: text('steered, edited'),
    });

    const resumed = await h.manager.resumePending(id);
    expect(resumed.map((p) => p.status)).toEqual(['waiting']);
    await vi.waitFor(() => expect(ofType(h, id, 'turn.finished')).toHaveLength(3), {
      timeout: 3000,
      interval: 5,
    });
    await waitForState(h, id, 'idle');
    expect(userMessages(h, id)).toEqual(['please approve', 'queued', 'steered, edited']);
  });

  it('停止过程中发的消息不暂停：取消结算后发出；之前排队的暂停', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const before = await deliver(h, id, 'before stop', 'queue');
    const cancel = h.adapter.cancel.bind(h.adapter);
    vi.spyOn(h.adapter, 'cancel').mockImplementationOnce(async (engineSessionId) => {
      await delay(40);
      await cancel(engineSessionId);
    });
    const cancelling = h.manager.cancel(id);
    await waitForState(h, id, 'cancelling');
    const during = await deliver(h, id, 'after stop', 'steer');
    expect(
      h.events.pending(id, during.pendingId as NonNullable<typeof during.pendingId>),
    ).toMatchObject({ delivery: 'queue', status: 'waiting', fallback: { reason: 'turn_ended' } });
    await cancelling;
    await vi.waitFor(() => expect(userMessages(h, id)).toEqual(['please approve', 'after stop']), {
      timeout: 2000,
      interval: 5,
    });
    await waitForState(h, id, 'idle');
    expect(snapshot(h, id).pendingMessages).toEqual([
      expect.objectContaining({ id: before.pendingId, status: 'held' }),
    ]);
  });

  it('停止过程中继续发送暂停的消息：取消结算后照常发出，不再暂停', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    await deliver(h, id, 'held one', 'queue');
    await h.manager.cancel(id);
    expect(snapshot(h, id).pendingMessages?.map((p) => p.status)).toEqual(['held']);

    await send(h, id, 'please approve again');
    await waitForApproval(h, id);
    const cancel = h.adapter.cancel.bind(h.adapter);
    vi.spyOn(h.adapter, 'cancel').mockImplementationOnce(async (engineSessionId) => {
      await delay(40);
      await cancel(engineSessionId);
    });
    const cancelling = h.manager.cancel(id);
    await waitForState(h, id, 'cancelling');
    await h.manager.resumePending(id);
    await cancelling;
    await vi.waitFor(
      () =>
        expect(userMessages(h, id)).toEqual(['please approve', 'please approve again', 'held one']),
      { timeout: 2000, interval: 5 },
    );
    await waitForState(h, id, 'idle');
    expect(snapshot(h, id).pendingMessages).toBeUndefined();
  });

  it('引擎退出：等待中的暂停；会话 error 时不能继续发送，resume 之后继续发送', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    await deliver(h, id, 'after crash', 'queue');
    await h.adapter.simulateEngineExit();
    await waitForState(h, id, 'error');
    expect(snapshot(h, id).pendingMessages?.map((p) => p.status)).toEqual(['held']);
    await expect(h.manager.resumePending(id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      data: { state: 'error' },
    });
    await h.manager.resume(id);
    await h.manager.resumePending(id);
    await waitForState(h, id, 'idle');
    expect(userMessages(h, id)).toEqual(['please approve', 'after crash']);
  });

  it('取消待发消息；已取消的再取消无操作、再编辑报错；不存在的报 PENDING_NOT_FOUND', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const { pendingId } = await deliver(h, id, 'never mind', 'queue');
    const pid = pendingId as NonNullable<typeof pendingId>;
    expect(h.manager.cancelPending({ sessionId: id, pendingId: pid })).toMatchObject({
      status: 'cancelled',
    });
    expect(h.manager.cancelPending({ sessionId: id, pendingId: pid })).toMatchObject({
      status: 'cancelled',
    });
    expect(ofType(h, id, 'pending.updated')).toHaveLength(1);
    await expect(
      h.manager.updatePending({ sessionId: id, pendingId: pid, content: text('x') }),
    ).rejects.toMatchObject({ code: 'PENDING_NOT_EDITABLE', data: { status: 'cancelled' } });
    expect(() =>
      h.manager.cancelPending({ sessionId: id, pendingId: 'pnd_01JA2B3C4D5E6F7G8H9JKMNPQR' }),
    ).toThrow(expect.objectContaining({ code: 'PENDING_NOT_FOUND' }));
    await approve(h, id);
    await waitForState(h, id, 'idle');
    await delay(20);
    expect(userMessages(h, id)).toEqual(['please approve']);
  });

  it('排队的改成插话：回合进行中交给引擎，之后进了回合', async () => {
    const h = setup();
    const id = await create(h);
    const { turnId } = await send(h, id, 'please approve');
    await waitForApproval(h, id);
    const { pendingId } = await deliver(h, id, 'switch me', 'queue');
    const pid = pendingId as NonNullable<typeof pendingId>;
    expect(
      await h.manager.updatePending({ sessionId: id, pendingId: pid, delivery: 'steer' }),
    ).toMatchObject({ delivery: 'steer', status: 'waiting' });
    await approve(h, id);
    await waitForState(h, id, 'idle');
    expect(turnStory(h, id, turnId)).toEqual([
      'Echo: please approve',
      'steer:switch me',
      'Echo: switch me',
    ]);
  });

  it('Host 重启：待发消息还在，一律暂停', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'please approve');
    await waitForApproval(h, id);
    await deliver(h, id, 'survive restart', 'queue');
    // 引擎还是同一个（会话仍在），继续发送时自动 resume。
    const { h: h2 } = restart(h, h.adapter);
    expect(state(h2, id)).toBe('idle');
    expect(snapshot(h2, id).pendingMessages).toEqual([
      expect.objectContaining({ status: 'held', content: text('survive restart') }),
    ]);
    // 真实的引擎随 Host 一起没了；这里的引擎还挂着那个等审批的回合，先停掉它。
    await h2.adapter.cancel(snapshot(h2, id).session.engine.sessionId);
    await h2.manager.resumePending(id);
    await waitForState(h2, id, 'idle');
    expect(userMessages(h2, id)).toEqual(['please approve', 'survive restart']);
  });
});

describe('SessionManager：Codex 引擎的事件（R3）', () => {
  it('审批详情取工具最新的输入：请求之前的 tool.updated（带理由）覆盖 tool.started 的输入', async () => {
    const h = setup();
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementation((engineSessionId) =>
      justifyBeforeApproval(subscribe(engineSessionId)),
    );
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    expect(approval.detail).toMatchObject({
      toolName: 'echo_write',
      input: { file_path: '/outside-workspace/echo.txt', justification: '要写工作区外的文件' },
      justification: '要写工作区外的文件',
    });
    await h.manager.cancel(id);
  });

  it('engine.raw 原样写下引擎的协议（codex-app-server）', async () => {
    const h = setup();
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementation((engineSessionId) =>
      withCodexRaw(subscribe(engineSessionId), engineSessionId),
    );
    const id = await create(h);
    await send(h, id, 'hello');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'engine.raw').map((e) => e.payload)).toEqual([
      { protocol: 'codex-app-server', method: 'turn/diff/updated', params: { diff: '' } },
    ]);
  });
});

describe('SessionManager：自动压缩降不下用量时停下回合', () => {
  /**
   * 停在审批上的回合（不靠计时，各平台一样），测试往它的事件流里注入用量与压缩：引擎这时不发别的事件，注入的按顺序处理。
   */
  async function parked() {
    const injected = new EventHub<AgentEvent>();
    const h = setup();
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementation((engineSessionId) =>
      withInjected(subscribe(engineSessionId), injected, engineSessionId),
    );
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    const engineSessionId = h.storage.sessions.get(id)?.engineSessionId as string;
    let compactions = 0;
    let usages = 0;
    /** `autoCompactAt` 为 null：引擎这次不报压缩线。 */
    const usage = (contextUsed: number, autoCompactAt: number | null = 115_200) => {
      usages += 1;
      injected.emit({
        type: 'usage.updated',
        engineSessionId,
        contextUsed,
        contextSize: 128_000,
        ...(autoCompactAt !== null && { autoCompactAt }),
      });
    };
    const compacted = (trigger: 'auto' | 'manual' = 'auto') => {
      compactions += 1;
      const compactionId = `compact_${compactions}`;
      injected.emit({ type: 'context.compacting', engineSessionId, compactionId, trigger });
      injected.emit({ type: 'context.compacted', engineSessionId, compactionId, trigger });
    };
    /** 等 Host 处理完注入的全部用量与压缩。 */
    const processed = () =>
      vi.waitFor(() => {
        expect(ofType(h, id, 'context.compacted')).toHaveLength(compactions);
        expect(ofType(h, id, 'usage.updated')).toHaveLength(usages);
      });
    return { h, id, approval, usage, compacted, processed };
  }

  it('连续两次自动压缩之后用量仍在压缩线以上：说明原因并取消回合', async () => {
    const { h, id, approval, usage, compacted, processed } = await parked();
    // 像 Codex：请求的用量过线 → 压缩（期间是压缩请求与估算的用量）→ 下一个请求的用量。
    usage(124_000);
    compacted();
    usage(124_500);
    compacted();
    usage(124_300);
    await processed();
    await waitForState(h, id, 'idle');
    const [error] = ofType(h, id, 'engine.error');
    expect(error?.payload).toMatchObject({ category: 'provider', fatal: false });
    expect(error?.payload.turnId).toBe(approval.turnId);
    expect(error?.payload.message).toMatch(
      /^Stopped the turn: after 2 automatic context compactions in a row the model service still reported 124300 tokens in use, at or above the compaction threshold of 115200 for a 128000-token context window/,
    );
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('cancelled');
    expect(transitions(h, id)).toContain('awaiting_approval→cancelling:cancel_requested');
    expect(ofType(h, id, 'approval.resolved')[0]?.payload.status).toBe('cancelled');
  });

  it('压缩管用（之后用量降到线下）、手动压缩、不报压缩线时都不停', async () => {
    const { h, id, approval, usage, compacted, processed } = await parked();
    usage(124_000);
    compacted();
    usage(124_000);
    // 降下来了：重新计数。
    compacted();
    usage(30_000);
    compacted();
    usage(124_000);
    // 手动压缩不算。
    compacted('manual');
    usage(124_000);
    // 引擎这次不报压缩线：不算。
    compacted();
    usage(124_000, null);
    compacted();
    usage(124_000);
    await processed();
    expect(ofType(h, id, 'engine.error')).toEqual([]);
    expect(state(h, id)).toBe('awaiting_approval');
    await h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, desktop);
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('completed');
  });
});

describe('SessionManager：子会话（R4）', () => {
  /** 父会话的唯一一个子会话。 */
  async function childOf(h: Harness, parent: SessionId): Promise<SessionId> {
    let child: SessionId | undefined;
    await vi.waitFor(
      () => {
        const records = h.storage.sessions.list({ parentSessionId: parent });
        expect(records).toHaveLength(1);
        child = records[0]?.id as SessionId;
      },
      { timeout: 2000, interval: 5 },
    );
    return child as SessionId;
  }

  function summaries(h: Harness, parent: SessionId) {
    return snapshot(h, parent).subagents ?? [];
  }

  it('C1 C2：父回合派出子会话，子会话有自己的事件流，父会话的摘要跟着它的状态', async () => {
    const h = setup();
    const parent = await create(h);
    const { turnId } = await send(h, parent, 'subagent');
    await waitForState(h, parent, 'idle');
    const child = await childOf(h, parent);
    await waitForState(h, child, 'idle');

    const spawn = ofType(h, parent, 'tool.started').find(
      (e) => e.payload.toolName === 'spawn_agent',
    );
    const [started] = ofType(h, parent, 'subagent.started');
    expect(started?.payload.subagent).toMatchObject({
      sessionId: child,
      parentToolCallId: spawn?.payload.toolCallId,
      parentTurnId: turnId,
      title: 'Helper task: helper',
      modelId: 'deepseek-chat',
      nickname: 'Echo helper',
      status: 'running',
      pendingApprovals: [],
    });
    // 子会话：session.created 带 parent，兜底标题，回合由引擎开始、带输入。
    expect(typesAfter(h, child, 0)).toEqual([
      'session.created',
      'session.title_changed',
      'turn.started',
      'session.state_changed',
      'assistant.delta*',
      'assistant.stream_ended',
      'assistant.message',
      'usage.updated',
      'turn.finished',
      'session.state_changed',
    ]);
    expect(ofType(h, child, 'session.created')[0]?.payload.parent).toEqual({
      sessionId: parent,
      toolCallId: spawn?.payload.toolCallId,
      turnId,
    });
    expect(ofType(h, child, 'turn.started')[0]?.payload.input).toEqual(text('Helper task: helper'));
    expect(transitions(h, child)).toEqual([
      'idle→running:turn_started',
      'running→idle:turn_finished',
    ]);

    const session = snapshot(h, child).session;
    expect(session).toMatchObject({
      parentSessionId: parent,
      title: 'Helper task: helper',
      subagent: {
        parentToolCallId: spawn?.payload.toolCallId,
        parentTurnId: turnId,
        status: 'completed',
      },
    });
    expect(session.subagent?.endedAt).toEqual(expect.any(String));
    expect(summaries(h, parent)).toEqual([
      expect.objectContaining({
        sessionId: child,
        status: 'completed',
        endedAt: session.subagent?.endedAt,
      }),
    ]);
    // 父会话的状态与回合不受影响；父会话列表不含子会话。
    expect(transitions(h, parent)).toEqual([
      'idle→running:turn_started',
      'running→idle:turn_finished',
    ]);
    expect(h.storage.sessions.list().map((record) => record.id)).toEqual([parent]);
  });

  it('子会话只读：send、close、resume 都是 INVALID_STATE，带上父会话；空闲时 cancel 是无操作', async () => {
    const h = setup();
    const parent = await create(h);
    await send(h, parent, 'subagent');
    const child = await childOf(h, parent);
    await waitForState(h, parent, 'idle');
    const invalid = { code: 'INVALID_STATE', data: { parentSessionId: parent } };
    await expect(send(h, child, 'hi')).rejects.toMatchObject(invalid);
    await expect(h.manager.cancel(child)).resolves.toBeUndefined();
    await expect(h.manager.close(child)).rejects.toMatchObject(invalid);
    await expect(h.manager.resume(child)).rejects.toMatchObject(invalid);
  });

  it('单独停掉一个子会话（0.14.0）：子回合取消、摘要 cancelled，父会话照常结束，适配器带 notifyParent', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const cancel = vi.spyOn(adapter, 'cancel');
    const h = setup({ adapter });
    const parent = await create(h);
    await send(h, parent, 'subagent approve');
    const child = await childOf(h, parent);
    await waitForApproval(h, child);
    await h.manager.cancel(child);
    expect(state(h, child)).toBe('idle');
    expect(ofType(h, child, 'turn.finished').at(-1)?.payload).toMatchObject({
      outcome: 'cancelled',
    });
    expect(ofType(h, child, 'approval.resolved')[0]?.payload).toMatchObject({
      status: 'cancelled',
    });
    const childEngine = cancel.mock.calls.at(-1)?.[0];
    expect(cancel.mock.calls.at(-1)?.[1]).toEqual({ notifyParent: true });
    await waitForState(h, parent, 'idle');
    expect(summaries(h, parent)[0]).toMatchObject({ sessionId: child, status: 'cancelled' });
    expect(ofType(h, parent, 'turn.finished').at(-1)?.payload).toMatchObject({
      outcome: 'completed',
    });
    // 父会话自己的取消不带 notifyParent。
    expect(
      cancel.mock.calls.filter(([id]) => id !== childEngine).every(([, o]) => o === undefined),
    ).toBe(true);
  });

  it('子会话的审批：属于子会话，父会话的摘要带着它，任何连接都能回', async () => {
    const h = setup();
    const parent = await create(h);
    await send(h, parent, 'subagent approve');
    const child = await childOf(h, parent);
    const approval = await waitForApproval(h, child);
    expect(approval.sessionId).toBe(child);
    // 父会话不进 awaiting_approval，它的摘要带着子会话的未决审批。
    expect(state(h, parent)).toBe('running');
    expect(snapshot(h, parent).pendingApprovals).toEqual([]);
    expect(summaries(h, parent)[0]?.pendingApprovals).toEqual([approval]);
    expect(ofType(h, parent, 'approval.requested')).toEqual([]);

    await h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, desktop);
    await waitForState(h, parent, 'idle');
    await waitForState(h, child, 'idle');
    expect(ofType(h, child, 'approval.resolved')[0]?.payload).toMatchObject({
      status: 'approved',
      resolution: { decidedBy: desktop },
    });
    expect(summaries(h, parent)[0]).toMatchObject({ status: 'completed', pendingApprovals: [] });
    // 父会话的流里，摘要先带上审批、再随结算去掉。
    const counts = ofType(h, parent, 'subagent.updated').map(
      (e) => e.payload.subagent.pendingApprovals.length,
    );
    expect(counts).toContain(1);
    expect(counts.at(-1)).toBe(0);
  });

  it('C3：取消父会话时级联取消活动中的子会话（Codex 自己不级联）', async () => {
    const h = setup();
    const parent = await create(h);
    await send(h, parent, 'subagent approve');
    const child = await childOf(h, parent);
    const approval = await waitForApproval(h, child);

    await h.manager.cancel(parent);
    await waitForState(h, child, 'idle');
    expect(state(h, parent)).toBe('idle');
    expect(ofType(h, parent, 'turn.finished').at(-1)?.payload.outcome).toBe('cancelled');
    expect(ofType(h, child, 'approval.resolved')[0]?.payload).toMatchObject({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'turn_cancelled' },
    });
    expect(ofType(h, child, 'turn.finished').at(-1)?.payload.outcome).toBe('cancelled');
    expect(transitions(h, child)).toEqual([
      'idle→running:turn_started',
      'running→awaiting_approval:approval_requested',
      'awaiting_approval→cancelling:cancel_requested',
      'cancelling→idle:turn_finished',
    ]);
    expect(summaries(h, parent)[0]).toMatchObject({ status: 'cancelled', pendingApprovals: [] });
  });

  it('C4：父 agent 关掉子会话；关闭父会话时子会话不随之关闭', async () => {
    const h = setup();
    const parent = await create(h);
    await send(h, parent, 'subagent close');
    await waitForState(h, parent, 'idle');
    const child = await childOf(h, parent);
    await waitForState(h, child, 'closed');
    expect(transitions(h, child).at(-1)).toBe('idle→closed:closed');
    expect(snapshot(h, child).session.subagent?.status).toBe('closed');
    expect(summaries(h, parent)[0]?.status).toBe('closed');

    const h2 = setup();
    const parent2 = await create(h2);
    await send(h2, parent2, 'subagent');
    await waitForState(h2, parent2, 'idle');
    const child2 = await childOf(h2, parent2);
    await waitForState(h2, child2, 'idle');
    await h2.manager.close(parent2);
    expect(state(h2, parent2)).toBe('closed');
    expect(state(h2, child2)).toBe('idle');
  });

  it('C4：父 agent 关掉进行中的子会话：先结掉审批与回合，再关闭；晚到的标题与昵称进摘要', async () => {
    const injected = new EventHub<AgentEvent>();
    const h = setup();
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementation((engineSessionId) =>
      withInjected(subscribe(engineSessionId), injected, engineSessionId),
    );
    const parent = await create(h);
    await send(h, parent, 'subagent approve');
    const child = await childOf(h, parent);
    const approval = await waitForApproval(h, child);
    const engineParent = h.storage.sessions.get(parent)?.engineSessionId as string;
    const engineChild = h.storage.sessions.get(child)?.engineSessionId as string;

    // 引擎晚报的名称与昵称（Codex：thread/read、thread/name/updated）。
    injected.emit({
      type: 'subagent.updated',
      engineSessionId: engineParent,
      childEngineSessionId: engineChild,
      title: 'Codex 给的名称',
      nickname: 'Kuhn',
      role: 'worker',
    });
    await vi.waitFor(() =>
      expect(summaries(h, parent)[0]).toMatchObject({
        title: 'Codex 给的名称',
        nickname: 'Kuhn',
        role: 'worker',
      }),
    );
    expect(snapshot(h, child).session).toMatchObject({
      title: 'Codex 给的名称',
      titleSource: 'first_prompt',
    });

    // 父 agent 在子会话等审批时关掉它（Codex 的 close_agent）。
    injected.emit({
      type: 'subagent.updated',
      engineSessionId: engineParent,
      childEngineSessionId: engineChild,
      closed: true,
    });
    await waitForState(h, child, 'closed');
    expect(ofType(h, child, 'approval.resolved')[0]?.payload).toMatchObject({
      approvalId: approval.id,
      status: 'cancelled',
      resolution: { reason: 'session_closed' },
    });
    expect(ofType(h, child, 'turn.finished').at(-1)?.payload.outcome).toBe('cancelled');
    expect(transitions(h, child).slice(-3)).toEqual([
      'awaiting_approval→running:approvals_settled',
      'running→idle:turn_finished',
      'idle→closed:closed',
    ]);
    expect(summaries(h, parent)[0]).toMatchObject({ status: 'closed', pendingApprovals: [] });
    // 收尾：父回合还在等子 agent（echo 的子会话没被真的停下），取消它。
    await h.manager.cancel(parent);
  });

  it('Host 重启：进行中的子会话按 #15 回到 idle（状态 failed），父会话的摘要跟着变，历史照常可读', async () => {
    const first = setup();
    const parent = await create(first);
    await send(first, parent, 'subagent approve');
    const child = await childOf(first, parent);
    await waitForApproval(first, child);

    const { h, report } = restart(first);
    expect(report.interruptedSessions.sort()).toEqual([parent, child].sort());
    expect(state(h, child)).toBe('idle');
    expect(snapshot(h, child).session.subagent?.status).toBe('failed');
    expect(summaries(h, parent)[0]).toMatchObject({ status: 'failed', pendingApprovals: [] });
    expect(all(h, child).length).toBeGreaterThan(5);
    await expect(send(h, child, 'hi')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('SessionManager：其他', () => {
  it('dispose 之后的调用返回 HOST_SHUTTING_DOWN', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.dispose();
    await expect(send(h, id, 'hi')).rejects.toMatchObject({ code: 'HOST_SHUTTING_DOWN' });
  });

  it('引擎的 usage.recorded 交给 onUsage，带会话此刻的 Provider 与模型，不写事件流', async () => {
    const injected = new EventHub<AgentEvent>();
    const onUsage = vi.fn();
    const h = setup({ manager: { onUsage } });
    const subscribe = h.adapter.subscribe.bind(h.adapter);
    vi.spyOn(h.adapter, 'subscribe').mockImplementation((engineSessionId) =>
      withInjected(subscribe(engineSessionId), injected, engineSessionId),
    );
    const id = await create(h);
    const engineSessionId = h.storage.sessions.get(id)?.engineSessionId as string;
    const event: AgentEvent = {
      type: 'usage.recorded',
      engineSessionId,
      requestId: 'msg_1',
      inputTokens: 3,
      outputTokens: 7,
    };
    injected.emit(event);
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1));
    expect(onUsage).toHaveBeenCalledWith(
      { sessionId: id, providerId: 'deepseek-official', modelId: 'deepseek-chat' },
      event,
    );
    expect(all(h, id).map((e) => e.type)).not.toContain('usage.recorded');
  });

  it('上面的用例走过了 domain-model §4.1 的每一条状态转换', () => {
    const expected = SESSION_TRANSITIONS.flatMap((t) =>
      t.from.map((from) => `${from}→${t.to}:${t.reason}`),
    );
    expect(expected.filter((t) => !seenTransitions.has(t))).toEqual([]);
  });
});

describe('SessionManager：重连进度与额度恢复后自动继续（0.119.0）', () => {
  it('引擎重试请求：turn.retrying 带次数与原因，回合照常完成', async () => {
    const h = setup();
    const id = await create(h);
    await send(h, id, 'reconnect please');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'turn.retrying').map((e) => e.payload)).toEqual(
      [1, 2, 3].map((attempt) => ({
        turnId: expect.stringMatching(/^trn_/),
        attempt,
        maxAttempts: 5,
        reason: expect.stringContaining('stream disconnected'),
      })),
    );
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('completed');
  });

  it('用量上限：engine.error 带 usageLimit；打开后到点替用户发继续消息，引擎看到原文', async () => {
    // 时钟拨到重置之后，重置后不再等：一打开就到点。
    const h = setup({
      manager: { autoContinue: { now: () => Date.now() + 120_000, delayMs: 0 } },
    });
    const id = await create(h);
    const turnId = turnOf(await send(h, id, 'hitlimit'));
    await waitForState(h, id, 'idle');
    const [error] = ofType(h, id, 'engine.error');
    expect(error?.payload).toMatchObject({
      category: 'provider',
      turnId,
      fatal: false,
      usageLimit: { resetsAt: expect.any(String), windowMinutes: 300 },
    });
    const { session } = await h.manager.setAutoContinue({ sessionId: id, turnId, enabled: true });
    expect(session.autoContinue).toEqual({ turnId, resumeAt: expect.any(String) });
    await vi.waitFor(() => expect(ofType(h, id, 'turn.finished')).toHaveLength(2), {
      timeout: 2000,
      interval: 5,
    });
    const resumed = ofType(h, id, 'user.message')[1]?.payload;
    expect(resumed?.from).toEqual({ sessionId: id, kind: 'report', usageLimit: { turnId } });
    expect(resumed?.content).toEqual(
      text(
        'I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.',
      ),
    );
    // 不包信封：echo 原样回出这句。
    expect(ofType(h, id, 'assistant.message').at(-1)?.payload.text).toBe(
      'Echo: I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.',
    );
    expect(snapshot(h, id).session.autoContinue).toBeUndefined();
  });

  it('关掉、发了新消息都作废；没碰到上限的回合、过了一天才重置的打不开', async () => {
    const h = setup();
    const id = await create(h);
    const turnId = turnOf(await send(h, id, 'hitlimit'));
    await waitForState(h, id, 'idle');
    await h.manager.setAutoContinue({ sessionId: id, turnId, enabled: true });
    const off = await h.manager.setAutoContinue({ sessionId: id, turnId, enabled: false });
    expect(off.session.autoContinue).toBeUndefined();
    expect(ofType(h, id, 'session.auto_continue').map((e) => e.payload.resumeAt === null)).toEqual([
      false,
      true,
    ]);

    await h.manager.setAutoContinue({ sessionId: id, turnId, enabled: true });
    const next = turnOf(await send(h, id, 'hello'));
    await waitForState(h, id, 'idle');
    expect(snapshot(h, id).session.autoContinue).toBeUndefined();
    await expect(
      h.manager.setAutoContinue({ sessionId: id, turnId: next, enabled: true }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      h.manager.setAutoContinue({ sessionId: id, turnId, enabled: true }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const far = setup({
      manager: { autoContinue: { now: () => Date.now() - 2 * 24 * 60 * 60 * 1000 } },
    });
    const farId = await create(far);
    const limited = turnOf(await send(far, farId, 'hitlimit'));
    await waitForState(far, farId, 'idle');
    await expect(
      far.manager.setAutoContinue({ sessionId: farId, turnId: limited, enabled: true }),
    ).rejects.toThrow(/more than a day away/);
  });
});

describe('换模型继续（0.143.0）', () => {
  const PROMPT =
    'I hit my usage limit while you were working, so I switched to a different model. Please continue from where you left off.';

  it('同一来源换模型：取消排着的自动继续，换模型后替用户发继续消息', async () => {
    const h = setup();
    const id = await create(h);
    const turnId = turnOf(await send(h, id, 'hitlimit'));
    await waitForState(h, id, 'idle');
    await h.manager.setAutoContinue({ sessionId: id, turnId, enabled: true });
    const result = await h.manager.continueWithModel(
      { sessionId: id, turnId, modelId: 'deepseek-reasoner', reasoningEffort: 'high' },
      cli,
    );
    expect(result.session).toMatchObject({ modelId: 'deepseek-reasoner', reasoningEffort: 'high' });
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'session.auto_continue').map((e) => e.payload.resumeAt === null)).toEqual([
      false,
      true,
    ]);
    const types = all(h, id)
      .map((e) => e.type)
      .filter((type) =>
        ['session.auto_continue', 'session.configured', 'turn.started'].includes(type),
      );
    expect(types).toEqual([
      'turn.started',
      'session.auto_continue',
      'session.auto_continue',
      'session.configured',
      'turn.started',
    ]);
    const resumed = ofType(h, id, 'user.message')[1];
    expect(resumed?.payload.turnId).toBe(result.turnId);
    expect(resumed?.payload.from).toEqual({
      sessionId: id,
      kind: 'report',
      usageLimit: { turnId },
    });
    expect(resumed?.payload.content).toEqual(text(PROMPT));
    expect(resumed?.payload.sentBy).toEqual(cli);
    expect(ofType(h, id, 'assistant.message').at(-1)?.payload.text).toBe(`Echo: ${PROMPT}`);
    expect(snapshot(h, id).session.autoContinue).toBeUndefined();
    expect(ofType(h, id, 'user.message')).toHaveLength(2);
  });

  it('没换模型、回合不是用量上限的最后一个回合时不换也不发', async () => {
    const h = setup();
    const id = await create(h);
    const turnId = turnOf(await send(h, id, 'hitlimit'));
    await waitForState(h, id, 'idle');
    await expect(
      h.manager.continueWithModel({ sessionId: id, turnId, modelId: 'deepseek-chat' }, cli),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(h.manager.continueWithModel({ sessionId: id, turnId }, cli)).rejects.toMatchObject(
      { code: 'INVALID_PARAMS' },
    );
    const next = turnOf(await send(h, id, 'hello'));
    await waitForState(h, id, 'idle');
    for (const target of [turnId, next]) {
      await expect(
        h.manager.continueWithModel(
          { sessionId: id, turnId: target, modelId: 'deepseek-reasoner' },
          cli,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    expect(ofType(h, id, 'session.configured')).toHaveLength(0);
    expect(ofType(h, id, 'user.message')).toHaveLength(2);
  });
});

// ── 测试用的事件流 ────────────────────────────────────────────────────

async function* breakAfter(source: AsyncIterable<AgentEvent>, count: number) {
  let seen = 0;
  for await (const event of source) {
    yield event;
    seen += 1;
    if (seen >= count) throw new Error('pipe broken');
  }
}

function endImmediately(): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  };
}

async function* dropToolFinished(source: AsyncIterable<AgentEvent>) {
  for await (const event of source) {
    if (event.type !== 'tool.finished') yield event;
  }
}

/** 审批请求之前插一条 tool.updated，输入带上理由（adapter-codex 的做法，codex-event-mapping.md §6.6）。 */
async function* justifyBeforeApproval(source: AsyncIterable<AgentEvent>) {
  const inputs = new Map<string, unknown>();
  for await (const event of source) {
    if (event.type === 'tool.started') inputs.set(event.toolCallId, event.input);
    if (event.type === 'approval.requested') {
      yield {
        type: 'tool.updated',
        engineSessionId: event.engineSessionId,
        toolCallId: event.toolCallId,
        input: {
          ...(inputs.get(event.toolCallId) as Record<string, unknown>),
          justification: '要写工作区外的文件',
        },
      } satisfies AgentEvent;
    }
    yield event;
  }
}

/** 把测试注入的事件并进引擎的事件流（只收 `engineSessionId` 是这个会话的）。 */
async function* withInjected(
  source: AsyncIterable<AgentEvent>,
  injected: EventHub<AgentEvent>,
  engineSessionId: string,
): AsyncIterable<AgentEvent> {
  const engine = source[Symbol.asyncIterator]();
  const extra = injected.subscribe();
  let fromEngine = engine.next();
  let fromTest = extra.next();
  for (;;) {
    const next = await Promise.race([
      fromEngine.then((result) => ({ engine: true, result })),
      fromTest.then((result) => ({ engine: false, result })),
    ]);
    if (next.engine) {
      if (next.result.done) return;
      yield next.result.value;
      fromEngine = engine.next();
    } else {
      if (!next.result.done && next.result.value.engineSessionId === engineSessionId) {
        yield next.result.value;
      }
      fromTest = extra.next();
    }
  }
}

/** 回合结束之前插一条 Codex 的 engine.raw。 */
async function* withCodexRaw(source: AsyncIterable<AgentEvent>, engineSessionId: string) {
  for await (const event of source) {
    if (event.type === 'turn.settled') {
      yield {
        type: 'engine.raw',
        engineSessionId,
        protocol: 'codex-app-server',
        method: 'turn/diff/updated',
        params: { diff: '' },
      } satisfies AgentEvent;
    }
    yield event;
  }
}

describe('SessionManager：换模型与推理档位（0.9.0）', () => {
  it('交给引擎再写 session.configured；快照与 sessions 表跟着变；值没变不写', async () => {
    const h = setup();
    const id = await create(h);
    const spy = vi.spyOn(h.adapter, 'configureSession');

    const session = await h.manager.configure({
      sessionId: id,
      modelId: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
    expect(session).toMatchObject({ modelId: 'deepseek-v4-pro', reasoningEffort: 'high' });
    expect(spy).toHaveBeenCalledWith(session.engine.sessionId, {
      modelId: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      permissionMode: 'on_request',
    });
    expect(ofType(h, id, 'session.configured').map((e) => e.payload)).toEqual([
      { modelId: 'deepseek-v4-pro', reasoningEffort: 'high', permissionMode: 'on_request' },
    ]);
    expect(h.storage.sessions.get(id)).toMatchObject({
      modelId: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });

    await h.manager.configure({ sessionId: id, reasoningEffort: 'high' });
    expect(ofType(h, id, 'session.configured')).toHaveLength(1);

    // 只给档位：模型不变；null 清掉档位。
    await h.manager.configure({ sessionId: id, reasoningEffort: 'max' });
    const cleared = await h.manager.configure({ sessionId: id, reasoningEffort: null });
    expect(cleared.modelId).toBe('deepseek-v4-pro');
    expect(cleared.reasoningEffort).toBeUndefined();
    expect(h.storage.sessions.get(id)?.reasoningEffort).toBeUndefined();
  });

  it('换了模型而没给档位时清掉档位；回合进行中也能换，下一个回合起生效', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 30 }) });
    const { id } = await h.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      reasoningEffort: 'high',
    });
    await send(h, id, 'slow');
    expect(state(h, id)).toBe('running');
    const session = await h.manager.configure({ sessionId: id, modelId: 'deepseek-flash' });
    expect(session).toMatchObject({ modelId: 'deepseek-flash', state: 'running' });
    expect(session.reasoningEffort).toBeUndefined();
    await waitForState(h, id, 'idle');
  });

  it('Host 重启后引擎会话没挂上：只记下新值，resume 时交给引擎', async () => {
    const first = setup();
    const id = await create(first);
    const { h } = restart(first);
    const spy = vi.spyOn(h.adapter, 'configureSession');
    const session = await h.manager.configure({ sessionId: id, modelId: 'deepseek-v4-pro' });
    expect(session.modelId).toBe('deepseek-v4-pro');
    expect(spy).not.toHaveBeenCalled();
    expect(h.storage.sessions.get(id)?.modelId).toBe('deepseek-v4-pro');
  });

  it('Provider 列了模型时只能在其中换；引擎不支持时回 ENGINE_ERROR', async () => {
    const h = setup();
    h.storage.providers.insert({
      id: 'local',
      kind: 'openai-compatible',
      displayName: 'Local',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'a' }, { id: 'b' }],
      defaultModelId: 'a',
      createdAt: T0,
      updatedAt: T0,
    });
    const { id } = await h.manager.create({ workspaceId: 'ws_1', providerId: 'local' });
    await expect(h.manager.configure({ sessionId: id, modelId: 'c' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect((await h.manager.configure({ sessionId: id, modelId: 'b' })).modelId).toBe('b');

    const adapter = new EchoAdapter({ stepDelayMs: 1 });
    Object.defineProperty(adapter, 'configureSession', { value: undefined });
    const other = setup({ adapter });
    const otherId = await create(other);
    await expect(
      other.manager.configure({ sessionId: otherId, modelId: 'x' }),
    ).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
  });
});

describe('SessionManager：权限模式（0.11.0）', () => {
  it('建会话时交给引擎、写进 session.created 与 sessions 表；省略时是 on_request', async () => {
    const h = setup();
    const spy = vi.spyOn(h.adapter, 'createSession');
    const { id } = await h.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      permissionMode: 'full_access',
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ permissionMode: 'full_access' });
    expect(ofType(h, id, 'session.created')[0]?.payload).toMatchObject({
      permissionMode: 'full_access',
    });
    expect(h.storage.sessions.get(id)?.permissionMode).toBe('full_access');
    expect(snapshot(h, id).session.permissionMode).toBe('full_access');

    const plain = await create(h);
    expect(snapshot(h, plain).session.permissionMode).toBe('on_request');
  });

  it('完全访问下不再请求审批；换回请求批准后下一个回合照常请求', async () => {
    const h = setup();
    const { id } = await h.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      permissionMode: 'full_access',
    });
    await send(h, id, 'please approve');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'approval.requested')).toHaveLength(0);

    const session = await h.manager.configure({ sessionId: id, permissionMode: 'on_request' });
    expect(session.permissionMode).toBe('on_request');
    expect(ofType(h, id, 'session.configured').map((e) => e.payload)).toEqual([
      { modelId: session.modelId, permissionMode: 'on_request' },
    ]);
    expect(h.storage.sessions.get(id)?.permissionMode).toBe('on_request');
    await send(h, id, 'please approve again');
    await waitForApproval(h, id);
  });

  it('只给权限模式时模型与档位不变；值没变不写；重启后 resume 带上记下的模式', async () => {
    const first = setup();
    const { id } = await first.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      reasoningEffort: 'high',
    });
    const session = await first.manager.configure({ sessionId: id, permissionMode: 'auto_review' });
    expect(session).toMatchObject({ reasoningEffort: 'high', permissionMode: 'auto_review' });
    await first.manager.configure({ sessionId: id, permissionMode: 'auto_review' });
    expect(ofType(first, id, 'session.configured')).toHaveLength(1);

    const { h } = restart(first);
    const spy = vi.spyOn(h.adapter, 'resumeSession');
    // 新的 echo 不认识这个引擎会话（恢复失败），这里只看 Host 交给它的配置。
    await send(h, id, 'hello').catch(() => {});
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ permissionMode: 'auto_review' });
  });

  it('引擎不支持权限模式时只接受 on_request，会话不带这个字段', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 1 });
    Object.defineProperty(adapter, 'permissionModes', { value: undefined });
    const h = setup({ adapter });
    const { id } = await h.manager.create({
      workspaceId: 'ws_1',
      providerId: 'deepseek-official',
      permissionMode: 'on_request',
    });
    expect(snapshot(h, id).session.permissionMode).toBeUndefined();
    await expect(
      h.manager.create({
        workspaceId: 'ws_1',
        providerId: 'deepseek-official',
        permissionMode: 'full_access',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.manager.configure({ sessionId: id, permissionMode: 'auto_review' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('SessionManager：向用户提问（0.10.0）', () => {
  async function ask(h: Harness, id: SessionId) {
    await send(h, id, 'ask me');
    for (let i = 0; i < 200; i += 1) {
      const pending = snapshot(h, id).pendingQuestions ?? [];
      if (pending[0]) return pending[0];
      await delay(5);
    }
    throw new Error('没有等到提问');
  }

  it('写 question.requested，会话 awaitingInput；回答后写 question.resolved 并交给引擎，回合接着做', async () => {
    const h = setup();
    const id = await create(h);
    const question = await ask(h, id);
    expect(question).toMatchObject({ sessionId: id, status: 'pending' });
    expect(question.questions.map((q) => q.id)).toEqual(['scope', 'targets']);
    expect(snapshot(h, id).session).toMatchObject({ state: 'running', awaitingInput: true });

    await expect(
      h.manager.respondToQuestion(
        { questionId: question.id, answers: { scope: { answers: ['a', 'b'] } } },
        desktop,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.manager.respondToQuestion(
        { questionId: question.id, answers: { targets: { answers: ['BeOS'] } } },
        desktop,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    const result = await h.manager.respondToQuestion(
      { questionId: question.id, answers: { scope: { answers: ['Full stack'] } } },
      desktop,
    );
    expect(result).toMatchObject({
      status: 'answered',
      resolution: {
        reason: 'user',
        answers: { scope: { answers: ['Full stack'] }, targets: { answers: [] } },
        answeredBy: desktop,
      },
    });
    await waitForState(h, id, 'idle');
    expect(snapshot(h, id).session.awaitingInput).toBeUndefined();
    const reply = ofType(h, id, 'assistant.message').at(-1)?.payload.text ?? '';
    expect(reply).toContain('Answers: scope=Full stack; targets=');

    // 再回答：返回已有的结局，不报错。
    const again = await h.manager.respondToQuestion({ questionId: question.id, answers: {} }, cli);
    expect(again).toEqual(result);
    await expect(
      h.manager.respondToQuestion({ questionId: 'qst_missing' as never, answers: {} }, cli),
    ).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
  });

  it('取消回合时未答的问题以 cancelled（turn_cancelled）结束', async () => {
    const h = setup();
    const id = await create(h);
    const question = await ask(h, id);
    await h.manager.cancel(id);
    expect(ofType(h, id, 'question.resolved').map((e) => e.payload)).toEqual([
      { questionId: question.id, status: 'cancelled', resolution: { reason: 'turn_cancelled' } },
    ]);
    expect(snapshot(h, id).pendingQuestions).toBeUndefined();
  });

  it('推荐的选项：引擎给的（要是选项之一）、标了 (Recommended) / （推荐）的，或第一个；没有选项时没有', () => {
    const options = (...labels: string[]) => labels.map((label) => ({ label }));
    const q = (extra: Partial<UserQuestion>): UserQuestion => ({
      id: 'q',
      question: '?',
      options: options('A', 'B (Recommended)', 'C'),
      ...extra,
    });
    expect(defaultOptionOf(q({}))).toBe('B (Recommended)');
    expect(defaultOptionOf(q({ defaultOption: 'C' }))).toBe('C');
    expect(defaultOptionOf(q({ defaultOption: 'Z' }))).toBe('B (Recommended)');
    expect(defaultOptionOf(q({ options: options('甲', '乙（推荐）') }))).toBe('乙（推荐）');
    expect(defaultOptionOf(q({ options: options('A', 'B') }))).toBe('A');
    expect(defaultOptionOf(q({ options: [] }))).toBeUndefined();
  });

  it('交互会话一直等，不带 autoAnswerAt；推荐的选项取引擎给的，没给时取第一个', async () => {
    const h = setup({ manager: { questionTimeoutMs: 20 } });
    const id = await create(h);
    const question = await ask(h, id);
    expect(question.autoAnswerAt).toBeUndefined();
    expect(question.questions.map((q) => q.defaultOption)).toEqual(['Full stack', 'macOS']);
    await delay(60);
    expect(snapshot(h, id).pendingQuestions).toHaveLength(1);
  });

  it('无人值守的会话：到 autoAnswerAt 没人回答，按推荐回答（timeout），回合接着做', async () => {
    const h = setup({ manager: { questionTimeoutMs: 30 } });
    const parent = await create(h);
    const { id } = await h.manager.create(
      { workspaceId: 'ws_1', providerId: 'deepseek-official' },
      { openedBy: parent },
    );
    const question = await ask(h, id);
    expect(Date.parse(question.autoAnswerAt ?? '') - Date.parse(question.createdAt)).toBe(30);
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'question.resolved').map((e) => e.payload)).toEqual([
      {
        questionId: question.id,
        status: 'answered',
        resolution: {
          reason: 'timeout',
          answers: { scope: { answers: ['Full stack'] }, targets: { answers: ['macOS'] } },
        },
      },
    ]);
    const reply = ofType(h, id, 'assistant.message').at(-1)?.payload.text ?? '';
    expect(reply).toContain('Answers: scope=Full stack; targets=macOS');
    // 超时之后再回答：返回超时的结局。
    const again = await h.manager.respondToQuestion({ questionId: question.id, answers: {} }, cli);
    expect(again.resolution.reason).toBe('timeout');
  });

  it('无人值守的会话里先回答了：不再超时', async () => {
    const h = setup({ manager: { questionTimeoutMs: 40 } });
    const { id } = await h.manager.create(
      { workspaceId: 'ws_1', providerId: 'deepseek-official' },
      { automation: { automationId: 'aut_1' as never, runId: 'arn_1' as never } },
    );
    const question = await ask(h, id);
    expect(question.autoAnswerAt).toBeDefined();
    await h.manager.respondToQuestion(
      { questionId: question.id, answers: { scope: { answers: ['UI only'] } } },
      desktop,
    );
    await waitForState(h, id, 'idle');
    await delay(80);
    expect(ofType(h, id, 'question.resolved').map((e) => e.payload.resolution.reason)).toEqual([
      'user',
    ]);
    expect(h.errors).toEqual([]);
  });

  it('Host 重启：未答的问题以 cancelled（host_restarted）结束', async () => {
    const first = setup();
    const id = await create(first);
    const question = await ask(first, id);
    const { h } = restart(first);
    expect(ofType(h, id, 'question.resolved').map((e) => e.payload)).toEqual([
      { questionId: question.id, status: 'cancelled', resolution: { reason: 'host_restarted' } },
    ]);
  });
});

describe('SessionManager：审批过期（0.105.0）', () => {
  async function unattendedSession(h: Harness): Promise<SessionId> {
    const parent = await create(h);
    const { id } = await h.manager.create(
      { workspaceId: 'ws_1', providerId: 'deepseek-official' },
      { openedBy: parent },
    );
    return id;
  }

  it('无人值守的会话：到 expiresAt 没人回，按拒绝回复引擎，审批结为 expired（timeout），回合照常结束', async () => {
    const h = setup({ manager: { approvalTimeoutMs: () => 30 } });
    const id = await unattendedSession(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    expect(Date.parse(approval.expiresAt ?? '') - Date.parse(approval.createdAt)).toBe(30);
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'approval.resolved').map((e) => e.payload)).toEqual([
      {
        approvalId: approval.id,
        status: 'expired',
        resolution: { reason: 'timeout', optionId: 'reject-once' },
      },
    ]);
    expect(ofType(h, id, 'tool.finished').at(-1)?.payload.status).toBe('failed');
    expect(ofType(h, id, 'turn.finished')[0]?.payload.outcome).toBe('completed');
    expect(transitions(h, id)).toContain('awaiting_approval→running:approvals_settled');
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, desktop),
    ).rejects.toMatchObject({
      code: 'APPROVAL_EXPIRED',
      data: { approvalId: approval.id, resolution: { reason: 'timeout' } },
    });
  });

  it('交互会话的审批不带 expiresAt，一直等', async () => {
    const h = setup({ manager: { approvalTimeoutMs: () => 20 } });
    const id = await create(h);
    await send(h, id, 'please approve');
    const approval = await waitForApproval(h, id);
    expect(approval.expiresAt).toBeUndefined();
    await delay(60);
    expect(snapshot(h, id).pendingApprovals).toHaveLength(1);
    await h.manager.cancel(id);
  });

  it('设置是 0 时不过期；改设置只影响之后的审批', async () => {
    let timeoutMs = 0;
    const h = setup({ manager: { approvalTimeoutMs: () => timeoutMs } });
    const id = await unattendedSession(h);
    await send(h, id, 'please approve');
    const first = await waitForApproval(h, id);
    expect(first.expiresAt).toBeUndefined();
    timeoutMs = 20;
    await delay(50);
    expect(snapshot(h, id).pendingApprovals).toHaveLength(1);
    await h.manager.respondToApproval({ approvalId: first.id, optionId: 'allow-once' }, desktop);
    await waitForState(h, id, 'idle');
    await send(h, id, 'please approve');
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'approval.resolved').map((e) => e.payload.status)).toEqual([
      'approved',
      'expired',
    ]);
  });

  it('先回答了就不再过期；过了 expiresAt、计时器还没轮到时回复也按过期处理', async () => {
    const h = setup({ manager: { approvalTimeoutMs: () => 60_000 } });
    const id = await unattendedSession(h);
    await send(h, id, 'please approve');
    const first = await waitForApproval(h, id);
    await h.manager.respondToApproval({ approvalId: first.id, optionId: 'allow-once' }, desktop);
    await waitForState(h, id, 'idle');

    await send(h, id, 'please approve');
    const second = await waitForApproval(h, id);
    const later = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await expect(
        h.manager.respondToApproval({ approvalId: second.id, optionId: 'allow-once' }, desktop),
      ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    } finally {
      clock.mockRestore();
    }
    await waitForState(h, id, 'idle');
    expect(ofType(h, id, 'approval.resolved').map((e) => e.payload)).toEqual([
      expect.objectContaining({ approvalId: first.id, status: 'approved' }),
      {
        approvalId: second.id,
        status: 'expired',
        resolution: { reason: 'timeout', optionId: 'reject-once' },
      },
    ]);
  });

  it('Host 重启：残留的审批仍结为 expired（host_restarted），回复回 ALREADY_DECIDED', async () => {
    const first = setup({ manager: { approvalTimeoutMs: () => 60_000 } });
    const id = await unattendedSession(first);
    await send(first, id, 'please approve');
    const approval = await waitForApproval(first, id);
    const { h } = restart(first);
    expect(h.storage.approvals.get(approval.id)).toMatchObject({
      status: 'expired',
      resolution: { reason: 'host_restarted' },
    });
    await expect(
      h.manager.respondToApproval({ approvalId: approval.id, optionId: 'allow-once' }, desktop),
    ).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
  });
});

/** 内容里第一段文本。 */
function textOf(content: readonly UserContentPart[]): string {
  const part = content[0];
  return part?.type === 'text' ? part.text : '';
}
