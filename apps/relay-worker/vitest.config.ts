import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'relay-worker',
    globalSetup: ['test/global-setup.ts'],
    // 每个测试起一个 Miniflare（workerd 进程），比 Node 的中继慢。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
