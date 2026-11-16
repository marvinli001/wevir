import { z } from 'zod';

export const ZUV_API_PROVIDER_ID = 'zuv-api-login';

export const ZuvApiErrorSchema = z.enum([
  'network',
  'timeout',
  'service',
  'invalid_response',
  'rate_limited',
  'slow_down',
  'authorization_expired',
  'authorization_cancelled',
  'authorization_denied',
  'authorization_completed',
  'authorization_not_found',
  'invalid_host_proof',
  'key_disabled',
  'key_revoked',
  'key_expired',
  'key_limit_reached',
  'key_window_limit',
  'key_replaced',
  'key_limit',
  'account_suspended',
  'invalid_api_key',
  'ip_not_allowed',
  'not_revealable',
  'no_models',
  'auth',
  'protocol',
  'server',
]);
export type ZuvApiError = z.infer<typeof ZuvApiErrorSchema>;

export const ZuvApiStateSchema = z.object({
  status: z.enum(['disconnected', 'authorizing', 'connected', 'error']),
  account: z.object({ id: z.string(), email: z.string(), name: z.string() }).optional(),
  keyPrefix: z.string().max(32).optional(),
  providerId: z.string().optional(),
  login: z
    .object({ requestId: z.string(), authorizationUrl: z.url(), expiresAt: z.iso.datetime() })
    .optional(),
  error: ZuvApiErrorSchema.optional(),
  modelsError: ZuvApiErrorSchema.optional(),
  modelCount: z.int().min(0).optional(),
});
export type ZuvApiState = z.infer<typeof ZuvApiStateSchema>;
export const ZuvApiResultSchema = z.object({ connection: ZuvApiStateSchema });
export const ZuvApiCancelParamsSchema = z.object({ requestId: z.string().optional() });
