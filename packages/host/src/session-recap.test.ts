// 离开后摘要（0.54.0，domain-model §3.24）：session.recap 经方法表对着 EchoAdapter 的会话；摘要由假的 `generateTitle` 给，
// 测试里不请求任何真实的模型。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_RECAP_MIN_AWAY_MS, type SessionId } from '@wevir/protocol';
import { AdapterError, type TitleRequest } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const AWAY = SESSION_RECAP_MIN_AWAY_MS + 1000;
const RECAP_OUTPUT = '{"recap": "在补登录页的测试，两个用例已写好。请先跑一遍确认通过。"}';

describe('session.recap', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(
    options: {
      generate?: (request: TitleRequest) => Promise<string>;
      /** 不给时有 `generate` 就用“写摘要”；`null` 表示没有读到提示词。 */
      instructions?: string | null;
    } = {},
  ) {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const calls: Array<{ engineSessionId: string; request: TitleRequest }> = [];
    if (options.generate !== undefined) {
      const { generate } = options;
      Object.assign(adapter, {
        generateTitle: (engineSessionId: string, request: TitleRequest) => {
          calls.push({ engineSessionId, request });
          return generate(request);
        },
      });
    }
    const root = realpathSync(tempDir());
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    const T0 = '2026-10-18T00:00:00.000Z';
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const warnings: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];
    const state = { enabled: true };
    const managerOptions = {
      storage,
      events,
      adapter,
      ...(options.instructions !== null &&
      (options.instructions !== undefined || options.generate !== undefined)
        ? { recapInstructions: options.instructions ?? '写摘要' }
        : {}),
      recapEnabled: () => state.enabled,
      onWarning: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, fields }),
    };
    const manager = new SessionManager(managerOptions);
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
    });
    return { adapter, storage, events, manager, methods, calls, warnings, state, managerOptions };
  }
  type Env = ReturnType<typeof setup>;
  const context = { client: identity, capabilities: {} };

  async function newSession({ manager }: Env): Promise<SessionId> {
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    return session.id as SessionId;
  }

  function lastSeq({ events }: Env, id: SessionId): number {
    return events.snapshot(id)?.session.lastSeq ?? 0;
  }

  /** 发一条消息并等回合结束。 */
  async function turn(env: Env, id: SessionId, text: string): Promise<void> {
    await env.methods['session.send'](
      { sessionId: id, content: [{ type: 'text', text }] },
      context,
    );
    await vi.waitFor(() => expect(env.events.snapshot(id)?.session.state).toBe('idle'));
  }

  function recap(env: Env, id: SessionId, seenSeq: number, awayMs = AWAY) {
    return env.methods['session.recap']({ sessionId: id, seenSeq, awayMs }, context);
  }

  /** 两个回合，离开之后又多一个回合：返回离开时看到的位置。 */
  async function awayAfterTurns(env: Env, id: SessionId): Promise<number> {
    await turn(env, id, '给登录页补测试');
    await turn(env, id, '再补一个过期的用例 <b>& 优先');
    const seen = lastSeq(env, id);
    await turn(env, id, '跑一遍');
    return seen;
  }

  it('离开期间有新的助手输出：用会话的模型生成摘要，输入是最近的消息与回合状态', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);
    const before = lastSeq(env, id);

    const result = await recap(env, id, seen);
    expect(result.reason).toBeUndefined();
    expect(result.recap).toMatchObject({
      text: '在补登录页的测试，两个用例已写好。请先跑一遍确认通过。',
    });
    expect(result.recap?.throughSeq).toBeLessThanOrEqual(before);
    expect(env.calls).toHaveLength(1);
    const call = env.calls[0];
    expect(call?.engineSessionId).toBe(env.events.snapshot(id)?.session.engine.sessionId);
    expect(call?.request.instructions).toBe('写摘要');
    expect(call?.request.outputSchema).toMatchObject({ required: ['recap'] });
    expect(call?.request.input).toContain('<message role="user">给登录页补测试</message>');
    expect(call?.request.input).toContain('再补一个过期的用例 &lt;b&gt;&amp; 优先');
    expect(call?.request.input).toContain('<message role="assistant">Echo: 跑一遍</message>');
    expect(call?.request.input).toContain('last_turn: completed');
    // 摘要不写事件、不改会话。
    expect(lastSeq(env, id)).toBe(before);
    expect(env.warnings).toEqual([]);
  });

  it('同一段离开只生成一次：之后的请求拿缓存；会话有了新回合再重新生成', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);

    const first = await recap(env, id, seen);
    const second = await recap(env, id, seen, AWAY * 3);
    expect(second.recap).toEqual(first.recap);
    expect(env.calls).toHaveLength(1);

    const seenAgain = lastSeq(env, id);
    await turn(env, id, '改一下断言');
    const third = await recap(env, id, seenAgain);
    expect(third.recap?.throughSeq).toBeGreaterThan(first.recap?.throughSeq ?? 0);
    expect(env.calls).toHaveLength(2);
  });

  it('并发的请求共用同一次生成', async () => {
    let release!: (text: string) => void;
    const env = setup({ generate: () => new Promise<string>((resolve) => (release = resolve)) });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);

    const requests = [recap(env, id, seen), recap(env, id, seen), recap(env, id, seen)];
    await vi.waitFor(() => expect(env.calls).toHaveLength(1));
    release(RECAP_OUTPUT);
    const results = await Promise.all(requests);
    expect(new Set(results.map((result) => result.recap?.text)).size).toBe(1);
    expect(results[0]?.recap).toBeDefined();
    expect(env.calls).toHaveLength(1);
  });

  it('不生成的情况：离开太短、设置里关了、没有新输出、回合太少', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    await turn(env, id, '第一个');
    const afterFirst = lastSeq(env, id);
    // 只有一个回合。
    expect(await recap(env, id, 0)).toEqual({ reason: 'few_turns' });
    await turn(env, id, '第二个');
    const afterSecond = lastSeq(env, id);

    expect(await recap(env, id, afterFirst, SESSION_RECAP_MIN_AWAY_MS - 1)).toEqual({
      reason: 'too_short',
    });
    // 离开期间什么都没发生。
    expect(await recap(env, id, afterSecond)).toEqual({ reason: 'no_activity' });
    expect(await recap(env, id, afterSecond + 5)).toEqual({ reason: 'no_activity' });
    env.state.enabled = false;
    expect(await recap(env, id, afterFirst)).toEqual({ reason: 'disabled' });
    env.state.enabled = true;
    expect((await recap(env, id, afterFirst)).recap).toBeDefined();
    expect(env.calls).toHaveLength(1);
  });

  it('会话还在运行回合、有待审批时不生成', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);

    await env.methods['session.send'](
      { sessionId: id, content: [{ type: 'text', text: 'slow 慢一点' }] },
      context,
    );
    expect(await recap(env, id, seen)).toEqual({ reason: 'running' });
    await vi.waitFor(() => expect(env.events.snapshot(id)?.session.state).toBe('idle'));

    await env.methods['session.send'](
      { sessionId: id, content: [{ type: 'text', text: 'approve 写个文件' }] },
      context,
    );
    await vi.waitFor(() =>
      expect(env.events.snapshot(id)?.session.state).toBe('awaiting_approval'),
    );
    expect(await recap(env, id, seen)).toEqual({ reason: 'waiting' });
    expect(env.calls).toHaveLength(0);
  });

  it('支线会话不生成', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    await awayAfterTurns(env, id);
    const { session } = await env.methods['session.fork']({ sessionId: id, side: true }, context);
    expect(await recap(env, session.id as SessionId, 0)).toEqual({ reason: 'sub_session' });
    expect(env.calls).toHaveLength(0);
  });

  it('适配器不能生成文字：unsupported', async () => {
    const env = setup({ instructions: '写摘要' });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);
    expect(await recap(env, id, seen)).toEqual({ reason: 'unsupported' });
  });

  it('没有读到提示词：unsupported', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT, instructions: null });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);
    expect(await recap(env, id, seen)).toEqual({ reason: 'unsupported' });
    expect(env.calls).toHaveLength(0);
  });

  it('引擎会话没挂着（Host 重启后）：detached，不去恢复引擎', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);
    const restarted = new SessionManager({ ...env.managerOptions });
    managers.push(restarted);
    expect(await restarted.recap({ sessionId: id, seenSeq: seen, awayMs: AWAY })).toEqual({
      reason: 'detached',
    });
    expect(env.calls).toHaveLength(0);
  });

  it('生成失败或输出解析不了：静默（reason failed、记告警），不缓存，下次重试', async () => {
    const outputs: Array<string | Error> = [
      new AdapterError('engine_unavailable', '502'),
      '{"title": "别的字段"}',
      RECAP_OUTPUT,
    ];
    const env = setup({
      generate: async () => {
        const next = outputs.shift();
        if (next instanceof Error) throw next;
        return next ?? '';
      },
    });
    const id = await newSession(env);
    const seen = await awayAfterTurns(env, id);

    expect(await recap(env, id, seen)).toEqual({ reason: 'failed' });
    expect(await recap(env, id, seen)).toEqual({ reason: 'failed' });
    expect(env.warnings.map((warning) => warning.message)).toEqual([
      '生成离开后摘要失败',
      '生成的离开后摘要无法解析，不显示',
    ]);
    expect((await recap(env, id, seen)).recap?.text).toContain('登录页');
    expect(env.calls).toHaveLength(3);
  });

  it('不存在的会话：SESSION_NOT_FOUND', async () => {
    const env = setup({ generate: async () => RECAP_OUTPUT });
    await expect(
      recap(env, 'ses_00000000000000000000000000' as SessionId, 0),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});
