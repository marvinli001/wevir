// 回合后验证的检查命令能不能解析（项目环境就绪，0.70.0）：只看命令的第一段，不跑它。`pnpm test` 看 pnpm 在不在、`test` 脚本有没有；
// `npx vitest` 看 `node_modules/.bin/vitest`；`./scripts/test.sh` 看文件在不在、能不能执行；别的看第一个词在不在 PATH 里。

import type { CheckDefinition, ReadinessEvidence, ReadinessItem } from '@wevir/protocol';
import { fileEvidence, joinRel, type ProjectFiles, stringRecord } from './files.js';
import type { ProbeResult } from './probe.js';

/** 一个检查要的东西：工具（探测）、脚本或依赖里的命令（读文件）。 */
export interface CheckNeed {
  check: CheckDefinition;
  /** 命令实际在哪个目录跑（相对根目录）。 */
  cwd: string;
  tool?: string;
  script?: string;
  bin?: string;
  file?: string;
  /** 命令会联网下载东西（`pnpm dlx`、`npx` 找不到本地的）。 */
  downloads?: boolean;
}

const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** `pnpm <x>` / `yarn <x>` 里不是脚本的内置命令。 */
const MANAGER_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'update',
  'up',
  'outdated',
  'list',
  'ls',
  'why',
  'link',
  'unlink',
  'publish',
  'pack',
  'audit',
  'config',
  'store',
  'init',
  'create',
  'help',
  'version',
]);

/** 把命令拆成词（处理单双引号），去掉开头的 `VAR=值`、`cd 目录 &&`、`exec`、`time`。 */
export function parseCheckCommand(command: string): { cd?: string; words: string[] } {
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/);
  let cd: string | undefined;
  let words: string[] = [];
  for (const segment of segments) {
    words = splitWords(segment);
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) words.shift();
    while (words[0] === 'exec' || words[0] === 'time' || words[0] === 'command') words.shift();
    if (words[0] === 'cd' && words.length === 2) {
      cd = cd === undefined ? words[1] : `${cd}/${words[1]}`;
      continue;
    }
    break;
  }
  return { ...(cd !== undefined && { cd }), words };
}

function splitWords(text: string): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

