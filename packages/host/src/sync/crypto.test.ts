// Adapted from wevir-zuv packages/sync-protocol/src/protocol.test.ts
// Commit: 7e9f90f6d859ce352490cb5fc6b74ee58b5a2912; MIT, contracts/wevir-sync/v1/LICENSE.
import { createCipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { jcs } from '@wevir/protocol/sync';
import { describe, expect, it } from 'vitest';
import { decryptPack, encryptPack, eventDigest, parseEnvelope, sha256 } from './crypto.js';

const root = new URL('../../../../contracts/wevir-sync/v1/', import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

describe('wevir-sync/1 public crypto vectors', () => {
  it('verifies stable domain-separated source events', () => {
    for (const vector of read('event-hash-vectors.json').vectors)
      expect(eventDigest(vector.source, vector.event)).toBe(vector.sha256);
  });
  it('reproduces and decrypts both golden envelopes and rejects tampering/wrong references', async () => {
    for (const vector of read('crypto-vectors.json').vectors) {
      const vaultKey = Buffer.from(vector.vaultKey, 'base64url');
      const bytes = await encryptPack(
        {
          vaultId: vector.operation.vaultId,
          blobId: vector.operation.payload.blobId,
          keyEpoch: '1',
          vaultKey,
          records: vector.pack,
          compression: vector.name,
        },
        {
          dek: Buffer.from(vector.dek, 'base64url'),
          nonce: Buffer.from(vector.nonce, 'base64url'),
        },
      );
      // Deflate output varies across zlib versions; the frozen gzip envelope must still decrypt.
      if (vector.name === 'none') expect(bytes.toString('base64url')).toBe(vector.envelope);
      const golden = Buffer.from(vector.envelope, 'base64url');
      expect(sha256(golden)).toBe(vector.cipherSha256);
      expect(
        await decryptPack(golden, vaultKey, [vector.operation], [vector.recordManifest]),
      ).toEqual(vector.pack);
      expect(
        await decryptPack(bytes, vaultKey, [vector.operation], [vector.recordManifest]),
      ).toEqual(vector.pack);
      const broken = Buffer.from(bytes);
      broken[broken.length - 1] = (broken.at(-1) ?? 0) ^ 1;
      await expect(
        decryptPack(broken, vaultKey, [vector.operation], [vector.recordManifest]),
      ).rejects.toThrow();
      await expect(
        decryptPack(
          bytes,
          vaultKey,
          [{ ...vector.operation, entityId: 'wrong_entity' }],
          [vector.recordManifest],
        ),
      ).rejects.toThrow();
      await expect(
        decryptPack(
          bytes,
          vaultKey,
          [vector.operation],
          [{ ...vector.recordManifest, projectId: 'wrong_project' }],
        ),
      ).rejects.toThrow();
    }
  });
  it('rejects an authenticated compression bomb before parsing its expanded records', async () => {
    const vector = read('crypto-vectors.json').vectors[0];
    const original = parseEnvelope(Buffer.from(vector.envelope, 'base64url'));
    const plain = Buffer.from(
      jcs({
        ...vector.pack,
        records: [{ ...vector.pack.records[0], content: 'x'.repeat(1000000) }],
      }),
    );
    const compressed = gzipSync(plain);
    const aad = Buffer.from(
      jcs({ ...original.header, compression: 'gzip', plainBytes: plain.length }),
    );
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(vector.dek, 'base64url'),
      Buffer.from(original.header.nonce, 'base64url'),
    );
    cipher.setAAD(aad);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(aad.length);
    const bytes = Buffer.concat([
      prefix,
      aad,
      cipher.update(compressed),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await expect(
      decryptPack(
        bytes,
        Buffer.from(vector.vaultKey, 'base64url'),
        [vector.operation],
        [vector.recordManifest],
      ),
    ).rejects.toThrow('expansion ratio');
  });
  it('returns only records verified against committed envelopes and manifests', async () => {
    const vector = read('crypto-vectors.json').vectors[0];
    const key = Buffer.from(vector.vaultKey, 'base64url');
    const records = {
      v: 1 as const,
      records: [
        ...vector.pack.records,
        { ...vector.pack.records[0], opId: 'unreferenced_op', content: 'must not be applied' },
      ],
    };
    const bytes = await encryptPack({
      vaultId: vector.operation.vaultId,
      blobId: vector.operation.payload.blobId,
      keyEpoch: '1',
      vaultKey: key,
      records,
    });
    const verified = await decryptPack(bytes, key, [vector.operation], [vector.recordManifest]);
    expect(verified).toEqual(vector.pack);
  });
});
