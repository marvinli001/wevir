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
  it('rejects a package before queuing a dependency closure larger than the preparation limit', async () => {
    const h = fixture();
    h.storage.sync.setScopes(h.vault().vaultId, {
      ...h.vault(),
      categories: ['skill-bundle', 'artifact'],
    });
    const path = join(h.home, 'large-skill');
    await mkdir(path);
    for (let i = 0; i < 4095; i++) await writeFile(join(path, `${i}.md`), 'x');
    await expect(
      h.capture.bundle(
        h.vault(),
        { path, name: 'Large', category: 'skill-bundle', localKey: 'large-skill' },
        false,
        false,
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(h.storage.sync.drafts(h.vault().vaultId)).toEqual([]);
  }, 30000);
  it('does not queue an in-flight package after consent is withdrawn', async () => {
    const h = fixture();
    h.storage.sync.setScopes(h.vault().vaultId, {
      enabled: true,
      revision: '2',
      categories: ['artifact'],
      projectIds: [],
    });
    const directory = join(h.home, 'package');
    await mkdir(directory);
    await writeFile(join(directory, 'data.bin'), Buffer.alloc(192 * 1024, 42));
    let consented = true;
    const capture = new SyncFilesCapture({
      storage: h.storage,
      memoryDir: h.memoryDir,
      eligible: () => (consented ? h.storage.sync.activeVault() : undefined),
    });
    const reading = capture.prepareBundle(
      h.vault(),
      {
        category: 'artifact',
        localKey: 'synthetic:package',
        name: 'Synthetic package',
        path: directory,
      },
      false,
      false,
    );
    consented = false;
    await expect(reading).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    expect(h.storage.sync.drafts(h.vault().vaultId)).toEqual([]);
  });
  it('records absent and excluded shared paths without scanning siblings or retrying their upload', async () => {
    const h = fixture();
    h.storage.sync.setScopes(h.vault().vaultId, {
      revision: '2',
      enabled: true,
      categories: ['artifact'],
      projectIds: [],
    });
    const directory = join(h.home, 'shared');
    await mkdir(directory);
    await writeFile(join(directory, 'private.txt'), 'Synthetic sibling');
    await h.capture.bundle(
      h.vault(),
      {
        category: 'artifact',
        name: 'Synthetic',
        path: directory,
        localKey: 'shared-missing',
        paths: ['deleted.txt', '.env.test'],
      },
      false,
      false,
    );
    const bodies = h.storage.sync
      .drafts(h.vault().vaultId)
      .map((draft) => (draft.content as SyncDraftPayload).body);
    expect(bodies).toMatchObject([
      { schema: 'wevir-bundle/1', files: [], exclusions: ['deleted.txt', '.env.test'] },
    ]);
  });

  it('fixes selected file bytes with the business transaction and survives rollback and restart', async () => {
    const h = fixture();
    h.storage.sync.setScopes(h.vault().vaultId, {
      revision: '2',
      enabled: true,
      categories: ['artifact'],
      projectIds: [],
    });
    const directory = join(h.home, 'files');
    await mkdir(directory);
    await writeFile(join(directory, 'report.txt'), 'Synthetic before');
    await writeFile(join(directory, 'unselected.txt'), 'Synthetic not selected');
    const commit = await h.capture.prepareBundle(
      h.vault(),
      {
        category: 'artifact',
        name: 'Synthetic',
        path: directory,
        paths: ['report.txt'],
        localKey: 'synthetic-pending',
      },
      false,
      false,
    );
    if (!commit) throw new Error('missing prepared bundle');
    expect(h.storage.sync.drafts(h.vault().vaultId)).toEqual([]);
    await writeFile(join(directory, 'report.txt'), 'Synthetic after');
    expect(() =>
      h.storage.transaction(() => {
        commit('shared-one');
        throw new Error('Crash');
      }),
    ).toThrow('Crash');
    expect(h.storage.sync.drafts(h.vault().vaultId)).toEqual([]);
    h.storage.transaction(() => commit('shared-one'));
    h.reopen();
    const bodies = h.storage.sync
      .drafts(h.vault().vaultId)
      .map((draft) => (draft.content as SyncDraftPayload).body) as Array<{
      schema: string;
      data?: string;
      files?: Array<{ path: string }>;
    }>;
    expect(
      bodies.find((body) => body.schema === 'wevir-bundle/1')?.files?.map((file) => file.path),
    ).toEqual(['report.txt']);
    expect(
      Buffer.from(
        bodies.find((body) => body.schema === 'wevir-chunk/1')?.data ?? '',
        'base64url',
      ).toString(),
    ).toBe('Synthetic before');
  });

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
