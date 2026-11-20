import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { projectInstructionFiles } from './context-files.js';

it('uses the nearest repository boundary, override precedence and the cumulative Codex byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wevir-context-'));
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
