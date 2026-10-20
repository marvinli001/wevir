// Node 项目的预检（项目环境就绪，0.70.0）：包管理器与版本（`packageManager`、`devEngines`、`engines`、锁文件）、Node 版本要求
// （`engines.node`、`.nvmrc`、`.node-version`）、锁文件与清单是否一致（pnpm、npm、yarn、bun 的锁文件各读各的格式）、依赖目录在不在、
// 有没有比锁文件旧，以及按锁文件与项目约定的安装命令。只读文件，不跑包管理器。

import { createHash } from 'node:crypto';
import type { InstallScripts, ReadinessEvidence, ReadinessItem } from '@wevir/protocol';
import {
  type Analysis,
  emptyAnalysis,
  LIFECYCLE_SCRIPTS,
  type PlanDraft,
  type ToolNeed,
} from './analysis.js';
import { fileEvidence, joinRel, type ProjectFiles, stringRecord, within } from './files.js';
import { parseVersion } from './versions.js';

export type NodeManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

const LOCKFILES: ReadonlyArray<readonly [string, NodeManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** 一份清单的依赖（`dependencies` 等合在一起，名字 → 版本要求）。 */
type DependencyMap = Map<string, string>;

/** 锁文件里每个目录（importer）记下的直接依赖；`undefined` 是读不懂。 */
type LockImporters = Map<string, DependencyMap>;

/** 两次比较之间允许的时间差：安装时先写锁文件再写安装标记。 */
const MTIME_SLACK_MS = 2000;
/** 每个目录最多看这么多个直接依赖在不在。 */
const DEPENDENCY_CHECK_MAX = 400;

interface Manifest {
  path: string;
  json: Record<string, unknown>;
}

/** `dirs` 里有 `package.json` 的目录 → Node 项目（各自带锁文件或工作区配置的是独立的项目，其余是成员或嵌套的独立项目）。 */
export async function analyzeNode(files: ProjectFiles, dirs: readonly string[]): Promise<Analysis> {
  const result = emptyAnalysis();
  const manifests: Manifest[] = [];
  for (const dir of dirs) {
    const json = await files.json(joinRel(dir, 'package.json'));
    if (json) manifests.push({ path: dir, json });
  }
  const roots: Array<{ manifest: Manifest; members: Manifest[] }> = [];
  for (const manifest of manifests) {
    // 最近的上层项目（目录按层次从浅到深）。
    const owner = roots
      .filter(
        (root) => root.manifest.path !== manifest.path && within(manifest.path, root.manifest.path),
      )
      .at(-1);
    if (
      owner &&
      (await isMember(files, owner.manifest, manifest.path)) &&
      !(await lockfileOf(files, manifest.path))
    ) {
      owner.members.push(manifest);
      continue;
    }
    roots.push({ manifest, members: [] });
  }
  for (const { manifest, members } of roots) {
    const part = await analyzeProject(files, manifest, members);
    for (const key of Object.keys(part) as Array<keyof Analysis>) {
      (result[key] as unknown[]).push(...(part[key] as unknown[]));
    }
  }
  return result;
}

async function lockfileOf(
  files: ProjectFiles,
  dir: string,
): Promise<{ file: string; manager: NodeManager } | undefined> {
  for (const [file, manager] of LOCKFILES) {
    if (await files.isFile(joinRel(dir, file))) return { file, manager };
  }
  return undefined;
}

/** 工作区的成员目录模式：pnpm-workspace.yaml 的 `packages`，或 package.json 的 `workspaces`。 */
async function workspacePatterns(files: ProjectFiles, root: Manifest): Promise<string[]> {
  const patterns: string[] = [];
  const yaml = await files.text(joinRel(root.path, 'pnpm-workspace.yaml'));
  if (yaml !== undefined) patterns.push(...yamlList(yaml, 'packages'));
  const workspaces = root.json.workspaces;
  if (Array.isArray(workspaces)) {
    patterns.push(...workspaces.filter((item): item is string => typeof item === 'string'));
  } else if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      patterns.push(...packages.filter((item): item is string => typeof item === 'string'));
    }
  }
  return patterns;
}

