// 跨引擎的规则文件（0.68.0，domain-model §3.27）：各家 coding agent 读不同的说明文件——Codex 读 AGENTS.md，Claude 读 CLAUDE.md，
// Gemini 系读 GEMINI.md，Cursor 读 .cursor/rules。项目里只写了其中一种的用户换引擎或接力之后，那份规则就没人读了。Host 在建立引擎
// 会话时找出用户与项目的这几种文件，按引擎自己读哪些（适配器的 `ruleFiles`）只补它不读的，并把“这个会话加载了哪些、谁读的”
// 记进 `session.rules`。
//
// 找哪些：用户级是各工具家目录里那一份（`$CODEX_HOME` 或 `~/.codex` 的 AGENTS.md、`$CLAUDE_CONFIG_DIR` 或 `~/.claude` 的
// CLAUDE.md、`~/.gemini/GEMINI.md`）；项目里从仓库根（会话目录往上第一个有 `.git` 的目录，不越过家目录；没有时就是会话目录）一路
// 到会话目录，每一层的 AGENTS.md、CLAUDE.md、.claude/CLAUDE.md、CLAUDE.local.md、GEMINI.md、.cursorrules 与 .cursor/rules 里
// `alwaysApply: true` 的规则（按条件或由模型挑选的规则不算会话级规则，不列）。CLAUDE.md 与 GEMINI.md 里的 `@路径` 照两家的写法展开
// （相对文件所在目录或 `~/`，只认存在的普通文件，至多四层），引入的文件跟在引入它的后面。同一个文件（realpath 相同，如 CLAUDE.md
// 是指向 AGENTS.md 的符号链接）只算一次。
//
// 怎么补：引擎自己读的标 `engine`；它展开 `@` 时，它读的文件引入的也算它读的（本仓库的 CLAUDE.md 只有一行 `@AGENTS.md`，Claude
// 因此已经读了 AGENTS.md，不再补）。其余按先后补，内容与已读或已补的一样的跳过（`duplicate`），总量不超过 32 KiB（Codex 的
// `project_doc_max_bytes` 默认值），放不下整份的截一段（`truncated`），剩下的不补（`over_budget`）。补给的正文由适配器放进引擎的
// 系统或开发者说明，适配器做不到时由 Host 放在下一条消息的开头。
//
// 只看文件，不执行任何东西；读不了的文件列为 `unreadable`，不让建会话失败。

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  RuleDeliveryChannel,
  RuleFile,
  RuleFileScope,
  SessionCustomInstructions,
  SessionRules,
} from '@wevir/protocol';
import type { EngineRuleFiles, RuleFileKind } from '@wevir/runtime-adapter';

/** Host 补给的规则正文的预算（UTF-8 字节）。 */
export const RULE_FILES_BUDGET_BYTES = 32 * 1024;
/** 比这大的文件不读（列为 `unreadable`）。 */
const RULE_FILE_MAX_BYTES = 1024 * 1024;
/** 预算剩下不到这么多时不再截一段，整份不补。 */
const RULE_TRUNCATE_MIN_BYTES = 512;
/** `@` 引入至多几层（Claude Code 是五跳，含最初那个文件）。 */
const RULE_IMPORT_DEPTH = 4;
/** 往上找仓库根至多几层。 */
const RULE_PARENT_LEVELS = 32;
/** 一个 `.cursor/rules` 目录里至多看多少个文件。 */
const CURSOR_RULES_MAX = 64;

/** 每一层目录里找的文件，按这个先后。 */
const PROJECT_FILES: ReadonlyArray<{ kind: RuleFileKind; name: string }> = [
  { kind: 'agents', name: 'AGENTS.md' },
  { kind: 'claude', name: 'CLAUDE.md' },
  { kind: 'claude', name: join('.claude', 'CLAUDE.md') },
  { kind: 'claude', name: 'CLAUDE.local.md' },
  { kind: 'gemini', name: 'GEMINI.md' },
  { kind: 'cursor', name: '.cursorrules' },
];

/** 找到的一个规则文件。 */
export interface FoundRuleFile {
  /** 找到它的路径（绝对路径，可能是符号链接）。 */
  path: string;
  /** realpath：判断是不是同一个文件。 */
  real: string;
  scope: RuleFileScope;
  kind: RuleFileKind;
  /** 正文（Cursor 的 .mdc 去掉了 frontmatter）；读不了时是空串。 */
  text: string;
  bytes: number;
  /** 由哪个文件 `@` 引入（那个文件的 `path`）；顶层找到的没有。 */
  importedFrom?: string;
  /** 它 `@` 引入了哪些文件（realpath）。 */
  imports: string[];
  unreadable?: true;
}

