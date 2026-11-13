import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStorage, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory.js';
import { useTempDir } from '../test-utils.js';
import { SyncFilesCapture } from './files-capture.js';
import type { SyncDraftPayload } from './queue.js';

const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = tempDir();
  const memoryDir = join(home, 'memory');
  let storage = openStorage({ dataDir: home });
  cleanups.push(() => storage.close());
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'device_synthetic',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes('vault_synthetic', {
      revision: '1',
      enabled: true,
      categories: ['memory'],
      projectIds: [],
    });
  });
  let capture = new SyncFilesCapture({ storage, memoryDir });
  const vault = () => storage.sync.activeVault() as SyncVaultRecord;
  const memory = new MemoryStore({
    dir: memoryDir,
    beforeWrite: (path, text) => capture.beforeMemoryWrite(vault(), path, text),
  });
  return {
    home,
    memoryDir,
    memory,
    get storage() {
      return storage;
    },
    get capture() {
      return capture;
    },
    vault,
    reopen() {
      storage.close();
      storage = openStorage({ dataDir: home });
      capture = new SyncFilesCapture({ storage, memoryDir });
    },
  };
}

describe('durable local file capture', () => {
  it('keeps every saved revision and deletion before the next batch scan', async () => {
    const h = fixture();
    const saved = await h.memory.save('global', undefined, {
      name: 'synthetic-note',
      type: 'project',
      description: 'Synthetic',
      content: 'First revision',
    });
    await h.memory.update('global', undefined, 'synthetic-note', saved.note.revision, {
      content: 'Second revision',
    });
    await h.memory.delete('global', undefined, 'synthetic-note');
    const drafts = h.storage.sync.drafts(h.vault().vaultId);
    expect(drafts).toHaveLength(3);
    expect(drafts.map((value) => (value.content as SyncDraftPayload).body)).toMatchObject([
      { markdown: expect.stringContaining('First revision') },
      { markdown: expect.stringContaining('Second revision') },
      { deleted: true },
    ]);
    expect(drafts[1]?.parents).toEqual([drafts[0]?.opId]);
    expect(drafts[2]).toMatchObject({ kind: 'delete', parents: [drafts[1]?.opId] });
    expect(h.storage.sync.localWrites(h.vault().vaultId)).toEqual([]);
  });

  it('recovers a file promoted before SQLite finalization and retains an unpromoted intent without uploading it', async () => {
    const h = fixture();
    const path = join(h.memoryDir, 'global/synthetic-note.md');
    await mkdir(join(h.memoryDir, 'global'), { recursive: true });
    h.capture.beforeMemoryWrite(h.vault(), path, 'Synthetic promoted bytes');
    await writeFile(path, 'Synthetic promoted bytes');
    h.reopen();
    await h.capture.recoverWrites(h.vault());
    expect(h.storage.sync.drafts(h.vault().vaultId)).toHaveLength(1);
    await h.capture.recoverWrites(h.vault());
    expect(h.storage.sync.drafts(h.vault().vaultId)).toHaveLength(1);
    h.capture.beforeMemoryWrite(h.vault(), path, 'Synthetic unpromoted bytes');
    h.reopen();
    await h.capture.recoverWrites(h.vault());
    expect(await readFile(path, 'utf8')).toBe('Synthetic promoted bytes');
    expect(h.storage.sync.drafts(h.vault().vaultId)).toHaveLength(1);
    expect(h.storage.sync.localWrites(h.vault().vaultId)).toMatchObject([
      { state: 'abandoned', content: { markdown: 'Synthetic unpromoted bytes' } },
    ]);
  });
});
