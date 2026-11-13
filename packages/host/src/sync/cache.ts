import { link, mkdir, open, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { id, LIMITS } from '@wevir/protocol/sync';
import { newId } from '../ids.js';
import { sha256 } from './crypto.js';

export class SyncBlobCache {
  readonly #directory: string;
  constructor(directory: string) {
    this.#directory = directory;
  }

  path(vaultId: string, blobId: string): string {
    return join(this.#directory, id.parse(vaultId), `${id.parse(blobId)}.bin`);
  }

  async assertSpace(vaultId: string, cipherBytes: number): Promise<void> {
    const directory = join(this.#directory, id.parse(vaultId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const disk = await statfs(directory, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(cipherBytes + LIMITS.plainBytes))
      throw Object.assign(new Error('sync cache disk full'), { code: 'ENOSPC' });
  }

  async put(
    vaultId: string,
    blobId: string,
    bytes: Uint8Array,
    expectedSha256: string,
  ): Promise<string> {
    if (bytes.byteLength > LIMITS.blobBytes || sha256(bytes) !== expectedSha256)
      throw new Error('sync cache integrity failed');
    const directory = join(this.#directory, id.parse(vaultId));
    await this.assertSpace(vaultId, bytes.byteLength);
    const path = this.path(vaultId, blobId);
    const temporary = join(directory, `.${blobId}.${newId('tmp')}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.read(vaultId, blobId, bytes.byteLength, expectedSha256);
      }
      if (process.platform !== 'win32') {
        const folder = await open(directory, 'r');
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      }
      return path;
    } finally {
      await unlink(temporary);
    }
  }

  async read(vaultId: string, blobId: string, size: number, digest: string): Promise<Buffer> {
    if (size < 1 || size > LIMITS.blobBytes) throw new Error('sync cache size invalid');
    const file = await open(this.path(vaultId, blobId), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== size) throw new Error('sync cache integrity failed');
      const bytes = await file.readFile();
      if (bytes.length !== size || sha256(bytes) !== digest)
        throw new Error('sync cache integrity failed');
      return bytes;
    } finally {
      await file.close();
    }
  }
}
