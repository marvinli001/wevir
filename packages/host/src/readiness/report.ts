// 拼预检报告（项目环境就绪，0.70.0）：各语言生态读文件 → 探测要用的工具 → 工具与检查命令的项 → 安装方案（ID、凭据、脚本）→ 网络诊断
// → 总状态。只要有一项阻塞而不就绪，报告就是 `not_ready`。

import { createHash } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  AgentNetwork,
  CheckDefinition,
  InstallPlan,
  InstallRun,
  ReadinessItem,
  ReadinessReport,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { READINESS_EVIDENCE_OUTPUT_MAX_LENGTH, READINESS_ITEMS_MAX } from '@wevir/protocol';
import { type Analysis, emptyAnalysis, mergeAnalysis, type ToolNeed } from './analysis.js';
import { checkItem, checkNeed } from './checks.js';
import { ProjectFiles } from './files.js';
import { diagnoseNetwork } from './network.js';
import { analyzeNode, referencedVariables } from './node.js';
import { analyzeGo, analyzeNative, analyzePython, analyzeRust } from './others.js';
import type { ProbeResult } from './probe.js';
import {
  atLeast,
  parseVersion,
  parseVersionOutput,
  satisfiesNpmRange,
  satisfiesPep440,
} from './versions.js';

/** 扫描根目录下几层、最多多少个目录。 */
export const SCAN_DEPTH = 2;
export const SCAN_MAX_DIRS = 300;

