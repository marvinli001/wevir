import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexAdapter } from './codex-adapter.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('only resumes Codex rollouts inside this account’s CODEX_HOME', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wevir-external-codex-'));
  roots.push(root);
  const home = join(root, 'codex');
  const dir = join(home, 'sessions', '2026', '10', '01');
  mkdirSync(dir, { recursive: true });
  const id = '22222222-2222-4222-8222-222222222222';
  const path = join(dir, `rollout-2026-10-01-${id}.jsonl`);
  writeFileSync(path, '');
  const adapter = new CodexAdapter({
    home: root,
    mode: 'chatgpt',
    account: { codexHome: home, providerId: 'chatgpt' },
  });
  const origin = { app: 'codex' as const, externalId: id, path };
  const config = { cwd: '/workspace/demo', providerId: 'chatgpt', modelId: 'demo' };
  expect(await adapter.canResumeExternalSession(origin, config)).toBe(true);
  const isolated = new CodexAdapter({ home: join(root, 'private'), mode: 'chatgpt' });
  expect(await isolated.canResumeExternalSession(origin, config)).toBe(false);
  expect(await adapter.canResumeExternalSession({ ...origin, app: 'claude' }, config)).toBe(false);
  await adapter.dispose();
  await isolated.dispose();
});
