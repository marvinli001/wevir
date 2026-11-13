import { z } from 'zod';
import { digest, id, LIMITS, schemas } from './sync-wire.js';

const MAX_OPERATIONS = 50000;
export const SyncSnapshotJobSchema = z.strictObject({
  v: z.literal(1),
  jobId: id,
  vaultId: id,
  accountId: id,
  deviceId: id,
  origin: z.string().min(1).max(2048),
  state: z.enum(['creating', 'listing', 'verified', 'failed']),
  exported: schemas.exported.optional(),
  exportedDigest: digest.optional(),
  pages: z
    .array(
      z.strictObject({
        digest,
        count: z.int().min(0).max(LIMITS.operations),
        fromCursor: z.string().max(512),
        nextCursor: z.string().min(1).max(512),
        hasMore: z.boolean(),
      }),
    )
    .max(MAX_OPERATIONS + 1),
  errorCode: z.string().max(64).optional(),
});
export type SyncSnapshotJob = z.infer<typeof SyncSnapshotJobSchema>;

export const SyncSnapshotEntriesSchema = z
  .array(z.strictObject({ operation: schemas.operation, recordManifest: schemas.recordManifest }))
  .max(LIMITS.operations);
export const SyncSigningKeysCacheSchema = z
  .array(z.tuple([id, z.string().min(40).max(1024)]))
  .max(1000);
