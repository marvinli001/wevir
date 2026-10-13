// DshAdapter 的审批桥接（T3.3）：test-fixtures/fake-dsh.mjs 回放 T0.3 录制的审批样本（mock/transcripts/ 的
// B allow、C deny、D cancel），dsh 换成真实子进程与真实 ACP 帧。校验 approval.requested 的内容与顺序，回给
// dsh 的 ACP 响应与 mock/permission/responses.json 一致，取消、关闭、引擎退出、dispose 时挂起的审批以
// cancelled 结束，重复决定不重复发给 dsh。

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentEvent,
  type ApprovalRequestedEvent,
  isAdapterError,
  isTurnTerminal,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
import { ACP_FIXTURES, readFixture, readTranscript } from './test-fixtures/acp-fixtures.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));
const TRANSCRIPTS = join(ACP_FIXTURES, 'mock', 'transcripts');

type Sample = 'B-permission-allow' | 'C-permission-deny' | 'D-permission-cancel';

const RESPONSES = readFixture<Record<'allow' | 'deny' | 'cancelled', unknown>>(
  'mock/permission/responses.json',
);

interface RecordedRequest {
  toolCall: { toolCallId: string };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** 样本里 dsh 发出的审批请求。 */
function recordedRequest(sample: Sample): RecordedRequest {
  const line = readTranscript(`mock/transcripts/${sample}.jsonl`).find(
    (l) => l.msg.method === 'session/request_permission',
  );
  if (line === undefined) throw new Error(`${sample} 里没有审批请求`);
  return line.msg.params as RecordedRequest;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-approval-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(options: Partial<DshAdapterOptions> = {}) {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    entry: FAKE_DSH,
    env: { FAKE_DSH_MODE: 'acp', FAKE_DSH_FIXTURES: TRANSCRIPTS },
    streamTap: false,
    disposeTimeouts: { stdinEofMs: 400, sigtermMs: 400, sigkillMs: 400 },
    restart: { maxRestarts: 0 },
    logger: { warn: (message, fields) => void warnings.push({ message, fields }) },
    ...options,
  });
  cleanups.push(() => adapter.dispose());
  const config = { cwd: tempDir('ws'), providerId: 'wevir-test', modelId: 'wevir-mock' };
  return { adapter, warnings, config };
}

/** 读到满足 `stop` 的事件为止（含）；订阅先结束就返回已读到的。 */
async function readUntil(
  events: AsyncIterator<AgentEvent>,
  stop: (event: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
    if (stop(value)) return out;
  }
}

/** 开一个回放样本的回合，读到审批请求为止。 */
async function startApproval(adapter: DshAdapter, config: { cwd: string }, sample: Sample) {
  const { engineSessionId } = await adapter.createSession({
    ...config,
    providerId: 'wevir-test',
    modelId: 'wevir-mock',
  });
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  await adapter.send(engineSessionId, { content: [{ type: 'text', text: `replay:${sample}` }] });
  const before = await readUntil(events, (e) => e.type === 'approval.requested');
  const request = before.at(-1) as ApprovalRequestedEvent;
  expect(request.type).toBe('approval.requested');
  return { engineSessionId, events, before, request };
}

/** fake dsh 收到的客户端消息（initialize 之外，按到达顺序）。 */
function received(adapter: DshAdapter): Array<Record<string, unknown>> {
  const file = join(adapter.process.paths.dshHome, 'fake-dsh.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { received: Array<Record<string, unknown>> })
    .received;
}

/** 回给 dsh 的审批响应（没有 method 的客户端消息）。 */
function permissionResponses(adapter: DshAdapter): unknown[] {
  return received(adapter)
    .filter((m) => m.method === undefined)
    .map((m) => m.result ?? m.error);
}

async function expectAdapterError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAdapterError(error) ? error.code : error).toBe(code);
}

