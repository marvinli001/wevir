import { z } from 'zod';
import { SessionIdSchema, WorkspaceIdSchema } from './common.js';
import { BundleMethodSchemas } from './sync-bundles.js';
import { SyncSettingsValuesSchema } from './sync-settings.js';
import { decimal, digest, entityType, id, PROTOCOL, schemas } from './sync-wire.js';

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
  reset: z
    .object({
      jobId: id,
      phase: z.enum([
        'creating',
        'metadata',
        'records',
        'staged',
        'failed',
        'applying',
        'applied',
        'acknowledged',
      ]),
      busy: z.boolean(),
      pendingBefore: z.number().int().nonnegative(),
      operations: z.number().int().nonnegative(),
      selected: z.number().int().nonnegative(),
      staged: z.number().int().nonnegative(),
      applied: z.number().int().nonnegative(),
      errorCode: z.string().max(64).optional(),
    })
    .optional(),
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

const memoryVersion = z.object({
  opId: id,
  parents: z.array(id).max(32),
  markdown: z
    .string()
    .max(128 * 1024)
    .optional(),
  deleted: z.boolean().optional(),
});
const resolutionHeads = z
  .array(id)
  .min(2)
  .max(32)
  .refine((heads) => new Set(heads).size === heads.length);
const fileFingerprint = z.union([digest, z.literal('missing')]);
const settingsVersion = z.object({
  opId: id,
  parents: z.array(id).max(32),
  values: SyncSettingsValuesSchema,
});
export const SyncMethodSchemas = {
  ...BundleMethodSchemas,
  'sync.settingsConflicts': {
    params: z.object({ after: id.optional() }),
    result: z.object({
      conflicts: z
        .array(
          z.object({ entityId: id, key: SyncSettingsValuesSchema.keyof(), heads: resolutionHeads }),
        )
        .max(100),
      next: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.previewSettingsMerge': {
    params: z.object({ entityId: id }),
    result: z.object({
      entityId: id,
      key: SyncSettingsValuesSchema.keyof(),
      expectedHeads: resolutionHeads,
      localRevision: id,
      valueFingerprint: digest,
      localValues: SyncSettingsValuesSchema,
      versions: z.array(settingsVersion).min(2).max(32),
      base: settingsVersion.optional(),
      merged: SyncSettingsValuesSchema.optional(),
      mergeState: z.enum(['clean', 'conflict', 'unavailable']),
    }),
    permission: 'host.manage',
  },
  'sync.resolveSettings': {
    params: z.object({
      entityId: id,
      expectedHeads: resolutionHeads,
      localRevision: id,
      valueFingerprint: digest,
      values: SyncSettingsValuesSchema,
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
  'sync.memoryConflicts': {
    params: z.object({ after: id.optional() }),
    result: z.object({
      conflicts: z
        .array(
          z.object({
            entityId: id,
            name: z.string().min(1).max(80),
            scope: z.enum(['global', 'project']),
            projectId: id.optional(),
            heads: resolutionHeads,
          }),
        )
        .max(100),
      next: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.previewMemoryMerge': {
    params: z.object({ entityId: id }),
    result: z.object({
      entityId: id,
      name: z.string().min(1).max(80),
      scope: z.enum(['global', 'project']),
      expectedHeads: resolutionHeads,
      localRevision: id,
      fileFingerprint,
      versions: z.array(memoryVersion).min(2).max(32),
      base: memoryVersion.optional(),
      merged: z
        .string()
        .max(128 * 1024)
        .optional(),
      mergeState: z.enum(['clean', 'conflict', 'unavailable']),
    }),
    permission: 'host.manage',
  },
  'sync.resolveMemory': {
    params: z.object({
      entityId: id,
      expectedHeads: resolutionHeads,
      localRevision: id,
      fileFingerprint,
      markdown: z
        .string()
        .max(128 * 1024)
        .optional(),
      deleted: z.boolean().optional(),
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
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
  'sync.resetPrepare': {
    params: z.object({ restart: z.boolean().optional() }),
    result: SyncStatusSchema,
    permission: 'host.manage',
  },
  'sync.resetApply': {
    params: z.object({ jobId: id }),
    result: SyncStatusSchema,
    permission: 'host.manage',
  },
  'sync.resetCancel': {
    params: z.object({ jobId: id }),
    result: SyncStatusSchema,
    permission: 'host.manage',
  },
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
