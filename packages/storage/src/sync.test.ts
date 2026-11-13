import { describe, expect, it } from 'vitest';
import { openStorage } from './storage.js';
import type { SyncOperationRecord } from './sync.js';
import { seedSession, useTempStorage } from './test-utils.js';

const vault = {
  vaultId: 'vault_fixture',
  accountId: 'account_fixture',
  deviceId: 'device_fixture',
  originHostId: 'device_fixture',
  appliedCursor: 'cursor_initial',
};
const op = (overrides: Partial<SyncOperationRecord> = {}): SyncOperationRecord => ({
  vaultId: vault.vaultId,
  opId: 'operation_first',
  deviceId: vault.deviceId,
  deviceSeq: '1',
  entityType: 'memory',
  entityId: 'entity_fixture',
  envelope: {},
  manifest: {},
  digest: 'digest_fixture',
  record: { text: 'synthetic memory' },
  direction: 'outbox',
  state: 'queued',
  ...overrides,
});

describe('durable sync mappings', () => {
  const { storage, dataDir } = useTempStorage();
  const bind = () => storage().transaction(() => storage().sync.bindVault(vault));

  it('opens existing local data without a vault or content capture', () => {
    const session = seedSession(storage());
    expect(storage().sync.activeVault()).toBeUndefined();
    expect(storage().sessions.get(session.id)).toEqual(session);
    expect(storage().db.prepare('SELECT COUNT(*) AS n FROM sync_operations').get()?.n).toBe(0);
  });

  it('rolls local business writes, outbox and decimal sequence back together and survives restart', () => {
    const session = seedSession(storage());
    bind();
    const save = () => {
      const seq = storage().sync.nextDeviceSeq(vault.vaultId);
      storage().events.insert({
        sessionId: session.id,
        seq: 1,
        ts: '2026-11-13T00:00:00.000Z',
        type: 'user.message',
        source: 'host',
        payload: { text: 'synthetic' },
      });
      storage().sync.putOperation(op({ deviceSeq: seq }));
    };
    expect(() =>
      storage().transaction(() => {
        save();
        throw new Error('interrupted');
      }),
    ).toThrow('interrupted');
    expect(storage().events.list(session.id)).toEqual([]);
    expect(storage().sync.getVault(vault.vaultId)?.deviceSeq).toBe('0');
    storage().db.prepare('UPDATE sync_vaults SET device_seq = ?').run('9007199254740992');
    storage().transaction(save);
    storage().close();
    const reopened = openStorage({ dataDir: dataDir() });
    try {
      expect(reopened.events.list(session.id)).toHaveLength(1);
      expect(reopened.sync.operations(vault.vaultId, 'outbox', 'queued')[0]?.deviceSeq).toBe(
        '9007199254740993',
      );
      expect(reopened.sync.activeVault()?.deviceSeq).toBe('9007199254740993');
    } finally {
      reopened.close();
    }
  });

  it('requires explicit account unbinding, disables capture and preserves the previous queue', () => {
    bind();
    storage().transaction(() => storage().sync.putOperation(op()));
    const other = { ...vault, vaultId: 'vault_other', accountId: 'account_other' };
    expect(() => storage().transaction(() => storage().sync.bindVault(other))).toThrow(
      'VAULT_BOUND',
    );
    storage().sync.detachVault(vault.vaultId);
    storage().transaction(() => storage().sync.bindVault(other));
    expect(storage().sync.activeVault()).toMatchObject({ vaultId: other.vaultId, enabled: false });
    expect(storage().sync.operations(vault.vaultId, 'outbox', 'queued')).toHaveLength(1);
    expect(storage().sync.operations(other.vaultId, 'outbox', 'queued')).toEqual([]);
    storage().sync.detachVault(other.vaultId);
    expect(() =>
      storage().transaction(() =>
        storage().sync.bindVault({ ...vault, deviceId: 'reinstalled_device' }),
      ),
    ).toThrow('DEVICE_CHANGED');
  });

  it('keeps operation identity and entity/project binding immutable', () => {
    bind();
    storage().transaction(() => {
      expect(storage().sync.putOperation(op({ projectId: 'project_fixture' }))).toBe(true);
      expect(storage().sync.putOperation(op({ projectId: 'project_fixture' }))).toBe(false);
    });
    expect(() =>
      storage().transaction(() => storage().sync.putOperation(op({ digest: 'changed_manifest' }))),
    ).toThrow('OP_ID_REUSED');
    expect(() =>
      storage().transaction(() =>
        storage().sync.putOperation(
          op({ opId: 'operation_second', deviceSeq: '2', projectId: 'other_project' }),
        ),
      ),
    ).toThrow('PROJECT_CHANGED');
  });

  it('keeps concurrent heads and never resurrects a superseded revision on retry', () => {
    bind();
    const put = (opId: string, parents: string[], seq: string) => {
      storage().sync.putOperation(op({ opId, deviceSeq: seq, digest: opId }));
      storage().sync.applyHeads(vault.vaultId, 'entity_fixture', opId, parents);
    };
    storage().transaction(() => {
      put('operation_first', [], '1');
      put('operation_left', ['operation_first'], '2');
      put('operation_right', ['operation_first'], '3');
      storage().sync.applyHeads(vault.vaultId, 'entity_fixture', 'operation_first', []);
    });
    expect(storage().sync.heads(vault.vaultId, 'entity_fixture')).toEqual([
      'operation_left',
      'operation_right',
    ]);
    expect(() =>
      storage().transaction(() => put('operation_missing', ['missing_parent'], '4')),
    ).toThrow('MISSING_PARENT');
    expect(storage().sync.getOperation(vault.vaultId, 'operation_missing')).toBeUndefined();
    storage().transaction(() =>
      put('operation_resolved', ['operation_left', 'operation_right'], '5'),
    );
    expect(storage().sync.heads(vault.vaultId, 'entity_fixture')).toEqual(['operation_resolved']);
  });

  it('restarts a changed consent range without discarding operations or claiming unapplied pages', () => {
    bind();
    storage().transaction(() => {
      storage().sync.putOperation(op());
      storage().sync.putOperation(
        op({ opId: 'operation_inbox', deviceSeq: '2', direction: 'inbox', state: 'received' }),
      );
      storage().sync.putPage({
        vaultId: vault.vaultId,
        pageId: 'page_pending',
        fromCursor: vault.appliedCursor,
        nextCursor: 'cursor_unapplied',
        opIds: ['operation_inbox'],
      });
    });
    expect(() =>
      storage().transaction(() => {
        storage().sync.restartPull(vault.vaultId, vault.appliedCursor, 'cursor_replay');
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(storage().sync.pages(vault.vaultId)).toHaveLength(1);
    storage().transaction(() =>
      storage().sync.restartPull(vault.vaultId, vault.appliedCursor, 'cursor_replay'),
    );
    expect(storage().sync.activeVault()?.appliedCursor).toBe('cursor_replay');
    expect(storage().sync.pages(vault.vaultId)).toEqual([]);
    expect(storage().sync.getOperation(vault.vaultId, 'operation_inbox')?.state).toBe('received');
    expect(storage().sync.getOperation(vault.vaultId, 'operation_first')?.state).toBe('queued');
    expect(() =>
      storage().transaction(() =>
        storage().sync.restartPull(vault.vaultId, 'cursor_wrong', 'cursor_other'),
      ),
    ).toThrow('CURSOR_CONFLICT');
  });

  it('compares partial source overlaps by stream tuple and fingerprint', () => {
    bind();
    const source = {
      vaultId: vault.vaultId,
      hostId: 'host_remote',
      sessionId: 'session_remote',
      streamId: 'stream_remote',
      mirrored: true,
    };
    storage().sync.putSource(source);
    storage().sync.sourceEvent(source, '1', 'digest_1');
    storage().sync.sourceEvent(source, '2', 'digest_2');
    storage().sync.sourceEvent(source, '2', 'digest_2');
    expect(() => storage().sync.sourceEvent(source, '2', 'digest_conflict')).toThrow(
      'INTEGRITY_FAILED',
    );
    const branch = { ...source, streamId: 'stream_parallel' };
    storage().sync.putSource(branch);
    storage().sync.sourceEvent(branch, '2', 'digest_conflict');
    expect(() => storage().sync.putSource({ ...source, mirrored: false })).toThrow(
      'INTEGRITY_FAILED',
    );
  });

  it('advances an applied cursor only after every referenced operation is safe', () => {
    bind();
    storage().transaction(() => {
      storage().sync.putOperation(op({ direction: 'inbox', state: 'received' }));
      storage().sync.putPage({
        vaultId: vault.vaultId,
        pageId: 'page_fixture',
        fromCursor: vault.appliedCursor,
        nextCursor: 'cursor_after',
        opIds: ['operation_first'],
      });
    });
    expect(() =>
      storage().transaction(() => storage().sync.applyPage(vault.vaultId, 'page_fixture')),
    ).toThrow('INTEGRITY_FAILED');
    storage().sync.markOperation(
      vault.vaultId,
      'operation_first',
      'quarantined',
      'INTEGRITY_FAILED',
    );
    expect(() =>
      storage().transaction(() => storage().sync.applyPage(vault.vaultId, 'page_fixture')),
    ).toThrow();
    expect(storage().sync.activeVault()?.appliedCursor).toBe(vault.appliedCursor);
    storage().transaction(() => {
      storage().sync.markOperation(vault.vaultId, 'operation_first', 'applied');
      storage().sync.applyPage(vault.vaultId, 'page_fixture');
      storage().sync.applyPage(vault.vaultId, 'page_fixture');
    });
    expect(storage().sync.activeVault()?.appliedCursor).toBe('cursor_after');
  });
});
