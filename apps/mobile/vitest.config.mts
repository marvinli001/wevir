import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'mobile',
    // 只测不 import React Native 的纯逻辑（src/lib）；界面在模拟器上点验。
    include: ['src/**/*.test.ts'],
  },
});
