// 输入建议（0.53.0，domain-model §3.23）：回合正常结束后用会话的模型预测用户接着会发的一句话，对着 EchoAdapter 的会话；
// 请求由测试替换的 `generateTitle` 接住，不碰真实模型。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { PROMPT_SUGGESTION_VOIDING_EVENTS } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { SessionManager } from './session-manager.js';
import { applyEvent, INITIAL_PROJECTION } from './snapshot.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const T0 = '2026-10-18T00:00:00.000Z';

let harnessCount = 0;

interface Request {
  engineSessionId: string;
  instructions: string;
  input: string;
  signal: AbortSignal | undefined;
}

describe('输入建议', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(
    options: { enabled?: () => boolean; output?: (request: Request) => Promise<string> } = {},
  ) {
    harnessCount += 1;
    const root = join(realpathSync(tempDir()), `h${harnessCount}`);
    mkdirSync(root);
    const dataDir = join(root, 'data');
    const storage = storages.open(dataDir);
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
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
    const adapter = new EchoAdapter({ stepDelayMs: 1 });
    const requests: Request[] = [];
    const output = options.output ?? (async () => '{"suggestion": "跑一下测试"}');
    Object.assign(adapter, {
      generateTitle: (
        engineSessionId: string,
        request: { instructions: string; input: string; signal?: AbortSignal },
      ) => {
        const entry = { engineSessionId, ...request, signal: request.signal };
        requests.push(entry);
        return output(entry);
      },
    });
    const warnings: string[] = [];
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter,
      onWarning: (message) => warnings.push(message),
      suggestion: { instructions: '猜下一句', enabled: options.enabled ?? (() => true) },
    });
    managers.push(manager);
    return { storage, events, manager, adapter, requests, warnings };
  }
  type Env = ReturnType<typeof setup>;
  const text = (value: string) => [{ type: 'text' as const, text: value }];

  async function newSession({ manager }: Env): Promise<SessionId> {
    const session = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    return session.id as SessionId;
  }

  function send(env: Env, sessionId: SessionId, value: string, extra: object = {}) {
    return env.manager.send({ sessionId, content: text(value), ...extra }, identity);
  }

  async function idle({ events }: Env, sessionId: SessionId): Promise<void> {
    await vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'));
  }

  const suggestionEvents = ({ events }: Env, sessionId: SessionId) =>
    events.readSince(sessionId, 0).filter((event) => event.type === 'suggestion.updated');

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it('回合正常结束后用会话的模型生成一条建议，写 suggestion.updated，快照里有；每个回合一次', async () => {
    const env = setup();
    const id = await newSession(env);
    const { turnId } = (await send(env, id, '修一下登录接口')) as { turnId: string };
    await idle(env, id);
    await vi.waitFor(() => expect(env.events.snapshot(id)?.promptSuggestion).toBeDefined());
    expect(env.events.snapshot(id)?.promptSuggestion).toEqual({ turnId, text: '跑一下测试' });
    expect(suggestionEvents(env, id)).toHaveLength(1);
    expect(env.requests).toHaveLength(1);
    const [request] = env.requests;
    expect(request?.instructions).toBe('猜下一句');
    expect(request?.engineSessionId).toBe(env.events.snapshot(id)?.session.engine.sessionId);
    expect(request?.input).toMatch(
      /^<conversation>\n<message role="user">修一下登录接口<\/message>/u,
    );
    expect(request?.input).toContain('<message role="assistant">');
    expect(env.warnings).toEqual([]);

    // 下一个回合开始就作废；这个回合结束后重新来一条，总共两次请求。
    await send(env, id, '好的');
    await idle(env, id);
    await vi.waitFor(() => expect(suggestionEvents(env, id)).toHaveLength(2));
    expect(env.requests).toHaveLength(2);
  });

  it('用户有了新消息：当前的建议作废，还在生成的那次被中止、结果不写', async () => {
    let release!: (output: string) => void;
    const env = setup({ output: () => new Promise<string>((resolve) => (release = resolve)) });
    const id = await newSession(env);
    await send(env, id, '你好');
    await idle(env, id);
    await vi.waitFor(() => expect(env.requests).toHaveLength(1));
    const first = env.requests[0] as Request;
    expect(first.signal?.aborted).toBe(false);

    await send(env, id, 'slow 再来');
    expect(first.signal?.aborted).toBe(true);
    release('{"suggestion": "太晚了"}');
    await idle(env, id);
    await settle();
    expect(suggestionEvents(env, id).map((event) => event.payload)).not.toContainEqual(
      expect.objectContaining({ text: '太晚了' }),
    );
    expect(env.events.snapshot(id)?.promptSuggestion).toBeUndefined();
  });

  it('建议出来之后，用户的消息把它清掉（快照里没有）；事件留在流里', async () => {
    const env = setup();
    const id = await newSession(env);
    await send(env, id, '你好');
    await idle(env, id);
    await vi.waitFor(() => expect(env.events.snapshot(id)?.promptSuggestion).toBeDefined());
    env.requests.length = 0;
    await send(env, id, 'slow 继续');
    expect(env.events.snapshot(id)?.promptSuggestion).toBeUndefined();
    expect(suggestionEvents(env, id)).toHaveLength(1);
    await idle(env, id);
  });

  it('设置关着：不发请求；设置每个回合结束时重新问一次', async () => {
    let on = false;
    const env = setup({ enabled: () => on });
    const id = await newSession(env);
    await send(env, id, '你好');
    await idle(env, id);
    await settle();
    expect(env.requests).toHaveLength(0);
    on = true;
    await send(env, id, '再来');
    await idle(env, id);
    await vi.waitFor(() => expect(env.requests).toHaveLength(1));
  });

  it('没有提示词（没给 suggestion）或适配器不实现 generateTitle：没有建议', async () => {
    const env = setup();
    const bare = new SessionManager({
      storage: env.storage,
      events: env.events,
      adapter: env.adapter,
    });
    managers.push(bare);
    const session = await bare.create({ workspaceId: 'ws_1', providerId: 'mock' });
    await bare.send({ sessionId: session.id, content: text('你好') }, identity);
    await vi.waitFor(() => expect(env.events.snapshot(session.id)?.session.state).toBe('idle'));
    await settle();
    expect(env.requests).toHaveLength(0);
  });

  it('模型留空、写了提问或评价：不写事件，也不告警', async () => {
    for (const output of [
      '{"suggestion": ""}',
      '{"suggestion": "要继续吗？"}',
      '随便说点什么\n再说点',
    ]) {
      const env = setup({ output: async () => output });
      const id = await newSession(env);
      await send(env, id, '你好');
      await idle(env, id);
      await vi.waitFor(() => expect(env.requests).toHaveLength(1));
      await settle();
      expect(suggestionEvents(env, id), output).toHaveLength(0);
      expect(env.warnings, output).toEqual([]);
    }
  });

  it('请求失败：只记告警，会话不受影响，还能继续对话', async () => {
    const env = setup({ output: () => Promise.reject(new Error('502 bad gateway')) });
    const id = await newSession(env);
    await send(env, id, '你好');
    await idle(env, id);
    await vi.waitFor(() => expect(env.warnings).toHaveLength(1));
    expect(env.warnings[0]).toContain('生成输入建议失败');
    expect(suggestionEvents(env, id)).toHaveLength(0);
    expect(env.events.snapshot(id)?.session.state).toBe('idle');
    await send(env, id, '再来');
    await idle(env, id);
  });

  it('不生成：计划模式、被取消的回合、支线会话、子会话、agent 开的会话', async () => {
    const env = setup();
    const id = await newSession(env);

    // 计划模式的回合。
    await send(env, id, '做个计划', { collaborationMode: 'plan' });
    await idle(env, id);
    await settle();
    expect(env.requests).toHaveLength(0);

    // 被取消的回合。
    await send(env, id, 'slow 慢慢来');
    await vi.waitFor(() => expect(env.events.snapshot(id)?.session.state).toBe('running'));
    await env.manager.cancel(id);
    await idle(env, id);
    await settle();
    expect(env.requests).toHaveLength(0);

    // 正常的回合：生成；然后在它上面分出支线，支线里的回合不生成。
    await send(env, id, '你好');
    await idle(env, id);
    await vi.waitFor(() => expect(env.requests).toHaveLength(1));
    const side = await env.manager.fork({ sessionId: id, side: true });
    await send(env, side.id as SessionId, '顺便问一句');
    await idle(env, side.id as SessionId);
    await settle();
    expect(env.requests).toHaveLength(1);

    // 派出子 agent 的回合：父会话生成一次，子会话不生成。
    await send(env, id, 'subagent 去查查');
    await idle(env, id);
    await vi.waitFor(() => expect(env.requests).toHaveLength(2));
    await settle();
    expect(env.requests).toHaveLength(2);

    // agent 开的会话。
    const opened = await env.manager.create(
      { workspaceId: 'ws_1', providerId: 'mock' },
      { openedBy: id },
    );
    await send(env, opened.id as SessionId, '你好');
    await idle(env, opened.id as SessionId);
    await settle();
    expect(env.requests).toHaveLength(2);
  });

  it('重放：Host 重启后（新的事件库从数据库读）快照里仍是最近一条建议', async () => {
    const env = setup();
    const id = await newSession(env);
    await send(env, id, '你好');
    await idle(env, id);
    await vi.waitFor(() => expect(env.events.snapshot(id)?.promptSuggestion).toBeDefined());
    const expected = env.events.snapshot(id)?.promptSuggestion;
    const reopened = new EventStore({ storage: env.storage });
    expect(reopened.snapshot(id)?.promptSuggestion).toEqual(expected);
    reopened.close();
  });
});

