// DshAdapter 的单元测试：dsh 换成 test-fixtures/fake-dsh.mjs 的 acp 模式（真实子进程、真实 ACP 帧与 fd 3）。
// 回合怎么走由提示词的第一个词决定（fake-dsh.mjs 的 PROMPT_SCRIPTS）。

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AgentEvent, isAdapterError, isTurnTerminal } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
import { readFixture } from './test-fixtures/acp-fixtures.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-adapter-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(options: Partial<DshAdapterOptions> = {}) {
  const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    entry: FAKE_DSH,
    env: { FAKE_DSH_MODE: 'acp' },
    disposeTimeouts: { stdinEofMs: 400, sigtermMs: 400, sigkillMs: 400 },
    restart: { maxRestarts: 0 },
    logger: { warn: (message, fields) => void warnings.push({ message, fields }) },
    ...options,
  });
  cleanups.push(() => adapter.dispose());
  const config = { cwd: tempDir('ws'), providerId: 'wevir-test', modelId: 'wevir-mock' };
  return { adapter, warnings, config };
}

/** 读到回合的终结事件为止（含）。 */
async function untilTerminal(events: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
    if (isTurnTerminal(value)) return out;
  }
}

async function drain(events: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
  }
}

const text = (word: string) => ({ content: [{ type: 'text' as const, text: `${word} 请开始` }] });

async function expectAdapterError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAdapterError(error) ? error.code : error).toBe(code);
}

