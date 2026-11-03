import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { MemoryFreshness } from '@wevir/protocol';
import { isSafeRelativePath, repoInfo, runGit } from './git-diff.js';

interface AnchoredMemory {
  scope: string;
  paths?: string[];
  anchorHead?: string;
}

export async function memoryAnchor(
  cwd: string | undefined,
  content: string,
  paths: readonly string[] = [],
): Promise<{ paths?: string[]; anchorHead?: string }> {
  const repo = cwd === undefined ? undefined : await repoInfo(cwd);
  const merged = [...paths];
  if (cwd !== undefined) {
    for (const match of content.matchAll(/`([^`\n]+)`/g)) {
      const path = match[1] as string;
      if (!isSafeRelativePath(path)) continue;
      try {
        const full = await realpath(resolve(cwd, path));
        const root = repo?.toplevel ?? cwd;
        const fromRoot = relative(root, full).split(sep).join('/');
        if (
          isSafeRelativePath(fromRoot) &&
          (await stat(full)).isFile() &&
          !merged.includes(fromRoot)
        )
          merged.push(fromRoot);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      if (merged.length >= 10) break;
    }
  }
  return {
    ...(merged.length > 0 && { paths: merged.slice(0, 10) }),
    ...(repo?.head !== undefined && { anchorHead: repo.head }),
  };
}

export function validMemoryPaths(paths: readonly string[], scope: string): boolean {
  return (
    paths.length <= 10 &&
    paths.every(
      (path) =>
        path !== '' &&
        !/[\r\n,\0]/.test(path) &&
        (scope === 'global' || (isSafeRelativePath(path) && !isAbsolute(path))),
    )
  );
}

export async function memoryFreshness(
  notes: readonly AnchoredMemory[],
  cwd: string | undefined,
): Promise<MemoryFreshness[]> {
  const repo = cwd === undefined ? undefined : await repoInfo(cwd);
  const diffs = new Map<string, { status: string; path: string; to?: string }[] | undefined>();
  for (const note of notes) {
    if (
      repo === undefined ||
      note.scope === 'global' ||
      !note.paths?.length ||
      note.anchorHead === undefined ||
      diffs.has(note.anchorHead)
    )
      continue;
    try {
      const diff = await runGit(
        repo.toplevel,
        [...repo.config, 'diff', '--name-status', '-z', '-M', note.anchorHead, '--'],
        { okCodes: [0, 128] },
      );
      if (diff.code !== 0) {
        diffs.set(note.anchorHead, undefined);
        continue;
      }
      const parts = diff.stdout.toString('utf8').split('\0');
      const changes: { status: string; path: string; to?: string }[] = [];
      for (let index = 0; index < parts.length - 1; ) {
        const status = parts[index++] as string;
        const path = parts[index++] as string;
        if (status.startsWith('R') || status.startsWith('C'))
          changes.push({ status, path, to: parts[index++] as string });
        else changes.push({ status, path });
      }
      diffs.set(note.anchorHead, changes);
    } catch {
      diffs.set(note.anchorHead, undefined);
    }
  }
  return notes.map((note): MemoryFreshness => {
    if (!note.paths?.length) return { state: 'unanchored' };
    const diff = note.anchorHead === undefined ? undefined : diffs.get(note.anchorHead);
    if (repo === undefined || note.scope === 'global' || diff === undefined)
      return { state: 'unknown' };
    const changes = diff.filter((change) =>
      note.paths?.some(
        (path) => change.path === path || change.path.startsWith(`${path}/`) || change.to === path,
      ),
    );
    if (changes.length === 0) return { state: 'fresh' };
    const moved = changes.find((change) => change.status.startsWith('R'));
    if (moved !== undefined)
      return {
        state: 'moved',
        paths: [moved.path],
        movedTo: moved.to,
        anchorHead: note.anchorHead,
      };
    return {
      state: changes.some((change) => change.status === 'D') ? 'missing' : 'changed',
      paths: changes.map((change) => change.path),
      anchorHead: note.anchorHead,
    };
  });
}

export function memoryFreshnessLabel(freshness: MemoryFreshness | undefined): string {
  if (freshness === undefined || ['fresh', 'unknown', 'unanchored'].includes(freshness.state))
    return '';
  if (freshness.state === 'moved')
    return ` [moved: ${freshness.paths?.[0]} → ${freshness.movedTo}]`;
  const paths = freshness.paths ?? [];
  const detail = `${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}`;
  return freshness.state === 'missing'
    ? ` [missing: ${detail}]`
    : ` [changed since ${freshness.anchorHead?.slice(0, 7)}: ${detail}]`;
}
