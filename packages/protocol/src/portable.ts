import { z } from 'zod';
import { SessionSchema } from './entities.js';
import { WevirEventSchema } from './events.js';
import { SyncRelativePathSchema } from './sync-content.js';
import { digest, entityType, id, packRecord, schemas } from './sync-wire.js';

export const PortableVersionSchema = z.strictObject({
  vaultId: id,
  entityId: id,
  opId: id,
  entityType,
  record: packRecord,
  operation: schemas.operation.optional(),
  manifest: schemas.recordManifest.optional(),
});
export const PortableLocalFilesSchema = z.object({
  schema: z.literal('wevir-portable-files/1'),
  files: z
    .array(
      z.object({
        key: z.string(),
        path: SyncRelativePathSchema,
        bytes: z.int().nonnegative(),
        sha256: digest,
        parts: z.array(id),
      }),
    )
    .max(100000),
});

export const PortableEntrySchema = z.strictObject({
  id,
  kind: z.enum([
    'project',
    'session',
    'events',
    'episode',
    'retro',
    'settings',
    'memory',
    'file',
    'version',
    'references',
  ]),
  key: z.string().min(1).max(4096),
  bytes: z
    .int()
    .min(0)
    .max(2 * 1024 * 1024),
  sha256: digest,
  encoding: z.enum(['json', 'binary']),
  path: SyncRelativePathSchema.optional(),
  vaultId: id.optional(),
  entityId: id.optional(),
  opId: id.optional(),
});
export const PORTABLE_RECOVERY_INSTRUCTIONS =
  'Decrypted content; no subscription, vault key or engine credentials required. Keep this directory private. Imported history is a read-only mirror; restoring a version creates a new local operation.';
export const PortableManifestSchema = z.strictObject({
  schema: z.literal('wevir-portable/1'),
  packageId: id,
  createdAt: z.iso.datetime(),
  hostProtocol: z.string(),
  protection: z.literal('plaintext'),
  consistency: z.enum(['database-cas-and-per-root-snapshots', 'fixed-signed-snapshot']),
  omissions: z.array(z.string().max(2048)).max(10000),
  recovery: z.literal(PORTABLE_RECOVERY_INSTRUCTIONS),
  entries: z.array(PortableEntrySchema).max(100000),
});
export type PortableManifest = z.infer<typeof PortableManifestSchema>;
export const PortablePreviewSchema = z.object({
  importId: id,
  packageId: id,
  path: z.string(),
  createdAt: z.iso.datetime(),
  protection: z.literal('plaintext'),
  entries: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  counts: z.record(z.string(), z.int().nonnegative()),
  omissions: z.array(z.string()),
  omissionCount: z.int().nonnegative().optional(),
  state: z.enum(['exported', 'staged', 'imported']),
});
export const PortableConversationSchema = z.object({
  session: SessionSchema,
  events: z.array(WevirEventSchema),
});
export const PortableMethodSchemas = {
  'sync.cancelRecovery': {
    params: z.object({}),
    result: z.object({ cancelled: z.boolean() }),
    permission: 'host.manage',
  },
  'sync.exportLocal': {
    params: z.object({ directory: z.string().min(1).max(4096).optional() }),
    result: PortablePreviewSchema,
    permission: 'host.manage',
  },
  'sync.importPrepare': {
    params: z.object({ path: z.string().min(1).max(4096) }),
    result: PortablePreviewSchema,
    permission: 'host.manage',
  },
  'sync.importApply': {
    params: z.object({ importId: id }),
    result: PortablePreviewSchema,
    permission: 'host.manage',
  },
  'sync.importList': {
    params: z.object({}),
    result: z.object({ packages: z.array(PortablePreviewSchema) }),
    permission: 'host.manage',
  },
  'sync.importRead': {
    params: z.object({ importId: id, after: z.int().min(0).optional() }),
    result: z.object({
      entries: z.array(PortableEntrySchema),
      next: z.int().nonnegative().optional(),
    }),
    permission: 'host.manage',
  },
  'sync.importEntry': {
    params: z.object({ importId: id, entryId: id }),
    result: z.object({ entry: PortableEntrySchema, base64: z.string().max(3 * 1024 * 1024) }),
    permission: 'host.manage',
  },
  'sync.importConversation': {
    params: z.object({
      importId: id,
      sessionId: z.string().min(1),
      afterSeq: z.int().nonnegative().optional(),
    }),
    result: PortableConversationSchema.extend({ next: z.int().nonnegative().optional() }),
    permission: 'host.manage',
  },
} as const;
