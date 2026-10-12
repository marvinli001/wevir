import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 每个工作区包是一个独立的 Vitest project，包内 vitest.config.ts 用 defineProject 声明。
    // 这些 project 不继承本文件的配置，所以 "@wevir/source" 条件写在各包自己的配置里（ADR-0004 补记 1）。
    projects: ['apps/*', 'packages/*'],
  },
});
