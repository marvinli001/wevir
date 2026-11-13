import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { HostSettingsSchema, MemoryNameSchema } from './entities.js';
import { decimal, id } from './sync-wire.js';

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
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
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
  sessionId: SessionIdSchema,
  throughSeq: decimal,
  title: z.string().max(2048),
  titleSource: z.enum(['first_prompt', 'user', 'generated']),
  providerId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
  engine: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  origin: z.json().optional(),
});
export const SyncEventStreamContentSchema = z.object({
  schema: z.literal('wevir-event-stream/1'),
  sessionId: SessionIdSchema,
  streamId: id,
  exclusions: z.array(z.literal('engine.raw')).max(1),
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
export const SyncSettingsValuesSchema = HostSettingsSchema.pick({
  sendWhileBusy: true,
  autoMemory: true,
  autoEpisodes: true,
  ruleFiles: true,
  agentInstructions: true,
  outputStyle: true,
  writingStyle: true,
  notifications: true,
})
  .partial()
  .strict();
export const SyncSettingsContentSchema = z.object({
  schema: z.literal('wevir-settings/1'),
  values: SyncSettingsValuesSchema,
  exclusions: z.array(z.string().max(128)).max(128),
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
export const SyncBundleContentSchema = z.object({
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
    .max(10000)
    .refine(
      (files) => files.reduce((total, file) => total + file.bytes, 0) <= 64 * 1024 * 1024,
      'material size limit',
    ),
  exclusions: z.array(SyncRelativePathSchema).max(10000),
  metadata: z.json().optional(),
});
