import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  // 测试只覆盖不依赖 Electron 的主进程模块与共用模块，跑在 Node 上。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'desktop',
    include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
  },
});