async function isMember(files: ProjectFiles, root: Manifest, dir: string): Promise<boolean> {
  const rel = root.path === '' ? dir : dir.slice(root.path.length + 1);
  return (await workspacePatterns(files, root)).some(
    (pattern) => !pattern.startsWith('!') && matchWorkspace(pattern, rel),
  );
}

/** 工作区模式（`packages/*`、`apps/**`、`tools/cli`）匹配相对目录吗。 */
export function matchWorkspace(pattern: string, rel: string): boolean {
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  let source = '';
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i] as string;
    if (char === '*' && clean[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(rel);
}

/** YAML 顶层 `key:` 下的 `- item` 列表（pnpm-workspace.yaml 的 `packages`、`onlyBuiltDependencies`）。 */
export function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start < 0) {
    const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(text);
    return inline ? (inline[1] as string).split(',').map(unquote).filter(Boolean) : [];
  }
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) items.push(unquote(match[1] as string));
  }
  return items;
}

/** YAML 顶层 `key: value` 的值。 */
export function yamlValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(text);
  return match ? unquote(match[1] as string) : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, '');
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** 清单里会装的依赖（`dependencies`、`devDependencies`、`optionalDependencies`）。 */
export function manifestDependencies(json: Record<string, unknown>): DependencyMap {
  const map: DependencyMap = new Map();
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(stringRecord(json[key]))) map.set(name, spec);
  }
  return map;
}

/** `packageManager: "pnpm@12.6.0+sha512…"` → 名字与版本。 */
export function parsePackageManager(
  value: unknown,
): { name: string; version?: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(@?[^@\s]+)(?:@([^+\s]+))?/.exec(value.trim());
  if (!match) return undefined;
  return { name: match[1] as string, ...(match[2] !== undefined && { version: match[2] }) };
}