/** 检查 → 要看的东西。 */
export function checkNeed(check: CheckDefinition): CheckNeed {
  const parsed = parseCheckCommand(check.command);
  const cwd = normalize(joinRel(check.cwd, parsed.cd ?? ''));
  const [first, ...rest] = parsed.words;
  const base = { check, cwd };
  if (first === undefined) return base;
  if (first.includes('/') || first.includes('\\')) return { ...base, file: first };
  const args = rest.filter((word) => !word.startsWith('-'));
  const flags = rest.some(
    (word) =>
      /^(-r|--recursive|--filter|-F|-w|--workspace|--workspaces|-C|--dir|--prefix|--if-present)$/.test(
        word,
      ) || word.startsWith('--filter='),
  );
  if (first === 'npx' || first === 'bunx') {
    return args[0] === undefined
      ? { ...base, tool: first }
      : { ...base, tool: first === 'npx' ? 'npm' : 'bun', bin: args[0] };
  }
  if (NODE_MANAGERS.has(first)) {
    const [sub, name] = args;
    if (sub === undefined || flags) return { ...base, tool: first };
    if (sub === 'run' || sub === 'run-script')
      return name === undefined ? { ...base, tool: first } : { ...base, tool: first, script: name };
    if (sub === 'exec')
      return name === undefined ? { ...base, tool: first } : { ...base, tool: first, bin: name };
    if (sub === 'dlx' || sub === 'x') return { ...base, tool: first, downloads: true };
    if (first === 'npm') {
      return ['test', 't', 'start', 'stop', 'restart'].includes(sub)
        ? { ...base, tool: first, script: sub === 't' ? 'test' : sub }
        : { ...base, tool: first };
    }
    if (first === 'bun' && sub === 'test') return { ...base, tool: first };
    if (MANAGER_BUILTINS.has(sub)) return { ...base, tool: first };
    // `pnpm test`、`yarn lint`：先找脚本，没有时找依赖里的命令。
    return { ...base, tool: first, script: sub, bin: sub };
  }
  return { ...base, tool: first };
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** 从 `cwd` 往上找最近的 `package.json`（到根目录为止）。 */
async function nearestManifest(
  files: ProjectFiles,
  cwd: string,
): Promise<{ path: string; json: Record<string, unknown> } | undefined> {
  for (let dir = cwd; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    const json = await files.json(joinRel(dir, 'package.json'));
    if (json) return { path: joinRel(dir, 'package.json'), json };
    if (dir === '') return undefined;
  }
}

async function findBin(
  files: ProjectFiles,
  cwd: string,
  name: string,
): Promise<string | undefined> {
  for (let dir = cwd; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    const path = joinRel(dir, `node_modules/.bin/${name}`);
    if (await files.exists(path)) return path;
    if (dir === '') return undefined;
  }
}

/** 一个检查的项；`probe` 是探测到的工具。 */
export async function checkItem(
  files: ProjectFiles,
  need: CheckNeed,
  probe: ReadonlyMap<string, ProbeResult>,
): Promise<ReadinessItem> {
  const base = {
    id: `check::${need.check.id}`,
    kind: 'check',
    name: need.check.name,
    path: need.cwd,
    checkId: need.check.id,
    blocking: true,
  };
  const command: ReadinessEvidence = { kind: 'command', command: need.check.command.slice(0, 500) };
  const missing = (reason: string, evidence: ReadinessEvidence[]): ReadinessItem => ({
    ...base,
    status: 'missing',
    reason,
    evidence: [command, ...evidence],
  });
  if (!(await files.isDir(need.cwd)))
    return missing('cwd_missing', [fileEvidence(need.cwd || '.', 'not found')]);
  if (need.file !== undefined) {
    const rel = normalize(joinRel(need.cwd, need.file));
    if (need.file.startsWith('/'))
      return { ...base, status: 'unknown', reason: 'outside_project', evidence: [command] };
    if (!(await files.isFile(rel)))
      return missing('command_not_found', [fileEvidence(rel, 'not found')]);
    if (!(await files.isExecutable(rel)) && !/\.(cmd|bat|ps1)$/i.test(rel)) {
      return {
        ...base,
        status: 'permission',
        reason: 'not_executable',
        evidence: [command, fileEvidence(rel, 'not executable')],
      };
    }
    return { ...base, status: 'ready', evidence: [command, fileEvidence(rel)] };
  }
  const evidence: ReadinessEvidence[] = [];
  if (need.tool !== undefined) {
    const found = probe.get(need.tool);
    if (found?.problem === 'not_found' || found?.problem === 'clt_missing') {
      return missing('command_not_found', [
        { kind: 'command', command: `command -v ${need.tool}`, exitCode: 127 },
      ]);
    }
    if (found?.path)
      evidence.push({
        kind: 'command',
        command: `command -v ${need.tool}`,
        exitCode: 0,
        output: found.path,
      });
  }
  if (need.script !== undefined) {
    const manifest = await nearestManifest(files, need.cwd);
    const scripts = stringRecord(manifest?.json.scripts);
    if (manifest && scripts[need.script] !== undefined) {
      return {
        ...base,
        status: 'ready',
        evidence: [command, ...evidence, fileEvidence(manifest.path, `scripts.${need.script}`)],
      };
    }
    if (need.bin === undefined) {
      return missing('script_missing', [
        fileEvidence(manifest?.path ?? 'package.json', `no scripts.${need.script}`),
      ]);
    }
  }
  if (need.bin !== undefined) {
    const bin = await findBin(files, need.cwd, need.bin);
    if (bin === undefined) {
      return missing(need.script !== undefined ? 'script_missing' : 'bin_missing', [
        fileEvidence(joinRel(need.cwd, `node_modules/.bin/${need.bin}`), 'not found'),
      ]);
    }
    return { ...base, status: 'ready', evidence: [command, ...evidence, fileEvidence(bin)] };
  }
  if (need.downloads === true) {
    return {
      ...base,
      status: 'unknown',
      reason: 'downloads_package',
      blocking: false,
      evidence: [command, ...evidence],
    };
  }
  return {
    ...base,
    status: need.tool !== undefined && probe.get(need.tool) === undefined ? 'unknown' : 'ready',
    evidence: [command, ...evidence],
  };
}
