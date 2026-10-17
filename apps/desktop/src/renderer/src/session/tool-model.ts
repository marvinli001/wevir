// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/lib/tool-aggregate.ts、apps/app/src/lib/current-tool-lifecycle.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #6；U2 再改）。工具分类从 OpenCode 的工具名换成 Wevir 的展示类型（ToolDisplay.kind，
// domain-model §7）。U2 起照 Claude Code 桌面端与 Codex（design-refs/09–12）把一串连续的思考与工具调用（全部种类，
// 同 OpenWork 的聚合）合成一个“工作组”：摘要是中文计数（“思考了 17 秒，读取了 6 个文件，运行了 2 条命令”）加改动行数，
// 进行中显示当前动作（同 OpenWork 的当前动作行）；失败、被拒绝、状态未知单独计数，不被折叠吞掉。“状态未知”规则照搬
// current-tool-lifecycle：只有回合仍在进行时未收尾的工具才算运行中，否则显示状态未知；另加“被拒绝”（同一 toolCallId
// 的审批被拒）。

import type { ChatPart, ChatPartOf } from '@wevir/client-sdk';
import type { ToolDisplayKind } from '@wevir/protocol';
import { t } from '@/i18n';
import { between, formatDuration } from './format';

export type ToolPart = ChatPartOf<'tool'>;
export type ReasoningPart = ChatPartOf<'reasoning'>;
export type RawPart = ChatPartOf<'raw'>;

/** 工具调用显示的状态。 */
export type ToolLifecycle =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'unknown';

/**
 * 工具调用的状态。未收尾的工具只在所属回合仍在进行时算运行中 / 等待审批，否则是“状态未知”——不让一个
 * 停掉的回合留下一直转圈的一行。审批被拒的工具显示“被拒绝”。
 */
export function toolLifecycle(part: ToolPart, turnActive: boolean): ToolLifecycle {
  if (part.status === 'running' || part.status === 'awaiting_approval') {
    return turnActive ? part.status : 'unknown';
  }
  if (part.approval?.status === 'denied' && part.status !== 'completed') return 'denied';
  return part.status;
}

export function isInFlight(lifecycle: ToolLifecycle): boolean {
  return lifecycle === 'running' || lifecycle === 'awaiting_approval';
}

/** 一行参数摘要：路径、命令、查询词或 URL；都没有时取输入里的第一个字符串字段。 */
export function toolSummary(part: Pick<ToolPart, 'display' | 'input'>): string | undefined {
  const { display } = part;
  const summary =
    display.summary ??
    display.command ??
    (display.paths?.length ? display.paths.join(' ') : undefined) ??
    display.query ??
    display.url;
  if (summary) return firstLine(summary);
  if (isRecord(part.input)) {
    for (const value of Object.values(part.input)) {
      if (typeof value === 'string' && value.trim()) return firstLine(value);
    }
  }
  return undefined;
}

/** 结果摘要：输出的第一行非空文字。 */
export function outputSummary(part: ToolPart): string | undefined {
  const text = part.output?.text;
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim();
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── 改动行数 ─────────────────────────────────────────────────────────

export interface LineStats {
  added: number;
  removed: number;
}

/**
 * 一次修改 / 写文件的增删行数，算不出时为 undefined。认两种输入：Codex 的 `fileChange`（`changes[].diff`：新建与删除是
 * 文件全文，修改是统一 diff，codex-rs `convert_patch_changes`）；dsh 的 edit（`old_string` / `new_string`，去掉首尾相同的
 * 行再计）与 write（`content` 全算新增）。
 */
export function editStats(part: ToolPart): LineStats | undefined {
  if (part.display.kind !== 'edit' && part.display.kind !== 'write') return undefined;
  const input = part.input;
  if (!isRecord(input)) return undefined;
  if (Array.isArray(input.changes)) {
    const stats = { added: 0, removed: 0 };
    for (const change of input.changes) {
      if (!isRecord(change) || typeof change.diff !== 'string' || !isRecord(change.kind)) continue;
      if (change.kind.type === 'add') stats.added += lineCount(change.diff);
      else if (change.kind.type === 'delete') stats.removed += lineCount(change.diff);
      else addUnifiedDiff(stats, change.diff);
    }
    return stats;
  }
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return replaceStats(input.old_string, input.new_string);
  }
  if (typeof input.content === 'string') return { added: lineCount(input.content), removed: 0 };
  return undefined;
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function addUnifiedDiff(stats: LineStats, diff: string): void {
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    // 第一个 @@ 之前的 `---` / `+++` 是文件头。
    else if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) continue;
    else if (line.startsWith('+')) stats.added += 1;
    else if (line.startsWith('-')) stats.removed += 1;
  }
}

