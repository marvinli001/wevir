import { z } from 'zod';
import { id } from './sync-wire.js';

export const SyncVersionInfoSchema = z.object({
  deviceId: id.optional(),
  clientTime: z.iso.datetime().optional(),
});