async function analyzeProject(
  files: ProjectFiles,
  root: Manifest,
  members: Manifest[],
): Promise<Analysis> {
  const result = emptyAnalysis();
  const dir = root.path;
  const manifestPath = joinRel(dir, 'package.json');
  const lock = await lockfileOf(files, dir);
  const declared = parsePackageManager(root.json.packageManager);
  const devEngines = root.json.devEngines as Record<string, unknown> | undefined;
  const devManager = devEngines?.packageManager as Record<string, unknown> | undefined;
  const engines = stringRecord(root.json.engines);
  const manager: NodeManager =
    knownManager(declared?.name) ??
    knownManager(typeof devManager?.name === 'string' ? devManager.name : undefined) ??
    lock?.manager ??
    'npm';
  const all = [root, ...members];
  const deps = all.map((manifest) => manifestDependencies(manifest.json));
  const hasDependencies = deps.some((map) => map.size > 0);
  result.projects.push({ path: dir, ecosystems: ['node'] });

  // ── 包管理器 ──
  const managerEvidence: ReadinessEvidence[] = [];
  let managerRequired: string | undefined;
  let managerRange: ToolNeed['rangeKind'];
  if (declared && knownManager(declared.name) === manager) {
    managerEvidence.push(
      fileEvidence(
        manifestPath,
        `packageManager: ${String(root.json.packageManager).replace(/\+.*$/, '')}`,
      ),
    );
    if (declared.version !== undefined) {
      managerRequired = declared.version;
      managerRange = 'exact';
    }
  } else if (typeof devManager?.version === 'string') {
    managerEvidence.push(
      fileEvidence(
        manifestPath,
        `devEngines.packageManager: ${String(devManager.name)}@${devManager.version}`,
      ),
    );
    managerRequired = devManager.version;
    managerRange = 'npm';
  }
  if (managerRequired === undefined && engines[manager] !== undefined) {
    managerEvidence.push(fileEvidence(manifestPath, `engines.${manager}: ${engines[manager]}`));
    managerRequired = engines[manager];
    managerRange = 'npm';
  }
  if (lock) managerEvidence.push(fileEvidence(joinRel(dir, lock.file)));
  if (declared && knownManager(declared.name) === undefined) {
    managerEvidence.push(fileEvidence(manifestPath, `packageManager: ${declared.name}`));
  }
  result.tools.push({
    tool: manager,
    kind: 'package_manager',
    path: dir,
    ...(managerRequired !== undefined && { required: managerRequired }),
    ...(managerRange !== undefined && { rangeKind: managerRange }),
    blocking: hasDependencies,
    versionBlocking: false,
    evidence: managerEvidence,
  });

  // ── Node 版本 ──
  const nodeEvidence: ReadinessEvidence[] = [];
  let nodeRequired: string | undefined;
  if (engines.node !== undefined) {
    nodeEvidence.push(fileEvidence(manifestPath, `engines.node: ${engines.node}`));
    nodeRequired = engines.node;
  }
  const runtime = devEngines?.runtime as Record<string, unknown> | undefined;
  if (
    nodeRequired === undefined &&
    runtime?.name === 'node' &&
    typeof runtime.version === 'string'
  ) {
    nodeEvidence.push(fileEvidence(manifestPath, `devEngines.runtime: node@${runtime.version}`));
    nodeRequired = runtime.version;
  }
  for (const file of ['.nvmrc', '.node-version']) {
    const text = (await files.text(joinRel(dir, file)))?.trim();
    if (!text) continue;
    nodeEvidence.push(fileEvidence(joinRel(dir, file), text.slice(0, 60)));
    const version = text.replace(/^v/, '');
    if (nodeRequired === undefined && /^\d+(\.\d+){0,2}$/.test(version)) nodeRequired = version;
  }
  result.tools.push({
    tool: 'node',
    kind: 'runtime',
    path: dir,
    ...(nodeRequired !== undefined && { required: nodeRequired, rangeKind: 'npm' as const }),
    blocking: true,
    versionBlocking: engines.node !== undefined || runtime !== undefined,
    evidence: nodeEvidence,
  });

  if (!hasDependencies) return result;

  // ── 锁文件与清单 ──
  const lockItem = await lockfileItem(files, dir, lock, all);
  result.items.push(lockItem);

  // ── 依赖目录 ──
  const pnp = await files.isFile(joinRel(dir, '.pnp.cjs'));
  const depsItem = pnp
    ? await pnpItem(files, dir, lock)
    : await dependenciesItem(files, dir, lock, manager, all, deps);
  result.items.push(depsItem);

  // ── 安装方案 ──
  {
    const mismatch = lockItem.status === 'incompatible';
    const berry =
      manager === 'yarn' &&
      ((await files.isFile(joinRel(dir, '.yarnrc.yml'))) ||
        (declared?.name === 'yarn' && (parseVersion(declared.version ?? '')?.[0] ?? 1) >= 2));
    const command = installCommand(manager, { lock: lock !== undefined && !mismatch, berry });
    const npmrc = (await files.text(joinRel(dir, '.npmrc'))) ?? '';
    const yarnrc = (await files.text(joinRel(dir, berry ? '.yarnrc.yml' : '.yarnrc'))) ?? '';
    const workspaceYaml = (await files.text(joinRel(dir, 'pnpm-workspace.yaml'))) ?? '';
    const plan: PlanDraft = {
      path: dir,
      manager,
      command,
      ...(lock !== undefined && { lockfile: lock.file }),
      writesLockfile: lock === undefined || mismatch,
      reason: mismatch ? 'lockfile_mismatch' : (depsItem.reason ?? 'dependencies_missing'),
      scripts: { project: lifecycleScripts(all), dependencies: 'unknown' },
      dependencyScripts: (version) =>
        dependencyScripts(manager, { npmrc, yarnrc, workspaceYaml, berry, version }),
      credentials: referencedVariables(`${npmrc}\n${yarnrc}`),
      fingerprint: await fingerprintOf(files, [
        ...all.map((manifest) => joinRel(manifest.path, 'package.json')),
        ...(lock ? [joinRel(dir, lock.file)] : []),
      ]),
      needed: depsItem.status !== 'ready' || mismatch,
    };
    result.plans.push(plan);
  }
  return result;
}