describe('DshAdapter 审批桥接（T0.3 样本回放）', () => {
  it('allow：approval.requested 原样带选项、排在同一 toolCallId 的 tool.started 之后；回复与样本一致，重复决定不再发给 dsh', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, before, request } = await startApproval(
      adapter,
      config,
      'B-permission-allow',
    );
    const recorded = readFixture<RecordedRequest>('mock/permission/request.json');
    expect(request).toEqual({
      type: 'approval.requested',
      engineSessionId,
      requestId: expect.any(String),
      toolCallId: recorded.toolCall.toolCallId,
      options: recorded.options.map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind })),
    });
    // 沙箱先拒绝第一次写入，模型带 sandbox_permissions 重试，第二次调用才请求审批（acp-event-mapping.md §5）。
    const tools = before.filter((e) => e.type === 'tool.started' || e.type === 'tool.finished');
    expect(tools).toEqual([
      expect.objectContaining({ type: 'tool.started', toolName: 'write' }),
      expect.objectContaining({
        type: 'tool.finished',
        status: 'failed',
        output: expect.stringContaining('[sandbox: file access denied under workspace-write mode]'),
      }),
      expect.objectContaining({
        type: 'tool.started',
        toolCallId: request.toolCallId,
        toolName: 'write',
        display: expect.objectContaining({ kind: 'write' }),
        input: expect.objectContaining({
          sandbox_permissions: 'danger-full-access',
          justification: expect.any(String),
        }),
      }),
    ]);
    const { type: _type, ...pending } = request;
    expect(await adapter.listPendingApprovals()).toEqual([pending]);
    expect(await adapter.listPendingApprovals(engineSessionId)).toEqual([pending]);
    expect(await adapter.listPendingApprovals('nope')).toEqual([]);

    await expectAdapterError(
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-always' }),
      'invalid_option',
    );
    expect(await adapter.listPendingApprovals()).toEqual([pending]);
    await adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' });
    expect(await adapter.listPendingApprovals()).toEqual([]);
    await expectAdapterError(
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' }),
      'approval_not_found',
    );

    const after = await readUntil(events, isTurnTerminal);
    expect(after.map((e) => e.type)).toEqual([
      'tool.finished',
      'assistant.message',
      'usage.updated',
      'turn.settled',
    ]);
    expect(after[0]).toMatchObject({ toolCallId: request.toolCallId, status: 'completed' });
    expect(after.at(-1)).toMatchObject({ outcome: 'completed' });
    expect(permissionResponses(adapter)).toEqual([RESPONSES.allow]);
  });

  it('deny：回复 reject-once，工具以 dsh 的拒绝说明失败，回合正常结束', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, request } = await startApproval(
      adapter,
      config,
      'C-permission-deny',
    );
    expect(request.toolCallId).toBe(recordedRequest('C-permission-deny').toolCall.toolCallId);
    await adapter.respondToApproval(engineSessionId, request.requestId, {
      optionId: 'reject-once',
    });
    const after = await readUntil(events, isTurnTerminal);
    expect(after.find((e) => e.type === 'tool.finished')).toMatchObject({
      toolCallId: request.toolCallId,
      status: 'failed',
      output: expect.stringContaining('the user rejected escalating this operation'),
    });
    expect(after.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(permissionResponses(adapter)).toEqual([RESPONSES.deny]);
  });

  it('两个决定同时到达：只有一个回复 dsh，另一个报 approval_not_found', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, request } = await startApproval(
      adapter,
      config,
      'B-permission-allow',
    );
    const results = await Promise.allSettled([
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' }),
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'reject-once' }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status === 'rejected' && isAdapterError(results[1].reason)).toBe(true);
    expect(results[1].status === 'rejected' && results[1].reason.code).toBe('approval_not_found');
    await readUntil(events, isTurnTerminal);
    expect(permissionResponses(adapter)).toEqual([RESPONSES.allow]);
  });

  it('审批挂起时取消：先写 session/cancel 再以 cancelled 回复，approval.cancelled（turn_cancelled）在工具结果与回合结算之前', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, request } = await startApproval(
      adapter,
      config,
      'D-permission-cancel',
    );
    await adapter.cancel(engineSessionId);
    const after = await readUntil(events, isTurnTerminal);
    expect(after.map((e) => e.type)).toEqual([
      'approval.cancelled',
      'tool.finished',
      'turn.settled',
    ]);
    expect(after[0]).toEqual({
      type: 'approval.cancelled',
      engineSessionId,
      requestId: request.requestId,
      reason: 'turn_cancelled',
    });
    expect(after[1]).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('was cancelled'),
    });
    expect(after[2]).toMatchObject({ outcome: 'cancelled', stopReason: 'cancelled' });
    // 与 T0.3 场景 D 的顺序相同。
    const tail = received(adapter).slice(-2);
    expect(tail[0]).toMatchObject({
      method: 'session/cancel',
      params: { sessionId: engineSessionId },
    });
    expect(tail[1]?.result).toEqual(RESPONSES.cancelled);
    expect(permissionResponses(adapter)).toEqual([RESPONSES.cancelled]);
    await expectAdapterError(
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' }),
      'approval_not_found',
    );
    expect(await adapter.listPendingApprovals()).toEqual([]);
  });

  it('取消开始之后才到的审批请求：照常上报，随即以 cancelled 结束并回复 dsh', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, {
      content: [{ type: 'text', text: 'replay:D-permission-cancel' }],
    });
    // send 发出 session/prompt 就返回，dsh 还没读到它，审批请求必然在取消之后到达。
    await adapter.cancel(engineSessionId);
    const list = await readUntil(events, isTurnTerminal);
    const types = list.map((e) => e.type);
    const requested = types.indexOf('approval.requested');
    expect(types.slice(requested)).toEqual([
      'approval.requested',
      'approval.cancelled',
      'tool.finished',
      'turn.settled',
    ]);
    expect(list[requested + 1]).toMatchObject({ reason: 'turn_cancelled' });
    expect(list.at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect(permissionResponses(adapter)).toEqual([RESPONSES.cancelled]);
    expect(await adapter.listPendingApprovals()).toEqual([]);
  });

  it('审批挂起时关闭会话：同样以 cancelled 回复，回合结算后订阅结束', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, request } = await startApproval(
      adapter,
      config,
      'D-permission-cancel',
    );
    await adapter.close(engineSessionId);
    const after = await readUntil(events, () => false);
    expect(after.map((e) => e.type)).toEqual([
      'approval.cancelled',
      'tool.finished',
      'turn.settled',
    ]);
    expect(after[0]).toMatchObject({ requestId: request.requestId, reason: 'turn_cancelled' });
    expect(permissionResponses(adapter)).toEqual([RESPONSES.cancelled]);
    expect(received(adapter).at(-1)).toMatchObject({ method: 'session/close' });
  });

  it('审批挂起时引擎进程退出：approval.cancelled（engine_exited）在 engine.exited 之前', async () => {
    const { adapter, config } = setup();
    const { engineSessionId, events, request } = await startApproval(
      adapter,
      config,
      'B-permission-allow',
    );
    process.kill(adapter.process.pid as number, 'SIGKILL');
    const after = await readUntil(events, () => false);
    expect(after.map((e) => e.type)).toEqual(['approval.cancelled', 'engine.exited']);
    expect(after[0]).toMatchObject({ requestId: request.requestId, reason: 'engine_exited' });
    expect(await adapter.listPendingApprovals()).toEqual([]);
    await expectAdapterError(
      adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'allow-once' }),
      'approval_not_found',
    );
  });

  it('审批挂起时 dispose：approval.cancelled（disposed），cancelled 回复在 stdin 关闭之前写到 dsh', async () => {
    const { adapter, config } = setup();
    const { events, request } = await startApproval(adapter, config, 'B-permission-allow');
    await adapter.dispose();
    const after = await readUntil(events, () => false);
    expect(after).toEqual([
      expect.objectContaining({
        type: 'approval.cancelled',
        requestId: request.requestId,
        reason: 'disposed',
      }),
    ]);
    expect(permissionResponses(adapter)).toEqual([RESPONSES.cancelled]);
  });

  it('不属于进行中回合的审批请求：直接回复 cancelled 并告警', async () => {
    const { adapter, warnings } = setup({ env: { FAKE_DSH_MODE: 'ask-permission' } });
    await adapter.process.start();
    const file = join(adapter.process.paths.dshHome, 'fake-dsh.json');
    let response: unknown;
    for (let i = 0; i < 100 && response === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      response = (JSON.parse(readFileSync(file, 'utf8')) as { permissionResponse?: unknown })
        .permissionResponse;
    }
    expect(response).toEqual(RESPONSES.cancelled);
    expect(warnings.map((w) => w.message)).toContain(
      'ACP session/request_permission 不属于进行中的回合，回复 cancelled',
    );
  });
});
