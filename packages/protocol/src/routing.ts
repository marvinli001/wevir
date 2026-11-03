import { z } from 'zod';
import {
  IsoTimeSchema,
  ProviderIdSchema,
  SeqSchema,
  SessionIdSchema,
  TurnIdSchema,
} from './common.js';

export const ROUTING_MAX_ATTEMPTS = 3;

export const RoutingTargetSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
});
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;

export const RoutingSettingsSchema = z.object({
  enabled: z.boolean(),
  chain: z.array(
    z.object({
      providerId: ProviderIdSchema,
      modelId: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    }),
  ),
  preferSoonestReset: z.boolean(),
});
export type RoutingSettings = z.infer<typeof RoutingSettingsSchema>;

export const RoutingFailoverSchema = z.object({
  attempt: z.int().min(1).max(ROUTING_MAX_ATTEMPTS),
  originTurnId: TurnIdSchema,
});
export type RoutingFailover = z.infer<typeof RoutingFailoverSchema>;

export const RoutingDecisionSchema = z.object({
  turnId: TurnIdSchema,
  originTurnId: TurnIdSchema,
  attempt: z.int().min(0).max(ROUTING_MAX_ATTEMPTS),
  from: RoutingTargetSchema,
  to: RoutingTargetSchema.nullable(),
  skipped: z.array(z.object({ providerId: ProviderIdSchema, reason: z.string().min(1) })),
  at: IsoTimeSchema,
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const RoutingCursorSchema = z.object({
  at: IsoTimeSchema,
  sessionId: SessionIdSchema,
  seq: SeqSchema,
});
export const RoutingDecisionsParamsSchema = z.object({
  cursor: RoutingCursorSchema.optional(),
  limit: z.int().min(1).max(100).optional(),
});
export const RoutingDecisionsResultSchema = z.object({
  decisions: z.array(RoutingDecisionSchema.extend({ sessionId: SessionIdSchema, seq: SeqSchema })),
  nextCursor: RoutingCursorSchema.optional(),
});