function knownManager(name: string | undefined): NodeManager | undefined {
  return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun' ? name : undefined;
}

/** 按锁文件与项目约定的安装命令：有锁文件时不改它。 */
export function installCommand(
  manager: NodeManager,
  options: { lock: boolean; berry: boolean },
): string {
  if (!options.lock) return `${manager} install`;
  switch (manager) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'npm':
      return 'npm ci';
    case 'yarn':
      return options.berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
  }
}

/** 项目自己的安装生命周期脚本（`postinstall: node scripts/setup.js`）。 */
function lifecycleScripts(manifests: readonly Manifest[]): string[] {
  const found: string[] = [];
  for (const manifest of manifests) {
    const scripts = stringRecord(manifest.json.scripts);
    for (const name of LIFECYCLE_SCRIPTS) {
      const body = scripts[name];
      if (body === undefined) continue;
      const prefix = manifest.path === '' ? '' : `${manifest.path}: `;
      found.push(`${prefix}${name}: ${body}`.slice(0, 200));
    }
  }
  return found.slice(0, 20);
}

/** 依赖的安装脚本会不会跑。 */
export function dependencyScripts(
  manager: NodeManager,
  config: {
    npmrc: string;
    yarnrc: string;
    workspaceYaml: string;
    berry: boolean;
    version: string | undefined;
  },
): InstallScripts['dependencies'] {
  if (/^\s*ignore-scripts\s*=\s*true\s*$/m.test(config.npmrc)) return 'disabled';
  switch (manager) {
    case 'pnpm': {
      if (
        /^dangerouslyAllowAllBuilds:\s*true\s*$/m.test(config.workspaceYaml) ||
        /^\s*dangerously-allow-all-builds\s*=\s*true\s*$/m.test(config.npmrc)
      )
        return 'run';
      const major = parseVersion(config.version ?? '')?.[0];
      if (major === undefined) return 'unknown';
      return major >= 10 ? 'restricted' : 'run';
    }
    case 'yarn':
      if (config.berry)
        return /^enableScripts:\s*false\s*$/m.test(config.yarnrc) ? 'disabled' : 'run';
      return /^\s*ignore-scripts\s+true\s*$/m.test(config.yarnrc) ? 'disabled' : 'run';
    case 'bun':
      return 'restricted';
    case 'npm':
      return 'run';
  }
}

/** 配置里引用的环境变量（`${NPM_TOKEN}`、`${NPM_TOKEN:-}`）。 */
export function referencedVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,63})(?::?-[^}]*)?\}/g)) {
    names.add(match[1] as string);
  }
  return [...names].slice(0, 16);
}

