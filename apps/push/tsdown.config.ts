import { defineConfig } from 'tsdown';

export default defineConfig({
  // main.ts 是可执行入口 wevir-push（package.json 的 bin）；index.ts 给 Host 的端到端测试用。
  // @wevir/protocol 与 zod 打进来：Docker 镜像里只放 dist/，不装依赖（Dockerfile）。
  entry: ['src/index.ts', 'src/main.ts'],
  platform: 'node',
  deps: { alwaysBundle: ['@wevir/protocol', 'zod'] },
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
