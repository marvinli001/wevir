import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { projectInstructionFiles } from './context-files.js';

const fixture = vi.hoisted(() => ({ prefix: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    stat: async (name: string) => {
      // The system temp directory may itself be inside a repository.
      if (basename(name) === '.git' && !name.startsWith(fixture.prefix)) {
        throw new Error('Project marker outside the test fixture');
      }
      return fs.stat(name);
    },
  };
});

it('uses the nearest repository boundary, override precedence and the cumulative Codex byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wevir-context-'));
  fixture.prefix = `${root}${sep}`;
  const repo = join(root, 'repo'),
    cwd = join(repo, 'src');
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), 'outside');
    const parent = join(repo, 'AGENTS.md'),
      child = join(cwd, 'AGENTS.md'),
      override = join(cwd, 'AGENTS.override.md');
    await writeFile(parent, 'a'.repeat(32766));
    await writeFile(child, 'regular');
    expect(await projectInstructionFiles(cwd, 'codex')).toEqual([{ name: child, text: 'regular' }]);
    await mkdir(join(repo, '.git'));
    await writeFile(override, 'override');
    expect(
      (await projectInstructionFiles(cwd, 'codex')).map((f) => [f.name, f.text.length]),
    ).toEqual([
      [parent, 32766],
      [override, 2],
    ]);
    await writeFile(override, '');
    expect((await projectInstructionFiles(cwd, 'codex')).map((f) => f.name)).toEqual([parent]);
    expect((await projectInstructionFiles(cwd, 'opencode')).map((f) => f.name)).toEqual([
      parent,
      child,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
