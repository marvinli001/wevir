import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findCandidates,
  instructionCommands,
  kindOf,
  readScript,
  scriptHash,
} from './candidates.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findCandidates', () => {
  it('lists declared commands without running any of them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wevir-candidates-'));
    dirs.push(root);
    // 读候选时要是执行了脚本，就会写出 ran.txt。
    const marker = `node -e "require('fs').writeFileSync('ran.txt','x')"`;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          test: marker,
          build: 'tsc -p .',
          dev: 'vite',
          'lint:fix': 'biome check --write',
        },
      }),
    );
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    mkdirSync(join(root, 'packages', 'core'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'core', 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        '# Repo',
        '',
        '```bash',
        '$ pnpm test',
        '# comment',
        'pnpm dev',
        '```',
        '',
        'Run `pnpm typecheck` before pushing.',
        '',
        '```ts',
        'test()',
        '```',
      ].join('\n'),
    );

    const candidates = await findCandidates(root);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
    expect(
      candidates.map((candidate) => [candidate.command, candidate.cwd, candidate.kind]),
    ).toEqual([
      ['pnpm run test', '', 'test'],
      ['pnpm run build', '', 'build'],
      ['pnpm run lint:fix', '', 'lint'],
      ['pnpm run typecheck', 'packages/core', 'typecheck'],
      ['pnpm test', '', 'test'],
      ['pnpm typecheck', '', 'typecheck'],
    ]);
    expect(candidates[0]?.source).toEqual({
      kind: 'package_script',
      file: 'package.json',
      script: 'test',
      body: marker,
    });
    expect(candidates[4]?.source).toEqual({ kind: 'instructions', file: 'AGENTS.md', line: 4 });
    expect(await readScript(root, 'package.json', 'test')).toBe(marker);
    expect(scriptHash(marker)).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('is empty for an empty folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wevir-candidates-'));
    dirs.push(root);
    expect(await findCandidates(root)).toEqual([]);
  });
});

describe('helpers', () => {
  it('infers the kind', () => {
    expect(kindOf('vitest run')).toBe('test');
    expect(kindOf('tsc --noEmit')).toBe('typecheck');
    expect(kindOf('cargo clippy')).toBe('lint');
    expect(kindOf('vite build')).toBe('build');
    expect(kindOf('echo hi')).toBe('other');
  });

  it('reads commands in shell code blocks and inline code', () => {
    expect(instructionCommands('```\nmake test\n```\n`npm run lint` and `foo bar`')).toEqual([
      { command: 'make test', line: 2 },
      { command: 'npm run lint', line: 4 },
    ]);
  });
});
