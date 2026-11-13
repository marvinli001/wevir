import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { SyncStreamRefSchema } from './sync.js';
import { SyncRelativePathSchema } from './sync-content.js';
import { id } from './sync-wire.js';

export { type SyncWorkspaceMetadata, SyncWorkspaceMetadataSchema } from './sync-content.js';

export const SyncWorkspaceRefSchema = z.object({
  vaultId: id,
  entityId: id,
  opId: id,
});
export type SyncWorkspaceRef = z.infer<typeof SyncWorkspaceRefSchema>;

export const SyncWorkspaceSnapshotSchema = SyncWorkspaceRefSchema.extend({
  projectId: id,
  source: SyncStreamRefSchema,
  capturedAt: z.iso.datetime(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  exclusions: z.array(SyncRelativePathSchema).max(10000),
});

export const SyncWorkspaceMethodSchemas = {
  'sync.workspaceCapture': {
    params: z.object({
      sessionId: SessionIdSchema,
      untracked: z.array(SyncRelativePathSchema).max(1000).optional(),
    }),
    result: z.object({ snapshot: SyncWorkspaceSnapshotSchema }),
    permission: 'host.manage',
  },
  'sync.workspaceSnapshots': {
    params: z.object({ sessionId: SessionIdSchema }),
    result: z.object({ snapshots: z.array(SyncWorkspaceSnapshotSchema).max(100) }),
    permission: 'session.read',
  },
  'sync.workspaceRestore': {
    params: z.object({
      sessionId: SessionIdSchema,
      snapshot: SyncWorkspaceRefSchema,
      restoreId: id.optional(),
    }),
    result: z.object({
      restoreId: id,
      cwd: z.string(),
      sourceHead: z.string().nullable(),
      head: z.string(),
      requiresTrust: z.array(SyncRelativePathSchema).max(10000),
      modified: z.boolean().optional(),
      recoveredFrom: z
        .object({ deviceId: id, opId: id, source: SyncStreamRefSchema.optional() })
        .optional(),
    }),
    permission: 'host.manage',
  },
} as const;
