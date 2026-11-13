import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { SyncBlobCache } from './cache.js';
import { sha256 } from './crypto.js';

const tempDir = useTempDir();
describe('immutable sync ciphertext cache', () => {
  it('accepts identical writes and never replaces a good object with reused identity', async () => {
    const cache = new SyncBlobCache(join(tempDir(), 'sync'));
    const bytes = Buffer.from('synthetic encrypted bytes');
    const digest = sha256(bytes);
    await cache.put('vault_fixture', 'blob_fixture', bytes, digest);
    await cache.put('vault_fixture', 'blob_fixture', bytes, digest);
    const changed = Buffer.from('different encrypted bytes');
    await expect(
      cache.put('vault_fixture', 'blob_fixture', changed, sha256(changed)),
    ).rejects.toThrow('integrity');
    expect(await cache.read('vault_fixture', 'blob_fixture', bytes.length, digest)).toEqual(bytes);
    expect(() => cache.path('vault_fixture', '../escape')).toThrow();
  });
});
