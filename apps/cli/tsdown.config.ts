import { defineConfig } from 'tsdown';

export default defineConfig({
  // main.ts 是可执行入口 wevir（package.json 的 bin）。工作区依赖与 mute-stream 照常作为外部依赖，不打进来。
  entry: ['src/main.ts'],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: false,
});
