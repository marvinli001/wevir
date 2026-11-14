import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SyncRelativePathSchema, type SyncWorkspaceMetadata } from '@wevir/protocol';
import { PROJECT_FILES } from '../rule-files.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { type BundleFile, excludedBundlePath, snapshotBundle } from './bundle-snapshot.js';
import { sha256 } from './crypto.js';

export const WORKSPACE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const fold = (path: string) => path.normalize('NFC').toLowerCase();
export const workspaceRequiresTrust = (path: string) =>
  PROJECT_FILES.some(
    (file) =>
      fold(path) === fold(file.name.split('\\').join('/')) ||
      fold(path).endsWith(`/${fold(file.name.split('\\').join('/'))}`),
  ) ||
  /(^|\/)(?:\.claude|\.codex|\.cursor|\.opencode|\.kiro|\.gemini|\.agents|\.wevir)(?:\/|$)|(^|\/)(?:\.gitattributes|\.mcp\.json|mcp\.json|opencode\.jsonc?)$/i.test(
    path,
  );

/** Plumbing only: no shell, global Git config, filters, fsmonitor or hooks. */
export function workspaceGit(
  cwd: string,
  args: readonly string[],
  input?: Uint8Array,
  maximumOutputBytes = WORKSPACE_MAX_BYTES,
) {
  return new Promise<Buffer>((accept, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const child = spawn(
      'git',
      [
        '--no-lazy-fetch',
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.quotePath=false',
        '-c',
        `core.attributesFile=${devNull}`,
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        cwd,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: devNull,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const output: Buffer[] = [];
    let length = 0,
      error: Error | undefined;
    const timer = setTimeout(() => {
      error = new ZuvRequestError('QUOTA_EXCEEDED');
      child.kill();
    }, 30000);
    child.stdout.on('data', (bytes: Buffer) => {
      length += bytes.length;
      if (length > maximumOutputBytes) {
        error = new ZuvRequestError('QUOTA_EXCEEDED');
        child.kill();
      } else output.push(bytes);
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(new ZuvRequestError('RECOVERY_REQUIRED'));
      else accept(Buffer.concat(output));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

type GitEntry = { path: string; oid: string; executable: boolean };
function entries(bytes: Buffer, index: boolean): GitEntry[] {
  const result: GitEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const row of decoder.decode(bytes).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, second, third] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    if (!SyncRelativePathSchema.safeParse(path).success)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (excludedBundlePath(path)) continue;
    if (!['100644', '100755'].includes(mode ?? '') || (index && third !== '0'))
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const oid = index ? second : third;
    if (!oid || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    result.push({ path, oid, executable: mode === '100755' });
    if (result.length > MAX_FILES) throw new ZuvRequestError('QUOTA_EXCEEDED');
  }
  validateWorkspacePaths(result.map((file) => file.path));
  return result;
}

export function validateWorkspacePaths(paths: readonly string[]) {
  const seen = new Set<string>();
  const spelling = new Map<string, string>();
  for (const path of paths) {
    if (!SyncRelativePathSchema.safeParse(path).success || excludedBundlePath(path))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const parts = path.split('/');
    if (
      parts.some(
        (part) =>
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[<>:"|?*]|[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const name = fold(path);
    if (seen.has(name)) throw new ZuvRequestError('INTEGRITY_FAILED');
    seen.add(name);
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = fold(prefix);
      if (spelling.has(key) && spelling.get(key) !== prefix)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      spelling.set(key, prefix);
    }
  }
  for (const name of seen) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/'))) throw new ZuvRequestError('INTEGRITY_FAILED');
      parts.pop();
    }
  }
}

async function gitState(cwd: string) {
  const head = await workspaceGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(
    (bytes) => bytes.toString().trim(),
    async () => {
      if ((await workspaceGit(cwd, ['rev-list', '--all', '--max-count=1'])).length)
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      return null;
    },
  );
  const index = await workspaceGit(cwd, ['ls-files', '--stage', '-z']);
  const status = await workspaceGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return {
    head,
    index,
    status,
    hash: sha256(Buffer.concat([Buffer.from(head ?? ''), index, status])),
  };
}

export async function captureWorkspaceTree(
  cwd: string,
  untracked: readonly string[],
  guard: () => void = () => {},
) {
  guard();
  if ((await lstat(cwd)).isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
  const root = await realpath(cwd);
  if (
    resolve((await workspaceGit(root, ['rev-parse', '--show-toplevel'])).toString().trim()) !== root
  )
    throw new ZuvRequestError('RECOVERY_REQUIRED');
  validateWorkspacePaths(untracked);
  const before = await gitState(root);
  const baseRaw = before.head
    ? await workspaceGit(root, ['ls-tree', '-rz', before.head])
    : Buffer.alloc(0);
  const base = entries(baseRaw, false),
    index = entries(before.index, true);
  const tracked = new Set([...base, ...index].map((entry) => entry.path));
  const available = new Set(
    (await workspaceGit(root, ['ls-files', '--others', '--exclude-standard', '-z']))
      .toString()
      .split('\0')
      .filter(Boolean),
  );
  if (untracked.some((path) => tracked.has(path) || !available.has(path)))
    throw new ZuvRequestError('REVISION_CONFLICT');
  const selected = [...new Set([...tracked, ...untracked])].sort();
  validateWorkspacePaths(selected);
  const executables = new Map(index.map((file) => [file.path, file.executable]));
  const worktree = await snapshotBundle({ path: root, paths: selected, guard, executables });
  const files: BundleFile[] = [];
  let bytes = 0;
  const contents = new Set<string>();
  const add = (file: BundleFile) => {
    if (!contents.has(file.sha256)) {
      bytes += file.bytes.length;
      contents.add(file.sha256);
    }
    if (bytes > WORKSPACE_MAX_BYTES || files.length >= MAX_FILES)
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    files.push(file);
  };
  const objects = new Map<string, Buffer>();
  for (const [layer, values] of [
    ['base', base],
    ['index', index],
  ] as const) {
    for (const entry of values) {
      guard();
      let content = objects.get(entry.oid);
      if (!content) {
        const size = Number((await workspaceGit(root, ['cat-file', '-s', entry.oid])).toString());
        if (!Number.isSafeInteger(size) || size < 0 || bytes + size > WORKSPACE_MAX_BYTES)
          throw new ZuvRequestError('QUOTA_EXCEEDED');
        content = await workspaceGit(root, ['cat-file', 'blob', entry.oid]);
        if (content.length !== size) throw new ZuvRequestError('REVISION_CONFLICT');
        objects.set(entry.oid, content);
      }
      add({
        path: `${layer}/${entry.path}`,
        bytes: content,
        sha256: sha256(content),
        executable: entry.executable,
      });
    }
  }
  for (const file of worktree.files) add({ ...file, path: `worktree/${file.path}` });
  workspaceLayers(files);
  const afterFiles = await snapshotBundle({ path: root, paths: selected, guard, executables });
  guard();
  if (
    before.hash !== (await gitState(root)).hash ||
    worktree.fingerprint !== afterFiles.fingerprint
  )
    throw new ZuvRequestError('REVISION_CONFLICT');
  const exclusions = new Set<string>();
  for (const raw of [baseRaw, before.index])
    for (const row of raw.toString().split('\0').filter(Boolean)) {
      const path = row.slice(row.indexOf('\t') + 1);
      if (excludedBundlePath(path)) exclusions.add(path);
    }
  return {
    files,
    exclusions: [...exclusions].sort(),
    sourceHead: before.head,
    statusHash: before.hash,
  };
}

export function workspaceLayers(files: readonly BundleFile[]) {
  const layers = {
    base: [] as BundleFile[],
    index: [] as BundleFile[],
    worktree: [] as BundleFile[],
  };
  let total = 0;
  const contents = new Set<string>();
  const digests = new Map<Buffer, string>();
  for (const file of files) {
    const slash = file.path.indexOf('/'),
      layer = file.path.slice(0, slash);
    if (!['base', 'index', 'worktree'].includes(layer))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const digest = digests.get(file.bytes) ?? sha256(file.bytes);
    digests.set(file.bytes, digest);
    if (file.bytes.length > WORKSPACE_MAX_BYTES || digest !== file.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (!contents.has(file.sha256)) {
      total += file.bytes.length;
      contents.add(file.sha256);
    }
    if (total > WORKSPACE_MAX_BYTES || files.length > MAX_FILES)
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    layers[layer as keyof typeof layers].push({ ...file, path: file.path.slice(slash + 1) });
  }
  for (const layer of Object.values(layers)) validateWorkspacePaths(layer.map((file) => file.path));
  const names = [
    ...new Set(
      Object.values(layers)
        .flat()
        .map((file) => file.path),
    ),
  ];
  const caseNames = new Map<string, string>();
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length) {
      const prefix = parts.join('/');
      if (caseNames.has(fold(prefix)) && caseNames.get(fold(prefix)) !== prefix)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      caseNames.set(fold(prefix), prefix);
      parts.pop();
    }
  }
  return layers;
}

async function writeIndex(cwd: string, files: readonly BundleFile[], guard: () => void) {
  guard();
  await workspaceGit(cwd, ['read-tree', '--empty']);
  const rows: string[] = [];
  for (const file of files) {
    guard();
    const oid = (
      await workspaceGit(cwd, ['hash-object', '-w', '--stdin', '--no-filters'], file.bytes)
    )
      .toString()
      .trim();
    rows.push(`${file.executable ? '100755' : '100644'} ${oid}\t${file.path}\0`);
  }
  await workspaceGit(cwd, ['update-index', '-z', '--index-info'], Buffer.from(rows.join('')));
  guard();
}

export async function restoreWorkspaceTree(
  cwd: string,
  files: readonly BundleFile[],
  metadata: SyncWorkspaceMetadata,
  guard: () => void = () => {},
) {
  guard();
  const layers = workspaceLayers(files);
  await workspaceGit(cwd, ['init', '--template=', '--initial-branch=handoff']);
  await writeIndex(cwd, layers.base, guard);
  const tree = (await workspaceGit(cwd, ['write-tree'])).toString().trim();
  const commit = Buffer.from(
    `tree ${tree}\nauthor Wevir <workspace@localhost> 0 +0000\ncommitter Wevir <workspace@localhost> 0 +0000\n\nWorkspace base (${metadata.sourceHead ?? 'unborn'})\n`,
  );
  const head = (await workspaceGit(cwd, ['hash-object', '-t', 'commit', '-w', '--stdin'], commit))
    .toString()
    .trim();
  await workspaceGit(cwd, ['update-ref', 'refs/heads/handoff', head]);
  await writeIndex(cwd, layers.index, guard);
  for (const file of layers.worktree) {
    guard();
    const path = join(cwd, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const output = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      file.executable ? 0o700 : 0o600,
    );
    try {
      await output.writeFile(file.bytes);
      await output.sync();
    } finally {
      await output.close();
    }
  }
  // No checkout/add: downloaded attributes must never invoke clean/smudge filters.
  await mkdir(join(cwd, '.git/info'), { recursive: true, mode: 0o700 });
  await writeFile(join(cwd, '.git/info/exclude'), '.wevir-sync-*\n');
  guard();
  return {
    head,
    requiresTrust: layers.worktree.map((file) => file.path).filter(workspaceRequiresTrust),
  };
}

export async function inspectWorkspaceTree(cwd: string) {
  const info = await lstat(cwd);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
  const names = [
    ...PROJECT_FILES.map((file) => file.name.split('\\').join('/')),
    '.gitattributes',
    '.mcp.json',
    'mcp.json',
    'opencode.json',
    'opencode.jsonc',
    ...['.claude', '.codex', '.cursor', '.opencode', '.kiro', '.gemini', '.agents', '.wevir'].map(
      (dir) => `${dir}/**`,
    ),
  ];
  const candidates = (
    await workspaceGit(
      cwd,
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...names.map((name) => `:(glob)**/${name}`),
      ],
      undefined,
      1024 * 1024,
    )
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  const requiresTrust: string[] = [];
  for (const path of new Set(candidates)) {
    if (!workspaceRequiresTrust(path)) continue;
    const file = await lstat(join(cwd, path)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    if (file) requiresTrust.push(path);
  }
  let fingerprint: string | undefined;
  try {
    const status = await workspaceGit(
      cwd,
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      undefined,
      1024 * 1024,
    );
    const revision = await workspaceGit(cwd, ['rev-parse', '--verify', 'HEAD']).then(
      () => 'HEAD',
      () => '--cached',
    );
    const diff = await workspaceGit(
      cwd,
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', revision],
      undefined,
      1024 * 1024,
    );
    fingerprint = sha256(Buffer.concat([status, diff]));
  } catch (error) {
    if (!(error instanceof ZuvRequestError && error.code === 'QUOTA_EXCEEDED')) throw error;
  }
  return {
    fingerprint,
    requiresTrust: requiresTrust.sort(),
  };
}

export async function workspaceTreeFingerprint(cwd: string) {
  return (await inspectWorkspaceTree(cwd)).fingerprint;
}
