// Adapted from wevir-zuv packages/sync-protocol/src/recovery.ts (verifySigned).
// Commit: 7e9f90f6d859ce352490cb5fc6b74ee58b5a2912; MIT, Copyright (c) 2026 Wevir Labs.
// License: contracts/wevir-sync/v1/LICENSE.
import { createPublicKey, verify } from 'node:crypto';
import { jcs } from '@wevir/protocol/sync';
import { ZuvRequestError } from '../zuv/transport.js';

export function verifySyncSignature<T extends { signingKeyId: string; signature: string }>(
  value: T,
  publicKeys: ReadonlyMap<string, string>,
): void {
  const { signature, ...body } = value;
  const pem = publicKeys.get(value.signingKeyId);
  if (!pem) throw new ZuvRequestError('INTEGRITY_FAILED');
  try {
    const key = createPublicKey(pem);
    const bytes = Buffer.from(signature, 'base64url');
    if (
      key.asymmetricKeyType === 'ed25519' &&
      bytes.length === 64 &&
      bytes.toString('base64url') === signature &&
      verify(null, Buffer.from(jcs(body)), key, bytes)
    )
      return;
  } catch {
    // Invalid key material and invalid signatures have the same external error.
  }
  throw new ZuvRequestError('INTEGRITY_FAILED');
}
