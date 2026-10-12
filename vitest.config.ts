import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 每个工作区包是一个独立的 Vitest project，包内 vitest.config.ts 用 defineProject 声明。
    projects: ['apps/*', 'packages/*'],
  },
});
