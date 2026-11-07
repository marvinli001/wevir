import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'runtime-perf', include: ['*.test.mjs'] },
});
