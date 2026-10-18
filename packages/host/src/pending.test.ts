// R11：回合进行中发消息与 Host 设置经 RPC（host-api.md §3.1 session.send 的 delivery、pending.*、settings.*）。会话层的
// 规则在 session-manager.test.ts；这里只看线缆：功能声明、结果与事件的形状、settings.updated 的去向、settings.json。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

async function start(home = join(tempDir(), 'home')) {
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    home,
    logger: createLogger({ mirror: () => {} }),
  });
  running.push(host);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async () => {
    const client = await TestRpcClient.connect(host.url);
    clients.push(client);
    const frame = await client.hello(token);
    expect(frame.error).toBeUndefined();
    return { client, hello: frame.result };
  };
  return { home, host, connect };
}

describe('Host 设置（settings.*）', () => {
  it('默认插话；更新后写进 settings.json，调过 settings.* 的连接收到 settings.updated，别的连接收不到', async () => {
    const { home, connect, host } = await start();
    const { client: watcher, hello } = await connect();
    expect(hello.features).toMatchObject({ pending_messages: true, host_settings: true });
    const other = (await connect()).client;
    expect(await watcher.request('settings.get')).toEqual({
      settings: { sendWhileBusy: 'steer', sessionRecap: true },
    });

    const updater = (await connect()).client;
    expect(
      await updater.request('settings.update', { settings: { sendWhileBusy: 'queue' } }),
    ).toEqual({ settings: { sendWhileBusy: 'queue', sessionRecap: true } });
    await watcher.until(
      () =>
        watcher.notifications('settings.updated').find((p) => p.settings.sendWhileBusy === 'queue'),
      'settings.updated',
    );
    expect(other.notifications('settings.updated')).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({
      sendWhileBusy: 'queue',
      sessionRecap: true,
    });
    // 值没变不通知。
    await updater.request('settings.update', { settings: { sendWhileBusy: 'queue' } });
    expect(watcher.notifications('settings.updated')).toHaveLength(1);

    // 离开后摘要的开关（0.54.0）：默认开，关掉后写进文件，只改给出的字段。
    expect(await updater.request('settings.update', { settings: { sessionRecap: false } })).toEqual(
      { settings: { sendWhileBusy: 'queue', sessionRecap: false } },
    );
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toEqual({
      sendWhileBusy: 'queue',
      sessionRecap: false,
    });

    // Host 重启后从文件读回。
    await host.shutdown();
    running.splice(running.indexOf(host), 1);
    const again = await start(home);
    const { client } = await again.connect();
    expect(await client.request('settings.get')).toEqual({
      settings: { sendWhileBusy: 'queue', sessionRecap: false },
    });
  });
});

describe('回合进行中发消息（session.send 的 delivery、pending.*）', () => {
  it('插话与排队：结果带 pendingId，事件 pending.* 与 user.steered；快照带 pendingMessages', async () => {
    const { connect } = await start();
    const { client } = await connect();
    const workspaceDir = join(tempDir(), 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    const { workspace } = await client.request('workspace.add', { rootPath: workspaceDir });
    await client.request('provider.upsert', {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      defaultModelId: 'deepseek-chat',
      models: [],
    });
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: 'deepseek-official',
    });
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    const events = () => client.events(subscriptionId) as WevirEvent[];
    const text = (value: string) => [{ type: 'text', text: value }];

    const { turnId } = await client.request('session.send', {
      sessionId: session.id,
      content: text('please approve'),
    });
    const approval = await client.until(
      () => events().find((e) => e.type === 'approval.requested'),
      'approval.requested',
    );

    const steer = await client.request('session.send', {
      sessionId: session.id,
      content: text('also this'),
      delivery: 'steer',
    });
    expect(steer).toEqual({ pendingId: expect.stringMatching(/^pnd_/), seq: expect.any(Number) });
    const queue = await client.request('session.send', {
      sessionId: session.id,
      content: text('after that'),
      delivery: 'queue',
    });
    // 不带 delivery：旧行为。
    const busy = await client.call('session.send', {
      sessionId: session.id,
      content: text('old client'),
    });
    expect(busy.error).toMatchObject({ code: -32021 });

    const snapshot = await client.request('session.get', { sessionId: session.id });
    expect(snapshot.pendingMessages).toEqual([
      expect.objectContaining({ id: steer.pendingId, delivery: 'steer', status: 'waiting' }),
      expect.objectContaining({ id: queue.pendingId, delivery: 'queue', status: 'waiting' }),
    ]);
    expect(
      (await client.call('pending.cancel', { sessionId: session.id, pendingId: steer.pendingId }))
        .error,
    ).toMatchObject({ code: -32025, data: { pendingId: steer.pendingId, status: 'waiting' } });
    expect(
      (
        await client.call('pending.update', {
          sessionId: session.id,
          pendingId: 'pnd_01JA2B3C4D5E6F7G8H9JKMNPQR',
          content: text('x'),
        })
      ).error,
    ).toMatchObject({ code: -32014 });

    if (approval?.type !== 'approval.requested') throw new Error('no approval');
    await client.request('approval.respond', {
      approvalId: approval.payload.approval.id,
      optionId: 'allow-once',
    });
    await client.until(
      () => events().filter((e) => e.type === 'turn.finished').length === 2 || undefined,
      '排队的消息发出并结束',
    );
    const steered = events().find((e) => e.type === 'user.steered');
    expect(steered).toMatchObject({ payload: { turnId, pendingId: steer.pendingId } });
    const messages = events().filter((e) => e.type === 'user.message');
    expect(messages.map((e) => e.type === 'user.message' && e.payload.pendingId)).toEqual([
      undefined,
      queue.pendingId,
    ]);
    expect(
      events()
        .filter((e) => e.type === 'pending.updated')
        .map(
          (e) => e.type === 'pending.updated' && [e.payload.pending.id, e.payload.pending.status],
        ),
    ).toEqual([
      [steer.pendingId, 'inserted'],
      [queue.pendingId, 'sent'],
    ]);
    expect(await client.request('pending.resume', { sessionId: session.id })).toEqual({
      pendingMessages: [],
    });
  });
});
