// 运行配置的候选（0.84.0，`preview.list`，ADR-0013 决策 2）：只读 `package.json` 里像开发服务器的脚本与 `.claude/launch.json`
// （Claude Code 的格式），什么都不执行。端口只认写明的（脚本里的 `--port 3000`、`-p 3000`、`PORT=3000`，launch.json 的 `port`），
// 不按框架猜默认端口：猜错了就永远等不到就绪；没有端口时 Host 从输出里认地址。

import { join } from 'node:path';
import type { PreviewCandidate } from '@wevir/protocol';
import {
  PREVIEW_ENV_MAX,
  PREVIEW_NAME_MAX_LENGTH,
  PREVIEW_URL_MAX_LENGTH,
  PROCESS_COMMAND_MAX_LENGTH,
} from '@wevir/protocol';
import { packageFiles, packageManager, readSmall } from '../verification/candidates.js';
import { normalizeRelative } from '../verification/checks-store.js';

/** 最多列这么多个候选。 */
export const PREVIEW_CANDIDATES_MAX = 20;

/** 看起来像开发服务器的脚本名。 */
const SCRIPT_NAME = /^(dev|develop|start|serve|server|preview|storybook)([:-].*)?$/i;
/** 脚本名像，但其实是构建或测试的（`dev:build`、`start:test`）。 */
const NOT_SERVER = /(^|[:-])(build|test|tests|lint|typecheck|clean|e2e)([:-]|$)/i;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 脚本正文里写明的端口：`--port 3000`、`--port=3000`、`-p 3000`、`PORT=3000`。 */
export function explicitPort(body: string): number | undefined {
  const match =
    /(?:^|\s)--port[=\s]+(\d{2,5})\b/.exec(body) ??
    /(?:^|\s)-p\s+(\d{2,5})\b/.exec(body) ??
    /(?:^|\s)PORT=(\d{2,5})\b/.exec(body);
  const port = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** 一个参数在 POSIX shell 里的写法：只含安全字符的原样写，其余用单引号括起来。 */
export function shellQuote(word: string): string {
  if (/^[\w@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function launchCandidates(text: string, file: string): PreviewCandidate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const configurations = (raw as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(configurations)) return [];
  const found: PreviewCandidate[] = [];
  for (const item of configurations as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const executable =
      typeof entry.runtimeExecutable === 'string' ? entry.runtimeExecutable.trim() : '';
    if (name === '' || executable === '') continue;
    const args = Array.isArray(entry.runtimeArgs)
      ? entry.runtimeArgs.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const command = [executable, ...args].map(shellQuote).join(' ');
    if (command.length > PROCESS_COMMAND_MAX_LENGTH) continue;
    const cwd = typeof entry.cwd === 'string' ? normalizeRelative(entry.cwd) : '';
    if (cwd === undefined) continue;
    const port =
      typeof entry.port === 'number' &&
      Number.isInteger(entry.port) &&
      entry.port >= 1 &&
      entry.port <= 65535
        ? entry.port
        : undefined;
    const url =
      typeof entry.url === 'string' &&
      /^https?:\/\/\S+$/i.test(entry.url) &&
      entry.url.length <= PREVIEW_URL_MAX_LENGTH
        ? entry.url
        : undefined;
    const env =
      entry.env !== null && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>)
              .filter(
                (pair): pair is [string, string] =>
                  /^[A-Za-z_][A-Za-z0-9_]*$/.test(pair[0]) && typeof pair[1] === 'string',
              )
              .slice(0, PREVIEW_ENV_MAX),
          )
        : {};
    found.push({
      name: clip(name, PREVIEW_NAME_MAX_LENGTH),
      command,
      cwd,
      ...(port !== undefined && { port }),
      ...(url !== undefined && { url }),
      ...(Object.keys(env).length > 0 && { env }),
      origin: 'claude_launch',
      file,
    });
  }
  return found;
}

/** 会话目录里的候选。`root` 是会话目录。读文件出错的跳过；什么都没有时是空数组。 */
export async function findPreviewCandidates(root: string): Promise<PreviewCandidate[]> {
  const candidates: PreviewCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: PreviewCandidate) => {
    const key = `${candidate.cwd}\0${candidate.command}`;
    if (seen.has(key) || candidates.length >= PREVIEW_CANDIDATES_MAX) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const launch = '.claude/launch.json';
  const launchText = await readSmall(join(root, launch));
  if (launchText !== undefined)
    for (const found of launchCandidates(launchText, launch)) push(found);

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
    if (scripts === undefined || scripts === null || typeof scripts !== 'object') continue;
    const cwd = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    for (const [script, body] of Object.entries(scripts)) {
      if (typeof body !== 'string' || !SCRIPT_NAME.test(script) || NOT_SERVER.test(script)) {
        continue;
      }
      const port = explicitPort(body);
      push({
        name: clip(cwd === '' ? script : `${script} · ${cwd}`, PREVIEW_NAME_MAX_LENGTH),
        command: `${runner} run ${script}`,
        cwd,
        ...(port !== undefined && { port }),
        origin: 'package_script',
        file,
      });
    }
  }
  return candidates;
}
