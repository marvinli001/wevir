import { describe, expect, it } from 'vitest';
import { type BotEvent, type BotSource, BotStore } from './bot-store';
import { type Bot, type BotPost, botKey, postPreview, sortBots } from './bots';

function bot(id: string, patch: Partial<Bot> = {}): Bot {
  return {
    key: botKey('mac', id),
    id,
    computer: 'mac',
    computerName: 'Mac',
    name: id,
    description: '',
    avatar: { type: 'pebble', color: 0, seed: 0 },
    state: 'idle',
    unreadCount: 0,
    createdAt: '2026-10-20T00:00:00Z',
    ...patch,
  };
}

function text(seq: number, value = `#${seq}`): BotPost {
  return {
    id: `cpo_${seq}`,
    seq,
    author: 'bot',
    createdAt: new Date(Date.UTC(2026, 9, 23, 0, seq)).toISOString(),
    card: { kind: 'text', text: value },
  };
}

/** 一个助理、45 条旧消息的假来源。 */
function fakeSource() {
  const posts = Array.from({ length: 45 }, (_, i) => text(i + 1));
  const listeners = new Set<(event: BotEvent) => void>();
  const read: string[] = [];
  const source: BotSource = {
    list: async () => [bot('a', { unreadCount: 3 }), bot('b')],
    posts: async (_key, beforeSeq, limit) => {
      const list = posts.filter((p) => beforeSeq === undefined || p.seq < beforeSeq);
      return { posts: list.slice(-limit), hasMore: list.length > limit };
    },
    post: async (_key, value) => {
      const post = { ...text(posts.length + 1, value), author: 'user' as const };
      posts.push(post);
      return post;
    },
    decide: async (_key, postId, decision) => {
      const post = posts.find((p) => p.id === postId) as BotPost;
      return { ...post, card: { kind: 'suggestion', text: 'x', decision } };
    },
    markRead: async (key) => {
      read.push(key);
    },
    create: async (input) => bot('new', { name: input.name, avatar: input.avatar }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: BotEvent) => {
    for (const l of listeners) l(event);
  };
  return { source, emit, read };
}

describe('bot store', () => {
  it('opens the newest page, loads older pages and marks the bot read', async () => {
    const { source, read } = fakeSource();
    const store = new BotStore(source);
    await store.start();
    const key = botKey('mac', 'a');
    await store.open(key);
    expect(store.timeline(key).posts.map((p) => p.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 26),
    );
    expect(store.timeline(key).hasMore).toBe(true);
    expect(store.bot(key)?.unreadCount).toBe(0);
    expect(read).toEqual([key]);

    await store.loadOlder(key);
    expect(store.timeline(key).posts[0]?.seq).toBe(6);
    await store.loadOlder(key);
    expect(store.timeline(key).posts).toHaveLength(45);
    expect(store.timeline(key).hasMore).toBe(false);
  });

  it('appends sent and pushed posts once, and updates the list preview', async () => {
    const { source, emit } = fakeSource();
    const store = new BotStore(source);
    await store.start();
    const key = botKey('mac', 'b');
    await store.open(key);
    await store.send(key, '  hello  ');
    // 订阅又推来同一条。
    emit({ kind: 'post', key, post: store.timeline(key).posts.at(-1) as BotPost });
    const posts = store.timeline(key).posts;
    expect(posts.filter((p) => p.seq === 46)).toHaveLength(1);
    expect(store.bot(key)?.lastPost?.text).toBe('hello');
    // 有动静的排到前面。
    expect(store.list[0]?.key).toBe(key);
    await store.send(key, '   ');
    expect(store.timeline(key).posts).toHaveLength(posts.length);
  });

  it('replaces a decided card in place', async () => {
    const { source } = fakeSource();
    const store = new BotStore(source);
    await store.start();
    const key = botKey('mac', 'a');
    await store.open(key);
    await store.decide(key, 'cpo_40', 'approved');
    const card = store.timeline(key).posts.find((p) => p.id === 'cpo_40')?.card;
    expect(card).toEqual({ kind: 'suggestion', text: 'x', decision: 'approved' });
  });

  it('sorts bots waiting on the user first, then by last activity', () => {
    const at = (iso: string) => ({ text: '', at: iso });
    const sorted = sortBots([
      bot('old', { lastPost: at('2026-10-20T00:00:00Z') }),
      bot('new', { lastPost: at('2026-10-23T00:00:00Z') }),
      bot('waiting', { state: 'waiting', lastPost: at('2026-10-01T00:00:00Z') }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(['waiting', 'new', 'old']);
  });

  it('previews every card kind as one line', () => {
    expect(postPreview({ kind: 'text', text: 'a\n b' })).toBe('a b');
    expect(postPreview({ kind: 'brief', todo: [], done: ['done'], decide: ['decide'] })).toBe(
      'decide',
    );
    expect(
      postPreview({
        kind: 'approval',
        action: 'email',
        target: 'x',
        subject: 'Re: date',
        text: 'body',
        decision: 'pending',
      }),
    ).toBe('Re: date');
    expect(
      postPreview({
        kind: 'thread',
        sessionId: 's',
        title: 'Fix CI',
        project: 'p',
        status: 'working',
      }),
    ).toBe('Fix CI');
  });
});
