import { z } from 'zod';
import { IsoTimeSchema, SeqSchema, SessionIdSchema, WorkspaceIdSchema } from './common.js';
import { MemoryFreshnessSchema, MemoryValiditySchema } from './entities.js';
import {
  RetroChapterSchema,
  RetroCommitSchema,
  RetroDecisionSchema,
  RetroDeliverySchema,
  RetroFileSchema,
  RetroItemSchema,
  RetroMemorySchema,
  RetroRelatedSessionSchema,
  RetroSummarySchema,
  RetroWorkItemSchema,
} from './retro.js';

export const EpisodeIdSchema = z.string().regex(/^ep_[0-9A-Za-z]{1,64}$/);
export type EpisodeId = z.infer<typeof EpisodeIdSchema>;
export const EpisodeLessonSchema = z.object({
  kind: z.enum([
    'check_recovered',
    'check_failed',
    'command_recovered',
    'correction',
    'guardrail',
    'turn_failed',
  ]),
  text: z.string(),
  sources: z.array(z.string()),
  files: z.array(z.string()).optional(),
  verified: z.boolean(),
});
export type EpisodeLesson = z.infer<typeof EpisodeLessonSchema>;
export const EpisodeOverridesSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  goal: RetroItemSchema.optional(),
  open: z.array(RetroWorkItemSchema).max(10).optional(),
  lessons: z.array(EpisodeLessonSchema).max(10).optional(),
  decisions: z.array(RetroDecisionSchema).max(15).optional(),
});
export type EpisodeOverrides = z.infer<typeof EpisodeOverridesSchema>;
export const EpisodeSchema = z.object({
  id: EpisodeIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema,
  rootSessionId: SessionIdSchema,
  title: z.string(),
  goal: RetroItemSchema.optional(),
  outcome: RetroDeliverySchema.extend({
    lastTurn: z.string().optional(),
    open: z.int().min(0),
    checkedAt: IsoTimeSchema,
    comparedToCode: z.literal(false),
  }),
  done: z.array(RetroWorkItemSchema).max(10),
  open: z.array(RetroWorkItemSchema).max(10),
  decisions: z.array(RetroDecisionSchema).max(15),
  lessons: z.array(EpisodeLessonSchema).max(10),
  files: z.array(RetroFileSchema).max(50),
  omittedFiles: z.int().min(0).optional(),
  commits: z.array(RetroCommitSchema).max(20),
  anchor: z.object({
    branch: z.string().optional(),
    head: z.string().nullable().optional(),
    startHead: z.string().optional(),
  }),
  engines: z.array(z.object({ providerId: z.string(), modelId: z.string(), seq: SeqSchema })),
  period: z.object({ start: IsoTimeSchema, end: IsoTimeSchema }),
  throughSeq: SeqSchema,
  schemaVersion: z.int().min(1),
  memories: z.array(RetroMemorySchema),
  chapters: z.array(RetroChapterSchema),
  sessions: z.array(RetroRelatedSessionSchema),
  summary: RetroSummarySchema.optional(),
  overrides: EpisodeOverridesSchema,
  pinned: z.boolean(),
  excluded: z.boolean(),
  source: z.enum(['available', 'deleted']),
  revision: z.string().min(1),
  redactions: z.int().min(0),
  updatedAt: IsoTimeSchema,
});
export type Episode = z.infer<typeof EpisodeSchema>;
export const EpisodeSummarySchema = EpisodeSchema.pick({
  id: true,
  workspaceId: true,
  sessionId: true,
  title: true,
  outcome: true,
  period: true,
  throughSeq: true,
  pinned: true,
  excluded: true,
  source: true,
  revision: true,
  updatedAt: true,
});
export type EpisodeSummary = z.infer<typeof EpisodeSummarySchema>;

export const ContextSourceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constraint'), index: z.int().min(0) }),
  z.object({
    kind: z.literal('memory'),
    scope: z.enum(['global', 'project']),
    name: z.string(),
    revision: z.string(),
    workspaceId: WorkspaceIdSchema.optional(),
    freshness: z.string().optional(),
  }),
  z.object({
    kind: z.literal('episode'),
    id: EpisodeIdSchema,
    revision: z.string(),
    throughSeq: SeqSchema,
    section: z.string().optional(),
  }),
  z.object({ kind: z.literal('history'), sessionId: SessionIdSchema, itemId: z.string() }),
]);
export type ContextSourceRef = z.infer<typeof ContextSourceRefSchema>;
export const ContextHitSchema = z.object({
  handle: z.string(),
  kind: z.enum(['memory', 'episode', 'session']),
  title: z.string(),
  snippet: z.string().max(200),
  updatedAt: z.string(),
  source: ContextSourceRefSchema,
  revision: z.string().optional(),
  freshness: MemoryFreshnessSchema.optional(),
  validity: MemoryValiditySchema.optional(),
  sections: z.array(z.string()).optional(),
});
export type ContextHit = z.infer<typeof ContextHitSchema>;
export const ContextSearchParamsSchema = z
  .object({
    workspaceId: WorkspaceIdSchema.optional(),
    query: z.string().trim().min(1).max(1000).optional(),
    handle: z.string().min(1).max(300).optional(),
    kinds: z
      .array(z.enum(['memory', 'episode', 'session']))
      .min(1)
      .max(3)
      .optional(),
    path: z.string().min(1).optional(),
    includeInvalid: z.boolean().optional(),
    limit: z.int().min(1).max(10).optional(),
    textOffset: z.int().min(0).optional(),
  })
  .refine(
    (value) => (value.query === undefined) !== (value.handle === undefined),
    'Provide query or handle.',
  );
export type ContextSearchParams = z.infer<typeof ContextSearchParamsSchema>;
export const ContextSearchResultSchema = z.object({
  hits: z.array(ContextHitSchema),
  scan: z
    .object({
      reason: z.enum(['short_term', 'fts_unavailable']),
      examined: z.int().min(0),
      limit: z.int().min(1),
    })
    .optional(),
  body: z.string().optional(),
  revision: z.string().optional(),
  source: ContextSourceRefSchema.optional(),
  freshness: MemoryFreshnessSchema.optional(),
  validity: MemoryValiditySchema.optional(),
  textOffset: z.int().min(0).optional(),
  nextTextOffset: z.int().min(0).nullable().optional(),
});
export type ContextSearchResult = z.infer<typeof ContextSearchResultSchema>;