describe('输入建议在快照里的清除', () => {
  const sessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
  const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
  const make = (type: string, payload: object, seq: number) =>
    ({ seq, sessionId, ts: T0, source: 'host', type, payload }) as unknown as WevirEvent;

  it('suggestion.updated 设置，下面这些事件各自清掉；别的事件不动它', () => {
    expect([...PROMPT_SUGGESTION_VOIDING_EVENTS].sort()).toEqual([
      'turn.redone',
      'turn.rewound',
      'turn.started',
      'turn.undone',
      'user.message',
      'user.steered',
    ]);
    const suggested = applyEvent(
      INITIAL_PROJECTION,
      make('suggestion.updated', { turnId: TURN, text: '跑一下测试' }, 1),
    );
    expect(suggested.promptSuggestion).toEqual({ turnId: TURN, text: '跑一下测试' });
    for (const type of ['usage.updated', 'session.title_changed', 'tasks.board_updated']) {
      const payload =
        type === 'usage.updated'
          ? { contextUsed: 1, contextSize: 2 }
          : type === 'session.title_changed'
            ? { title: 'x', source: 'generated' }
            : { tasks: [] };
      expect(applyEvent(suggested, make(type, payload, 2)).promptSuggestion, type).toEqual(
        suggested.promptSuggestion,
      );
    }
    for (const type of PROMPT_SUGGESTION_VOIDING_EVENTS) {
      const payload =
        type === 'user.message'
          ? { turnId: TURN, content: [], sentBy: identity }
          : { turnId: TURN, content: [] };
      expect(applyEvent(suggested, make(type, payload, 2)).promptSuggestion, type).toBeUndefined();
    }
  });
});
