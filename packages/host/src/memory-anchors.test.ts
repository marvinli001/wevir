import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { MEMORY_INDEX_MAX_BYTES, MemoryStore } from './memory.js';
import { useTempDir } from './test-utils.js';

const dir = useTempDir();
const note = {
  name: 'test-command',
  type: 'reference' as const,
  description: 'Test command',
  content: 'Use npm test from `package.json`.',
};
function boot() {
  const cwd = join(dir(), 'project');
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, 'package.json'), '{"scripts":{"test":"node --test"}}');
  git('add', 'package.json');
  git('commit', '-qm', 'Initial');
  const memory = new MemoryStore({ dir: join(dir(), 'memory'), workspacePath: () => cwd });
  return { cwd, git, memory };
}

describe('memory anchors and validity', () => {
  it('extracts existing relative files and marks uncommitted changes without invalidating', async () => {
    const { memory, cwd, git } = boot();
    const saved = await memory.save('project', 'ws_1', note, { cwd });
    expect(saved.note.paths).toEqual(['package.json']);
    expect(saved.note.anchorHead).toBe(git('rev-parse', 'HEAD'));
    expect((await memory.read('project', 'ws_1', note.name)).freshness?.state).toBe('fresh');
    writeFileSync(join(cwd, 'package.json'), '{"scripts":{"test":"pnpm vitest"}}');
    const changed = await memory.read('project', 'ws_1', note.name);
    expect(changed.freshness).toMatchObject({ state: 'changed', paths: ['package.json'] });
    expect(changed.validity).toBeUndefined();
    expect(changed.enabled).toBe(true);
    expect(await memory.indexText('ws_1')).toContain('[changed since');
    expect(await memory.list('ws_1')).toHaveLength(1);
  });

  it('reports renames, missing files, non-Git projects, and unknown anchors', async () => {
    const { memory, cwd, git } = boot();
    await memory.save('project', 'ws_1', note, { cwd });
    git('mv', 'package.json', 'renamed.json');
    expect((await memory.read('project', 'ws_1', note.name)).freshness).toMatchObject({
      state: 'moved',
      movedTo: 'renamed.json',
    });
    rmSync(join(cwd, 'renamed.json'));
    expect((await memory.read('project', 'ws_1', note.name)).freshness?.state).toBe('missing');
    const nongit = join(dir(), 'plain');
    mkdirSync(nongit);
    expect(
      (await memory.read('project', 'ws_1', note.name, { cwd: nongit })).freshness?.state,
    ).toBe('unknown');
    const file = join(dir(), 'memory/projects/ws_1/test-command.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/anchor-head: .*/, `anchor-head: ${'f'.repeat(40)}`),
    );
    expect((await memory.read('project', 'ws_1', note.name)).freshness?.state).toBe('unknown');
  });

  it('supersedes in the same queue with F2 revision conflicts; exactly one Agent wins', async () => {
    const { memory, cwd } = boot();
    const writer1 = { sessionId: 'ses_1' as SessionId };
    const writer2 = { sessionId: 'ses_2' as SessionId };
    const old = await memory.save('project', 'ws_1', note, { cwd, writer: writer1 });
    const results = await Promise.allSettled(
      ['new-a', 'new-b'].map((name) =>
        memory.save(
          'project',
          'ws_1',
          { ...note, name },
          { cwd, writer: writer2, supersedes: note.name, supersedesRevision: old.note.revision },
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const invalid = await memory.read('project', 'ws_1', note.name);
    expect(invalid.validity?.supersededBy).toBe('new-a');
    expect(invalid.validity?.invalidAt).toBeDefined();
    expect((await memory.list('ws_1')).map((entry) => entry.name)).toEqual(['new-a']);
    expect(await memory.indexText('ws_1')).not.toContain('test-command (');
    const restored = await memory.update('project', 'ws_1', note.name, invalid.revision, {
      invalidate: { undo: true },
    });
    expect(restored.note.validity?.invalidAt).toBeUndefined();
  });

  it('preserves user edits and anchors; invalidation uses the same revision guard', async () => {
    const { memory, cwd } = boot();
    const old = await memory.save('project', 'ws_1', note, { cwd });
    const updated = await memory.update('project', 'ws_1', note.name, old.note.revision, {
      content: 'User correction',
      paths: ['package.json'],
    });
    expect(updated.note.anchorHead).toBe(old.note.anchorHead);
    expect(
      (await memory.update('project', 'ws_1', note.name, old.note.revision, { invalidate: {} }))
        .conflict,
    ).toBe(true);
    const invalid = await memory.update('project', 'ws_1', note.name, updated.note.revision, {
      invalidate: { reason: 'Obsolete command' },
    });
    expect(invalid.note.validity?.reason).toBe('Obsolete command');
    await expect(
      memory.save(
        'project',
        'ws_1',
        { ...note, name: 'replacement' },
        { cwd, writer: { sessionId: 'ses_2' as SessionId }, supersedes: note.name },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not rewrite old files on read and preserves unknown frontmatter on user edits', async () => {
    const { memory } = boot();
    const file = join(dir(), 'memory/global/legacy.md');
    mkdirSync(join(dir(), 'memory/global'), { recursive: true });
    const text =
      '---\nname: legacy\ntype: reference\ndescription: Legacy\nupdated: 2026-11-04\ncustom: retained\n---\n\nLegacy body\n';
    writeFileSync(file, text);
    const read = await memory.read('global', undefined, 'legacy');
    expect(readFileSync(file, 'utf8')).toBe(text);
    await memory.update('global', undefined, 'legacy', read.revision, {
      invalidate: { reason: 'Retired' },
    });
    const written = readFileSync(file, 'utf8');
    expect(written).toContain('custom: retained');
    expect(written).toContain('invalid-at:');
  });

  it('counts labels and the omission marker in the byte budget', async () => {
    const { memory } = boot();
    for (let index = 0; index < 40; index++)
      await memory.save('global', undefined, {
        ...note,
        name: `note-${index}`,
        description: '长'.repeat(190),
      });
    expect(Buffer.byteLength((await memory.indexText('ws_1')) ?? '')).toBeLessThanOrEqual(
      MEMORY_INDEX_MAX_BYTES,
    );
  });
});
