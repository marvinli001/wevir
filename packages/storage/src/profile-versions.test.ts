import { describe, expect, it } from 'vitest';
import { session, T0, T1, T2, useTempStorage, workspace } from './test-utils.js';

describe('profile_versions', () => {
  const { storage } = useTempStorage();

  const next = (id: string, fingerprint: string, workspaceId?: string) => ({
    id,
    ...(workspaceId !== undefined && { workspaceId }),
    fingerprint,
    manifest: { layers: [{ key: 'rules', hash: fingerprint, items: [] }] },
    createdAt: T0,
  });

  it('指纹与最新版本相同就沿用，不同就按范围开下一个序号；改回旧样子也开新版本', () => {
    const db = storage();
    expect(db.profileVersions.ensure(next('pfv_1', 'a'))).toMatchObject({
      created: true,
      version: { id: 'pfv_1', seq: 1 },
    });
    expect(db.profileVersions.ensure(next('pfv_x', 'a'))).toMatchObject({
      created: false,
      version: { id: 'pfv_1', seq: 1 },
    });
    expect(db.profileVersions.ensure(next('pfv_2', 'b')).version.seq).toBe(2);
    expect(db.profileVersions.ensure(next('pfv_3', 'a')).version.seq).toBe(3);
    // 项目与全局各自编号。
    expect(db.profileVersions.ensure(next('pfv_p1', 'a', 'ws_01')).version.seq).toBe(1);

    expect(db.profileVersions.latest(undefined)?.id).toBe('pfv_3');
    expect(db.profileVersions.latest('ws_01')?.id).toBe('pfv_p1');
    expect(db.profileVersions.latest('ws_02')).toBeUndefined();
    expect(db.profileVersions.previous(undefined, 3)?.id).toBe('pfv_2');
    expect(db.profileVersions.previous(undefined, 1)).toBeUndefined();
    expect(db.profileVersions.list(undefined).map((v) => v.id)).toEqual([
      'pfv_3',
      'pfv_2',
      'pfv_1',
    ]);
    expect(db.profileVersions.list(undefined, { beforeSeq: 3, limit: 1 }).map((v) => v.id)).toEqual(
      ['pfv_2'],
    );
    expect(db.profileVersions.get('pfv_p1')).toEqual({ ...next('pfv_p1', 'a', 'ws_01'), seq: 1 });
    expect(db.profileVersions.manifests()).toHaveLength(4);
  });

  it('会话记下版本：按版本数会话、列会话', () => {
    const db = storage();
    db.workspaces.insert(workspace());
    db.profileVersions.ensure(next('pfv_1', 'a', 'ws_01'));
    db.sessions.insert(
      session({ id: 'ses_a', engineSessionId: 'eng_a', createdAt: T1, profileVersionId: 'pfv_1' }),
    );
    db.sessions.insert(
      session({ id: 'ses_b', engineSessionId: 'eng_b', createdAt: T2, profileVersionId: 'pfv_1' }),
    );
    db.sessions.insert(session({ id: 'ses_c', createdAt: T2, engineSessionId: 'eng_c' }));
    expect(db.sessions.get('ses_a')?.profileVersionId).toBe('pfv_1');
    expect(db.sessions.get('ses_c')?.profileVersionId).toBeUndefined();
    expect(db.profileVersions.sessionCounts(['pfv_1', 'pfv_2'])).toEqual(new Map([['pfv_1', 2]]));
    expect(db.profileVersions.sessionIds('pfv_1', 10)).toEqual(['ses_b', 'ses_a']);
    expect(db.profileVersions.sessionIds('pfv_1', 1)).toEqual(['ses_b']);
  });
});
