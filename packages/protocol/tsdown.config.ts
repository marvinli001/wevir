import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/sync-wire.ts', 'src/sync-execution-state.ts'],
  platform: 'neutral',
  dts: true,
});
