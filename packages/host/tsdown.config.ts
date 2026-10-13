import { defineConfig } from 'tsdown';

export default defineConfig({
  // main.ts 是可执行入口 wevir-host（package.json 的 bin）；runtime.ts 是给客户端进程用的轻量子路径
  // `@wevir/host/runtime`（数据目录与 host.json，只依赖 Node 内置模块）。
  entry: ['src/index.ts', 'src/main.ts', 'src/runtime.ts'],
  platform: 'node',
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
