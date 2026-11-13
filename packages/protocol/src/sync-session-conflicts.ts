import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import {
  SyncEpisodeContentSchema,
  SyncRetroSummaryContentSchema,
  SyncSessionContentSchema,
  SyncSessionStateContentSchema,
  SyncSessionTombstoneSchema,
} from './sync-content.js';
import { digest, id } from './sync-wire.js';

export const SyncSessionConflictContentSchema = z.union([
  SyncSessionContentSchema,
  SyncSessionStateContentSchema,
  SyncSessionTombstoneSchema,
  SyncEpisodeContentSchema,
  SyncRetroSummaryContentSchema,
]);
const heads = z
  .array(id)
  .min(2)
  .max(32)
  .refine((values) => new Set(values).size === values.length);
const kind = z.enum(['session', 'episode', 'retro-summary']);
const version = z.object({
  opId: id,
  parents: z.array(id).max(32),
  content: SyncSessionConflictContentSchema,
});
export const SyncSessionConflictMethodSchemas = {
  'sync.sessionConflicts': {
    params: z.object({ after: id.optional() }),
    result: z.object({
      conflicts: z
        .array(
          z.object({
            entityId: id,
            kind,
            sessionId: SessionIdSchema,
            title: z.string().max(2048),
            heads,
          }),
        )
        .max(100),
      next: id.optional(),
    }),
    permission: 'host.manage',
  },
  'sync.previewSessionMerge': {
    params: z.object({ entityId: id }),
    result: z.object({
      vaultId: id,
      entityId: id,
      kind,
      sessionId: SessionIdSchema,
      expectedHeads: heads,
      localRevision: id,
      localFingerprint: digest,
      versions: z.array(version).min(2).max(32),
      base: version.optional(),
      merged: SyncSessionStateContentSchema.optional(),
      mergeState: z.enum(['clean', 'conflict', 'unavailable']),
    }),
    permission: 'host.manage',
  },
  'sync.resolveSession': {
    params: z.object({
      vaultId: id,
      entityId: id,
      expectedHeads: heads,
      localRevision: id,
      localFingerprint: digest,
      selection: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('version'), opId: id }),
        z.object({ kind: z.literal('merged') }),
      ]),
    }),
    result: z.object({ opId: id }),
    permission: 'host.manage',
  },
} as const;
