// Python、Go、Rust、C/C++、Swift 项目的预检（项目环境就绪，0.70.0）：运行时与编译器的版本要求、锁文件与清单是否一致、依赖在不在，
// 以及按锁文件的安装命令。只读文件；Python 不往系统或用户目录装（没有项目里的虚拟环境时不给 pip 的方案）。

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReadinessEvidence, ReadinessItem } from '@wevir/protocol';
import { type Analysis, emptyAnalysis, type PlanDraft } from './analysis.js';
import { fileEvidence, joinRel, type ProjectFiles } from './files.js';
import { fingerprintOf } from './node.js';

const MTIME_SLACK_MS = 2000;

export interface AnalyzeOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home?: string;
}

// ── TOML 的一小部分 ─────────────────────────────────────────────────

/** `[header]` 这一节的正文（到下一个表头为止）；没有时 undefined。 */
export function tomlSection(text: string, header: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${header}]`);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[\[?[A-Za-z0-9_."' -]+\]\]?\s*(#.*)?$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

export function tomlString(section: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm').exec(
    section,
  );
  return match ? (match[1] ?? match[2]) : undefined;
}

/** `key = [ "a", "b" ]`（可以跨行）里的字符串。 */
export function tomlArray(section: string, key: string): string[] | undefined {
  const start = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[`, 'm').exec(section);
  if (!start) return undefined;
  let depth = 0;
  let end = start.index + start[0].length - 1;
  for (; end < section.length; end++) {
    const char = section[end];
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = section.slice(start.index + start[0].length, end);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

/** 表里的键（`[dependencies]` 下的依赖名）。 */
export function tomlKeys(section: string): string[] {
  const keys: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=/.exec(line);
    if (match) keys.push((match[1] as string).replace(/^"|"$/g, ''));
  }
  return keys;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** PEP 503 的名字规整。 */
export function pythonName(spec: string): string {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1] ?? spec;
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// ── Python ─────────────────────────────────────────────────────────

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg'];

export async function analyzePython(
  files: ProjectFiles,
  dirs: readonly string[],
  options: AnalyzeOptions,
): Promise<Analysis> {
  const result = emptyAnalysis();
  for (const dir of dirs) {
    let present = false;
    for (const marker of PYTHON_MARKERS) {
      if (await files.isFile(joinRel(dir, marker))) present = true;
    }
    if (!present) continue;
    await analyzePythonProject(files, dir, options, result);
  }
  return result;
}

async function analyzePythonProject(
  files: ProjectFiles,
  dir: string,
  options: AnalyzeOptions,
  result: Analysis,
): Promise<void> {
  const pyprojectPath = joinRel(dir, 'pyproject.toml');
  const pyproject = (await files.text(pyprojectPath)) ?? '';
  const project = tomlSection(pyproject, 'project');
  const dependencies = project === undefined ? [] : (tomlArray(project, 'dependencies') ?? []);
  const has = async (name: string) => files.isFile(joinRel(dir, name));
  const manager =
    (await has('uv.lock')) || tomlSection(pyproject, 'tool.uv') !== undefined
      ? 'uv'
      : (await has('poetry.lock')) || tomlSection(pyproject, 'tool.poetry') !== undefined
        ? 'poetry'
        : (await has('Pipfile'))
          ? 'pipenv'
          : 'pip';
  result.projects.push({ path: dir, ecosystems: ['python'] });

  // ── Python 版本 ──
  const evidence: ReadinessEvidence[] = [];
  let required: string | undefined;
  let rangeKind: 'pep440' | 'npm' | undefined;
  const requires = project === undefined ? undefined : tomlString(project, 'requires-python');
  if (requires !== undefined) {
    evidence.push(fileEvidence(pyprojectPath, `requires-python: ${requires}`));
    required = requires;
    rangeKind = 'pep440';
  }
  const pinned = (await files.text(joinRel(dir, '.python-version')))?.trim().split(/\s+/)[0];
  if (pinned) {
    evidence.push(fileEvidence(joinRel(dir, '.python-version'), pinned));
    if (required === undefined && /^\d+(\.\d+){0,2}$/.test(pinned)) {
      required = pinned;
      rangeKind = 'npm';
    }
  }
  result.tools.push({
    tool: options.platform === 'win32' ? 'python' : 'python3',
    name: 'python',
    kind: 'runtime',
    path: dir,
    ...(required !== undefined && { required, rangeKind }),
    blocking: true,
    versionBlocking: requires !== undefined,
    evidence,
    ...(options.platform !== 'win32' && { fallback: 'python' }),
  });
  if (manager !== 'pip') {
    result.tools.push({
      tool: manager,
      kind: 'package_manager',
      path: dir,
      blocking: true,
      versionBlocking: false,
      evidence: [fileEvidence(manager === 'pipenv' ? joinRel(dir, 'Pipfile') : pyprojectPath)],
    });
  }

  // ── 锁文件 ──
  const lockName =
    manager === 'uv'
      ? 'uv.lock'
      : manager === 'poetry'
        ? 'poetry.lock'
        : manager === 'pipenv'
          ? 'Pipfile.lock'
          : undefined;
  const lockPath = lockName === undefined ? undefined : joinRel(dir, lockName);
  let lockItem: ReadinessItem | undefined;
  if (lockPath !== undefined) {
    const lockText = await files.text(lockPath);
    const base = { id: `lockfile::${dir}`, kind: 'lockfile', name: lockName as string, path: dir };
    if (lockText === undefined) {
      lockItem = {
        ...base,
        status: 'missing',
        reason: 'lockfile_missing',
        blocking: false,
        evidence: [
          fileEvidence(
            manager === 'pipenv' ? joinRel(dir, 'Pipfile') : pyprojectPath,
            'no lockfile',
          ),
        ],
      };
    } else if (manager === 'uv') {
      const locked = uvLockedNames(lockText);
      const missing = dependencies
        .map(pythonName)
        .filter((name) => locked !== undefined && !locked.has(name));
      lockItem =
        locked === undefined
          ? {
              ...base,
              status: 'unknown',
              reason: 'lockfile_unreadable',
              blocking: false,
              evidence: [fileEvidence(lockPath)],
            }
          : missing.length > 0
            ? {
                ...base,
                status: 'incompatible',
                reason: 'lockfile_mismatch',
                blocking: true,
                evidence: [
                  fileEvidence(lockPath, `not locked: ${missing.slice(0, 8).join(', ')}`),
                  fileEvidence(pyprojectPath),
                ],
              }
            : { ...base, status: 'ready', blocking: false, evidence: [fileEvidence(lockPath)] };
    } else {
      const manifestTime = await files.mtime(
        manager === 'pipenv' ? joinRel(dir, 'Pipfile') : pyprojectPath,
      );
      const lockTime = await files.mtime(lockPath);
      lockItem =
        manifestTime !== undefined &&
        lockTime !== undefined &&
        manifestTime > lockTime + MTIME_SLACK_MS
          ? {
              ...base,
              status: 'unknown',
              reason: 'lockfile_maybe_outdated',
              blocking: false,
              evidence: [
                fileEvidence(
                  lockPath,
                  `older than ${manager === 'pipenv' ? 'Pipfile' : 'pyproject.toml'}`,
                ),
              ],
            }
          : { ...base, status: 'ready', blocking: false, evidence: [fileEvidence(lockPath)] };
    }
    result.items.push(lockItem);
  }

  // ── 虚拟环境 ──
  const venv = await findVenv(files, dir);
  const requirements = (await has('requirements.txt'))
    ? joinRel(dir, 'requirements.txt')
    : undefined;
  const declares =
    dependencies.length > 0 ||
    requirements !== undefined ||
    manager === 'pipenv' ||
    lockItem !== undefined;
  if (!declares) return;
  const base = { id: `dependencies::${dir}`, kind: 'dependencies', path: dir };
  let depsItem: ReadinessItem;
  // uv 的虚拟环境总在项目里；poetry、pipenv 与 pip 只认项目里的 `.venv` / `venv`，在别处时说不准。
  if (!venv) {
    depsItem =
      manager === 'uv'
        ? {
            ...base,
            name: '.venv',
            status: 'missing',
            reason: 'dependencies_missing',
            blocking: true,
            evidence: [fileEvidence(joinRel(dir, '.venv'), 'not found')],
          }
        : {
            ...base,
            name: 'virtualenv',
            status: 'unknown',
            reason: 'no_virtualenv',
            blocking: false,
            evidence: [fileEvidence(joinRel(dir, '.venv'), 'not found')],
          };
  } else {
    const sitePackages = await files.mtime(venv.sitePackages);
    const source = lockPath ?? requirements ?? pyprojectPath;
    const sourceTime = await files.mtime(source);
    const outdated =
      sitePackages !== undefined &&
      sourceTime !== undefined &&
      sourceTime > sitePackages + MTIME_SLACK_MS;
    depsItem = outdated
      ? {
          ...base,
          name: venv.dir,
          status: 'incompatible',
          reason: 'dependencies_outdated',
          blocking: manager === 'uv',
          evidence: [
            fileEvidence(venv.sitePackages, `older than ${source.split('/').at(-1)}`),
            fileEvidence(source),
          ],
        }
      : {
          ...base,
          name: venv.dir,
          status: 'ready',
          blocking: true,
          ...(venv.version !== undefined && { found: venv.version }),
          evidence: [fileEvidence(joinRel(venv.dir, 'pyvenv.cfg'), venv.version)],
        };
  }
  result.items.push(depsItem);

  const needed = depsItem.status !== 'ready' || lockItem?.status === 'incompatible';
  const lockReady =
    lockItem !== undefined && lockItem.status !== 'missing' && lockItem.status !== 'incompatible';
  const python = venv
    ? options.platform === 'win32'
      ? `${venv.dir.replace(/^.*\//, '')}\\Scripts\\python.exe`
      : `${venv.dir.replace(/^.*\//, '')}/bin/python`
    : undefined;
  const command =
    manager === 'uv'
      ? lockReady
        ? 'uv sync --locked'
        : 'uv sync'
      : manager === 'poetry'
        ? 'poetry install --no-interaction'
        : manager === 'pipenv'
          ? lockReady
            ? 'pipenv sync'
            : 'pipenv install'
          : python !== undefined && requirements !== undefined
            ? `${python} -m pip install -r requirements.txt`
            : undefined;
  if (command === undefined) return;
  result.plans.push({
    path: dir,
    manager,
    command,
    ...(lockName !== undefined && lockItem?.status !== 'missing' && { lockfile: lockName }),
    writesLockfile: lockName !== undefined && !lockReady,
    reason:
      lockItem?.status === 'incompatible'
        ? 'lockfile_mismatch'
        : (depsItem.reason ?? 'dependencies_missing'),
    // 源码包（sdist）的构建会执行代码。
    scripts: { project: [], dependencies: 'run' },
    credentials: pythonCredentials(options.env),
    fingerprint: await fingerprintOf(files, [
      pyprojectPath,
      ...(lockPath ? [lockPath] : []),
      ...(requirements ? [requirements] : []),
    ]),
    needed,
  } satisfies PlanDraft);
}

/** uv.lock 里项目自己（`source = { editable = "." }` / `virtual`）的 `requires-dist` 名字。 */
export function uvLockedNames(text: string): Set<string> | undefined {
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    if (!/^source\s*=\s*\{\s*(editable|virtual)\s*=\s*"\."\s*\}/m.test(block)) continue;
    const names = new Set<string>();
    const metadata = /\[package\.metadata\]([\s\S]*)/.exec(block)?.[1] ?? '';
    for (const match of metadata.matchAll(/\{\s*name\s*=\s*"([^"]+)"/g))
      names.add(pythonName(match[1] as string));
    for (const match of block.matchAll(/^\s*\{\s*name\s*=\s*"([^"]+)"/gm))
      names.add(pythonName(match[1] as string));
    return names;
  }
  return undefined;
}

async function findVenv(
  files: ProjectFiles,
  dir: string,
): Promise<{ dir: string; sitePackages: string; version?: string } | undefined> {
  for (const name of ['.venv', 'venv']) {
    const venv = joinRel(dir, name);
    const cfg = await files.text(joinRel(venv, 'pyvenv.cfg'));
    if (cfg === undefined) continue;
    const version = /^\s*version(?:_info)?\s*=\s*([\d.]+)/m.exec(cfg)?.[1];
    let sitePackages = joinRel(venv, 'Lib/site-packages');
    for (const lib of await files.list(joinRel(venv, 'lib'))) {
      if (lib.startsWith('python')) sitePackages = joinRel(venv, `lib/${lib}/site-packages`);
    }
    return { dir: venv, sitePackages, ...(version !== undefined && { version }) };
  }
  return undefined;
}

function pythonCredentials(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) =>
      /^(UV_INDEX_[A-Z0-9_]+_(USERNAME|PASSWORD)|POETRY_HTTP_BASIC_[A-Z0-9_]+_(USERNAME|PASSWORD)|PIP_INDEX_URL)$/.test(
        key,
      ),
    )
    .slice(0, 8);
}

