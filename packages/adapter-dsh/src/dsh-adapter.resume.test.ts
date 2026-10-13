// DshAdapter 的恢复（T3.5）：dsh 换成 test-fixtures/fake-dsh.mjs 的 acp 模式。会话 ID 以 gone- / newer- / corrupt-
// 开头时，fake-dsh 回放真实 dsh 录下的 session/resume 错误（acp/errors/resume-*.json）。真实 dsh 上的同样路径见
// dsh-adapter.resume.integration.test.ts。

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AdapterError,
  type AgentEvent,
  isAdapterError,
  isTurnTerminal,
  type SessionLostReason,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
import { DSH_VERSION } from './paths.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-resume-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(options: Partial<DshAdapterOptions> = {}) {
  const warnings: string[] = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    entry: FAKE_DSH,
    env: { FAKE_DSH_MODE: 'acp' },
    disposeTimeouts: { stdinEofMs: 400, sigtermMs: 400, sigkillMs: 400 },
    restart: { maxRestarts: 0 },
    logger: { warn: (message) => void warnings.push(message) },
    ...options,
  });
  cleanups.push(() => adapter.dispose());
  const config = { cwd: tempDir('ws'), providerId: 'wevir-test', modelId: 'wevir-mock' };
  return { adapter, warnings, config };
}

/** fake-dsh 收到的客户端消息（initialize 之外），只留方法名与参数。 */
function received(
  adapter: DshAdapter,
): Array<{ method?: string; params?: Record<string, unknown> }> {
  return JSON.parse(readFileSync(join(adapter.process.paths.dshHome, 'fake-dsh.json'), 'utf8'))
    .received;
}

const methodsOf = (adapter: DshAdapter) =>
  received(adapter)
    .map((m) => m.method)
    .filter((m) => m !== undefined);

const text = (word: string) => ({ content: [{ type: 'text' as const, text: `${word} 请开始` }] });

async function untilTerminal(events: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
    if (isTurnTerminal(value)) return out;
  }
}

async function adapterError(promise: Promise<unknown>): Promise<AdapterError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isAdapterError(error)) throw new Error(`应以 AdapterError 失败：${String(error)}`);
  return error;
}

