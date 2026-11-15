import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { SessionId } from '@wevir/protocol';
import { openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { EventStore } from '../event-store.js';
import { useTempDir } from '../test-utils.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { SyncEventCapture } from './capture.js';
import { SyncExecutions } from './executions.js';

const directory = useTempDir();
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function fixture() {
  const storage = openStorage({ dataDir: join(directory(), 'home') });
  cleanup.push(() => storage.close());
  storage.workspaces.insert(workspace({ id: 'ws_synthetic', rootPath: '/synthetic/project' }));
  const native = session({ id: 'ses_synthetic', workspaceId: 'ws_synthetic' });
  storage.sessions.insert(native);
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'device_synthetic',
      appliedCursor: 'cursor_synthetic',
    });
    storage.sync.setScopes('vault_synthetic', {
      revision: '1',
      enabled: true,
      categories: ['project', 'session', 'event-segment'],
      projectIds: ['project_synthetic'],
    });
    storage.sync.bindProject('vault_synthetic', 'project_synthetic', 'ws_synthetic');
    storage.sync.putExecution({
      vaultId: 'vault_synthetic',
      localSessionId: native.id,
      runId: native.id,
      epoch: '1',
      streamId: 'sst_synthetic',
      state: 'released',
    });
  });
  let permitted = true;
  const eligible = () => (permitted ? storage.sync.activeVault() : undefined);
  const capture = new SyncEventCapture({ storage, eligible });
  const events = new EventStore({
    storage,
    onAppendInTransaction: (batch) => capture.record(batch),
  });
  cleanup.push(() => events.close());
  events.append(native.id as SessionId, {
    type: 'session.created',
    source: 'host',
    payload: {
      workspaceId: 'ws_synthetic',
      cwd: '/synthetic/project',
      providerId: native.providerId,
      modelId: native.modelId,
    },
  });
  let epoch = '7';
  let held = false;
  const request = vi.fn(
    async (
      _name: string,
      _method: string,
      path: string,
      body: unknown,
      _options?: { signal?: AbortSignal },
    ) => {
      const input = body as { runId: string; expectedEpoch: string };
      if (path.endsWith('/claim')) {
        if (input.expectedEpoch !== epoch || held)
          throw new ZuvRequestError('EXECUTION_CONFLICT', 409);
        epoch = String(BigInt(epoch) + 1n);
      }
      return {
        runId: input.runId,
        epoch,
        fencingToken: 'fence_synthetic',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        branchRequired: false,
      };
    },
  );
  const read = vi.fn(async (_runId: string, _signal?: AbortSignal) => ({
    runId: native.id,
    epoch,
    state: held ? 'held' : 'released',
  }));
  const client = {
    json: request,
    executionState: read,
    transport: { serverNow: () => Date.now() },
  };
  const executions = new SyncExecutions({
    storage,
    events,
    capture,
    eligible,
    client: client as unknown as ZuvClient,
  });
  cleanup.push(() => executions.stop());
  return {
    executions,
    client,
    request,
    read,
    storage,
    native,
    current: () => storage.sync.execution('vault_synthetic', native.id),
    prepare: () => executions.prepare(native.id as SessionId, 'trn_synthetic'),
    hold: () => {
      held = true;
    },
    advance: () => {
      epoch = String(BigInt(epoch) + 1n);
    },
    revoke: () => {
      permitted = false;
    },
  };
}

