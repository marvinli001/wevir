import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: { name: 'relay' },
});
