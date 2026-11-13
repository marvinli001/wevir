import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { bundleFingerprint, snapshotBundle } from './bundle-snapshot.js';

const tempDir = useTempDir();
describe('bounded package snapshots', () => {
  it('canonicalizes names and ignores owned promotion scratch data without reading excluded files', async () => {
    const root = tempDir();
    await writeFile(join(root, 'z.txt'), 'Z');
    await writeFile(join(root, 'e\u0301.txt'), 'Unicode content');
    await writeFile(join(root, '.env'), 'Synthetic excluded value');
    await mkdir(join(root, '.wevir-sync-operation_fixture'));
    await writeFile(join(root, '.wevir-sync-operation_fixture/partial.next'), 'Transient bytes');
    const snapshot = await snapshotBundle({ path: root });
    expect(snapshot.files.map((file) => file.path)).toEqual(['z.txt', 'é.txt']);
    expect(snapshot.exclusions).toEqual(['.env']);
    expect(snapshot.fingerprint).toBe(
      bundleFingerprint({ ...snapshot, files: [...snapshot.files].reverse() }),
    );
    expect(
      bundleFingerprint({ files: [{ path: 'e\u0301.txt', sha256: 'synthetic' }], exclusions: [] }),
    ).toBe(bundleFingerprint({ files: [{ path: 'é.txt', sha256: 'synthetic' }], exclusions: [] }));
  });
  it('keeps explicit omissions and rejects duplicate selected paths before a package can be queued', async () => {
    const root = tempDir();
    await writeFile(join(root, 'kept.txt'), 'Kept');
    await writeFile(join(root, 'private.txt'), 'Synthetic omitted value');
    const snapshot = await snapshotBundle({ path: root, exclusions: ['private.txt'] });
    expect(snapshot.files.map((file) => file.path)).toEqual(['kept.txt']);
    expect(snapshot.exclusions).toEqual(['private.txt']);
    await expect(
      snapshotBundle({ path: root, paths: ['kept.txt', 'kept.txt'] }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
  });
});
