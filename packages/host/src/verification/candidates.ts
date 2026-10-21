// 仓库里声明的检查命令（0.65.0，`checks.candidates`，ADR-0008 决策 3）：只读 `package.json` 的 scripts 与 AGENTS.md / CLAUDE.md
// 里的命令，什么都不执行。它们只是候选：用户在设置里保存了才是检查，脚本还要记下正文的散列，正文变了要重新认可。

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { CheckCandidate, CheckKind } from '@wevir/protocol';
import { CHECK_COMMAND_MAX_LENGTH, CHECK_NAME_MAX_LENGTH } from '@wevir/protocol';

/** 最多列这么多个候选。 */
export const CANDIDATES_MAX = 40;
/** 读的 `package.json`：根目录，再加 `packages/*`、`apps/*` 这类一层子目录里的，最多这么多个。 */
const PACKAGE_FILES_MAX = 24;
const FILE_MAX_BYTES = 512 * 1024;
const PACKAGE_DIRS = ['packages', 'apps', 'services', 'libs', 'crates'];
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** 看起来像检查的脚本名。 */
const SCRIPT_NAME =
  /^(test|tests|check|checks|verify|lint|typecheck|type-check|types|tsc|build)([:-].*)?$/i;
/** 看起来像检查的命令。 */
const CHECK_COMMAND =
  /\b(test|vitest|jest|mocha|pytest|lint|eslint|biome|typecheck|type-check|tsc|build|cargo (test|check|clippy|build)|go (test|vet|build)|ruff|mypy|make (test|check|lint))\b/i;
const RUNNERS =
  /^(pnpm|npm|yarn|bun|npx|make|cargo|go|pytest|python3? -m|uv run|tsc|vitest|jest|node --test|deno|ruff|mypy|gradle|\.\/gradlew|mvn)\b/;

export function kindOf(text: string): CheckKind {
  const lower = text.toLowerCase();
  if (/typecheck|type-check|\btsc\b|\bmypy\b|\btypes\b/.test(lower)) return 'typecheck';
  if (/\blint\b|eslint|biome|clippy|ruff|\bvet\b/.test(lower)) return 'lint';
  if (/\btests?\b|vitest|jest|mocha|pytest|node --test/.test(lower)) return 'test';
  if (/\bbuild\b/.test(lower)) return 'build';
  return 'other';
}

/** 脚本正文的散列：保存时记下，运行前对一次。 */
export function scriptHash(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex').slice(0, 32)}`;
}

export async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > FILE_MAX_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `package.json` 里一个脚本的正文；文件没有、读不出、没有这个脚本时 undefined。 */
export async function readScript(
  root: string,
  file: string,
  script: string,
): Promise<string | undefined> {
  const text = await readSmall(join(root, file));
  if (text === undefined) return undefined;
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
    const body = scripts?.[script];
    return typeof body === 'string' ? body : undefined;
  } catch {
    return undefined;
  }
}

export async function packageManager(root: string): Promise<string> {
  const exists = (name: string) =>
    stat(join(root, name)).then(
      () => true,
      () => false,
    );
  if (await exists('pnpm-lock.yaml')) return 'pnpm';
  if (await exists('yarn.lock')) return 'yarn';
  if ((await exists('bun.lockb')) || (await exists('bun.lock'))) return 'bun';
  return 'npm';
}

export async function packageFiles(root: string): Promise<string[]> {
  const files = ['package.json'];
  for (const dir of PACKAGE_DIRS) {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= PACKAGE_FILES_MAX) return files;
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push(`${dir}/${entry.name}/package.json`);
      }
    }
  }
  return files;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 从 Markdown 里取命令：bash / sh 一类或没标语言的代码块里的行，以及行内代码里以常见工具开头的。 */
export function instructionCommands(text: string): Array<{ command: string; line: number }> {
  const found: Array<{ command: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  let fence: { shell: boolean } | undefined;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const open = /^(```|~~~)\s*([\w-]*)/.exec(line);
    if (open) {
      fence = fence
        ? undefined
        : { shell: /^(|bash|sh|shell|zsh|console|sh-session)$/i.test(open[2] ?? '') };
      return;
    }
    if (fence) {
      if (!fence.shell) return;
      const command = line.replace(/^\$\s+/, '');
      if (command === '' || command.startsWith('#')) return;
      found.push({ command, line: index + 1 });
      return;
    }
    for (const match of raw.matchAll(/`([^`\n]{3,200})`/g)) {
      const command = (match[1] ?? '').trim();
      if (RUNNERS.test(command)) found.push({ command, line: index + 1 });
    }
  });
  return found;
}

/**
 * 工作区里声明的候选。`root` 是工作区目录。读文件出错的跳过；什么都没有时是空数组。
 */
export async function findCandidates(root: string): Promise<CheckCandidate[]> {
  const candidates: CheckCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: CheckCandidate) => {
    const key = `${candidate.cwd}\0${candidate.command}`;
    if (seen.has(key) || candidates.length >= CANDIDATES_MAX) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const runner = await packageManager(root);
  for (const file of await packageFiles(root)) {
    const text = await readSmall(join(root, file));
    if (text === undefined) continue;
    let scripts: Record<string, unknown> | undefined;
    try {
      scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
    } catch {
      continue;
    }
    if (scripts === undefined || typeof scripts !== 'object') continue;
    const cwd = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    for (const [script, body] of Object.entries(scripts)) {
      if (typeof body !== 'string' || !SCRIPT_NAME.test(script)) continue;
      push({
        name: clip(cwd === '' ? script : `${script} · ${cwd}`, CHECK_NAME_MAX_LENGTH),
        command: `${runner} run ${script}`,
        cwd,
        // 脚本名比正文可靠（`build` 的正文常常是 `tsc`）。
        kind: kindOf(script) !== 'other' ? kindOf(script) : kindOf(body),
        source: {
          kind: 'package_script',
          file,
          script,
          body: clip(body, CHECK_COMMAND_MAX_LENGTH),
        },
      });
    }
  }
  for (const file of INSTRUCTION_FILES) {
    const text = await readSmall(join(root, file));
    if (text === undefined) continue;
    for (const { command, line } of instructionCommands(text)) {
      if (!CHECK_COMMAND.test(command) || command.length > CHECK_COMMAND_MAX_LENGTH) continue;
      push({
        name: clip(command, CHECK_NAME_MAX_LENGTH),
        command,
        cwd: '',
        kind: kindOf(command),
        source: { kind: 'instructions', file, line },
      });
    }
  }
  return candidates;
}

/** `file` 是否在 `root` 里（给 package_script 的来源校验）。 */
export function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}
