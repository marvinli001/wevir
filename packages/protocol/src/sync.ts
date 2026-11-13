import { z } from 'zod';
import { decimal, entityType, id, PROTOCOL } from './sync-wire.js';

export const SyncStatusSchema = z.object({
  protocol: z.literal(PROTOCOL),
  artifactRevision: z.literal(1),
  binding: z
    .object({
      vaultId: id,
      deviceId: id,
      enabled: z.boolean(),
      revision: decimal,
      categories: z.array(entityType),
      projectIds: z.array(id),
    })
    .optional(),
  pending: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const SyncMethodSchemas = {
  'sync.status': { params: z.object({}), result: SyncStatusSchema, permission: 'host.manage' },
} as const;
