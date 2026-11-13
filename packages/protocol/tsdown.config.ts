import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/sync-wire.ts'],
  platform: 'neutral',
  dts: true,
});