export async function fingerprintOf(
  files: ProjectFiles,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update((await files.text(path)) ?? '');
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// ── 锁文件 ──────────────────────────────────────────────────────────

async function lockfileItem(
  files: ProjectFiles,
  dir: string,
  lock: { file: string; manager: NodeManager } | undefined,
  manifests: readonly Manifest[],
): Promise<ReadinessItem> {
  const base = { id: `lockfile::${dir}`, kind: 'lockfile', path: dir };
  if (!lock) {
    return {
      ...base,
      name: 'lockfile',
      status: 'missing',
      reason: 'lockfile_missing',
      blocking: false,
      evidence: [fileEvidence(joinRel(dir, 'package.json'), 'no lockfile')],
    };
  }
  const lockPath = joinRel(dir, lock.file);
  const text = lock.file === 'bun.lockb' ? undefined : await files.text(lockPath);
  const importers = text === undefined ? undefined : parseLock(lock.file, text);
  if (importers === undefined) {
    return {
      ...base,
      name: lock.file,
      status: 'unknown',
      reason: 'lockfile_unreadable',
      blocking: false,
      evidence: [fileEvidence(lockPath)],
    };
  }
  const problems: string[] = [];
  for (const manifest of manifests) {
    const rel = dir === '' ? manifest.path : manifest.path.slice(dir.length + 1);
    const key = rel === '' ? '.' : rel;
    const wanted = manifestDependencies(manifest.json);
    const locked = importers.get(key);
    if (lock.file === 'yarn.lock') {
      for (const [name, spec] of wanted) {
        if (!yarnHas(importers, name, spec))
          problems.push(`${joinRel(manifest.path, 'package.json')}: ${name}@${spec}`);
      }
      continue;
    }
    if (!locked) {
      if (wanted.size > 0) problems.push(`${key}: not in ${lock.file}`);
      continue;
    }
    for (const [name, spec] of wanted) {
      const lockedSpec = locked.get(name);
      if (lockedSpec === undefined) problems.push(`${key}: ${name} not locked`);
      else if (lockedSpec !== spec) problems.push(`${key}: ${name} ${spec} ≠ ${lockedSpec}`);
    }
    // 自动装上的 peer 依赖也记在锁文件里。
    const peers = stringRecord(manifest.json.peerDependencies);
    for (const name of locked.keys()) {
      if (!wanted.has(name) && !(name in peers))
        problems.push(`${key}: ${name} only in ${lock.file}`);
    }
  }
  if (problems.length > 0) {
    return {
      ...base,
      name: lock.file,
      status: 'incompatible',
      reason: 'lockfile_mismatch',
      blocking: true,
      evidence: [
        fileEvidence(lockPath, problems.slice(0, 5).join('; ')),
        ...manifests
          .slice(0, 3)
          .map((manifest) => fileEvidence(joinRel(manifest.path, 'package.json'))),
      ],
    };
  }
  return {
    ...base,
    name: lock.file,
    status: 'ready',
    blocking: false,
    evidence: [fileEvidence(lockPath)],
  };
}

/** 锁文件 → 每个目录的直接依赖（yarn.lock 是描述符的集合，键是 `name@spec`）；读不懂时 undefined。 */
export function parseLock(file: string, text: string): LockImporters | undefined {
  try {
    if (file === 'pnpm-lock.yaml') return parsePnpmLock(text);
    if (file === 'package-lock.json' || file === 'npm-shrinkwrap.json') return parseNpmLock(text);
    if (file === 'yarn.lock') return parseYarnLock(text);
    if (file === 'bun.lock') return parseBunLock(text);
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * pnpm-lock.yaml。pnpm 11 起一个文件里可以有两份 YAML 文档（`---` 分开）：前一份是包管理器自己的（`packageManagerDependencies`），
 * 后一份才是项目的；各份的 importer 合在一起。
 */
export function parsePnpmLock(text: string): LockImporters | undefined {
  const documents = text.split(/^---\s*$/m).filter((part) => part.trim() !== '');
  const merged: LockImporters = new Map();
  for (const document of documents) {
    for (const [key, deps] of parsePnpmDocument(document)) {
      const target = merged.get(key) ?? new Map<string, string>();
      for (const [name, spec] of deps) target.set(name, spec);
      merged.set(key, target);
    }
  }
  return merged;
}

function parsePnpmDocument(text: string): LockImporters {
  const lines = text.split(/\r?\n/);
  const importers: LockImporters = new Map();
  const start = lines.indexOf('importers:');
  if (start < 0) {
    // 单个项目（lockfile v6 之前没有 importers）：顶层的 dependencies 等，或 v5 的 specifiers。
    const deps: DependencyMap = new Map();
    const specifiers = lines.indexOf('specifiers:');
    if (specifiers >= 0) {
      for (const line of lines.slice(specifiers + 1)) {
        if (/^\S/.test(line)) break;
        const match = /^ {2}(\S.*?):\s*(.+)$/.exec(line);
        if (match) deps.set(unquote(match[1] as string), unquote(match[2] as string));
      }
    } else {
      parseImporterBody(lines, 0, 0, deps);
    }
    importers.set('.', deps);
    return importers;
  }
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) break;
    const key = /^ {2}(\S.*?):\s*$/.exec(line);
    if (key) {
      const deps: DependencyMap = new Map();
      i = parseImporterBody(lines, i + 1, 2, deps);
      importers.set(unquote(key[1] as string), deps);
      continue;
    }
    i++;
  }
  return importers;
}

/** `indent` 是 importer 那一行的缩进：下面是 `dependencies:` 等，再下面是名字与 `specifier:`。返回下一个 importer 的行号。 */
function parseImporterBody(
  lines: readonly string[],
  from: number,
  indent: number,
  deps: DependencyMap,
): number {
  const section = ' '.repeat(indent === 0 ? 0 : indent + 2);
  const nameIndent = section.length + 2;
  let inSection = false;
  let name: string | undefined;
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') continue;
    const lead = line.length - line.trimStart().length;
    if (indent > 0 && lead <= indent) break;
    if (indent === 0 && lead === 0) {
      inSection = /^(dependencies|devDependencies|optionalDependencies):\s*$/.test(line);
      name = undefined;
      continue;
    }
    if (lead === section.length && indent > 0) {
      inSection = /^\s*(dependencies|devDependencies|optionalDependencies):\s*$/.test(line);
      name = undefined;
      continue;
    }
    if (!inSection) continue;
    if (lead === nameIndent) {
      const match = /^\s*(\S.*?):\s*(.*)$/.exec(line);
      if (!match) continue;
      name = unquote(match[1] as string);
      // v5 的单个项目：`name: version`（没有 specifier）。
      if (match[2] !== '' && indent === 0) deps.set(name, unquote(match[2] as string));
      continue;
    }
    if (name !== undefined && lead === nameIndent + 2) {
      const spec = /^\s*specifier:\s*(.+)$/.exec(line);
      if (spec) deps.set(name, unquote(spec[1] as string));
    }
  }
  return i;
}

