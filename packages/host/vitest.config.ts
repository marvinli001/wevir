import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  // Node 环境的测试跑在 Vite 的 ssr 环境里，所以设 ssr.resolve.conditions；Vitest 会把它和默认条件合并。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'host',
    // Windows 上起进程（git、dsh、Host）慢一个数量级，CI 的 runner 上一个用例几次 git 就会超过默认的 5 s。
    // 同一原因：afterEach 里关数据库、清临时目录也会超过默认的 10 s。
    ...(process.platform === 'win32' && { testTimeout: 30_000, hookTimeout: 30_000 }),
  },
});
