// Adapted from wevir-zuv packages/sync-protocol/src/index.ts
// Commit: 7e9f90f6d859ce352490cb5fc6b74ee58b5a2912; MIT, Copyright (c) 2026 Wevir Labs.
// License and frozen artifacts: contracts/wevir-sync/v1/.
import canonicalize from 'canonicalize';
import { z } from 'zod';

export const PROTOCOL = 'wevir-sync/1' as const;
export const LIMITS = {
  transferBytesPerSecond: 1024 * 1024,
  transferMs: 15000,
  transferChunkBytes: 64 * 1024,
  blobBytes: 4 * 1024 * 1024,
  headerBytes: 8192,
  plainBytes: 16 * 1024 * 1024,
  expansionRatio: 64,
  operations: 256,
  commitBytes: 1024 * 1024,
  parents: 32,
  changeBytes: 1024 * 1024,
  projects: 1000,
} as const;
export const id = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
export const decimal = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
export const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const cursor = z.string().min(1).max(512);
export const entityType = z.enum([
  'project',
  'session',
  'event-segment',
  'settings',
  'memory',
  'rule',
  'skill-bundle',
  'artifact',
  'workspace-snapshot',
]);
export type EntityType = z.infer<typeof entityType>;
export const kind = z.enum(['append', 'put', 'delete', 'resolve']);
export const origin = z.strictObject({
  hostId: id,
  sessionId: id,
  streamId: id,
  fromSeq: decimal,
  throughSeq: decimal,
});
export const operation = z.strictObject({
  protocol: z.literal(PROTOCOL),
  vaultId: id,
  opId: id,
  deviceId: id,
  deviceSeq: decimal,
  entityType,
  entityId: id,
  kind,
  parents: z.array(id).max(LIMITS.parents),
  payload: z.strictObject({ blobId: id, recordIndex: z.number().int().min(0).max(255) }).optional(),
  origin: origin.optional(),
  clientTime: z.iso.datetime(),
});
export type SyncOperation = z.infer<typeof operation>;
export const packRecord = z.strictObject({
  opId: id,
  entityId: id,
  kind,
  parents: z.array(id).max(LIMITS.parents),
  projectId: id.optional(),
  content: z.json(),
  events: z
    .array(z.strictObject({ seq: decimal, sha256: digest, content: z.json() }))
    .max(4096)
    .optional(),
});
export const pack = z.strictObject({
  v: z.literal(1),
  records: z.array(packRecord).min(1).max(256),
});
const count = z.number().int().safe().nonnegative();
export const header = z.strictObject({
  v: z.literal(1),
  vaultId: id,
  blobId: id,
  keyEpoch: decimal,
  cipher: z.literal('AES-256-GCM'),
  wrap: z.literal('AES-KW'),
  wrappedDek: z.string().regex(/^[A-Za-z0-9_-]{54}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  compression: z.enum(['none', 'gzip']),
  plainBytes: z.number().int().min(1).max(LIMITS.plainBytes),
  contentSchema: z.literal('wevir-sync-pack/1'),
});
export type BlobHeader = z.infer<typeof header>;
export const recordManifest = z.strictObject({
  opId: id,
  blobId: id.optional(),
  recordIndex: z.number().int().min(0).max(255).optional(),
  projectId: id.optional(),
  events: z
    .array(z.strictObject({ seq: decimal, sha256: digest }))
    .max(4096)
    .optional(),
});
export type RecordManifest = z.infer<typeof recordManifest>;
export const publicKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: digest,
});
export const empty = z.strictObject({});
export const schemas = {
  signingKeys: z.strictObject({
    keys: z.array(z.strictObject({ keyId: id, publicKey: z.string().min(40).max(1024) })).max(1),
  }),
  operation,
  header,
  pack,
  entitlements: z.strictObject({
    vault: z
      .strictObject({
        vaultId: id,
        keyEpoch: decimal,
        keyState: z.enum(['pending', 'ready', 'approval-required']),
        state: z.enum(['initializing', 'active', 'deleting', 'deleted']),
      })
      .nullable(),
    protocol: z.literal(PROTOCOL),
    identity: z.strictObject({ userId: id, deviceId: id }),
    deviceScopes: z.array(z.enum(['identity', 'inference', 'sync', 'recovery'])).max(4),
    subscriptionState: z.enum(['active', 'inactive', 'expired', 'none']),
    syncState: z.enum(['disabled', 'ready', 'paused', 'deleting', 'recovery-required']),
    quota: z.record(z.string().max(64), count),
    retentionUntil: z.iso.datetime().nullable(),
    recovery: z.strictObject({ eligible: z.boolean(), requiresApproval: z.boolean() }),
    limits: z.record(z.string().max(64), count),
  }),
  devices: z.strictObject({
    devices: z
      .array(
        z.strictObject({
          deviceId: id,
          name: z.string().max(100),
          thumbprint: digest,
          revokedAt: z.iso.datetime().nullable(),
          originHostId: id,
          keyThroughEpoch: decimal,
          enabled: z.boolean(),
          revision: decimal,
        }),
      )
      .max(100),
  }),
  approved: z.strictObject({ approved: z.literal(true) }),
  applied: z.strictObject({ applied: z.literal(true) }),
  recoveryCompleted: z.strictObject({
    requestId: id,
    state: z.literal('completed'),
    keyEpoch: decimal,
  }),
  enrollmentStart: z.strictObject({
    publicKey,
    deviceType: z.enum(['desktop', 'cli', 'mobile', 'browser']),
    name: z.string().trim().min(1).max(100),
    codeChallenge: digest,
    codeChallengeMethod: z.literal('S256'),
  }),
  enrollmentStarted: z.strictObject({
    enrollmentId: id,
    verificationUri: z.url(),
    intervalMs: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  }),
  enrollmentPoll: z.strictObject({
    enrollmentId: id,
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  enrollmentPolled: z.union([
    z.strictObject({ state: z.literal('pending'), retryAfterMs: z.number().int().positive() }),
    z.strictObject({
      state: z.literal('approved'),
      deviceId: id,
      grant: z.string().min(16).max(256),
      expiresAt: z.iso.datetime(),
      clientId: z.literal('wevir'),
    }),
  ]),
  vaultOpen: z.strictObject({ consent: z.literal(true), protocol: z.literal(PROTOCOL) }),
  vaultOpened: z.strictObject({
    vaultId: id,
    deviceId: id,
    originHostId: id,
    keyEpoch: decimal,
    keyState: z.enum(['pending', 'ready', 'approval-required']),
    cursor,
  }),
  scopes: z.strictObject({
    expectedRevision: decimal,
    enabled: z.boolean(),
    categories: z.array(entityType).max(9),
    projectIds: z.array(id).max(LIMITS.projects),
  }),
  scopesUpdated: z.strictObject({
    revision: decimal,
    enabled: z.boolean(),
    categories: z.array(entityType),
    projectIds: z.array(id),
  }),
  approveDevice: z.strictObject({ keyEpoch: decimal }),
  unlock: z.strictObject({ keyEpoch: decimal }),
  unlocked: z.strictObject({ vaultId: id, keyEpoch: decimal, keyMaterial: digest }),
  reserveBlob: z.strictObject({
    blobId: id,
    cipherBytes: z.number().int().min(1).max(LIMITS.blobBytes),
    cipherSha256: digest,
    purpose: entityType,
  }),
  blobReserved: z.strictObject({ uploadId: id, expiresAt: z.iso.datetime() }),
  uploaded: z.strictObject({ blobId: id, state: z.literal('ready') }),
  recordManifest,
  commit: z.strictObject({
    commitId: id,
    operations: z.array(operation).min(1).max(LIMITS.operations),
    recordManifest: z.array(recordManifest).max(256),
  }),
  commitResult: z.union([
    z.strictObject({ state: z.literal('committed'), commitId: id, cursor }),
    z.strictObject({ state: z.literal('pending'), commitId: id }),
  ]),
  changes: z.strictObject({
    operations: z.array(operation).max(256),
    recordManifest: z.array(recordManifest).max(256),
    nextCursor: cursor,
    hasMore: z.boolean(),
  }),
  download: z.strictObject({ blobId: id, restoreId: id.optional() }),
  downloadReserved: z.strictObject({
    downloadId: id,
    expiresAt: z.iso.datetime(),
    cipherBytes: z.number().int().min(1).max(LIMITS.blobBytes),
    cipherSha256: digest,
  }),
  ack: z.strictObject({ cursor, restoreId: id.optional() }),
  executionClaim: z.strictObject({
    runId: id,
    expectedEpoch: decimal,
    leaseSeconds: z.number().int().min(10).max(120),
  }),
  executionRenew: z.strictObject({
    runId: id,
    expectedEpoch: decimal,
    fencingToken: id,
    leaseSeconds: z.number().int().min(10).max(120),
  }),
  executionRelease: z.strictObject({ runId: id, expectedEpoch: decimal, fencingToken: id }),
  execution: z.strictObject({
    runId: id,
    epoch: decimal,
    fencingToken: id,
    expiresAt: z.iso.datetime(),
    branchRequired: z.boolean(),
  }),
  recoveryRequest: z.strictObject({ vaultId: id }),
  recoveryComplete: z.strictObject({ requestId: id }),
  recoveryState: z.strictObject({
    requestId: id,
    state: z.enum(['requested', 'verified', 'approved', 'completed', 'cancelled']),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  }),
  recoveryExport: z.strictObject({ snapshotCursor: cursor.optional() }),
  exported: z.strictObject({
    restoreId: id,
    snapshotCursor: cursor,
    expiresAt: z.iso.datetime(),
    manifest: z
      .array(z.strictObject({ blobId: id, cipherBytes: z.number().int(), cipherSha256: digest }))
      .max(50000),
    snapshot: z.strictObject({
      protocol: z.literal('wevir-sync-snapshot/1'),
      vaultId: id,
      restoreId: id,
      snapshotCursor: cursor,
      operationsSha256: digest,
      blobManifestSha256: digest,
      signingKeyId: id,
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    }),
  }),
  deleteVault: z.strictObject({ stepUpId: id }),
  deleted: z.strictObject({
    state: z.enum(['retained', 'cleaning', 'deleted']),
    retentionUntil: z.iso.datetime(),
  }),
  error: z.strictObject({
    error: z.strictObject({
      code: z.enum([
        'AUTH_REQUIRED',
        'DEVICE_REVOKED',
        'SUBSCRIPTION_REQUIRED',
        'SCOPE_DISABLED',
        'QUOTA_EXCEEDED',
        'BUDGET_PAUSED',
        'RATE_LIMITED',
        'MISSING_PARENT',
        'OP_ID_REUSED',
        'BLOB_INCOMPLETE',
        'INTEGRITY_FAILED',
        'RESET_REQUIRED',
        'EXECUTION_CONFLICT',
        'RECOVERY_REQUIRED',
        'UPGRADE_REQUIRED',
        'INVALID_REQUEST',
        'NOT_FOUND',
        'REVISION_CONFLICT',
        'ENROLLMENT_EXPIRED',
        'STEP_UP_REQUIRED',
        'SERVICE_UNAVAILABLE',
      ]),
      message: z.string().max(200),
      retryAfterMs: z.number().int().positive().optional(),
      details: z
        .record(z.string().max(64), z.union([z.string().max(512), z.array(id).max(32)]))
        .optional(),
    }),
  }),
};
export type ErrorCode = z.infer<typeof schemas.error>['error']['code'];

export function jcs(value: unknown): string {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop() as { value: unknown; depth: number };
    if (current.depth > 64) throw new Error('JSON nesting limit');
    if (typeof current.value === 'string' && /[\uD800-\uDFFF]/u.test(current.value))
      throw new Error('invalid Unicode');
    if (current.value && typeof current.value === 'object') {
      for (const [key, child] of Object.entries(current.value)) {
        if (/[\uD800-\uDFFF]/u.test(key)) throw new Error('invalid Unicode');
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  const result = (canonicalize as unknown as (value: unknown) => string | undefined)(value);
  if (result === undefined) throw new Error('JSON value required');
  return result;
}

export function validateOperation(value: unknown): SyncOperation {
  const op = operation.parse(value);
  if (new Set(op.parents).size !== op.parents.length || op.parents.includes(op.opId))
    throw new Error('invalid parents');
  if (op.kind !== 'delete' && !op.payload) throw new Error('payload required');
  if (op.kind === 'resolve' && op.parents.length < 2)
    throw new Error('resolve requires concurrent heads');
  if (
    op.origin &&
    (BigInt(op.origin.throughSeq) < BigInt(op.origin.fromSeq) ||
      BigInt(op.origin.throughSeq) - BigInt(op.origin.fromSeq) > 4095n)
  )
    throw new Error('invalid origin range');
  return op;
}

export function matchRecord(
  op: SyncOperation,
  record: z.infer<typeof packRecord>,
  manifest?: RecordManifest,
): void {
  for (const k of ['opId', 'entityId', 'kind'] as const)
    if (op[k] !== record[k]) throw new Error('record mismatch');
  if (jcs(op.parents) !== jcs(record.parents)) throw new Error('record parents mismatch');
  if (
    manifest &&
    (manifest.opId !== op.opId ||
      manifest.blobId !== op.payload?.blobId ||
      manifest.recordIndex !== op.payload?.recordIndex ||
      manifest.projectId !== record.projectId ||
      jcs(manifest.events ?? []) !==
        jcs(record.events?.map(({ seq, sha256 }) => ({ seq, sha256 })) ?? []))
  )
    throw new Error('record manifest mismatch');
  if (op.origin) {
    const events = record.events;
    if (
      !events ||
      BigInt(events.length) !== BigInt(op.origin.throughSeq) - BigInt(op.origin.fromSeq) + 1n
    )
      throw new Error('event range mismatch');
    for (const [i, event] of events.entries())
      if (BigInt(event.seq) !== BigInt(op.origin.fromSeq) + BigInt(i))
        throw new Error('event sequence mismatch');
  }
}
