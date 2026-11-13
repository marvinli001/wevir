import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { run, useTempDir } from './test-utils.js';

const temp = useTempDir();
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.shutdown();
});
async function boot(name: string) {
  const home = join(temp(), name, 'home');
  const userHome = join(temp(), name, 'user');
  await mkdir(userHome, { recursive: true });
  hosts.push(
    await startHost({
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      engine: 'echo',
      adapter: new EchoAdapter({ stepDelayMs: 1 }),
      logger: createLogger({ level: 'error', mirror: () => {} }),
    }),
  );
  return home;
}
describe('portable data through the Host CLI', () => {
  it('exports one isolated Host, previews and imports on another, and leaves its live session list unchanged', async () => {
    const first = await boot('first');
    const second = await boot('second');
    const directory = join(temp(), 'synthetic-project');
    await mkdir(directory);
    expect((await run(['workspace', 'add', directory], { home: first })).code).toBe(0);
    const exported = await run(['sync', 'export'], { home: first });
    expect(exported.code, exported.err).toBe(0);
    const archive = JSON.parse(exported.out);
    expect(archive.protection).toBe('plaintext');
    expect(archive.counts.project).toBe(1);
    const prepared = await run(['sync', 'import', archive.path], { home: second });
    expect(prepared.code, prepared.err).toBe(0);
    const preview = JSON.parse(prepared.out);
    expect(preview.state).toBe('staged');
    expect((await run(['sync', 'import-apply', preview.importId], { home: second })).code).toBe(0);
    const imported = await run(['sync', 'imports'], { home: second });
    expect(imported.code, imported.err).toBe(0);
    expect(JSON.parse(imported.out).packages).toHaveLength(1);
    const entries = await run(['sync', 'entries', preview.importId], { home: second });
    const project = JSON.parse(entries.out).entries.find(
      (entry: { kind: string }) => entry.kind === 'project',
    );
    const read = await run(['sync', 'entry', preview.importId, project.id], { home: second });
    expect(read.code, read.err).toBe(0);
    expect(Buffer.from(JSON.parse(read.out).base64, 'base64').toString()).toContain(
      'synthetic-project',
    );
    const status = await run(['sync', 'status'], { home: second });
    expect(JSON.parse(status.out)).toMatchObject({ state: 'disabled', pending: 0 });
    expect((await run(['session', 'list', '--json'], { home: second })).out).not.toContain(
      'synthetic-project',
    );
  });
});