export function parseNpmLock(text: string): LockImporters | undefined {
  const json = JSON.parse(text) as Record<string, unknown>;
  const packages = json.packages as Record<string, Record<string, unknown>> | undefined;
  if (!packages) return undefined;
  const importers: LockImporters = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (path.includes('node_modules/')) continue;
    if (path !== '' && entry.link === true) continue;
    const deps: DependencyMap = new Map();
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(stringRecord(entry[key]))) deps.set(name, spec);
    }
    importers.set(path === '' ? '.' : path, deps);
  }
  return importers;
}

/** yarn.lock：键是描述符（`lodash@^4.17.21`、berry 的 `lodash@npm:^4.17.21`），都放在 `'*'` 下。 */
export function parseYarnLock(text: string): LockImporters {
  const descriptors: DependencyMap = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || /^\s|^#/.test(line) || !line.endsWith(':')) continue;
    for (const part of line.slice(0, -1).split(/,\s*/)) {
      const descriptor = unquote(part);
      descriptors.set(descriptor, '');
    }
  }
  return new Map([['*', descriptors]]);
}

function yarnHas(importers: LockImporters, name: string, spec: string): boolean {
  const descriptors = importers.get('*');
  if (!descriptors) return false;
  if (/^(workspace|link|file|portal|patch):/.test(spec)) return true;
  return descriptors.has(`${name}@${spec}`) || descriptors.has(`${name}@npm:${spec}`);
}

export function parseBunLock(text: string): LockImporters | undefined {
  const json = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
  const workspaces = json.workspaces as Record<string, Record<string, unknown>> | undefined;
  if (!workspaces) return undefined;
  const importers: LockImporters = new Map();
  for (const [path, entry] of Object.entries(workspaces)) {
    const deps: DependencyMap = new Map();
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(stringRecord(entry[key]))) deps.set(name, spec);
    }
    importers.set(path === '' ? '.' : path, deps);
  }
  return importers;
}

// ── 依赖目录 ────────────────────────────────────────────────────────

/** 安装后包管理器写下的标记：比锁文件旧说明锁文件后来变了、还没重装。 */
const INSTALL_MARKERS: Record<NodeManager, readonly string[]> = {
  pnpm: ['node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'],
  npm: ['node_modules/.package-lock.json'],
  yarn: ['node_modules/.yarn-integrity', 'node_modules/.yarn-state.yml'],
  bun: [],
};

