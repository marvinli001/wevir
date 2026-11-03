import { z } from 'zod';
import { IsoTimeSchema, SeqSchema, SessionIdSchema, WorkspaceIdSchema } from './common.js';
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
