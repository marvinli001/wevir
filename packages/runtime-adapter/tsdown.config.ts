import { defineConfig } from 'tsdown';

export default defineConfig({
  // contract 单独成入口：它 import vitest（可选 peer），只有跑契约测试的包才加载它。
  entry: [
    'src/index.ts',
    'src/echo.ts',
    'src/history-tool.ts',
    'src/app-tools-bridge.ts',
    'src/web-tool.ts',
    'src/npm-package.ts',
    'src/private-home.ts',
    'src/contract.ts',
  ],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与 protocol 一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