function replaceStats(before: string, after: string): LineStats {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

// ── 工作组 ──────────────────────────────────────────────────────────

/** 工作组里的一条：一次思考、一次工具调用，或（只在开发模式投影的）未识别的引擎消息。 */
export type WorkEntry = ToolPart | ReasoningPart | RawPart;

/** 助手消息渲染时的一项。 */
export type StreamItem =
  /** 一串连续的思考与工具调用，折成一行摘要。`key` 取第一条的 key，流式增长时不变。 */
  | { kind: 'work'; key: string; entries: WorkEntry[] }
  /** 一串连续的子智能体“开始工作 / 已完成”，并成一行小标签。 */
  | { kind: 'subagents'; key: string; parts: ChatPartOf<'subagent'>[] }
  | { kind: 'part'; part: ChatPart };

/**
 * 把一条助手消息的部件分成工作组、子智能体行与其余部件。连续的思考与工具调用（全部种类）合成一组，子智能体的标记
 * 连成一行；正文、错误、待办断开（模型的正文总是断开一组，同 OpenWork）。开发模式的调试信息（`raw`）不断开：在工作组
 * 里是一条，夹在子智能体标记之间的挪到那一行后面。回合边界由调用方保证：每条助手消息只属于一个回合，插话把回合分成
 * 几条消息，也就断开了。
 */
export function groupWork(parts: readonly ChatPart[]): StreamItem[] {
  const items: StreamItem[] = [];
  let work: WorkEntry[] | undefined;
  let agents: ChatPartOf<'subagent'>[] | undefined;
  let deferred: RawPart[] = [];
  const flush = () => {
    if (work?.[0]) items.push({ kind: 'work', key: `w:${work[0].key}`, entries: work });
    if (agents?.[0]) items.push({ kind: 'subagents', key: `a:${agents[0].key}`, parts: agents });
    work = undefined;
    agents = undefined;
    if (deferred[0]) {
      const raws = deferred;
      deferred = [];
      work = raws;
    }
  };
  for (const part of parts) {
    if (part.type === 'raw' && agents) {
      deferred.push(part);
    } else if (part.type === 'tool' || part.type === 'reasoning' || part.type === 'raw') {
      if (agents) flush();
      work ??= [];
      work.push(part);
    } else if (part.type === 'subagent') {
      // 只有调试信息的组让给子智能体行：并进去之后再挪到它后面。
      if (work?.every((entry) => entry.type === 'raw')) {
        deferred.push(...(work as RawPart[]));
        work = undefined;
      }
      if (work) flush();
      agents ??= [];
      agents.push(part);
    } else {
      flush();
      if (work) flush();
      items.push({ kind: 'part', part });
    }
  }
  flush();
  if (work) flush();
  return items;
}

/** 思考用了多久（`ReasoningTiming`）；起止不全时为 undefined。 */
export function thoughtDuration(part: ReasoningPart): number | undefined {
  const ms = between(part.startedAt, part.endedAt);
  return ms === undefined ? undefined : Math.max(0, ms);
}

/**
 * 摘要里分别计数的工具种类，按显示的先后。`edit` 含写文件；`create` 是 Codex 补丁里新建的文件（U16，同 Claude Code 的
 * “created …”），从修改里分出来。
 */
const COUNTED_KINDS = [
  'read',
  'search',
  'edit',
  'create',
  'shell',
  'fetch',
  'plan',
  'sub_agent',
  'unknown',
] as const;
type CountedKind = (typeof COUNTED_KINDS)[number];

export interface WorkTally {
  /** 有思考时为总用时（毫秒）。 */
  thinkingMs?: number;
  /** 读取、修改与新建按不同路径计文件数（没有路径时按调用次数），其余按调用次数。 */
  counts: Record<CountedKind, number>;
  /** 读取、修改与新建涉及的路径（U16）：只涉及一个文件时摘要写出文件名。 */
  files: Record<FileKind, string[]>;
  /** 成功的修改的增删行数；没有成功的修改时为 undefined。 */
  lines?: LineStats;
  /** 不能被折叠吞掉的调用。 */
  issues: Record<IssueKind, number>;
  /** 开发模式的调试信息条数。 */
  debug: number;
}

export type IssueKind = 'failed' | 'denied' | 'unknown';

/** 摘要里按文件计数、只有一个时写出文件名的三种。 */
type FileKind = 'read' | 'edit' | 'create';
const ISSUE_KINDS: readonly IssueKind[] = ['failed', 'denied', 'unknown'];

function countedKind(kind: ToolDisplayKind): CountedKind {
  return kind === 'write' ? 'edit' : kind;
}

export function tallyWork(entries: readonly WorkEntry[], turnActive: boolean): WorkTally {
  let thinkingMs: number | undefined;
  const counts = Object.fromEntries(COUNTED_KINDS.map((kind) => [kind, 0])) as WorkTally['counts'];
  const issues: WorkTally['issues'] = { failed: 0, denied: 0, unknown: 0 };
  const paths: Record<FileKind, Set<string>> = {
    read: new Set(),
    edit: new Set(),
    create: new Set(),
  };
  let lines: LineStats | undefined;
  let debug = 0;
  for (const entry of entries) {
    if (entry.type === 'raw') {
      debug += 1;
      continue;
    }
    if (entry.type === 'reasoning') {
      thinkingMs = (thinkingMs ?? 0) + (thoughtDuration(entry) ?? 0);
      continue;
    }
    const kind = countedKind(entry.display.kind);
    const lifecycle = toolLifecycle(entry, turnActive);
    if (lifecycle === 'failed' || lifecycle === 'denied' || lifecycle === 'unknown') {
      issues[lifecycle] += 1;
    }
    if (kind === 'edit') {
      const changed = changedPaths(entry);
      if (changed.edit.length + changed.create.length === 0) counts.edit += 1;
      for (const path of changed.edit) paths.edit.add(path);
      for (const path of changed.create) paths.create.add(path);
    } else if (kind === 'read' && entry.display.paths?.length) {
      for (const path of entry.display.paths) paths.read.add(path);
    } else {
      counts[kind] += 1;
    }
    if (kind === 'edit' && lifecycle === 'completed') {
      const stats = editStats(entry);
      if (stats) {
        lines ??= { added: 0, removed: 0 };
        lines.added += stats.added;
        lines.removed += stats.removed;
      }
    }
  }
  // 同一个文件先建后改只算新建。
  for (const path of paths.create) paths.edit.delete(path);
  counts.read += paths.read.size;
  counts.edit += paths.edit.size;
  counts.create += paths.create.size;
  return {
    ...(thinkingMs !== undefined && { thinkingMs }),
    counts,
    files: { read: [...paths.read], edit: [...paths.edit], create: [...paths.create] },
    ...(lines && { lines }),
    issues,
    debug,
  };
}

/** 摘要的一段：说明文字色的 `text`，只涉及一个文件时后面跟着正文色的文件名（U16，照 Claude Code）。 */
export interface SummaryPart {
  text: string;
  file?: string;
  /** 文件名后面还有的文字（日文、韩文等动词在后的语言）。 */
  after?: string;
}

/** 思考不到这么久时不单独写进有工具调用的摘要（“思考了 0.2 秒”只是噪音）。 */
const THINKING_WORTH_MENTIONING_MS = 1000;

/** 不到这么久的思考显示不出时长（四舍五入成“0 秒”），写“思考过”。 */
const THINKING_TOO_SHORT_MS = 50;

/**
 * 收起时的一行摘要：“思考了 17 秒，读取了 6 个文件，修改了 index.ts，运行了 2 条命令”。读取、修改、新建只涉及一个文件时写出
 * 文件名（不含目录）；不到 1 秒的思考只在组里没有工具调用时才写。
 */
export function workSummaryParts(tally: WorkTally): SummaryPart[] {
  const parts: SummaryPart[] = [];
  for (const kind of COUNTED_KINDS) {
    const count = tally.counts[kind];
    if (count === 0) continue;
    const only = kind === 'read' || kind === 'edit' || kind === 'create' ? tally.files[kind] : [];
    if (count === 1 && only.length === 1 && only[0] !== undefined) {
      // 文件名在句子里的位置随语言变（“读取了 a.ts”“a.ts を読み取り”），按 {file} 切开，前后两段是说明文字色。
      const [before = '', after = ''] = t(`work.did.${kind as FileKind}`, { file: '\u0000' }).split(
        '\u0000',
      );
      parts.push({
        text: before.trimEnd(),
        file: basename(only[0]),
        ...(after.trim() && { after: after.trimStart() }),
      });
    } else {
      parts.push({
        text: kind === 'plan' ? t('work.count.plan') : t(`work.count.${kind}`, { count }),
      });
    }
  }
  const thinking = tally.thinkingMs;
  if (thinking !== undefined && (thinking >= THINKING_WORTH_MENTIONING_MS || parts.length === 0)) {
    parts.unshift({
      text:
        thinking >= THINKING_TOO_SHORT_MS
          ? t('work.thought', { duration: formatDuration(thinking) })
          : t('work.thoughtPlain'),
    });
  }
  // 只有调试信息的组（开发模式）。
  if (parts.length === 0 && tally.debug > 0) {
    parts.push({ text: t('work.count.raw', { count: tally.debug }) });
  }
  return parts;
}

/** 摘要的纯文本（无障碍名称、测试）。 */
export function workSummary(tally: WorkTally): string {
  return workSummaryParts(tally)
    .map((part) =>
      [part.text, part.file, part.after]
        .filter((text) => text !== undefined && text !== '')
        .join(' '),
    )
    .join(t('work.separator'));
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * 一次修改涉及的路径：Codex 的 `fileChange` 按 `changes[].kind` 分出新建的（`add`）与修改的（含删除、移动），其余（dsh 的
 * edit / write）都算修改，用展示里的路径。
 */
function changedPaths(entry: ToolPart): { edit: string[]; create: string[] } {
  const input = entry.input;
  if (isRecord(input) && Array.isArray(input.changes)) {
    const out = { edit: [] as string[], create: [] as string[] };
    for (const change of input.changes) {
      if (!isRecord(change) || typeof change.path !== 'string') continue;
      const created = isRecord(change.kind) && change.kind.type === 'add';
      (created ? out.create : out.edit).push(change.path);
    }
    if (out.edit.length + out.create.length > 0) return out;
  }
  return { edit: [...(entry.display.paths ?? [])], create: [] };
}

/** 摘要后面标出的失败、被拒绝、状态未知（各自的颜色由界面决定）；工作组与收起的回合共用。 */
export function workIssues(
  issues: Readonly<Record<IssueKind, number>>,
): Array<{ kind: IssueKind; text: string }> {
  return ISSUE_KINDS.filter((kind) => issues[kind] > 0).map((kind) => ({
    kind,
    text: t(`work.issue.${kind}`, { count: issues[kind] }),
  }));
}

/** 展开后的一行。`tone` 决定颜色：进行中闪光、待审批用待审批色、失败与被拒绝用失败色、状态未知用警示色。 */
export interface WorkLineView {
  label: string;
  /** 等宽显示的目标：文件名、命令、查询词、URL。 */
  target?: string;
  /** 目标只写了文件名时的完整路径（相对工作目录），悬停提示里显示。 */
  targetTitle?: string;
  /** 跑得久的命令的用时（照 Codex 的“在 10s 内运行”），排在行尾。 */
  duration?: string;
  tone: 'done' | 'running' | 'awaiting' | 'failed' | 'muted' | 'unknown';
}

/**
 * 进行中的这一组里还没结束的一条（U16）：在运行或等审批的工具、还在流出的最后一条思考。它由组头的当前动作代表，展开的
 * 逐条里先不列，结束后再列进来（照 Codex 的进行中列表）。
 */
export function isLiveEntry(entry: WorkEntry, last: boolean, tail: boolean): boolean {
  if (entry.type === 'tool') return isInFlight(toolLifecycle(entry, true));
  return entry.type === 'reasoning' && entry.state === 'streaming' && last && tail;
}

const LINE_TONES: Record<ToolLifecycle, WorkLineView['tone']> = {
  running: 'running',
  awaiting_approval: 'awaiting',
  completed: 'done',
  failed: 'failed',
  denied: 'failed',
  cancelled: 'muted',
  unknown: 'unknown',
};

/**
 * 思考：“思考了 3 秒”，还在想时“正在思考”；`settled` 是后面已经有别的输出（增量里的思考其实已经结束，已提交的版本
 * 还没到）。
 */
export function thoughtLine(part: ReasoningPart, settled: boolean): WorkLineView {
  if (part.state === 'streaming' && !settled) return { label: t('work.thinking'), tone: 'running' };
  const duration = thoughtDuration(part);
  return {
    label:
      duration === undefined || duration < THINKING_TOO_SHORT_MS
        ? t('work.thoughtPlain')
        : t('work.thought', { duration: formatDuration(duration) }),
    tone: 'done',
  };
}

/** 开发模式的调试信息：“未识别的引擎消息 turn/diff/updated”。 */
export function rawLine(part: RawPart): WorkLineView {
  return {
    label: t('raw.label'),
    target: part.kind ? `${part.method} · ${part.kind}` : part.method,
    tone: 'muted',
  };
}

/**
 * 文件路径写成相对工作区的（Codex 给的是绝对路径）：去掉 `root/` 前缀，正好是根目录时写 `.`。只用于读取与修改的
 * 路径，命令原样显示。
 */
export function relativeToRoot(target: string, root: string | undefined): string {
  if (!root) return target;
  const base = root.replace(/[\\/]+$/, '');
  if (target === base) return '.';
  return target.split(`${base}/`).join('');
}

/**
 * 网页搜索（0.34.0）：展示类型同代码搜索（`search`），按工具名认出来换成地球图标。认的名字：Wevir 的 `mcp__wevir_web__web_search`、
 * Codex 托管的 `webSearch`、dsh 的 `web_search`、Claude 的 `WebSearch`、OpenCode 的 `websearch`。
 */
export function isWebSearch(part: Pick<ToolPart, 'toolName' | 'display'>): boolean {
  return part.display.kind === 'search' && /web_?search$/i.test(part.toolName);
}

/**
 * 一行的动词：Codex 的补丁里全是新建的文件时是“创建”（§56，照 Codex 的“文件已创建”；摘要同样分出新建，见 changedPaths），
 * 其余同展示类型。
 */
function lineVerbKind(part: ToolPart): ToolDisplayKind | 'create' {
  if (
    part.display.kind !== 'write' ||
    !isRecord(part.input) ||
    !Array.isArray(part.input.changes)
  ) {
    return part.display.kind;
  }
  const changed = changedPaths(part);
  return changed.create.length > 0 && changed.edit.length === 0 ? 'create' : 'write';
}

/** 命令跑了这么久才在行尾写用时。 */
const SHELL_DURATION_WORTH_MENTIONING_MS = 2000;

/**
 * 工具调用：“已运行 pnpm test”“正在读取 a.ts”“等待审批：运行 touch …”“运行失败 pnpm test”。读取与修改的目标只写文件名
 * （照 Codex 与 Claude Code 桌面端），完整路径相对 `root`（会话的工作目录）放进 `targetTitle`；跑了 2 秒以上的命令带用时。
 */
export function toolLine(part: ToolPart, turnActive: boolean, root?: string): WorkLineView {
  const lifecycle = toolLifecycle(part, turnActive);
  const verbKind = lineVerbKind(part);
  const verb = t(`work.verb.${verbKind}`);
  const summary =
    part.display.kind === 'unknown'
      ? (part.display.summary ?? part.toolName)
      : part.display.kind === 'plan'
        ? undefined
        : toolSummary(part);
  const kind = part.display.kind;
  const isFile = kind === 'read' || kind === 'edit' || kind === 'write';
  const paths = isFile ? part.display.paths?.filter((path) => path.trim() !== '') : undefined;
  const target = paths?.length
    ? paths.map(basename).join(', ')
    : summary && isFile
      ? relativeToRoot(summary, root)
      : summary;
  const targetTitle = paths?.length
    ? paths.map((path) => relativeToRoot(path, root)).join('\n')
    : undefined;
  const ms =
    kind === 'shell' && (lifecycle === 'completed' || lifecycle === 'failed')
      ? between(part.startedAt, part.finishedAt)
      : undefined;
  return {
    label:
      lifecycle === 'running'
        ? t(`work.running.${verbKind}`)
        : lifecycle === 'completed'
          ? t(`work.done.${verbKind}`)
          : t(`work.line.${lifecycle}`, { verb }),
    ...(target && { target }),
    ...(targetTitle !== undefined && targetTitle !== target && { targetTitle }),
    ...(ms !== undefined &&
      ms >= SHELL_DURATION_WORTH_MENTIONING_MS && { duration: formatDuration(ms) }),
    tone: LINE_TONES[lifecycle],
  };
}

/**
 * 进行中的那一组的当前动作：等审批的工具优先（“等待审批：运行 touch …”），否则是最后一个还在运行的工具（“正在运行
 * pnpm test”），都没有时“正在思考”（模型拿到工具结果在想下一步，或者正在流出思考）。
 */
export function currentAction(
  entries: readonly WorkEntry[],
  root?: string,
): {
  text: string;
  tone: 'running' | 'awaiting';
} {
  const tools = entries.filter((entry): entry is ToolPart => entry.type === 'tool');
  const waiting = tools.find((tool) => tool.status === 'awaiting_approval');
  const running = waiting ?? tools.findLast((tool) => tool.status === 'running');
  if (!running) return { text: t('work.thinking'), tone: 'running' };
  const { label, target } = toolLine(running, true, root);
  return {
    text: target ? `${label} ${target}` : label,
    tone: waiting ? 'awaiting' : 'running',
  };
}
