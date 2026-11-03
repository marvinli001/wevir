import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude-adapter.js';
import { FakeClaudeSdk } from './test-fixtures/fake-sdk.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('only resumes Claude logs in the account’s own config directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wevir-external-claude-'));
  roots.push(root);
  const home = join(root, 'claude');
  const project = join(home, 'projects', 'demo');
  mkdirSync(project, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, '');
  const adapter = new ClaudeAdapter({
    home: join(root, 'host'),
    sdk: new FakeClaudeSdk(),
    env: { CLAUDE_CONFIG_DIR: home },
  });
  const origin = { app: 'claude' as const, externalId: id, path };
  const config = { cwd: '/workspace/demo', providerId: 'claude', modelId: 'demo' };
  expect(await adapter.canResumeExternalSession(origin, config)).toBe(true);
  expect(await adapter.canResumeExternalSession({ ...origin, app: 'codex' }, config)).toBe(false);
  expect(await adapter.canResumeExternalSession({ ...origin, externalId: 'another' }, config)).toBe(
    false,
  );
  const isolated = new ClaudeAdapter({
    home: join(root, 'other-host'),
    sdk: new FakeClaudeSdk(),
    env: { CLAUDE_CONFIG_DIR: join(root, 'private') },
  });
  expect(await isolated.canResumeExternalSession(origin, config)).toBe(false);
  await adapter.dispose();
  await isolated.dispose();
});