export interface ReportInput {
  workspaceId: WorkspaceId;
  sessionId?: SessionId;
  root: string;
  checks: readonly CheckDefinition[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home?: string;
  probe: (names: readonly string[]) => Promise<ReadonlyMap<string, ProbeResult>>;
  /** 存在 Wevir 里的凭据名。 */
  credentials: ReadonlySet<string>;
  /** `~/.npmrc` 的内容（里面引用的变量也是安装要的凭据）。 */
  userNpmrc?: string;
  agent?: AgentNetwork;
  /** 这个根目录最近的一次安装。 */
  install?: InstallRun;
}

const KIND_ORDER = [
  'runtime',
  'package_manager',
  'compiler',
  'build_tool',
  'lockfile',
  'dependencies',
  'check',
];

export async function buildReport(input: ReportInput): Promise<ReadinessReport> {
  const started = Date.now();
  const files = new ProjectFiles(input.root);
  const base = {
    workspaceId: input.workspaceId,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    root: input.root,
    checkedAt: new Date(started).toISOString(),
  };
  if (!(await stat(input.root).catch(() => undefined))?.isDirectory()) {
    return {
      ...base,
      status: 'unknown',
      durationMs: Date.now() - started,
      projects: [],
      items: [],
      plans: [],
      network: { registries: [], proxy: [], advice: [] },
      ...(input.install !== undefined && { install: input.install }),
    };
  }
  const dirs = await files.directories(SCAN_DEPTH, SCAN_MAX_DIRS);
  const options = {
    env: input.env,
    platform: input.platform,
    ...(input.home !== undefined && { home: input.home }),
  };
  const analysis: Analysis = emptyAnalysis();
  const node = await analyzeNode(files, dirs);
  const python = await analyzePython(files, dirs, options);
  mergeAnalysis(analysis, node);
  mergeAnalysis(analysis, python);
  mergeAnalysis(analysis, await analyzeGo(files, dirs, options));
  mergeAnalysis(analysis, await analyzeRust(files, dirs, options));
  mergeAnalysis(analysis, await analyzeNative(files, dirs));

  const needs = input.checks.map(checkNeed);
  const names = new Set<string>();
  for (const tool of analysis.tools) {
    names.add(tool.tool);
    if (tool.fallback) names.add(tool.fallback);
  }
  for (const need of needs) if (need.tool) names.add(need.tool);
  const probe = names.size === 0 ? new Map<string, ProbeResult>() : await input.probe([...names]);

  const items: ReadinessItem[] = [];
  const seen = new Set<string>();
  for (const need of analysis.tools) {
    const item = toolItem(need, probe);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // 嵌套的项目（`file:` 依赖、子目录里的另一个包）用同一个工具、要求相同且都就绪：只列上层那一项。
    if (
      item.status === 'ready' &&
      items.some(
        (other) =>
          other.status === 'ready' &&
          other.kind === item.kind &&
          other.name === item.name &&
          other.found === item.found &&
          other.required === item.required &&
          (other.path === '' || item.path.startsWith(`${other.path}/`)),
      )
    )
      continue;
    items.push(item);
  }
  items.push(...analysis.items);
  for (const need of needs) items.push(await checkItem(files, need, probe));

  // ── 安装方案 ──
  const plans: InstallPlan[] = [];
  const userVariables = referencedVariables(input.userNpmrc ?? '');
  const last = input.install;
  const interrupted =
    last !== undefined && last.status !== 'running' && last.status !== 'succeeded'
      ? last
      : undefined;
  for (const draft of analysis.plans) {
    const deps = items.find((item) => item.id === `dependencies::${draft.path}`);
    if (!draft.needed) {
      // 看着就绪，但上次在这个目录的安装没跑完：依赖目录可能只写了一半。之后在别处装过（依赖目录比那次新）就不算。
      if (interrupted?.path !== draft.path || !deps) continue;
      const marker = deps.evidence.find((evidence) => evidence.kind === 'file')?.path;
      const markerPath =
        marker === undefined
          ? undefined
          : marker.startsWith('~/') && input.home !== undefined
            ? join(input.home, marker.slice(2))
            : isAbsolute(marker)
              ? marker
              : files.abs(marker);
      const markerTime =
        markerPath === undefined
          ? undefined
          : (await stat(markerPath).catch(() => undefined))?.mtimeMs;
      const finished = Date.parse(interrupted.finishedAt ?? interrupted.startedAt);
      if (markerTime !== undefined && markerTime > finished) continue;
      deps.status = 'missing';
      deps.reason = 'install_incomplete';
      deps.blocking = true;
      deps.evidence = [
        ...deps.evidence,
        {
          kind: 'command' as const,
          command: interrupted.command,
          ...(interrupted.exitCode !== undefined && { exitCode: interrupted.exitCode }),
          detail: interrupted.status,
        },
      ].slice(0, 8);
    }
    const manager = items.find(
      (item) =>
        item.kind === 'package_manager' && item.path === draft.path && item.name === draft.manager,
    );
    const names = [
      ...new Set([
        ...draft.credentials,
        ...(draft.manager.match(/^(pnpm|npm|yarn|bun)$/) ? userVariables : []),
      ]),
    ];
    const command = draft.command;
    plans.push({
      id: `pln_${createHash('sha256').update(`${input.root}\0${draft.path}\0${command}\0${draft.fingerprint}`).digest('hex').slice(0, 12)}`,
      path: draft.path,
      manager: draft.manager,
      command,
      ...(draft.lockfile !== undefined && { lockfile: draft.lockfile }),
      writesLockfile: draft.writesLockfile,
      reason: draft.needed ? draft.reason : 'install_incomplete',
      scripts: {
        project: draft.scripts.project,
        dependencies: draft.dependencyScripts?.(manager?.found) ?? draft.scripts.dependencies,
      },
      credentials: names.slice(0, 16).map((name) => ({
        name,
        source: input.credentials.has(name)
          ? 'wevir'
          : input.env[name] !== undefined
            ? 'env'
            : 'missing',
      })),
    });
    // 目录写不进去：依赖那一项记成被权限拦截。上次安装的失败归类也落到依赖那一项上。
    if (!deps || deps.status === 'ready') continue;
    if (!(await writable(files.abs(draft.path)))) {
      deps.status = 'permission';
      deps.reason = 'not_writable';
      deps.evidence = [
        ...deps.evidence,
        { kind: 'file' as const, path: draft.path || '.', detail: 'not writable' },
      ].slice(0, 8);
    } else if (input.install?.status === 'failed' && input.install.path === draft.path) {
      const reason = input.install.reason;
      if (reason === 'network') deps.status = 'network';
      else if (reason === 'registry_auth' || reason === 'permission') deps.status = 'permission';
      if (reason === 'network' || reason === 'registry_auth' || reason === 'permission') {
        deps.reason = reason === 'network' ? 'last_install_network' : reason;
        deps.evidence = [
          ...deps.evidence,
          {
            kind: 'command' as const,
            command: input.install.command,
            exitCode: input.install.exitCode ?? null,
            ...(input.install.summary !== undefined && { output: tail(input.install.summary) }),
          },
        ].slice(0, 8);
      }
    }
  }

  const ecosystems = new Set(analysis.projects.flatMap((project) => project.ecosystems));
  const network = await diagnoseNetwork(
    files,
    ecosystems,
    node.projects.map((project) => project.path),
    python.projects.map((project) => project.path),
    {
      ...options,
      credentials: input.credentials,
      ...(input.agent !== undefined && { agent: input.agent }),
      hasPlans: plans.length > 0,
      ...(input.install?.status === 'failed' &&
        input.install.reason !== undefined && { lastInstallReason: input.install.reason }),
    },
  );

  plans.sort((a, b) => a.path.localeCompare(b.path));
  items.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  const blocked = items.some((item) => item.blocking && item.status !== 'ready');
  return {
    ...base,
    status: blocked
      ? 'not_ready'
      : analysis.projects.length === 0 && needs.length === 0
        ? 'unknown'
        : 'ready',
    durationMs: Date.now() - started,
    projects: mergeProjects(analysis.projects).slice(0, 50),
    items: items.slice(0, READINESS_ITEMS_MAX),
    plans: plans.slice(0, 20),
    network,
    ...(input.install !== undefined && { install: input.install }),
  };
}

function mergeProjects(projects: Analysis['projects']): ReadinessReport['projects'] {
  const map = new Map<string, Set<string>>();
  for (const project of projects) {
    const set = map.get(project.path) ?? new Set<string>();
    for (const ecosystem of project.ecosystems) set.add(ecosystem);
    map.set(project.path, set);
  }
  return [...map]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, set]) => ({ path, ecosystems: [...set] }));
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function tail(text: string): string {
  return text.length <= READINESS_EVIDENCE_OUTPUT_MAX_LENGTH
    ? text
    : text.slice(-READINESS_EVIDENCE_OUTPUT_MAX_LENGTH);
}