export interface RuleDiscoveryOptions {
  /** 会话目录（realpath）。 */
  cwd: string;
  /** 用户的家目录；默认 `os.homedir()`。 */
  home?: string;
  /** 读 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/** 找出这个会话目录的规则文件：用户级在前，项目里的从仓库根到会话目录，引入的跟在引入它的后面。 */
export async function discoverRuleFiles(options: RuleDiscoveryOptions): Promise<FoundRuleFile[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const found: FoundRuleFile[] = [];
  const seen = new Map<string, FoundRuleFile>();

  const add = async (
    path: string,
    scope: RuleFileScope,
    kind: RuleFileKind,
    depth: number,
    importedFrom?: string,
    body?: (text: string) => string | undefined,
  ): Promise<string | undefined> => {
    const file = await readRuleFile(path);
    if (file === undefined) return undefined;
    const existing = seen.get(file.real);
    if (existing !== undefined) return file.real;
    let text = file.text;
    if (body !== undefined && text !== undefined) {
      const kept = body(text);
      if (kept === undefined) return undefined;
      text = kept;
    }
    const entry: FoundRuleFile = {
      path,
      real: file.real,
      scope,
      kind,
      text: text ?? '',
      bytes: text === undefined ? file.size : Buffer.byteLength(text),
      imports: [],
      ...(importedFrom !== undefined && { importedFrom }),
      ...(text === undefined && { unreadable: true as const }),
    };
    seen.set(file.real, entry);
    found.push(entry);
    if (
      (kind === 'claude' || kind === 'gemini') &&
      text !== undefined &&
      depth < RULE_IMPORT_DEPTH
    ) {
      for (const target of importPaths(text, dirname(path), home)) {
        const real = await add(target, scope, kind, depth + 1, path);
        if (real !== undefined && !entry.imports.includes(real)) entry.imports.push(real);
      }
    }
    return file.real;
  };

  const codexHome = env.CODEX_HOME?.trim() ? env.CODEX_HOME : join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  await add(join(codexHome, 'AGENTS.md'), 'user', 'agents', 0);
  await add(join(claudeHome, 'CLAUDE.md'), 'user', 'claude', 0);
  await add(join(home, '.gemini', 'GEMINI.md'), 'user', 'gemini', 0);

  for (const dir of await projectDirs(options.cwd, home)) {
    for (const { kind, name } of PROJECT_FILES) await add(join(dir, name), 'project', kind, 0);
    for (const rule of await cursorRules(join(dir, '.cursor', 'rules'))) {
      await add(rule, 'project', 'cursor', 0, undefined, alwaysAppliedBody);
    }
  }
  return found;
}

/** 规则文件交给这个会话的引擎的计划：列表（谁读的）与要补的正文。 */
export interface RulePlan {
  rules: SessionRules;
  /** 要补的正文；没有要补的时省略。 */
  text?: string;
}

/**
 * 按引擎自己读哪些排出这个会话的规则：`engine` 为 `undefined` 时当作一个都不读、只能随消息补。`enabled` 为 false
 * （Host 设置 `ruleFiles` 关着）时引擎不读的都列为 `disabled`。纯函数：同样的输入给同样的结果。
 */
export function planRules(
  found: readonly FoundRuleFile[],
  options: {
    providerId: string;
    engine: EngineRuleFiles | undefined;
    enabled: boolean;
    budgetBytes?: number;
  },
): RulePlan {
  const engine = options.engine ?? { user: [], project: [], imports: false, instructions: false };
  const budget = options.budgetBytes ?? RULE_FILES_BUDGET_BYTES;
  const byReal = new Map(found.map((file) => [file.real, file]));

  // 引擎自己读的：它认的那几种顶层文件；它展开 `@` 时，再加上这些文件（一层层）引入的。
  const native = new Set<string>();
  const queue: FoundRuleFile[] = [];
  // 后备的种类：项目里一份引擎首选的都没有时，它读这几种。
  const fallback = found.some(
    (file) =>
      file.scope === 'project' &&
      file.importedFrom === undefined &&
      engine.project.includes(file.kind),
  )
    ? []
    : (engine.projectFallback ?? []);
  const reads = (file: FoundRuleFile) =>
    engine[file.scope].includes(file.kind) ||
    (file.scope === 'project' && fallback.includes(file.kind));
  for (const file of found) {
    if (file.importedFrom === undefined && reads(file)) {
      native.add(file.real);
      queue.push(file);
    }
  }
  if (engine.imports) {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (file.unreadable) continue;
      for (const real of file.imports) {
        const target = byReal.get(real);
        if (target === undefined || native.has(real)) continue;
        native.add(real);
        queue.push(target);
      }
    }
  }

