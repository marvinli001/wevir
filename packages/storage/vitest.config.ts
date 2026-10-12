import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  // Node 环境的测试跑在 Vite 的 ssr 环境里，所以设 ssr.resolve.conditions；Vitest 会把它和默认条件合并。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'storage',
  },
});