/** 工具的项：找不到、空壳、探测失败、版本不满足要求，或就绪。 */
export function toolItem(need: ToolNeed, probe: ReadonlyMap<string, ProbeResult>): ReadinessItem {
  const name = need.name ?? need.tool;
  let result = probe.get(need.tool);
  if ((result === undefined || result.problem === 'not_found') && need.fallback !== undefined) {
    const fallback = probe.get(need.fallback);
    if (fallback !== undefined && fallback.problem === undefined) result = fallback;
  }
  const base = {
    id: `${need.kind}:${need.path}:${name}`,
    kind: need.kind,
    name,
    path: need.path,
    ...(need.required !== undefined && { required: need.required }),
  };
  const evidence = [...need.evidence];
  if (result !== undefined) {
    evidence.push({
      kind: 'command',
      command: result.command,
      exitCode: result.exitCode,
      ...(result.output !== '' && {
        output: result.output.slice(0, READINESS_EVIDENCE_OUTPUT_MAX_LENGTH),
      }),
      ...(result.path !== undefined && result.path !== '' && { detail: result.path }),
    });
  }
  const done = (
    patch: Omit<ReadinessItem, keyof typeof base | 'evidence' | 'blocking'> & {
      blocking?: boolean;
    },
  ): ReadinessItem => ({
    ...base,
    blocking: need.blocking,
    ...patch,
    evidence: evidence.slice(-8),
  });
  if (result === undefined || result.problem === 'timeout' || result.problem === 'failed') {
    return done({ status: 'unknown', reason: 'probe_failed', blocking: false });
  }
  if (result.problem === 'not_found') return done({ status: 'missing', reason: 'not_found' });
  if (result.problem === 'clt_missing') return done({ status: 'missing', reason: 'clt_missing' });
  if (result.exitCode !== 0) {
    // corepack 的空壳：要的版本还没下载（探测时不许它联网）。
    if (/corepack|network access disabled/i.test(result.output)) {
      return done({ status: 'missing', reason: 'not_cached', blocking: false });
    }
    return done({ status: 'unknown', reason: 'probe_failed', blocking: false });
  }
  const found = parseVersionOutput(result.output);
  const withFound = found !== undefined ? { found } : {};
  if (need.required === undefined || found === undefined)
    return done({ status: 'ready', ...withFound });
  const ok =
    need.rangeKind === 'pep440'
      ? satisfiesPep440(found, need.required)
      : need.rangeKind === 'min'
        ? atLeast(found, need.required)
        : need.rangeKind === 'exact'
          ? sameVersion(found, need.required)
          : satisfiesNpmRange(found, need.required);
  if (ok === false) {
    return done({
      status: 'incompatible',
      reason: 'version_mismatch',
      blocking: need.blocking && need.versionBlocking,
      ...withFound,
    });
  }
  return done({ status: 'ready', ...withFound });
}

function sameVersion(found: string, required: string): boolean | undefined {
  const a = parseVersion(found);
  const b = parseVersion(required);
  if (!a || !b) return undefined;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
