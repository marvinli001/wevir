import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
