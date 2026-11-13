// Adapted from wevir-zuv packages/sync-protocol/src/crypto.ts
// Commit: 7e9f90f6d859ce352490cb5fc6b74ee58b5a2912; MIT, Copyright (c) 2026 Wevir Labs.
// License and frozen artifacts: contracts/wevir-sync/v1/.
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type BlobHeader,
  header,
  jcs,
  LIMITS,
  matchRecord,
  pack,
  type RecordManifest,
  type SyncOperation,
} from '@wevir/protocol/sync';

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('base64url');
export const eventDigest = (
  source: { vaultId: string; hostId: string; sessionId: string; streamId: string; seq: string },
  event: unknown,
) => sha256(jcs({ protocol: 'wevir-sync-event/1', ...source, event }));
const subtle = webcrypto.subtle;
const aesKey = (
  bytes: Uint8Array,
  name: 'AES-GCM' | 'AES-KW',
  usages: ('encrypt' | 'decrypt' | 'wrapKey' | 'unwrapKey')[],
) => subtle.importKey('raw', new Uint8Array(bytes), { name }, false, usages);

export function parseEnvelope(bytes: Uint8Array): {
  header: BlobHeader;
  aad: Buffer;
  cipher: Buffer;
} {
  const all = Buffer.from(bytes);
  if (all.length > LIMITS.blobBytes || all.length < 21) throw new Error('invalid envelope size');
  const length = all.readUInt32BE(0);
  if (length < 2 || length > LIMITS.headerBytes || length + 20 >= all.length)
    throw new Error('invalid header size');
  const aad = all.subarray(4, 4 + length);
  const parsed = header.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(aad)));
  if (!aad.equals(Buffer.from(jcs(parsed)))) throw new Error('header must be JCS');
  if (
    Buffer.from(parsed.wrappedDek, 'base64url').toString('base64url') !== parsed.wrappedDek ||
    Buffer.from(parsed.nonce, 'base64url').toString('base64url') !== parsed.nonce
  )
    throw new Error('noncanonical binary');
  return { header: parsed, aad, cipher: all.subarray(4 + length) };
}

export async function encryptPack(
  input: {
    vaultId: string;
    blobId: string;
    keyEpoch: string;
    vaultKey: Uint8Array;
    records: unknown;
    compression?: 'none' | 'gzip';
  },
  vector?: { dek: Uint8Array; nonce: Uint8Array },
): Promise<Buffer> {
  const plain = Buffer.from(jcs(pack.parse(input.records)));
  if (plain.length > LIMITS.plainBytes) throw new Error('pack too large');
  const compression = input.compression ?? 'none';
  const content = compression === 'gzip' ? gzipSync(plain) : plain;
  if (plain.length > content.length * LIMITS.expansionRatio) throw new Error('expansion ratio');
  const rawDek = vector?.dek ?? randomBytes(32);
  const nonce = vector?.nonce ?? randomBytes(12);
  const wrapping = await aesKey(input.vaultKey, 'AES-KW', ['wrapKey']);
  const dek = await subtle.importKey('raw', new Uint8Array(rawDek), 'AES-GCM', true, ['encrypt']);
  const wrapped = await subtle.wrapKey('raw', dek, wrapping, 'AES-KW');
  const h = header.parse({
    v: 1,
    vaultId: input.vaultId,
    blobId: input.blobId,
    keyEpoch: input.keyEpoch,
    cipher: 'AES-256-GCM',
    wrap: 'AES-KW',
    wrappedDek: Buffer.from(wrapped).toString('base64url'),
    nonce: Buffer.from(nonce).toString('base64url'),
    compression,
    plainBytes: plain.length,
    contentSchema: 'wevir-sync-pack/1',
  });
  const aad = Buffer.from(jcs(h));
  const cipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: aad, tagLength: 128 },
    dek,
    content,
  );
  const size = Buffer.alloc(4);
  size.writeUInt32BE(aad.length);
  const result = Buffer.concat([size, aad, Buffer.from(cipher)]);
  if (result.length > LIMITS.blobBytes) throw new Error('blob too large');
  return result;
}

export async function decryptPack(
  bytes: Uint8Array,
  vaultKey: Uint8Array,
  operations: SyncOperation[],
  manifests: RecordManifest[],
) {
  const envelope = parseEnvelope(bytes);
  const h = envelope.header;
  const wrapping = await aesKey(vaultKey, 'AES-KW', ['unwrapKey']);
  const dek = await subtle.unwrapKey(
    'raw',
    Buffer.from(h.wrappedDek, 'base64url'),
    wrapping,
    'AES-KW',
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const compressed = Buffer.from(
    await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(h.nonce, 'base64url'),
        additionalData: envelope.aad,
        tagLength: 128,
      },
      dek,
      envelope.cipher,
    ),
  );
  if (h.plainBytes > compressed.length * LIMITS.expansionRatio) throw new Error('expansion ratio');
  const plain =
    h.compression === 'gzip'
      ? gunzipSync(compressed, { maxOutputLength: LIMITS.plainBytes })
      : compressed;
  if (plain.length !== h.plainBytes) throw new Error('plain length mismatch');
  const result = pack.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  if (!plain.equals(Buffer.from(jcs(result)))) throw new Error('pack must be JCS');
  const verifiedIndices = new Set<number>();
  for (const op of operations) {
    if (op.vaultId !== h.vaultId || op.payload?.blobId !== h.blobId)
      throw new Error('blob reference mismatch');
    const record = result.records[op.payload.recordIndex];
    if (!record) throw new Error('record missing');
    const manifest = manifests.find((x) => x.opId === op.opId);
    if (!manifest) throw new Error('record manifest required');
    matchRecord(op, record, manifest);
    verifiedIndices.add(op.payload.recordIndex);
    for (const event of record.events ?? []) {
      if (
        !op.origin ||
        eventDigest(
          {
            vaultId: op.vaultId,
            hostId: op.origin.hostId,
            sessionId: op.origin.sessionId,
            streamId: op.origin.streamId,
            seq: event.seq,
          },
          event.content,
        ) !== event.sha256
      )
        throw new Error('event digest mismatch');
    }
  }
  return { v: result.v, records: result.records.filter((_, index) => verifiedIndices.has(index)) };
}