  const delivered = new Set<string>();
  for (const file of found) if (native.has(file.real)) delivered.add(normalized(file.text));
  const files: RuleFile[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const file of found) {
    const base: RuleFile = {
      path: file.path,
      scope: file.scope,
      kind: file.kind,
      delivery: 'engine',
      bytes: file.bytes,
      ...(file.importedFrom !== undefined && { importedFrom: file.importedFrom }),
    };
    if (native.has(file.real)) {
      files.push(base);
      continue;
    }
    const skip = (skipReason: string) => files.push({ ...base, delivery: 'skipped', skipReason });
    if (file.unreadable) {
      skip('unreadable');
      continue;
    }
    const key = normalized(file.text);
    if (key === '') {
      skip('empty');
      continue;
    }
    if (!options.enabled) {
      skip('disabled');
      continue;
    }
    if (delivered.has(key)) {
      skip('duplicate');
      continue;
    }
    const whole = ruleBlock(file, file.text.trim());
    const room = budget - used;
    if (Buffer.byteLength(whole) <= room) {
      blocks.push(whole);
      used += Buffer.byteLength(whole);
      delivered.add(key);
      files.push({ ...base, delivery: 'wevir' });
      continue;
    }
    const cut = truncatedBlock(file, room);
    if (cut === undefined) {
      skip('over_budget');
      continue;
    }
    blocks.push(cut);
    used += Buffer.byteLength(cut);
    delivered.add(key);
    files.push({ ...base, delivery: 'wevir', truncated: true });
  }

  const channel: RuleDeliveryChannel = engine.instructions ? 'instructions' : 'message';
  if (blocks.length === 0) return { rules: { providerId: options.providerId, files } };
  const text = `${RULES_HEADER}\n\n${blocks.join('\n\n')}`;
  return {
    rules: {
      providerId: options.providerId,
      files,
      channel,
      bytes: Buffer.byteLength(text),
      budgetBytes: budget,
    },
    text,
  };
}

/**
 * 把用户的说明（0.78.0，custom-instructions.ts）接在补给的规则文件后面：走同一个通道（引擎有说明可放时进说明，否则随下一条消息），
 * `bytes` 是整段的字节数，`custom` 记下交了哪些。没有用户的说明时原样返回。
 */
export function withCustomInstructions(
  plan: RulePlan,
  custom: { custom: SessionCustomInstructions; text: string } | undefined,
  engine: EngineRuleFiles,
): RulePlan {
  if (custom === undefined) return plan;
  const text = plan.text === undefined ? custom.text : `${plan.text}\n\n${custom.text}`;
  return {
    rules: {
      ...plan.rules,
      channel: engine.instructions ? 'instructions' : 'message',
      bytes: Buffer.byteLength(text),
      custom: custom.custom,
    },
    text,
  };
}

/** 两份规则列表是不是一样（决定恢复引擎会话时要不要再写 `session.rules`）。 */
export function sameRules(a: SessionRules | undefined, b: SessionRules): boolean {
  if (a === undefined) return false;
  const key = (rules: SessionRules) =>
    JSON.stringify([
      rules.providerId,
      rules.channel ?? null,
      rules.bytes ?? null,
      rules.custom ?? null,
      rules.files.map((file) => [
        file.path,
        file.delivery,
        file.bytes,
        file.truncated ?? false,
        file.skipReason ?? null,
      ]),
    ]);
  return key(a) === key(b);
}

const RULES_HEADER = [
  '# Rule files from other coding agents',
  '',
  'The user or this project keeps the instruction files below for other coding agents. Your engine does not load them by itself, so Wevir included them here; they apply to this session.',
  'Follow them like your own project instructions (AGENTS.md): a file in a deeper directory takes precedence over a shallower one, project files over user files, and the user’s direct requests over all of them. Parts that only make sense for another agent’s tools or commands may not apply to you.',
].join('\n');

