import type { Channel } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BotStore, PAGE_SIZE } from './bot-store';
import {
  approval,
  at,
  CHANNEL_A,
  CHANNEL_B,
  channel,
  FakeChannels,
  post,
  thread,
} from './bot-test-utils';
import { botKey } from './bots';

const KEY = botKey('mac', CHANNEL_A);

function setup(options: { posts?: number; canCreate?: boolean } = {}) {
  const host = new FakeChannels({ canCreate: options.canCreate });
  host.channels = [
    channel(CHANNEL_A, { unreadCount: 2, lastPostSeq: options.posts ?? 0 }),
    channel(CHANNEL_B, { lastPost: { seq: 1, author: 'host', preview: '早', at: at(90) } }),
  ];
  for (let seq = 1; seq <= (options.posts ?? 0); seq++) host.add(post(CHANNEL_A, seq));
  const store = new BotStore();
  store.setHosts([{ computer: 'mac', computerName: 'MacBook', client: host.client }]);
  return { host, store };
}

describe('BotStore', () => {
  it('每台在线的电脑读自己的助理，合并成一个按最后动静排的列表', async () => {
    const { store } = setup();
    const other = new FakeChannels();
    other.channels = [channel(CHANNEL_A, { title: '代码巡检', state: 'waiting' })];
    store.setHosts([
      { computer: 'mac', computerName: 'MacBook', client: setup().host.client },
      { computer: 'studio', computerName: 'Mac Studio', client: other.client },
      { computer: 'off', computerName: 'Offline', client: undefined },
    ]);
    await vi.waitFor(() => expect(store.list).toHaveLength(3));
    expect(store.list.map((b) => [b.computerName, b.name])).toEqual([
      ['Mac Studio', '代码巡检'],
      ['MacBook', '读书笔记'],
      ['MacBook', '小管家'],
    ]);
    expect(store.loaded).toBe(true);
  });

  it('离线后助理留在列表里，电脑被移除时一起去掉', async () => {
    const { host, store } = setup();
    await vi.waitFor(() => expect(store.list).toHaveLength(2));
    store.setHosts([{ computer: 'mac', computerName: 'MacBook', client: undefined }]);
    expect(store.list).toHaveLength(2);
    expect(host.listenerCount).toBe(0);
    store.setHosts([]);
    expect(store.list).toHaveLength(0);
  });

  it('打开时订阅并取最新一页，往上翻取更早的', async () => {
    const { host, store } = setup({ posts: 45 });
    await store.open(KEY);
    expect(host.calls('channel.subscribe')).toEqual([{ channelId: CHANNEL_A }]);
    let timeline = store.timeline(KEY);
    expect(timeline.loading).toBe(false);
    expect(timeline.posts.map((p) => p.seq)).toEqual(
      Array.from({ length: PAGE_SIZE }, (_, i) => 45 - PAGE_SIZE + 1 + i),
    );
    expect(timeline.hasMore).toBe(true);
    await store.loadOlder(KEY);
    timeline = store.timeline(KEY);
    expect(timeline.posts).toHaveLength(45);
    expect(timeline.hasMore).toBe(false);
  });

  it('新帖、帖子与线程、审批的更新跟着订阅改', async () => {
    const { host, store } = setup({ posts: 3 });
    await store.open(KEY);
    const sub = host.lastSub();
    host.posted(sub, post(CHANNEL_A, 4));
    host.posted(sub, post(CHANNEL_A, 4));
    expect(store.timeline(KEY).posts.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
    const root = post(CHANNEL_A, 2, { routedTo: [thread(post(CHANNEL_A, 2).id).sessionId] });
    host.updated({
      posts: [root],
      threads: [thread(root.id)],
      approvals: [approval()],
      channel: channel(CHANNEL_A, { state: 'working' }),
    });
    const timeline = store.timeline(KEY);
    expect(timeline.posts[1]?.routedTo).toHaveLength(1);
    expect(timeline.threads).toHaveLength(1);
    expect(timeline.approvals).toHaveLength(1);
    expect(store.bot(KEY)?.state).toBe('working');
  });

  it('列表变化：版本接上就改，接不上重读；重连后重读并按最后一条的 seq 重订', async () => {
    const { host, store } = setup({ posts: 3 });
    await store.open(KEY);
    host.changed({
      listVersion: 2,
      upserted: [channel(CHANNEL_B, { title: '旅行' })],
      removed: [],
    });
    expect(store.list.map((b) => b.name)).toContain('旅行');
    const lists = host.calls('channel.list').length;
    host.changed({ listVersion: 9, upserted: [], removed: [CHANNEL_B] });
    await vi.waitFor(() => expect(host.calls('channel.list')).toHaveLength(lists + 1));
    host.add(post(CHANNEL_A, 4));
    host.add(post(CHANNEL_A, 5));
    host.changed(undefined);
    await vi.waitFor(() => expect(store.timeline(KEY).posts).toHaveLength(5));
    expect(host.calls('channel.subscribe').at(-1)).toEqual({ channelId: CHANNEL_A, afterSeq: 3 });
  });

  it('发帖、采纳提议、批准审批', async () => {
    const { host, store } = setup({ posts: 1 });
    const suggestion = post(CHANNEL_A, 2, {
      card: { kind: 'suggestion', text: '周五前回复', status: 'open' },
    });
    host.add(suggestion);
    host.approvals = [approval()];
    await store.open(KEY);
    await store.send(KEY, '  好的  ');
    expect(host.calls('channel.post')[0]).toMatchObject({
      channelId: CHANNEL_A,
      content: [{ type: 'text', text: '好的' }],
    });
    expect(store.timeline(KEY).posts.at(-1)?.author).toEqual({ kind: 'user' });
    await store.respondSuggestion(KEY, suggestion.id, true);
    expect(store.timeline(KEY).posts[1]?.card).toMatchObject({ status: 'accepted' });
    await store.respondApproval(KEY, approval().id, 'approved');
    expect(host.calls('approval.respond')).toEqual([
      { approvalId: approval().id, optionId: 'once' },
    ]);
    host.updated({ approvals: [] });
    expect(store.timeline(KEY).decided).toEqual([{ request: approval(), decision: 'approved' }]);
  });

  it('已读：只在有更新的 seq 时发，并清掉未读数', async () => {
    const { host, store } = setup({ posts: 3 });
    await store.open(KEY);
    await store.markRead(KEY);
    await store.markRead(KEY);
    expect(host.calls('channel.markRead')).toEqual([{ channelId: CHANNEL_A, seq: 3 }]);
    expect(store.bot(KEY)?.unreadCount).toBe(0);
  });

  it('建助理：要有权限，协调者沿用已有助理的 Provider，没有时用第一个启用的', async () => {
    const denied = setup();
    await vi.waitFor(() => expect(denied.store.list).toHaveLength(2));
    expect(denied.store.creators()).toEqual([]);
    await expect(
      denied.store.create({
        computer: 'mac',
        name: 'x',
        description: '',
        avatar: { type: 'pebble', color: 0, seed: 0 },
      }),
    ).rejects.toThrow();

    const { host, store } = setup({ canCreate: true });
    await vi.waitFor(() => expect(store.list).toHaveLength(2));
    expect(store.creators()).toEqual([{ computer: 'mac', name: 'MacBook' }]);
    const avatar = { type: 'drop' as const, color: 1, seed: 0.5 };
    const bot = await store.create({ computer: 'mac', name: '旅行', description: '行程', avatar });
    expect(host.calls('channel.create')[0]).toEqual({
      kind: 'assistant',
      name: '旅行',
      description: '行程',
      avatar,
      coordinator: { providerId: 'prov_1' },
    });
    expect(store.bot(bot.key)?.name).toBe('旅行');

    const empty = new FakeChannels({ canCreate: true });
    const fresh = new BotStore();
    fresh.setHosts([{ computer: 'mac', computerName: 'MacBook', client: empty.client }]);
    await vi.waitFor(() => expect(empty.calls('channel.list')).toHaveLength(1));
    await fresh.create({ computer: 'mac', name: 'n', description: '', avatar });
    expect(empty.calls('channel.create')[0]).toMatchObject({
      coordinator: { providerId: 'prov_on' as Channel['coordinator']['providerId'] },
    });
  });
});
