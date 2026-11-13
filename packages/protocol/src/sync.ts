import { z } from 'zod';
import { SessionIdSchema, WorkspaceIdSchema } from './common.js';
import { decimal, entityType, id, PROTOCOL, schemas } from './sync-wire.js';

export const SyncStreamRefSchema = z.object({
  hostId: id,
  deviceId: id,
  sessionId: SessionIdSchema,
  streamId: id,
});
export type SyncStreamRef = z.infer<typeof SyncStreamRefSchema>;
export const SyncSourceOriginSchema = SyncStreamRefSchema.extend({ vaultId: id, seq: decimal });

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
  state: z
    .enum([
      'disabled',
      'configuring',
      'approval_required',
      'pending',
      'syncing',
      'idle',
      'paused',
      'attention',
      'reset_required',
      'revoked',
    ])
    .optional(),
  errorCode: z.string().max(64).optional(),
  lastSyncAt: z.iso.datetime().optional(),
  includeHistory: z.boolean().optional(),
  projects: z
    .array(
      z.object({
        projectId: id,
        workspaceId: WorkspaceIdSchema.optional(),
        displayName: z.string().max(256),
      }),
    )
    .optional(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const SyncConfigureParamsSchema = z.object({
  enabled: z.boolean(),
  categories: z.array(entityType).max(9),
  projects: z
    .array(z.object({ workspaceId: WorkspaceIdSchema, projectId: id.optional() }))
    .max(1000),
  includeHistory: z.boolean().optional(),
  expectedRevision: decimal.optional(),
});
export type SyncConfigureParams = z.infer<typeof SyncConfigureParamsSchema>;
export const SyncFailureDataSchema = z.object({
  code: z.string().min(1).max(64),
  retryAfterMs: z.number().int().positive().optional(),
});

export const SyncProjectCatalogSchema = z.object({
  projects: z
    .array(
      z.object({
        projectId: id,
        versions: z
          .array(
            z.object({
              opId: id,
              displayName: z.string().max(256).optional(),
              repoUrl: z.string().max(2048).optional(),
              deleted: z.boolean(),
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .max(1000),
});

export const SyncMethodSchemas = {
  'sync.projectCatalog': {
    params: z.object({ enable: z.boolean().optional() }),
    result: SyncProjectCatalogSchema,
    permission: 'host.manage',
  },
  'sync.resolveProject': {
    params: z.object({
      projectId: id,
      expectedHeads: z
        .array(id)
        .min(2)
        .max(32)
        .refine((heads) => new Set(heads).size === heads.length),
      selectedOpId: id,
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
  'sync.status': { params: z.object({}), result: SyncStatusSchema, permission: 'host.manage' },
  'sync.configure': {
    params: SyncConfigureParamsSchema,
    result: SyncStatusSchema,
    permission: 'host.manage',
  },
  'sync.retry': { params: z.object({}), result: SyncStatusSchema, permission: 'host.manage' },
  'sync.devices': {
    params: z.object({}),
    result: z.object({
      devices: z.array(z.object(schemas.devices.shape.devices.element.shape)).max(100),
    }),
    permission: 'host.manage',
  },
  'sync.approveDevice': {
    params: z.object({ deviceId: id }),
    result: z.object(schemas.approved.shape),
    permission: 'host.manage',
  },
} as const;