describe('authoritative execution epoch recovery', () => {
  it.each([false, true])(
    'waits for a finished claim and its release before the next turn (legacy=%s)',
    async (legacy) => {
      const f = fixture();
      if (legacy) f.read.mockResolvedValue(undefined as never);
      let grant!: () => void, release!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        grant = resolve;
      });
      const releaseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let epoch = 1;
      f.request.mockImplementation(async (_name, _method, path, body) => {
        const input = body as { expectedEpoch: string };
        expect(input.expectedEpoch).toBe(String(epoch));
        if (path.endsWith('/claim')) {
          epoch++;
          if (epoch === 2) await claimGate;
        } else await releaseGate;
        return {
          runId: f.native.id,
          epoch: String(epoch),
          fencingToken: 'fence_synthetic',
          expiresAt: new Date(Date.now() + 30000).toISOString(),
          branchRequired: false,
        };
      });
      const first = f.prepare();
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      f.executions.finish(f.native.id as SessionId, 'trn_synthetic');
      const second = f.executions.prepare(f.native.id as SessionId, 'trn_next');
      try {
        expect(f.request.mock.calls[0]?.[4]?.signal?.aborted).toBe(false);
        grant();
        await vi.waitFor(() =>
          expect(f.request.mock.calls.some((call) => call[2].endsWith('/release'))).toBe(true),
        );
        expect(f.request.mock.calls.filter((call) => call[2].endsWith('/claim'))).toHaveLength(1);
        expect(f.current()).toMatchObject({ epoch: '2', turnId: 'trn_synthetic' });
        release();
        await Promise.all([first, second]);
        expect(f.current()).toMatchObject({ epoch: '3', state: 'claimed', turnId: 'trn_next' });
        expect(f.read).not.toHaveBeenCalled();
      } finally {
        grant();
        release();
        await Promise.allSettled([first, second]);
      }
    },
  );
  it('recovers a stale released epoch with one query and one CAS retry', async () => {
    const f = fixture();
    await f.prepare();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.filter((call) => call[2].endsWith('/claim')).map((call) => call[3]),
    ).toEqual([
      { runId: f.native.id, expectedEpoch: '1', leaseSeconds: 30 },
      { runId: f.native.id, expectedEpoch: '7', leaseSeconds: 30 },
    ]);
    expect(f.current()).toMatchObject({
      state: 'claimed',
      epoch: '8',
      fencingToken: 'fence_synthetic',
    });
  });

  it('keeps a live holder and remembers its epoch without inventing a lease', async () => {
    const f = fixture();
    f.hold();
    await f.prepare();
    expect(f.current()).toMatchObject({ state: 'conflict', epoch: '7' });
    expect(f.current()?.fencingToken).toBeUndefined();
    expect(f.current()?.expiresAt).toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not query after an uncertain claim failure', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new ZuvRequestError('NETWORK_ERROR'));
    await f.prepare();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: 'offline', epoch: '1' });
  });

  it('stops after a competing claim advances the queried epoch', async () => {
    const f = fixture();
    f.read.mockImplementationOnce(async () => {
      f.advance();
      return { runId: f.native.id, epoch: '7', state: 'released' };
    });
    await f.prepare();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.current()).toMatchObject({ state: 'conflict', epoch: '7' });
    expect(f.current()?.fencingToken).toBeUndefined();
  });

  it.each(['finish', 'identity', 'stop'] as const)(
    'discards a late query after %s',
    async (change) => {
      const f = fixture();
      let resolve = (_value: { runId: string; epoch: string; state: string }) => {};
      f.read.mockImplementationOnce(
        () =>
          new Promise((accept) => {
            resolve = accept;
          }),
      );
      const pending = f.prepare();
      await expect.poll(() => f.read.mock.calls.length).toBe(1);
      if (change === 'finish') f.executions.finish(f.native.id as SessionId, 'trn_synthetic');
      else if (change === 'identity') f.revoke();
      else f.executions.stop();
      resolve({ runId: f.native.id, epoch: '7', state: 'released' });
      await pending;
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.current()).toMatchObject({ state: 'released', epoch: '1' });
    },
  );

  it.each([
    { runId: 'other_synthetic', epoch: '7', state: 'released' },
    { runId: 'ses_synthetic', epoch: '0', state: 'absent' },
  ])('rejects an inconsistent query $runId/$epoch', async (value) => {
    const f = fixture();
    f.read.mockResolvedValueOnce(value);
    await f.prepare();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.current()?.epoch).toBe('1');
    expect(f.current()?.state).not.toBe('claimed');
  });

  it('shares one two-second deadline across the claim, query and retry', async () => {
    const f = fixture();
    f.request
      .mockImplementationOnce(async (_name, _method, _path, _body, options) => {
        await delay(1150, undefined, { signal: options?.signal });
        throw new ZuvRequestError('EXECUTION_CONFLICT', 409);
      })
      .mockImplementationOnce(async (_name, _method, _path, _body, options) => {
        await delay(1150, undefined, { signal: options?.signal });
        throw new Error('retry exceeded shared deadline');
      });
    f.read.mockImplementationOnce(async (_id, signal) => {
      await delay(600, undefined, { signal });
      return { runId: f.native.id, epoch: '7', state: 'released' };
    });
    const started = performance.now();
    await f.prepare();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(performance.now() - started).toBeLessThan(2400);
    expect(f.current()).toMatchObject({ epoch: '7', state: 'offline' });
  });
});
