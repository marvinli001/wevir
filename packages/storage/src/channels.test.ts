import { describe, expect, it } from 'vitest';
import { T0, T1, useTempStorage } from './test-utils.js';

describe('channels', () => {
  const { storage } = useTempStorage();

  function channel() {
    const db = storage();
    db.channels.insert({
      id: 'chn_1',
      kind: 'assistant',
      workspaceId: 'ws_1',
      title: '收件箱',
      assistant: { description: 'x' },
      coordinator: { providerId: 'openai', mode: 'act', generation: 1 },
      budget: { dailyWakes: 20, dailyTokens: 200000 },
      createdAt: T0,
      updatedAt: T0,
    });
    return db;
  }

  it('帖子的 seq 逐条加一，同一个 clientPostId 返回原来那条', () => {
    const db = channel();
    const post = (id: string, clientPostId?: string) =>
      db.channels.appendPost({
        channelId: 'chn_1',
        id,
        author: { kind: 'user' },
        content: [{ type: 'text', text: id }],
        ...(clientPostId !== undefined && { clientPostId }),
        createdAt: T0,
      });
    expect(post('cpo_1', 'a')).toMatchObject({ created: true, post: { seq: 1 } });
    expect(post('cpo_2')).toMatchObject({ created: true, post: { seq: 2 } });
    expect(post('cpo_3', 'a')).toMatchObject({ created: false, post: { id: 'cpo_1', seq: 1 } });
    expect(db.channels.get('chn_1')?.lastPostSeq).toBe(2);
    expect(db.channels.posts('chn_1', { limit: 1 }).map((p) => p.id)).toEqual(['cpo_2']);
    expect(db.channels.posts('chn_1', { afterSeq: 0, limit: 10 }).map((p) => p.seq)).toEqual([
      1, 2,
    ]);
    expect(db.channels.posts('chn_1', { beforeSeq: 2, limit: 10 }).map((p) => p.seq)).toEqual([1]);
    db.channels.setRoutedTo('cpo_1', ['ses_1']);
    expect(db.channels.getPost('cpo_1')?.routedTo).toEqual(['ses_1']);
  });

  it('未读按各读者的最大值，只数非用户的帖子', () => {
    const db = channel();
    for (const [id, kind] of [
      ['cpo_1', 'user'],
      ['cpo_2', 'coordinator'],
      ['cpo_3', 'host'],
    ] as const) {
      db.channels.appendPost({
        channelId: 'chn_1',
        id,
        author: { kind },
        content: [],
        createdAt: T0,
      });
    }
    expect(db.channels.countUnread('chn_1', db.channels.seenSeq('chn_1'))).toBe(2);
    db.channels.markRead('chn_1', 'dev_1', 2);
    db.channels.markRead('chn_1', 'local', 1);
    db.channels.markRead('chn_1', 'dev_1', 1);
    expect(db.channels.seenSeq('chn_1')).toBe(2);
    expect(db.channels.countUnread('chn_1', 2)).toBe(1);
  });

  it('改、暂停、软删、线程与用量', () => {
    const db = channel();
    expect(
      db.channels.update('chn_1', {
        title: '邮件',
        pausedAt: T1,
        pauseReason: 'budget',
        updatedAt: T1,
      }),
    ).toBe(true);
    expect(db.channels.get('chn_1')).toMatchObject({
      title: '邮件',
      pausedAt: T1,
      pauseReason: 'budget',
    });
    db.channels.update('chn_1', { pausedAt: null, pauseReason: null, updatedAt: T1 });
    expect(db.channels.get('chn_1')?.pausedAt).toBeUndefined();
    db.channels.insertThread({
      sessionId: 'ses_1',
      channelId: 'chn_1',
      rootPostId: 'cpo_1',
      openedBy: 'coordinator',
      createdAt: T0,
    });
    db.channels.resolveThread('ses_1', { resolvedAt: T1, resolvedBy: 'user' });
    expect(db.channels.threads('chn_1')).toEqual([
      expect.objectContaining({ sessionId: 'ses_1', resolvedAt: T1, resolvedBy: 'user' }),
    ]);
    db.channels.addUsage('chn_1', '2026-10-12', { wakes: 1, tokens: 500 });
    db.channels.addUsage('chn_1', '2026-10-12', { tokens: 250 });
    expect(db.channels.usage('chn_1', '2026-10-12')).toEqual({
      day: '2026-10-12',
      wakes: 1,
      tokens: 750,
    });
    expect(db.channels.softDelete('chn_1', T1)).toBe(true);
    expect(db.channels.list()).toEqual([]);
    expect(db.channels.get('chn_1')?.deletedAt).toBe(T1);
  });
});
