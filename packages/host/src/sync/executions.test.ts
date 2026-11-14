import { join } from 'node:path';
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

describe('execution claim lifecycle fencing', () => {
  it.each([
    ['stop', 'accepted'],
    ['stop', 'rejected'],
    ['identity', 'accepted'],
    ['identity', 'rejected'],
    ['timeout', 'rejected'],
    ['finish', 'accepted'],
    ['clock', 'accepted'],
  ] as const)(
    'ignores a late %s claim response when %s',
    async (change, outcome) => {
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
      let accept = (_result: unknown) => {};
      let reject = (_error: Error) => {};
      const pending = new Promise((resolve, fail) => {
        accept = resolve;
        reject = fail;
      });
      const request = vi.fn((...args: unknown[]) => {
        if (String(args[2]).endsWith('/release'))
          return Promise.resolve({
            runId: native.id,
            epoch: '1',
            fencingToken: 'fence_synthetic',
            expiresAt: new Date().toISOString(),
            branchRequired: false,
          });
        if (change !== 'timeout') return pending;
        const signal = (args[4] as { signal: AbortSignal }).signal;
        return new Promise((_, fail) => {
          const timer = setTimeout(() => fail(new ZuvRequestError('NETWORK_ERROR')), 15000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              fail(new ZuvRequestError('NETWORK_ERROR'));
            },
            { once: true },
          );
        });
      });
      const executions = new SyncExecutions({
        storage,
        events,
        capture,
        eligible,
        client: {
          json: request,
          transport: { serverNow: () => serverNow },
        } as unknown as ZuvClient,
      });
      cleanup.push(() => executions.stop());
      const serverNow = Date.now();
      if (change === 'clock') vi.spyOn(Date, 'now').mockReturnValue(serverNow + 120000);
      const started = performance.now();
      const prepared = executions.prepare(native.id as SessionId, 'trn_synthetic');
      await expect.poll(() => request.mock.calls.length).toBe(1);
      if (change === 'stop') executions.stop();
      else if (change === 'identity') permitted = false;
      else if (change === 'finish') executions.finish(native.id as SessionId, 'trn_synthetic');
      if (change === 'timeout') {
        await prepared;
        const elapsed = performance.now() - started;
        process.stdout.write(`hung execution claim: ${elapsed.toFixed(1)}ms\n`);
        expect(elapsed).toBeLessThan(2500);
        expect(storage.sync.execution('vault_synthetic', native.id)?.state).toBe('offline');
        return;
      }
      if (outcome === 'accepted')
        accept({
          runId: native.id,
          epoch: '1',
          fencingToken: 'fence_synthetic',
          expiresAt: new Date(serverNow + 30000).toISOString(),
          branchRequired: false,
        });
      else reject(new ZuvRequestError('NETWORK_ERROR'));
      await prepared;
      if (change === 'clock') {
        expect(storage.sync.execution('vault_synthetic', native.id)?.state).toBe('claimed');
        return;
      }
      expect(storage.sync.execution('vault_synthetic', native.id)).toBeUndefined();
      expect(events.state(native.id as SessionId)?.syncExecution).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(change === 'finish' ? 2 : 1);
    },
    20000,
  );
});