// ── Go ─────────────────────────────────────────────────────────────

export interface GoModule {
  path: string;
  version: string;
}

/** go.mod：`go` 指令、`toolchain` 与 require 的模块。 */
export function parseGoMod(text: string): {
  go?: string;
  toolchain?: string;
  requires: GoModule[];
} {
  const go = /^go\s+(\d+(?:\.\d+){0,2})\s*$/m.exec(text)?.[1];
  const toolchain = /^toolchain\s+go(\S+)\s*$/m.exec(text)?.[1];
  const requires: GoModule[] = [];
  const add = (line: string) => {
    const match = /^\s*(\S+)\s+(v\S+)/.exec(line.replace(/\/\/.*$/, ''));
    if (match) requires.push({ path: match[1] as string, version: match[2] as string });
  };
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
    for (const line of (block[1] as string).split(/\r?\n/)) add(line);
  }
  for (const match of text.matchAll(/^require\s+([^(\s].*)$/gm)) add(match[1] as string);
  return {
    ...(go !== undefined && { go }),
    ...(toolchain !== undefined && { toolchain }),
    requires,
  };
}

/** 模块缓存里的路径写法：大写字母写成 `!` 加小写。 */
function escapeModule(path: string): string {
  return path.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`);
}

export async function analyzeGo(
  files: ProjectFiles,
  dirs: readonly string[],
  options: AnalyzeOptions,
): Promise<Analysis> {
  const result = emptyAnalysis();
  for (const dir of dirs) {
    const modPath = joinRel(dir, 'go.mod');
    const text = await files.text(modPath);
    if (text === undefined) continue;
    const mod = parseGoMod(text);
    result.projects.push({ path: dir, ecosystems: ['go'] });
    result.tools.push({
      tool: 'go',
      kind: 'runtime',
      path: dir,
      ...(mod.go !== undefined && { required: mod.go, rangeKind: 'min' as const }),
      blocking: true,
      versionBlocking: true,
      evidence: [
        fileEvidence(
          modPath,
          [mod.go && `go ${mod.go}`, mod.toolchain && `toolchain go${mod.toolchain}`]
            .filter(Boolean)
            .join('; ') || undefined,
        ),
      ],
    });
    if (mod.requires.length === 0) continue;
    const sumPath = joinRel(dir, 'go.sum');
    const sum = await files.text(sumPath);
    const base = { id: `lockfile::${dir}`, kind: 'lockfile', name: 'go.sum', path: dir };
    const unsummed =
      sum === undefined
        ? []
        : mod.requires.filter((m) => !sum.includes(`${m.path} ${m.version}/go.mod`));
    const lockItem: ReadinessItem =
      sum === undefined
        ? {
            ...base,
            status: 'missing',
            reason: 'lockfile_missing',
            blocking: true,
            evidence: [fileEvidence(sumPath, 'not found')],
          }
        : unsummed.length > 0
          ? {
              ...base,
              status: 'incompatible',
              reason: 'lockfile_mismatch',
              blocking: true,
              evidence: [
                fileEvidence(
                  sumPath,
                  `missing: ${unsummed
                    .slice(0, 5)
                    .map((m) => `${m.path}@${m.version}`)
                    .join(', ')}`,
                ),
                fileEvidence(modPath),
              ],
            }
          : { ...base, status: 'ready', blocking: false, evidence: [fileEvidence(sumPath)] };
    result.items.push(lockItem);

    const depsBase = { id: `dependencies::${dir}`, kind: 'dependencies', path: dir };
    let depsItem: ReadinessItem;
    if (await files.isFile(joinRel(dir, 'vendor/modules.txt'))) {
      depsItem = {
        ...depsBase,
        name: 'vendor',
        status: 'ready',
        blocking: true,
        evidence: [fileEvidence(joinRel(dir, 'vendor/modules.txt'))],
      };
    } else {
      const cache = goModCache(options);
      const missing: GoModule[] = [];
      for (const module of mod.requires.slice(0, 400)) {
        const zip = join(
          cache,
          'cache',
          'download',
          ...escapeModule(module.path).split('/'),
          '@v',
          `${module.version}.mod`,
        );
        if ((await stat(zip).catch(() => undefined)) === undefined) missing.push(module);
      }
      depsItem =
        missing.length > 0
          ? {
              ...depsBase,
              name: 'module cache',
              status: 'missing',
              reason: 'dependencies_missing',
              blocking: true,
              evidence: [
                {
                  kind: 'file',
                  path: tildePath(cache, options),
                  detail: `missing: ${missing
                    .slice(0, 5)
                    .map((m) => `${m.path}@${m.version}`)
                    .join(', ')}`,
                },
              ],
            }
          : {
              ...depsBase,
              name: 'module cache',
              status: 'ready',
              blocking: true,
              evidence: [{ kind: 'file', path: tildePath(cache, options) }],
            };
    }
    result.items.push(depsItem);
    const needed = depsItem.status !== 'ready' || lockItem.status !== 'ready';
    result.plans.push({
      path: dir,
      manager: 'go',
      command: 'go mod download',
      ...(sum !== undefined && { lockfile: 'go.sum' }),
      writesLockfile: lockItem.status !== 'ready',
      reason:
        lockItem.status === 'incompatible'
          ? 'lockfile_mismatch'
          : (depsItem.reason ?? 'dependencies_missing'),
      scripts: { project: [], dependencies: 'disabled' },
      credentials: [],
      fingerprint: await fingerprintOf(files, [modPath, sumPath]),
      needed,
    });
  }
  return result;
}

function goModCache(options: AnalyzeOptions): string {
  if (options.env.GOMODCACHE) return options.env.GOMODCACHE;
  const gopath = options.env.GOPATH?.split(options.platform === 'win32' ? ';' : ':')[0];
  return join(gopath || join(options.home ?? homedir(), 'go'), 'pkg', 'mod');
}

function tildePath(path: string, options: AnalyzeOptions): string {
  const home = options.home ?? homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// ── Rust ───────────────────────────────────────────────────────────

/** Cargo.toml 里的依赖名（含改名的 `package = "…"`）。 */
export function cargoDependencies(text: string): string[] {
  const names = new Set<string>();
  const lines = text.split(/\r?\n/);
  let inDeps = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const name = (header[1] as string).trim();
      const table =
        /^(?:target\..+\.)?(?:workspace\.)?(dependencies|dev-dependencies|build-dependencies)(?:\.(.+))?$/.exec(
          name,
        );
      inDeps = table !== null && table[2] === undefined;
      if (table?.[2] !== undefined) names.add(table[2].replace(/^"|"$/g, ''));
      continue;
    }
    if (!inDeps) continue;
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const renamed = /package\s*=\s*"([^"]+)"/.exec(match[2] as string)?.[1];
    if (/path\s*=/.test(match[2] as string)) continue;
    names.add(renamed ?? (match[1] as string));
  }
  return [...names];
}

export function cargoLockPackages(
  text: string,
): Array<{ name: string; version: string; source?: string }> {
  const packages: Array<{ name: string; version: string; source?: string }> = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const source = /^source\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (name && version) packages.push({ name, version, ...(source !== undefined && { source }) });
  }
  return packages;
}

export async function analyzeRust(
  files: ProjectFiles,
  dirs: readonly string[],
  options: AnalyzeOptions,
): Promise<Analysis> {
  const result = emptyAnalysis();
  const taken: string[] = [];
  for (const dir of dirs) {
    const tomlPath = joinRel(dir, 'Cargo.toml');
    const text = await files.text(tomlPath);
    if (text === undefined) continue;
    // 工作区成员跟着工作区根走。
    if (taken.some((root) => root === '' || dir.startsWith(`${root}/`))) continue;
    taken.push(dir);
    result.projects.push({ path: dir, ecosystems: ['rust'] });
    const msrv = tomlString(
      tomlSection(text, 'package') ?? tomlSection(text, 'workspace.package') ?? '',
      'rust-version',
    );
    const toolchainText =
      (await files.text(joinRel(dir, 'rust-toolchain.toml'))) ??
      (await files.text(joinRel(dir, 'rust-toolchain')));
    const channel =
      toolchainText === undefined
        ? undefined
        : (tomlString(toolchainText, 'channel') ?? toolchainText.trim().split(/\s+/)[0]);
    const evidence: ReadinessEvidence[] = [
      fileEvidence(tomlPath, msrv !== undefined ? `rust-version: ${msrv}` : undefined),
    ];
    if (channel)
      evidence.push(fileEvidence(joinRel(dir, 'rust-toolchain.toml'), `channel: ${channel}`));
    const required =
      msrv ?? (channel !== undefined && /^\d+\.\d+(\.\d+)?$/.test(channel) ? channel : undefined);
    result.tools.push({
      tool: 'rustc',
      kind: 'compiler',
      path: dir,
      ...(required !== undefined && { required, rangeKind: 'min' as const }),
      blocking: true,
      versionBlocking: msrv !== undefined,
      evidence,
    });
    result.tools.push({
      tool: 'cargo',
      kind: 'package_manager',
      path: dir,
      blocking: true,
      versionBlocking: false,
      evidence: [fileEvidence(tomlPath)],
    });

    const deps = cargoDependencies(text);
    if (deps.length === 0) continue;
    const lockPath = joinRel(dir, 'Cargo.lock');
    const lockText = await files.text(lockPath);
    const base = { id: `lockfile::${dir}`, kind: 'lockfile', name: 'Cargo.lock', path: dir };
    const packages = lockText === undefined ? [] : cargoLockPackages(lockText);
    const lockedNames = new Set(packages.map((pkg) => pkg.name));
    const unlocked = deps.filter(
      (name) => !lockedNames.has(name) && !lockedNames.has(name.replace(/_/g, '-')),
    );
    const lockItem: ReadinessItem =
      lockText === undefined
        ? {
            ...base,
            status: 'missing',
            reason: 'lockfile_missing',
            blocking: false,
            evidence: [fileEvidence(tomlPath, 'no Cargo.lock')],
          }
        : unlocked.length > 0
          ? {
              ...base,
              status: 'incompatible',
              reason: 'lockfile_mismatch',
              blocking: true,
              evidence: [
                fileEvidence(lockPath, `not locked: ${unlocked.slice(0, 8).join(', ')}`),
                fileEvidence(tomlPath),
              ],
            }
          : { ...base, status: 'ready', blocking: false, evidence: [fileEvidence(lockPath)] };
    result.items.push(lockItem);

    const cargoHome = options.env.CARGO_HOME || join(options.home ?? homedir(), '.cargo');
    const cacheRoot = join(cargoHome, 'registry', 'cache');
    const indexes = await readdir(cacheRoot).catch(() => [] as string[]);
    const registry = packages.filter(
      (pkg) => pkg.source?.startsWith('registry+') || pkg.source?.startsWith('sparse+'),
    );
    const missing: string[] = [];
    for (const pkg of registry.slice(0, 600)) {
      let found = false;
      for (const index of indexes) {
        if (
          (await stat(join(cacheRoot, index, `${pkg.name}-${pkg.version}.crate`)).catch(
            () => undefined,
          )) !== undefined
        ) {
          found = true;
          break;
        }
      }
      if (!found) missing.push(`${pkg.name}@${pkg.version}`);
    }
    const depsBase = {
      id: `dependencies::${dir}`,
      kind: 'dependencies',
      name: 'registry cache',
      path: dir,
    };
    const cachePath = tildePath(cacheRoot, options);
    const depsItem: ReadinessItem =
      lockText === undefined
        ? {
            ...depsBase,
            status: 'unknown',
            reason: 'lockfile_missing',
            blocking: false,
            evidence: [{ kind: 'file', path: cachePath }],
          }
        : missing.length > 0
          ? {
              ...depsBase,
              status: 'missing',
              reason: 'dependencies_missing',
              blocking: true,
              evidence: [
                {
                  kind: 'file',
                  path: cachePath,
                  detail: `missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}`,
                },
              ],
            }
          : {
              ...depsBase,
              status: 'ready',
              blocking: true,
              evidence: [{ kind: 'file', path: cachePath, detail: `${registry.length} crates` }],
            };
    result.items.push(depsItem);
    const needed = depsItem.status !== 'ready' || lockItem.status !== 'ready';
    const locked = lockItem.status === 'ready';
    result.plans.push({
      path: dir,
      manager: 'cargo',
      command: locked ? 'cargo fetch --locked' : 'cargo fetch',
      ...(lockText !== undefined && { lockfile: 'Cargo.lock' }),
      writesLockfile: !locked,
      reason:
        lockItem.status === 'incompatible'
          ? 'lockfile_mismatch'
          : (depsItem.reason ?? 'dependencies_missing'),
      // 下载不跑 build.rs（那在构建时）。
      scripts: { project: [], dependencies: 'disabled' },
      credentials: Object.keys(options.env)
        .filter((key) => /^CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN$/.test(key))
        .slice(0, 8),
      fingerprint: await fingerprintOf(files, [tomlPath, lockPath]),
      needed,
    });
  }
  return result;
}

// ── C / C++ / Swift ────────────────────────────────────────────────

export async function analyzeNative(
  files: ProjectFiles,
  dirs: readonly string[],
): Promise<Analysis> {
  const result = emptyAnalysis();
  for (const dir of dirs) {
    const tools: Array<[string, string]> = [];
    const cmake = joinRel(dir, 'CMakeLists.txt');
    const meson = joinRel(dir, 'meson.build');
    const makefile = (
      await Promise.all(
        ['Makefile', 'makefile', 'GNUmakefile'].map(async (name) =>
          (await files.isFile(joinRel(dir, name))) ? name : undefined,
        ),
      )
    ).find(Boolean);
    if (await files.isFile(cmake)) tools.push(['cmake', cmake], ['cc', cmake]);
    if (await files.isFile(meson)) tools.push(['meson', meson], ['ninja', meson], ['cc', meson]);
    if (makefile) {
      tools.push(['make', joinRel(dir, makefile)]);
      if (
        (await files.isFile(joinRel(dir, 'configure'))) ||
        /\$\(CC\)|\bgcc\b|\bclang\b|\bcc\b/.test((await files.text(joinRel(dir, makefile))) ?? '')
      ) {
        tools.push(['cc', joinRel(dir, makefile)]);
      }
    }
    const swift = joinRel(dir, 'Package.swift');
    if (await files.isFile(swift)) tools.push(['swift', swift]);
    if (tools.length === 0) continue;
    result.projects.push({
      path: dir,
      ecosystems:
        tools.some(([tool]) => tool === 'swift') && tools.length === 1 ? ['swift'] : ['c'],
    });
    const seen = new Set<string>();
    for (const [tool, file] of tools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      result.tools.push({
        tool,
        kind: tool === 'cc' || tool === 'swift' ? 'compiler' : 'build_tool',
        path: dir,
        blocking: true,
        versionBlocking: false,
        evidence: [fileEvidence(file)],
      });
    }
  }
  return result;
}