describe('DshAdapter.resumeSession', () => {
  it('不认识的会话（Host 重启后）：发 session/resume（创建时的 cwd），登记后可以对话', async () => {
    const { adapter, config } = setup();
    const resumed = await adapter.resumeSession('ses-from-before', config);
    expect(resumed).toEqual({
      engineSessionId: 'ses-from-before',
      engineVersion: DSH_VERSION,
      modelId: 'wevir-mock',
      reasoningEffort: 'high',
    });
    expect(received(adapter).find((m) => m.method === 'session/resume')?.params).toEqual({
      sessionId: 'ses-from-before',
      cwd: config.cwd,
      mcpServers: [],
    });
    // 路由与 dsh 恢复出来的相同，不再 set_config_option。
    expect(methodsOf(adapter)).not.toContain('session/set_config_option');
    const events = adapter.subscribe('ses-from-before')[Symbol.asyncIterator]();
    await adapter.send('ses-from-before', text('order'));
    expect((await untilTerminal(events)).at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
    });
  });

  it('dsh 恢复出的路由与 config 不同：按 config 重新选定', async () => {
    const { adapter, config } = setup();
    const resumed = await adapter.resumeSession('ses-x', {
      ...config,
      modelId: 'wevir-other',
      reasoningEffort: 'low',
    });
    expect(resumed).toMatchObject({ modelId: 'wevir-other', reasoningEffort: 'low' });
    expect(
      received(adapter)
        .filter((m) => m.method === 'session/set_config_option')
        .map((m) => [m.params?.configId, m.params?.value]),
    ).toEqual([
      ['model', '["wevir-test","wevir-other"]'],
      ['reasoning_effort', 'low'],
    ]);
  });

  it('已挂在本进程上：直接成功，不发 session/resume', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    await expect(adapter.resumeSession(engineSessionId, config)).resolves.toEqual({
      engineSessionId,
      engineVersion: DSH_VERSION,
    });
    expect(methodsOf(adapter)).not.toContain('session/resume');
  });

  it('close 之后 resume：同一进程照常恢复', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    await adapter.close(engineSessionId);
    await adapter.resumeSession(engineSessionId, config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('order'));
    expect((await untilTerminal(events)).at(-1)?.type).toBe('turn.settled');
  });

  it.each<[string, SessionLostReason]>([
    ['gone-1', 'not_found'],
    ['newer-1', 'incompatible'],
    ['corrupt-1', 'corrupted'],
  ])('引擎会话恢复不了（%s）：session_lost，原因 %s，原文保留', async (id, reason) => {
    const { adapter, config } = setup();
    const error = await adapterError(adapter.resumeSession(id, config));
    expect(error.code).toBe('session_lost');
    expect(error.lostReason).toBe(reason);
    expect(error.message).toContain(id);
    expect(() => adapter.subscribe(id)).toThrow();
  });

  it('cwd 与创建时不一致：session_unavailable', async () => {
    const { adapter, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    await adapter.close(engineSessionId);
    const cwd = tempDir('other');
    const error = await adapterError(adapter.resumeSession(engineSessionId, { ...config, cwd }));
    expect(error.code).toBe('session_unavailable');
    expect(error.lostReason).toBeUndefined();
    expect(error.message).toContain(`session cwd does not match: ${cwd}`);
  });

  it('dsh 说会话仍活跃（之前 session/close 失败）：沿用它，重新选定路由', async () => {
    const { adapter, warnings, config } = setup();
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('stubborn'));
    await untilTerminal(events);
    await adapter.close(engineSessionId);
    expect(warnings).toContain('ACP session/close 失败，按已关闭处理');

    await adapter.resumeSession(engineSessionId, config);
    expect(warnings).toContain('dsh 里这个会话仍挂着（之前的 session/close 失败过），直接沿用');
    expect(methodsOf(adapter).slice(-2)).toEqual(['session/resume', 'session/set_config_option']);
    const again = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, text('order'));
    expect((await untilTerminal(again)).at(-1)?.type).toBe('turn.settled');
  });

  it('路由选不上：invalid_input，刚恢复的会话在引擎侧关掉', async () => {
    const { adapter, config } = setup();
    const error = await adapterError(
      adapter.resumeSession('ses-y', { ...config, modelId: 'missing-model' }),
    );
    expect(error.code).toBe('invalid_input');
    expect(methodsOf(adapter).slice(-3)).toEqual([
      'session/resume',
      'session/set_config_option',
      'session/close',
    ]);
    expect(() => adapter.subscribe('ses-y')).toThrow();
  });

  it('cwd 为空：invalid_input；dispose 之后：disposed', async () => {
    const { adapter, config } = setup();
    expect((await adapterError(adapter.resumeSession('s', { ...config, cwd: '' }))).code).toBe(
      'invalid_input',
    );
    await adapter.dispose();
    expect((await adapterError(adapter.resumeSession('s', config))).code).toBe('disposed');
  });
});

describe('取消得不到确认时重启 dsh', () => {
  it('卡住的会话与同进程的其他会话都以 engine.exited（cancel_unconfirmed）脱开，resume 到新进程上照常对话', async () => {
    const { adapter, config } = setup({ cancelTimeoutMs: 200 });
    const stuck = (await adapter.createSession(config)).engineSessionId;
    const other = (await adapter.createSession(config)).engineSessionId;
    const stuckEvents = adapter.subscribe(stuck)[Symbol.asyncIterator]();
    const otherEvents = adapter.subscribe(other)[Symbol.asyncIterator]();
    const generation = adapter.process.generation;

    await adapter.send(stuck, text('stuck'));
    expect((await adapterError(adapter.cancel(stuck))).code).toBe('cancel_unconfirmed');
    const exited = {
      type: 'engine.exited',
      exitCode: null,
      signal: null,
      reason: 'cancel_unconfirmed',
    };
    expect((await untilTerminal(stuckEvents)).at(-1)).toEqual({
      ...exited,
      engineSessionId: stuck,
    });
    expect(await untilTerminal(otherEvents)).toEqual([{ ...exited, engineSessionId: other }]);
    expect((await stuckEvents.next()).done).toBe(true);
    expect((await adapterError(adapter.send(other, text('order')))).code).toBe('session_closed');

    // 新进程不认识这两个会话：resume 发 session/resume，而不是被 dsh 以 already active 拒绝。
    for (const id of [stuck, other]) {
      await adapter.resumeSession(id, config);
      const events = adapter.subscribe(id)[Symbol.asyncIterator]();
      await adapter.send(id, text('order'));
      expect((await untilTerminal(events)).at(-1)).toMatchObject({ type: 'turn.settled' });
    }
    expect(adapter.process.generation).toBe(generation + 1);
    expect(methodsOf(adapter).filter((m) => m === 'session/resume')).toHaveLength(2);
  });
});