describe('DshAdapter', () => {
  it('createSession：session/new 与 T0.3 样本同形，引擎采用的模型取自 configOptions', async () => {
    const { adapter, config } = setup();
    const session = await adapter.createSession(config);
    expect(session).toEqual({
      engineSessionId: 'fake-1',
      modelId: 'wevir-mock',
      reasoningEffort: 'high',
    });
    const sent = JSON.parse(
      readFileSync(join(adapter.process.paths.dshHome, 'fake-dsh.json'), 'utf8'),
    ).sessionNew as Record<string, unknown>;
    const { params: sample } = readFixture<{ params: Record<string, unknown> }>(
      'session-new.request.json',
    );
    expect(Object.keys(sent).sort()).toEqual(Object.keys(sample).sort());
    expect(sent).toEqual({ ...sample, cwd: config.cwd });
  });

  it('事件顺序与 ACP 交付顺序一致；同一次写里的回合结果排在全部更新之后；不认识的类型原样保留并只告警一次', async () => {
    const { adapter, warnings, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    for (let turn = 0; turn < 2; turn += 1) {
      await adapter.send(engineSessionId, text('order'));
      const list = await untilTerminal(events);
      expect(list.map((e) => e.type)).toEqual([
        'usage.updated',
        'engine.raw',
        'tool.started',
        'todo.updated',
        'tool.finished',
        'assistant.message',
        'turn.settled',
      ]);
      // SDK 的校验会删掉不认识的字段；这里拿到的是 dsh 写出的原样。
      expect(list[1]).toMatchObject({
        protocol: 'acp',
        method: 'session/update',
        kind: 'future_update',
        params: { sessionId: engineSessionId, update: { detail: { kept: true } } },
      });
    }
    expect(warnings.filter((w) => w.fields?.sessionUpdate === 'future_update')).toHaveLength(1);
  });

  it('回合失败：turn.failed 按错误原文归类，原文与错误码保留', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('fail'));
    expect(await untilTerminal(events)).toEqual([
      {
        type: 'turn.failed',
        engineSessionId,
        category: 'missing_credentials',
        message: expect.stringMatching(/^Internal error: turn failed: llm-pi-ai: no credential/),
        code: -32603,
      },
    ]);
    // 会话仍可用。
    await adapter.send(engineSessionId, text('order'));
    expect((await untilTerminal(events)).at(-1)).toMatchObject({ type: 'turn.settled' });
  });

  it('增量来自 fd 3，被已提交消息替换；子 agent 会话的帧丢弃；回合结束后迟到的 end 帧丢弃', async () => {
    const { adapter, config } = setup();
    expect(adapter.process.streamTapState).toBe('off');
    const { engineSessionId } = await adapter.createSession(config);
    expect(adapter.process.streamTapState).not.toBe('unavailable');
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('stream'));
    const attemptId = `${engineSessionId}:1`;
    expect(await untilTerminal(events)).toEqual([
      expect.objectContaining({
        type: 'assistant.delta',
        attemptId,
        blockIndex: 0,
        text: '你好，',
      }),
      expect.objectContaining({ type: 'assistant.delta', attemptId, blockIndex: 0, text: '世界' }),
      expect.objectContaining({
        type: 'assistant.message',
        text: '你好，世界',
        replaces: [{ attemptId, blockIndex: 0 }],
      }),
      expect.objectContaining({ type: 'turn.settled', outcome: 'completed' }),
    ]);
    expect(adapter.process.streamTapState).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await adapter.close(engineSessionId);
    expect(await drain(events)).toEqual([]);
  });

  it('生成中取消：补发的半段消息替换增量，回合以 cancelled 结算，cancel 返回时终结事件已发出', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('hang'));
    const first = await events.next();
    expect(first.value).toMatchObject({ type: 'assistant.delta', text: '指南针、' });
    await expectAdapterError(adapter.send(engineSessionId, text('order')), 'session_busy');
    await adapter.cancel(engineSessionId);
    await adapter.cancel(engineSessionId);
    const attemptId = `${engineSessionId}:1`;
    expect(await untilTerminal(events)).toEqual([
      expect.objectContaining({ type: 'assistant.delta', text: '造纸术' }),
      expect.objectContaining({
        type: 'assistant.message',
        text: '指南针、造纸术',
        replaces: [{ attemptId, blockIndex: 0 }],
      }),
      expect.objectContaining({
        type: 'turn.settled',
        outcome: 'cancelled',
        stopReason: 'cancelled',
      }),
    ]);
  });

  it('取消后引擎不结算：cancel 在时限内报 cancel_unconfirmed', async () => {
    const { adapter, config } = setup({ cancelTimeoutMs: 200 });
    const { engineSessionId } = await adapter.createSession(config);
    await adapter.send(engineSessionId, text('stuck'));
    await expectAdapterError(adapter.cancel(engineSessionId), 'cancel_unconfirmed');
  });

  it('close：引擎侧已不认识该会话（-32602）仍算关闭；订阅结束，之后 send 报 session_closed', async () => {
    const { adapter, warnings, config } = setup();
    const { error } = readFixture<{ error: { code: number } }>('errors/close-unknown-session.json');
    expect(error.code).toBe(-32602);
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('forget'));
    await untilTerminal(events);
    await adapter.close(engineSessionId);
    await adapter.close(engineSessionId);
    expect(await drain(events)).toEqual([]);
    expect(warnings.map((w) => w.message)).toContain('ACP session/close 失败，按已关闭处理');
    await expectAdapterError(adapter.send(engineSessionId, text('order')), 'session_closed');
    expect(() => adapter.subscribe(engineSessionId)).toThrow(/没有挂着/);
  });

  it('close：引擎回 {}（session-close.response.json）后结束订阅，不告警', async () => {
    const { adapter, warnings, config } = setup();
    const { result } = readFixture<{ result: unknown }>('session-close.response.json');
    expect(result).toEqual({});
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.close(engineSessionId);
    expect(await drain(events)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('回合中引擎进程退出：engine.exited 是最后一个事件，会话脱开', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('exit'));
    expect(await drain(events)).toEqual([
      {
        type: 'engine.exited',
        engineSessionId,
        exitCode: 3,
        signal: null,
        stderrTail: expect.stringContaining('exit during turn'),
      },
    ]);
    await expectAdapterError(adapter.send(engineSessionId, text('order')), 'session_closed');
    await adapter.cancel(engineSessionId);
  });

  it('两个会话的事件互不串', async () => {
    const { adapter, config } = setup();
    const a = (await adapter.createSession(config)).engineSessionId;
    const b = (await adapter.createSession(config)).engineSessionId;
    const ea = adapter.subscribe(a)[Symbol.asyncIterator]();
    const eb = adapter.subscribe(b)[Symbol.asyncIterator]();
    await Promise.all([adapter.send(a, text('stream')), adapter.send(b, text('order'))]);
    const [la, lb] = await Promise.all([untilTerminal(ea), untilTerminal(eb)]);
    expect(la.every((e) => e.engineSessionId === a)).toBe(true);
    expect(lb.every((e) => e.engineSessionId === b)).toBe(true);
    expect(la.filter((e) => e.type === 'assistant.delta')).toHaveLength(2);
    expect(lb.some((e) => e.type === 'assistant.delta')).toBe(false);
  });

  it('不认识的会话、审批（T3.3 之前）、resume 已挂着的会话、dispose 之后', async () => {
    const { adapter, config } = setup({ streamTap: false });
    await expectAdapterError(adapter.send('nope', text('order')), 'session_not_found');
    expect(() => adapter.subscribe('nope')).toThrow(/不认识/);
    await adapter.cancel('nope');
    const { engineSessionId } = await adapter.createSession(config);
    expect(adapter.process.streamTapState).toBe('off');
    await expect(adapter.resumeSession(engineSessionId, config)).resolves.toEqual({
      engineSessionId,
    });
    expect(await adapter.listPendingApprovals()).toEqual([]);
    await expectAdapterError(
      adapter.respondToApproval(engineSessionId, 'r1', { optionId: 'allow-once' }),
      'approval_not_found',
    );
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.dispose();
    await adapter.dispose();
    expect(await drain(events)).toEqual([]);
    expect(adapter.sessionCount).toBe(0);
    expect(adapter.process.pid).toBeUndefined();
    await expectAdapterError(adapter.createSession(config), 'disposed');
  });
});
