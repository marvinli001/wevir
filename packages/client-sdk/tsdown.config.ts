import { defineConfig } from 'tsdown';

export default defineConfig({
  // index.ts 是浏览器与 Node 共用的入口；node.ts 是只在 Node 上用的入口（读 run/host.json）。
  // 两个入口共用的代码进公共 chunk，index.js 能到达的文件里没有 node: 导入（build-output.test.ts）。
  entry: ['src/index.ts', 'src/node.ts'],
  platform: 'neutral',
  // neutral 平台不认识 Node 内置模块，node 入口用到的 node:* 显式声明为外部依赖。
  deps: { neverBundle: [/^node:/] },
  dts: true,
});
