// Adapted from wevir-zuv packages/sync-protocol/src/execution-state.ts
// Commit: 9e1df7b9614c293fe55d93514e76e7c4fffb6f85; MIT, Copyright (c) 2026 Wevir Labs.
// License: contracts/wevir-sync/v1/LICENSE; additive artifacts: contracts/wevir-sync/v1-r2/.
import { z } from 'zod';
import { id } from './sync-wire.js';

export const executionStateSchema = z.union([
  z.strictObject({ runId: id, epoch: z.literal('0'), state: z.literal('absent') }),
  z.strictObject({
    runId: id,
    epoch: z.string().regex(/^[1-9][0-9]{0,38}$/),
    state: z.enum(['held', 'released', 'expired']),
  }),
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;