async function dependenciesItem(
  files: ProjectFiles,
  dir: string,
  lock: { file: string; manager: NodeManager } | undefined,
  manager: NodeManager,
  manifests: readonly Manifest[],
  deps: readonly DependencyMap[],
): Promise<ReadinessItem> {
  const base = {
    id: `dependencies::${dir}`,
    kind: 'dependencies',
    name: 'node_modules',
    path: dir,
  };
  const modules = joinRel(dir, 'node_modules');
  if (!(await files.isDir(modules))) {
    return {
      ...base,
      status: 'missing',
      reason: 'dependencies_missing',
      blocking: true,
      evidence: [fileEvidence(modules, 'not found')],
    };
  }
  // 清单里的直接依赖逐个看在不在（pnpm 是链接，npm 与 yarn 可能提升到上层的 node_modules）。可选依赖不算。
  const missing: string[] = [];
  let checked = 0;
  for (const [index, manifest] of manifests.entries()) {
    const optional = stringRecord(manifest.json.optionalDependencies);
    for (const name of (deps[index] as DependencyMap).keys()) {
      if (name in optional || checked >= DEPENDENCY_CHECK_MAX) continue;
      checked++;
      if (!(await installed(files, manifest.path, dir, name))) {
        missing.push(manifest.path === dir ? name : `${manifest.path}: ${name}`);
      }
    }
  }
  if (missing.length > 0) {
    return {
      ...base,
      status: 'missing',
      reason: 'dependencies_missing',
      blocking: true,
      evidence: [
        fileEvidence(
          modules,
          `missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8})` : ''}`,
        ),
      ],
    };
  }
  if (lock) {
    const lockPath = joinRel(dir, lock.file);
    const lockTime = await files.mtime(lockPath);
    for (const marker of INSTALL_MARKERS[manager]) {
      const markerPath = joinRel(dir, marker);
      const markerTime = await files.mtime(markerPath);
      if (markerTime === undefined || lockTime === undefined) continue;
      if (lockTime > markerTime + MTIME_SLACK_MS) {
        return {
          ...base,
          status: 'incompatible',
          reason: 'dependencies_outdated',
          blocking: true,
          evidence: [fileEvidence(markerPath, `older than ${lock.file}`), fileEvidence(lockPath)],
        };
      }
      return {
        ...base,
        status: 'ready',
        blocking: true,
        evidence: [fileEvidence(markerPath, `newer than ${lock.file}`)],
      };
    }
  }
  return {
    ...base,
    status: 'ready',
    blocking: true,
    evidence: [fileEvidence(modules, `${checked} direct dependencies present`)],
  };
}

async function installed(
  files: ProjectFiles,
  from: string,
  stop: string,
  name: string,
): Promise<boolean> {
  for (let dir = from; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    if (await files.exists(joinRel(dir, `node_modules/${name}/package.json`))) return true;
    if (dir === stop || dir === '') return false;
  }
}

async function pnpItem(
  files: ProjectFiles,
  dir: string,
  lock: { file: string; manager: NodeManager } | undefined,
): Promise<ReadinessItem> {
  const base = { id: `dependencies::${dir}`, kind: 'dependencies', name: '.pnp.cjs', path: dir };
  const state = joinRel(dir, '.yarn/install-state.gz');
  const stateTime = await files.mtime(state);
  const lockTime = lock ? await files.mtime(joinRel(dir, lock.file)) : undefined;
  if (stateTime !== undefined && lockTime !== undefined && lockTime > stateTime + MTIME_SLACK_MS) {
    return {
      ...base,
      status: 'incompatible',
      reason: 'dependencies_outdated',
      blocking: true,
      evidence: [fileEvidence(state, `older than ${lock?.file}`)],
    };
  }
  return {
    ...base,
    status: 'ready',
    blocking: true,
    evidence: [fileEvidence(joinRel(dir, '.pnp.cjs'))],
  };
}