function ruleBlock(file: FoundRuleFile, text: string, note?: string): string {
  const from = file.importedFrom === undefined ? '' : ` imported_from="${attr(file.importedFrom)}"`;
  const tail = note === undefined ? '' : `\n${note}`;
  return `<rule_file path="${attr(file.path)}" scope="${file.scope}"${from}>\n${text}${tail}\n</rule_file>`;
}

/** 截到放得下的一段；剩的预算太少时 `undefined`。 */
function truncatedBlock(file: FoundRuleFile, room: number): string | undefined {
  if (room < RULE_TRUNCATE_MIN_BYTES) return undefined;
  const note = `[Truncated: the rest of this file (${file.bytes} bytes in all) did not fit; read the file if you need it.]`;
  const overhead = Buffer.byteLength(ruleBlock(file, '', note));
  const keep = room - overhead;
  if (keep < RULE_TRUNCATE_MIN_BYTES / 2) return undefined;
  return ruleBlock(file, utf8Prefix(file.text.trim(), keep), note);
}

/** 不超过 `bytes` 字节的开头，不切开多字节字符。 */
function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  // 退到一个字符的开头（UTF-8 的续字节是 10xxxxxx）。
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function attr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** 比较内容是否相同：去掉首尾空白，换行统一成 \n。 */
function normalized(text: string): string {
  return text.replaceAll('\r\n', '\n').trim();
}

async function readRuleFile(
  path: string,
): Promise<{ real: string; size: number; text?: string } | undefined> {
  let real: string;
  let size: number;
  try {
    real = await realpath(path);
    const info = await stat(real);
    if (!info.isFile()) return undefined;
    size = info.size;
  } catch {
    return undefined;
  }
  if (size > RULE_FILE_MAX_BYTES) return { real, size };
  try {
    return { real, size, text: await readFile(real, 'utf8') };
  } catch {
    return { real, size };
  }
}

/** 从仓库根（往上第一个有 `.git` 的目录，不越过家目录）到 `cwd` 的每一层；找不到仓库时只有 `cwd`。 */
async function projectDirs(cwd: string, home: string): Promise<string[]> {
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (let level = 0; level < RULE_PARENT_LEVELS; level++) {
    chain.push(dir);
    if (await exists(join(dir, '.git'))) return chain.reverse();
    const parent = dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return [resolve(cwd)];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `.cursor/rules` 里的规则文件（.mdc 与 .md，含子目录），按路径排序。 */
async function cursorRules(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /\.mdc?$/i.test(entry))
    .sort()
    .slice(0, CURSOR_RULES_MAX)
    .map((entry) => join(dir, entry));
}

/**
 * Cursor 规则的正文：frontmatter 写了 `alwaysApply: true` 才是会话级规则，返回去掉 frontmatter 的正文；按文件匹配、由模型挑选或
 * 手动引用的规则返回 `undefined`（不列）。
 */
function alwaysAppliedBody(text: string): string | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === undefined || match === null) return undefined;
  const always = /^alwaysApply:\s*(true|"true"|'true')\s*$/im.test(match[1] ?? '');
  return always ? text.slice(match[0].length) : undefined;
}

/**
 * CLAUDE.md / GEMINI.md 里的 `@路径`：行首或空白之后的 `@`，路径只取 ASCII 的文件名字符（`@AGENTS.md（说明）` 取 `AGENTS.md`），
 * 去掉结尾的句点；代码块与行内代码里的不算。相对路径相对文件所在目录，`~/` 相对家目录。
 */
export function importPaths(text: string, dir: string, home: string): string[] {
  const paths: string[] = [];
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '');
  for (const match of prose.matchAll(/(?:^|\s)@([A-Za-z0-9._~/\\-]+)/g)) {
    let raw = (match[1] ?? '').replace(/\.+$/, '');
    if (raw === '' || raw === '~' || raw.includes('@')) continue;
    if (!/[./\\]/.test(raw)) continue;
    if (raw.startsWith('~/')) raw = join(home, raw.slice(2));
    const path = isAbsolute(raw) ? raw : join(dir, raw);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** 给日志看的：一份规则列表的摘要。 */
export function describeRules(rules: SessionRules): Record<string, unknown> {
  const count = (delivery: string) => rules.files.filter((f) => f.delivery === delivery).length;
  return {
    providerId: rules.providerId,
    engine: count('engine'),
    wevir: count('wevir'),
    skipped: count('skipped'),
    ...(rules.channel !== undefined && { channel: rules.channel }),
    ...(rules.bytes !== undefined && { bytes: rules.bytes }),
    files: rules.files.map((file) => basename(file.path)),
  };
}
