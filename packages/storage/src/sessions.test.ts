import { describe, expect, it } from 'vitest';
import { seedSession, session, T0, T1, T2, useTempStorage, workspace } from './test-utils.js';

describe('sessions', () => {
  const { storage } = useTempStorage();

  it('插入与读取，可选字段与 JSON 字段原样往返', () => {
    const s = storage();
    const full = seedSession(s, {
      reasoningEffort: 'high',
      title: '整理周报',
      state: 'running',
      activeTurn: { turnId: 'trn_01', startedAt: T1, clientMessageId: 'msg-1' },
      lastError: { category: 'provider', message: 'rate limited' },
      lastSeq: 7,
    });
    expect(s.sessions.get('ses_01')).toEqual(full);
    expect(s.sessions.get('ses_missing')).toBeUndefined();
  });

  it('按引擎会话 ID 查找', () => {
    const s = storage();
    const record = seedSession(s);
    expect(s.sessions.getByEngineSessionId('dsh', record.engineSessionId)).toEqual(record);
    expect(s.sessions.getByEngineSessionId('other', record.engineSessionId)).toBeUndefined();
  });

  it('(engine, engine_session_id) 唯一', () => {
    const s = storage();
    const record = seedSession(s);
    expect(() => s.sessions.insert({ ...record, id: 'ses_02' })).toThrow(
      /UNIQUE constraint failed: sessions\.engine, sessions\.engine_session_id/,
    );
    // 不同引擎种类可以有相同的会话 ID。
    s.sessions.insert({ ...record, id: 'ses_02', engine: 'other' });
  });

  it('id 唯一', () => {
    const s = storage();
    const record = seedSession(s);
    expect(() => s.sessions.insert({ ...record, engineSessionId: 'another' })).toThrow(
      /UNIQUE constraint failed: sessions\.id/,
    );
  });

  it('工作区必须存在', () => {
    expect(() => storage().sessions.insert(session({ workspaceId: 'ws_missing' }))).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('更新缓存字段；null 清空 JSON 字段；未给的字段不变', () => {
    const s = storage();
    seedSession(s);
    const activeTurn = { turnId: 'trn_01', startedAt: T1 };
    expect(
      s.sessions.update('ses_01', { state: 'running', activeTurn, lastSeq: 3, updatedAt: T1 }),
    ).toBe(true);
    expect(s.sessions.get('ses_01')).toEqual(
      session({ state: 'running', activeTurn, lastSeq: 3, updatedAt: T1 }),
    );

    s.sessions.update('ses_01', {
      state: 'idle',
      activeTurn: null,
      title: '标题',
      titleSource: 'user',
      lastError: { category: 'unknown', message: 'x' },
    });
    expect(s.sessions.get('ses_01')).toEqual(
      session({
        title: '标题',
        titleSource: 'user',
        lastError: { category: 'unknown', message: 'x' },
        lastSeq: 3,
        updatedAt: T1,
      }),
    );
    expect(s.sessions.update('ses_missing', { state: 'idle' })).toBe(false);
    expect(() => s.sessions.update('ses_01', {})).toThrow(TypeError);
  });

  it('列表按更新时间倒序，默认隐藏已移除工作区的会话，可按工作区过滤', () => {
    const s = storage();
    s.workspaces.insert(workspace({ id: 'ws_a', rootPath: '/a' }));
    s.workspaces.insert(workspace({ id: 'ws_b', rootPath: '/b' }));
    seedSession(s, { id: 'ses_1', workspaceId: 'ws_a', engineSessionId: 'e1', updatedAt: T0 });
    seedSession(s, { id: 'ses_2', workspaceId: 'ws_a', engineSessionId: 'e2', updatedAt: T2 });
    seedSession(s, { id: 'ses_3', workspaceId: 'ws_b', engineSessionId: 'e3', updatedAt: T1 });

    const ids = (options?: Parameters<typeof s.sessions.list>[0]) =>
      s.sessions.list(options).map((x) => x.id);
    expect(ids()).toEqual(['ses_2', 'ses_3', 'ses_1']);
    expect(ids({ workspaceId: 'ws_a' })).toEqual(['ses_2', 'ses_1']);

    s.workspaces.markRemoved('ws_a', T2);
    expect(ids()).toEqual(['ses_3']);
    expect(ids({ workspaceId: 'ws_a' })).toEqual([]);
    expect(ids({ includeRemovedWorkspaces: true })).toEqual(['ses_2', 'ses_3', 'ses_1']);
  });

  it('统计未关闭的会话', () => {
    const s = storage();
    seedSession(s, { id: 'ses_1', engineSessionId: 'e1', state: 'idle' });
    seedSession(s, { id: 'ses_2', engineSessionId: 'e2', state: 'closed' });
    seedSession(s, { id: 'ses_3', engineSessionId: 'e3', state: 'error', providerId: 'other' });
    expect(s.sessions.countOpenByWorkspace('ws_01')).toBe(2);
    expect(s.sessions.countOpenByWorkspace('ws_missing')).toBe(0);
    expect(s.sessions.countOpenByProvider('deepseek-official')).toBe(1);
    expect(s.sessions.countOpenByProvider('other')).toBe(1);
  });
});
