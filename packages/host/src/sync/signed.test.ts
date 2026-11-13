import { generateKeyPairSync, sign } from 'node:crypto';
import { jcs } from '@wevir/protocol/sync';
import { describe, expect, it } from 'vitest';
import { verifySyncSignature } from './signed.js';

describe('sync signed metadata', () => {
  it('verifies the frozen JCS signing preimage and rejects changed content, keys and encodings', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const body = {
      protocol: 'wevir-sync-snapshot/1',
      vaultId: 'vault_synthetic',
      restoreId: 'restore_synthetic',
      snapshotCursor: 'cursor_synthetic',
      operationsSha256: 'a'.repeat(43),
      blobManifestSha256: 'b'.repeat(43),
      signingKeyId: 'signing_synthetic',
    };
    const signed = {
      ...body,
      signature: sign(null, Buffer.from(jcs(body)), privateKey).toString('base64url'),
    };
    const keys = new Map([
      [body.signingKeyId, String(publicKey.export({ type: 'spki', format: 'pem' }))],
    ]);
    expect(() => verifySyncSignature(signed, keys)).not.toThrow();
    for (const candidate of [
      { ...signed, vaultId: 'vault_other' },
      { ...signed, signingKeyId: 'signing_other' },
      { ...signed, signature: `${signed.signature}=` },
    ])
      expect(() => verifySyncSignature(candidate, keys)).toThrow('INTEGRITY_FAILED');
    expect(() =>
      verifySyncSignature(signed, new Map([[body.signingKeyId, 'invalid key']])),
    ).toThrow('INTEGRITY_FAILED');
  });
});
