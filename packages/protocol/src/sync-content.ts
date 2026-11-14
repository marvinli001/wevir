import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { EpisodeIdSchema, EpisodeSchema } from './context.js';
import { MemoryNameSchema, SessionForkedFromSchema, SyncRecoveredFromSchema } from './entities.js';
import { RetroSummarySchema } from './retro.js';
import { SyncStreamRefSchema } from './sync.js';
import { SyncSettingsContentSchema } from './sync-settings.js';
import { decimal, digest, id } from './sync-wire.js';

export { SyncSettingsContentSchema, SyncSettingsValuesSchema } from './sync-settings.js';

export const SyncRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !/^[A-Za-z]:/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part !== '' &&
            part !== '.' &&
            part !== '..' &&
            !Array.from(part).some((char) => char.charCodeAt(0) < 32) &&
            !/[<>:"|?*]|[. ]$|~[0-9]/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    'unsafe material path',
  );

export const SyncProjectContentSchema = z.object({
  schema: z.literal('wevir-project/1'),
  projectId: id,
  displayName: z.string().max(256),
  repoUrl: z.string().max(2048).optional(),
});
export const SyncSessionContentSchema = z.object({
  schema: z.literal('wevir-session/1'),
  recoveredFrom: SyncRecoveredFromSchema.optional(),
  sessionId: SessionIdSchema,
  throughSeq: decimal.optional(),
  title: z.string().max(2048),
  titleSource: z.enum(['first_prompt', 'user', 'generated']),
  providerId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
  engine: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  origin: z.json().optional(),
  source: SyncStreamRefSchema.optional(),
  archivedAt: z.iso.datetime().optional(),
  side: z.literal(true).optional(),
  parentSessionId: SessionIdSchema.optional(),
  forkedFrom: SessionForkedFromSchema.optional(),
});
export const SyncEventStreamContentSchema = z.object({
  schema: z.literal('wevir-event-stream/1'),
  recoveredFrom: SyncRecoveredFromSchema.optional(),
  sessionId: SessionIdSchema,
  streamId: id,
  exclusions: z.array(z.literal('engine.raw')).max(1),
});
export const SyncEpisodeContentSchema = z.object({
  schema: z.literal('wevir-episode/1'),
  source: SyncStreamRefSchema,
  episodeId: EpisodeIdSchema,
  episode: EpisodeSchema.optional(),
  deleted: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  unmappedRefs: z
    .array(z.object({ deviceId: id, sessionId: SessionIdSchema, ref: z.json() }))
    .max(128)
    .optional(),
});
export const SyncRetroSummaryContentSchema = z.object({
  schema: z.literal('wevir-retro-summary/1'),
  source: SyncStreamRefSchema,
  summary: RetroSummarySchema,
});
export const SyncSessionTombstoneSchema = z.object({
  schema: z.literal('wevir-session-deleted/1'),
  source: SyncStreamRefSchema,
  deletedAt: z.iso.datetime(),
});
export const SyncSessionStateContentSchema = z.object({
  schema: z.literal('wevir-session-state/1'),
  source: SyncStreamRefSchema,
  title: z.string().max(2048),
  titleSource: z.enum(['first_prompt', 'user', 'generated']),
  archivedAt: z.iso.datetime().nullable(),
});
export const SyncMemoryContentSchema = z.object({
  schema: z.literal('wevir-memory/1'),
  scope: z.enum(['global', 'project']),
  name: MemoryNameSchema,
  markdown: z
    .string()
    .max(128 * 1024)
    .optional(),
  deleted: z.boolean().optional(),
});
export const SyncChunkContentSchema = z.object({
  schema: z.literal('wevir-chunk/1'),
  ownerId: id,
  index: z.number().int().min(0).max(65535),
  data: z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .max(256 * 1024),
  sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const SyncBundleContentSchema = z
  .object({
    schema: z.literal('wevir-bundle/1'),
    category: z.enum(['rule', 'skill-bundle', 'artifact', 'workspace-snapshot']),
    name: z.string().min(1).max(256),
    files: z
      .array(
        z.object({
          path: SyncRelativePathSchema,
          bytes: z
            .number()
            .int()
            .min(0)
            .max(64 * 1024 * 1024),
          sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          parts: z.array(z.object({ entityId: id, opId: id })).max(1024),
          executable: z.boolean().optional(),
        }),
      )
      .max(10000),
    exclusions: z.array(SyncRelativePathSchema).max(10000),
    metadata: z.json().optional(),
    recoveredFrom: z
      .object({
        vaultId: id,
        deviceId: id,
        opId: id,
        commitId: id.optional(),
        source: SyncStreamRefSchema.optional(),
        origin: z
          .object({
            hostId: id,
            sessionId: SessionIdSchema,
            streamId: id,
            fromSeq: decimal,
            throughSeq: decimal,
          })
          .optional(),
      })
      .optional(),
  })
  .refine((bundle) => {
    const files =
      bundle.category === 'workspace-snapshot'
        ? [...new Map(bundle.files.map((file) => [`${file.sha256}:${file.bytes}`, file])).values()]
        : bundle.files;
    return files.reduce((total, file) => total + file.bytes, 0) <= 64 * 1024 * 1024;
  }, 'material size limit');

export const SyncSharedFilesMetadataSchema = z.object({
  schema: z.literal('wevir-shared-files/1'),
  source: SyncStreamRefSchema,
  seq: decimal,
  capture: z.enum(['shared', 'backfill']),
});

export const SyncWorkspaceMetadataSchema = z
  .object({
    schema: z.literal('wevir-workspace-snapshot/1'),
    projectId: id,
    source: SyncStreamRefSchema,
    throughSeq: z.number().int().nonnegative(),
    sourceHead: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
      .nullable(),
    base: z.literal('bounded-tree'),
    statusHash: digest,
    selectedUntracked: z.array(SyncRelativePathSchema).max(1000),
    ruleVersions: z.array(z.object({ entityId: id, opId: id })).max(1000),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type SyncWorkspaceMetadata = z.infer<typeof SyncWorkspaceMetadataSchema>;

export const SYNC_CONTENT_SCHEMAS = {
  workspace: SyncWorkspaceMetadataSchema,
  sharedFiles: SyncSharedFilesMetadataSchema,
  project: SyncProjectContentSchema,
  session: SyncSessionContentSchema,
  'event-stream': SyncEventStreamContentSchema,
  episode: SyncEpisodeContentSchema,
  'retro-summary': SyncRetroSummaryContentSchema,
  'session-state': SyncSessionStateContentSchema,
  'session-tombstone': SyncSessionTombstoneSchema,
  memory: SyncMemoryContentSchema,
  settings: SyncSettingsContentSchema,
  chunk: SyncChunkContentSchema,
  bundle: SyncBundleContentSchema,
} as const;
