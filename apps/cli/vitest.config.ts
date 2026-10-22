import { defineProject } from 'vitest/config';

export default defineProject({
  // 工作区依赖走 exports 里的 "@wevir/source" 条件，测源码而不是 dist/（ADR-0004 补记 1）。
  ssr: { resolve: { conditions: ['@wevir/source'] } },
  test: {
    name: 'cli',
    // 集成测试起 Host 子进程；Windows 的 CI runner 上起进程慢，一个用例会超过默认的 5 s，
    // 超时后进程还占着临时目录，afterEach 清目录就报 EPERM。
    ...(process.platform === 'win32' && { testTimeout: 30_000, hookTimeout: 30_000 }),
  },
});
