import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovalRequest,
  ClientIdentity,
  SessionId,
  SessionState,
  WevirEvent,
  WevirEventOf,
  WevirEventType,
} from '@wevir/protocol';
import { AdapterError, type AgentEvent } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import type { Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostError } from './errors.js';
import { EventStore } from './event-store.js';
import { SessionManager, type SessionManagerOptions } from './session-manager.js';
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
    for (const record of h.storage.sessions.list({ includeRemovedWorkspaces: true })) {
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
 * 和新的管理器，然后启动对账。默认换一个新的引擎（dsh 随 Host 一起消失）。
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
    const record = h.storage.sessions.getByEngineSessionId('dsh', session.engine.sessionId);
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
      new AdapterError('engine_unavailable', 'dsh failed to start'),
    );
    await expect(
      h.manager.create({ workspaceId: 'ws_1', providerId: 'deepseek-official' }),
    ).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'unknown', message: 'dsh failed to start' },
    });
    expect(h.storage.sessions.list()).toEqual([]);
  });
});

describe('SessionManager：回合', () => {
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

    // 新引擎不认识旧会话：send 前的自动 resume 失败（#11），不写 user.message。
    const before = lastSeq(h, d);
    await expect(send(h, d, 'hi')).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
      data: { category: 'session_unavailable' },
    });
    expect(typesAfter(h, d, before)).toEqual(['engine.error', 'session.state_changed']);
    expect(transitions(h, d)).toEqual(['idle→error:resume_failed']);
    expect(ofType(h, d, 'engine.error')[0]?.payload.fatal).toBe(true);

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

describe('SessionManager：其他', () => {
  it('dispose 之后的调用返回 HOST_SHUTTING_DOWN', async () => {
    const h = setup();
    const id = await create(h);
    await h.manager.dispose();
    await expect(send(h, id, 'hi')).rejects.toMatchObject({ code: 'HOST_SHUTTING_DOWN' });
  });

  it('上面的用例走过了 domain-model §4.1 的每一条状态转换', () => {
    const expected = SESSION_TRANSITIONS.flatMap((t) =>
      t.from.map((from) => `${from}→${t.to}:${t.reason}`),
    );
    expect(expected.filter((t) => !seenTransitions.has(t))).toEqual([]);
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
