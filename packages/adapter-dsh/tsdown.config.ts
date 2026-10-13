import { defineConfig } from 'tsdown';

export default defineConfig({
  // testing 单独成入口：只有做集成测试的包加载它（本地 mock Provider）。
  entry: ['src/index.ts', 'src/testing.ts'],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
