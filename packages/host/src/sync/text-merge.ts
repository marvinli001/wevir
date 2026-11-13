import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../git-diff.js';

const EDIT_FIELDS = new Set([
  'updated',
  'updated-by',
  'updated-session',
  'updated-turn',
  'updated-seq',
  'updated-proposal',
  'updated-imported-app',
  'updated-imported-path',
]);
function stripMemoryEdit(text: string): string {
  return text.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/,
    (_, header: string) =>
      `---\n${header
        .split(/\r?\n/)
        .filter((line) => !EDIT_FIELDS.has(line.split(':', 1)[0]?.trim() ?? ''))
        .join('\n')}\n---`,
  );
}
export function markMemoryResolution(text: string): string {
  return stripMemoryEdit(text).replace(
    /^---\n/,
    `---\nupdated: ${new Date().toISOString()}\nupdated-by: user\n`,
  );
}
export async function mergeMemoryText(home: string, base: string, local: string, remote: string) {
  const merged = await mergeSyncText(
    home,
    stripMemoryEdit(base),
    stripMemoryEdit(local),
    stripMemoryEdit(remote),
  );
  return merged === undefined ? undefined : markMemoryResolution(merged);
}

export async function mergeSyncText(home: string, base: string, local: string, remote: string) {
  if (
    [base, local, remote].some(
      (text) => text.includes('\0') || Buffer.byteLength(text) > 128 * 1024,
    )
  )
    return undefined;
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  const root = join(home, 'sync/merges');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'merge-'));
  try {
    const paths = ['local', 'base', 'remote'].map((name) => join(directory, name));
    await Promise.all(
      paths.map((path, index) =>
        writeFile(path, [local, base, remote][index] as string, { mode: 0o600 }),
      ),
    );
    const result = await runGit(
      directory,
      [
        '-c',
        `core.hooksPath=${devNull}`,
        'merge-file',
        '--stdout',
        '--diff3',
        '-L',
        'local',
        '-L',
        'base',
        '-L',
        'remote',
        ...paths,
      ],
      {
        env: { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
        okCodes: Array.from({ length: 128 }, (_, index) => index),
        maxBytes: 512 * 1024,
        timeoutMs: 5000,
      },
    );
    if (result.code !== 0 || result.stdout.length > 128 * 1024) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
