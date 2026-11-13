import { z } from 'zod';
import { PortablePreviewSchema } from './portable.js';
import { decimal, entityType, id, schemas } from './sync-wire.js';

export const SyncRecoveryStatusSchema = z.object({
  vaultId: id,
  request: z.object(schemas.recoveryState.shape).optional(),
  keyEpoch: decimal.optional(),
  unlocked: z.boolean(),
});
export const SyncRecoveryJournalSchema = z.strictObject({
  v: z.literal(1),
  origin: z.string(),
  accountId: id,
  deviceId: id,
  vaultId: id,
  request: schemas.recoveryState.optional(),
  requestedEpoch: decimal.optional(),
  unlockedEpoch: decimal.optional(),
});

export const SyncLifecycleMethodSchemas = {
  'sync.recoveryInfo': {
    params: z.object({}),
    result: z.object({
      vaultId: id.optional(),
      keyEpoch: decimal.optional(),
      eligible: z.boolean(),
      manageUrl: z.string().url(),
      deviceId: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.recoveryRequest': {
    params: z.object({ vaultId: id }),
    result: SyncRecoveryStatusSchema,
    permission: 'host.manage',
  },
  'sync.recoveryStatus': {
    params: z.object({ vaultId: id, refresh: z.boolean().optional() }),
    result: SyncRecoveryStatusSchema,
    permission: 'host.manage',
  },
  'sync.recoveryComplete': {
    params: z.object({ vaultId: id, requestId: id }),
    result: SyncRecoveryStatusSchema,
    permission: 'host.manage',
  },
  'sync.recoverySnapshot': {
    params: z.object({ vaultId: id, jobId: id.optional() }),
    result: z.object({
      jobId: id,
      restoreId: id,
      projectIds: z.array(id),
      operations: z.int().nonnegative(),
      expiresAt: z.iso.datetime(),
    }),
    permission: 'host.manage',
  },
  'sync.recoveryDownload': {
    params: z.object({
      vaultId: id,
      jobId: id,
      categories: z.array(entityType).min(1).max(9),
      projectIds: z.array(id).max(1000),
    }),
    result: PortablePreviewSchema,
    permission: 'host.manage',
  },
  'sync.unlockKeys': {
    params: z.object({ vaultId: id }),
    result: SyncRecoveryStatusSchema,
    permission: 'host.manage',
  },
  'sync.deleteCloud': {
    params: z.object({ vaultId: id, stepUpId: id }),
    result: z.object(schemas.deleted.shape),
    permission: 'host.manage',
  },
  'sync.detach': {
    params: z.object({ vaultId: id }),
    result: z.object({ detached: z.literal(true) }),
    permission: 'host.manage',
  },
} as const;
