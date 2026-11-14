import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { digest, entityType, id } from './sync-wire.js';

const heads = z
  .array(id)
  .max(32)
  .refine((values) => new Set(values).size === values.length);
const fingerprint = z.union([digest, z.literal('missing')]);
const target = z.object({
  targetId: id,
  name: z.string(),
  path: z.string(),
  fingerprint,
  managed: z.boolean(),
});
export const SyncVersionRestorePreviewSchema = z.object({
  importId: id,
  entryId: id,
  vaultId: id,
  entityId: id,
  entityType,
  versionFingerprint: digest,
  canRestore: z.boolean(),
  sourceVerified: z.boolean().optional(),
  reason: z
    .enum(['read_only', 'scope_disabled', 'different_vault', 'unmapped', 'reset_required'])
    .optional(),
  kind: z.enum(['memory', 'settings', 'session', 'project', 'bundle', 'workspace', 'history']),
  selectedText: z.string().max(160000),
  currentText: z.string().max(160000),
  selectedDeleted: z.boolean().optional(),
  currentDeleted: z.boolean().optional(),
  truncated: z.boolean().optional(),
  expectedHeads: heads,
  localRevision: id.optional(),
  localFingerprint: fingerprint.optional(),
  targetId: id.optional(),
  expectedTargetId: id.optional(),
  targetPath: z.string().optional(),
  targets: z.array(target).max(1000).optional(),
  sessionId: SessionIdSchema.optional(),
  localSeq: z.int().nonnegative().optional(),
});
export const SyncVersionRestoreMethodSchemas = {
  'sync.importRestorePreview': {
    params: z.object({ importId: id, entryId: id, targetId: id.optional() }),
    result: SyncVersionRestorePreviewSchema,
    permission: 'host.manage',
  },
  'sync.importRestore': {
    params: z.object({
      importId: id,
      entryId: id,
      vaultId: id,
      entityId: id,
      versionFingerprint: digest,
      expectedHeads: heads,
      localRevision: id.optional(),
      localFingerprint: fingerprint.optional(),
      targetId: id.optional(),
      expectedTargetId: id.optional(),
      sessionId: SessionIdSchema.optional(),
      localSeq: z.int().nonnegative().optional(),
    }),
    result: z.object({ opId: id, entityId: id }),
    permission: 'host.manage',
  },
} as const;
