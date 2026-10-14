import { defineConfig } from 'tsdown';

export default defineConfig({
  // sdk 单独成入口：引擎适配器与它们的测试经它拿 ACP SDK，SDK 的版本只由本包锁定。
  entry: ['src/index.ts', 'src/sdk.ts'],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
