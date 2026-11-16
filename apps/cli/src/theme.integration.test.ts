import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { afterEach, expect, it } from 'vitest';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const temp = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

it('lists, selects and clears Host themes through the CLI', async () => {
  const home = join(temp(), 'home');
  await mkdir(join(home, 'themes', 'lagoon'), { recursive: true });
  await writeFile(
    join(home, 'themes', 'lagoon', 'theme.json'),
    JSON.stringify({ schemaVersion: 1, name: 'Lagoon', dark: {} }),
  );
  host = await startEchoHost(home);
  expect((await run(['theme', 'list'], { home })).out).toContain('Lagoon');
  expect((await run(['theme', 'set', 'lagoon'], { home })).code).toBe(0);
  expect(JSON.parse((await run(['theme', 'list', '--json'], { home })).out).activeId).toBe(
    'lagoon',
  );
  const clear = await run(['theme', 'clear'], { home });
  expect(clear.code, clear.err).toBe(0);
  expect(JSON.parse((await run(['theme', '--json'], { home })).out).activeId).toBeNull();
  expect((await run(['theme', 'set', 'missing'], { home })).code).not.toBe(0);
  expect((await run(['theme', '--help'], { home, lang: 'en' })).out).toContain('wevir theme clear');
});
