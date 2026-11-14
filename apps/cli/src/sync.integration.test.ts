import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  it('resolves portable paths from the CLI directory and rejects ambiguous stdin and unused flags', async () => {
    const home = await boot('relative');
    const exported = await run(['sync', 'export', 'relative-output'], { home, cwd: temp() });
    expect(exported.code, exported.err).toBe(0);
    const path = JSON.parse(exported.out).path as string;
    expect(path.startsWith(join(temp(), 'relative-output'))).toBe(true);
    const prepared = await run(['sync', 'import', relative(temp(), path)], { home, cwd: temp() });
    expect(prepared.code, prepared.err).toBe(0);
    const ambiguous = await run(['sync', 'export', 'argument', '--stdin'], {
      home,
      cwd: temp(),
      input: JSON.stringify({ directory: join(temp(), 'stdin-output') }),
    });
    expect(ambiguous.code).toBe(2);
    expect((await run(['sync', 'export', '--refresh'], { home })).code).toBe(2);
  });
  it('exports one isolated Host, previews and imports on another, and leaves its live session list unchanged', async () => {
    const first = await boot('first');
    const second = await boot('second');
    const directory = join(temp(), 'synthetic-project');
    await mkdir(directory);
    expect((await run(['workspace', 'add', directory], { home: first })).code).toBe(0);
    const provider = await run(
      [
        'provider',
        'add',
        '--kind',
        'openai-compatible',
        '--id',
        'synthetic-echo',
        '--base-url',
        'http://127.0.0.1:9/v1',
        '--model',
        'synthetic',
      ],
      { home: first, input: 'synthetic-provider-key\n' },
    );
    expect(provider.code, provider.err).toBe(0);
    const original = await run(['session', 'new', '-w', directory, 'Portable continuity sample'], {
      home: first,
    });
    expect(original.code, original.err).toBe(0);
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
    const source = JSON.parse(entries.out).entries.find(
      (entry: { kind: string }) => entry.kind === 'session',
    );
    const conversation = await run(['sync', 'conversation', preview.importId, source.key], {
      home: second,
    });
    expect(conversation.code, conversation.err).toBe(0);
    expect(JSON.parse(conversation.out).session.readOnly.reason).toBe('imported');
    expect(JSON.stringify(JSON.parse(conversation.out).events)).toContain(
      'Portable continuity sample',
    );
    const read = await run(['sync', 'entry', preview.importId, project.id], { home: second });
    expect(read.code, read.err).toBe(0);
    expect(Buffer.from(JSON.parse(read.out).base64, 'base64').toString()).toContain(
      'synthetic-project',
    );
    const status = await run(['sync', 'status'], { home: second });
    expect(JSON.parse(status.out)).toMatchObject({ state: 'disabled', pending: 0 });
    const generic = await run(['sync', 'call', 'status'], { home: second });
    expect(generic.code, generic.err).toBe(0);
    expect(JSON.parse(generic.out)).toMatchObject({ state: 'disabled', pending: 0 });
    const malformed = await run(['sync', 'call', 'recoveryRequest', '--stdin'], {
      home: second,
      input: '{"vaultId":"private-synthetic-marker",',
    });
    expect(malformed.code).not.toBe(0);
    expect(malformed.err).not.toContain('private-synthetic-marker');
    expect((await run(['session', 'list', '--json'], { home: second })).out).not.toContain(
      'synthetic-project',
    );
  });
});
