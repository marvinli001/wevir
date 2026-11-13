import { z } from 'zod';
import { HostSettingsSchema } from './entities.js';

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
