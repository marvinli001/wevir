import { WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode, type Session, type SessionId, type WorkspaceId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type ChangesClient, cachedChanges, loadChanges, problemOf, statusLetter } from './changes';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const WSP = 'wsp_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;

function fakeClient(
  overrides: Partial<ChangesClient> & { diff?: unknown; fail?: unknown } = {},
): ChangesClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (overrides.fail !== undefined) throw overrides.fail;
    if (method === 'session.get') {
      return { session: { id: SES, workspaceId: WSP } as unknown as Session };
    }
    if (method === 'workspace.diff') {
      expect(params).toEqual({ workspaceId: WSP, sessionId: SES, source: { kind: 'branch' } });
      return overrides.diff;
    }
    throw new Error(`unexpected ${method}`);
  });
  return {
    canRead: true,
    supportsDiff: true,
    supportsFiles: true,
    ...overrides,
    request: request as never,
  } as ChangesClient & { request: ReturnType<typeof vi.fn> };
}

describe('loadChanges', () => {
  it('reads the branch range of the session’s workspace and parses the patch', async () => {
    const client = fakeClient({
      diff: {
        repo: true,
        base: 'a'.repeat(40),
        baseRef: 'origin/main',
        branch: 'feature',
        patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
        files: [{ path: 'x', status: 'modified', added: 1, removed: 1 }],
        fileCount: 1,
        added: 1,
        removed: 1,
      },
    });
    const changes = await loadChanges(client, 'mac/ses', SES);
    expect(changes.workspaceId).toBe(WSP);
    expect(changes.files.map((f) => f.path)).toEqual(['x']);
    expect(changes.rows.get('x')?.map((r) => r.kind)).toEqual(['hunk', 'remove', 'add']);
    expect(cachedChanges('mac/ses')).toBe(changes);
  });

  it('says why it cannot read', async () => {
    await expect(loadChanges(fakeClient({ canRead: false }), 'k1', SES)).rejects.toMatchObject({
      problem: 'forbidden',
    });
    await expect(loadChanges(fakeClient({ supportsDiff: false }), 'k2', SES)).rejects.toMatchObject(
      { problem: 'unsupported' },
    );
    await expect(
      loadChanges(fakeClient({ diff: { repo: false } }), 'k3', SES),
    ).rejects.toMatchObject({ problem: 'not_repo' });
    const forbidden = new WevirRpcError('workspace.diff', {
      code: ErrorCode.DEVICE_FORBIDDEN,
      message: 'forbidden',
    });
    await expect(loadChanges(fakeClient({ fail: forbidden }), 'k4', SES)).rejects.toMatchObject({
      problem: 'forbidden',
    });
    await expect(
      loadChanges(fakeClient({ fail: new Error('socket closed') }), 'k5', SES),
    ).rejects.toMatchObject({ problem: 'failed' });
    expect(cachedChanges('k5')).toBeUndefined();
  });

  it('classifies other errors', () => {
    expect(problemOf(new Error('x'))).toBe('failed');
  });
});

describe('statusLetter', () => {
  it('maps git statuses to one letter', () => {
    expect(
      ['added', 'deleted', 'modified', 'renamed', 'copied', 'untracked', 'type_changed', 'new'].map(
        statusLetter,
      ),
    ).toEqual(['A', 'D', 'M', 'R', 'C', 'U', 'T', 'M']);
  });
});
