// 你应该知道（0.78.0，domain-model §3.33）：回合结束后按频率限制用会话的模型在后台看一遍会话，对着 EchoAdapter 的会话；
// 请求由测试替换的 `generateTitle` 接住，不碰真实模型。EchoAdapter 遇到 “approve” 写一个文件（完全访问时不问），算 agent 做的一件事。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { INSIGHT_MIN_INTERVAL_MS } from './insight.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const T0 = '2026-10-21T00:00:00.000Z';

let harnessCount = 0;

const FOUND = JSON.stringify({
  show: true,
  tag: 'heads_up',
  summary: 'agent 往工作区外写了文件。',
  title: '工作区外多了一个文件',
  detail: '写到了 **/outside-workspace/echo.txt**。',
});
const NOTHING = '{"show": false, "tag": "", "summary": "", "title": "", "detail": ""}';

describe('你应该知道', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(
    options: {
      enabled?: () => boolean;
      output?: (input: string) => Promise<string>;
      now?: () => number;
    } = {},
  ) {
    harnessCount += 1;
    const root = join(realpathSync(tempDir()), `h${harnessCount}`);
    mkdirSync(root);
    const storage = storages.open(join(root, 'data'));
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
    const inputs: string[] = [];
    const output = options.output ?? (async () => FOUND);
    Object.assign(adapter, {
      generateTitle: (
        _engineSessionId: string,
        request: { instructions: string; input: string },
      ) => {
        expect(request.instructions).toBe('旁观');
        inputs.push(request.input);
        return output(request.input);
      },
    });
    const warnings: string[] = [];
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter,
      onWarning: (message) => warnings.push(message),
      insight: {
        instructions: '旁观',
        enabled: options.enabled ?? (() => true),
        ...(options.now !== undefined && { now: options.now }),
      },
    });
    managers.push(manager);
    return { events, manager, inputs, warnings };
  }
  type Env = ReturnType<typeof setup>;

  async function newSession({ manager }: Env): Promise<SessionId> {
    const session = await manager.create({
      workspaceId: 'ws_1',
      providerId: 'mock',
      permissionMode: 'full_access',
    });
    return session.id as SessionId;
  }

  async function turn(env: Env, sessionId: SessionId, text: string): Promise<string | undefined> {
    const sent = await env.manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
    return 'turnId' in sent ? sent.turnId : undefined;
  }

  const insightEvents = ({ events }: Env, sessionId: SessionId) =>
    events.readSince(sessionId, 0).filter((event) => event.type === 'insight.updated');

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it('agent 做满 3 件事后的回合结束才检查一次，写 open 的 insight.updated，快照里有', async () => {
    const env = setup();
    const id = await newSession(env);
    await turn(env, id, 'approve 1');
    await turn(env, id, 'approve 2');
    await settle();
    expect(env.inputs).toHaveLength(0);
    const turnId = await turn(env, id, 'approve 3');
    await vi.waitFor(() => expect(insightEvents(env, id)).toHaveLength(1));
    expect(env.inputs).toHaveLength(1);
    expect(env.inputs[0]).toContain('<action>File change: /outside-workspace/echo.txt</action>');
    expect(env.inputs[0]).toContain('<message role="user">approve 3</message>');
    expect(env.inputs[0]).toContain('last_turn: completed');
    const [insight] = env.events.snapshot(id)?.insights ?? [];
    expect(insight).toMatchObject({
      tag: 'heads_up',
      title: '工作区外多了一个文件',
      status: 'open',
      turnId,
    });
    expect(insight?.id).toMatch(/^isg_/u);
    expect(env.warnings).toEqual([]);
  });

  it('用户标为已知：写 known，再处理一次原样返回、不写事件；之后的检查带上提过的与已知的', async () => {
    let now = 0;
    const env = setup({ now: () => now });
    const id = await newSession(env);
    for (const n of [1, 2, 3]) await turn(env, id, `approve ${n}`);
    await vi.waitFor(() => expect(insightEvents(env, id)).toHaveLength(1));
    const insightId = env.events.snapshot(id)?.insights?.[0]?.id;
    if (insightId === undefined) throw new Error('no insight');
    const { insight } = env.manager.respondInsight({ sessionId: id, insightId, response: 'known' });
    expect(insight.status).toBe('known');
    expect(
      env.manager.respondInsight({ sessionId: id, insightId, response: 'dismissed' }).insight
        .status,
    ).toBe('known');
    expect(insightEvents(env, id)).toHaveLength(2);
    expect(() =>
      env.manager.respondInsight({
        sessionId: id,
        insightId: 'isg_01JA2B3C4D5E6F7G8H9JKMNPQR',
        response: 'known',
      }),
    ).toThrow(/not found/u);

    // 不到 10 分钟：做满 3 件也不检查。
    for (const n of [4, 5, 6]) await turn(env, id, `approve ${n}`);
    await settle();
    expect(env.inputs).toHaveLength(1);
    // 过了 10 分钟，下一个回合结束就检查（上次之后已经做了 4 件）。
    now = INSIGHT_MIN_INTERVAL_MS;
    await turn(env, id, 'approve 7');
    await vi.waitFor(() => expect(env.inputs).toHaveLength(2));
    expect(env.inputs[1]).toContain('<offered>\n- agent 往工作区外写了文件。\n</offered>');
    expect(env.inputs[1]).toContain('<known>\n- 工作区外多了一个文件：agent 往工作区外写了文件。');
  });

  it('还有没处理的一条时不再检查；模型说没有时不写事件', async () => {
    let now = 0;
    let found = false;
    const env = setup({ now: () => now, output: async () => (found ? FOUND : NOTHING) });
    const id = await newSession(env);
    for (const n of [1, 2, 3]) await turn(env, id, `approve ${n}`);
    await vi.waitFor(() => expect(env.inputs).toHaveLength(1));
    await settle();
    expect(insightEvents(env, id)).toHaveLength(0);

    found = true;
    now = INSIGHT_MIN_INTERVAL_MS;
    for (const n of [4, 5, 6]) await turn(env, id, `approve ${n}`);
    await vi.waitFor(() => expect(insightEvents(env, id)).toHaveLength(1));
    now = 3 * INSIGHT_MIN_INTERVAL_MS;
    for (const n of [7, 8, 9]) await turn(env, id, `approve ${n}`);
    await settle();
    expect(env.inputs).toHaveLength(2);
  });

  it('设置关着（默认）不发请求；只聊天的回合也不检查', async () => {
    const off = setup({ enabled: () => false });
    const a = await newSession(off);
    for (const n of [1, 2, 3]) await turn(off, a, `approve ${n}`);
    await settle();
    expect(off.inputs).toHaveLength(0);

    const chat = setup();
    const b = await newSession(chat);
    for (const n of [1, 2, 3, 4]) await turn(chat, b, `你好 ${n}`);
    await settle();
    expect(chat.inputs).toHaveLength(0);
  });

  it('请求失败只记告警，会话不受影响', async () => {
    const env = setup({ output: async () => Promise.reject(new Error('boom')) });
    const id = await newSession(env);
    for (const n of [1, 2, 3]) await turn(env, id, `approve ${n}`);
    await vi.waitFor(() => expect(env.warnings).toContain('“你应该知道”的检查失败'));
    expect(insightEvents(env, id)).toHaveLength(0);
    expect(env.events.snapshot(id)?.session.state).toBe('idle');
  });
});
