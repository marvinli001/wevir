import { defineProject } from 'vitest/config';

export default defineProject({ test: { name: 'codex-candidate', include: ['*.test.mjs'] } });
