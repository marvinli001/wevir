import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_INSIGHT_DETAIL_MAX_LENGTH,
  SESSION_INSIGHT_SUMMARY_MAX_LENGTH,
  SESSION_INSIGHT_TITLE_MAX_LENGTH,
  type SessionInsight,
  type SessionInsightTag,
  type TurnId,
  type TurnOutcome,
  type WevirEvent,
} from '@wevir/protocol';
import { type HistoryItem, historyItems } from './handoff.js';
import { redactSecrets } from './secret-patterns.js';
import { defaultPromptsDir } from './title.js';

// 你应该知道（0.79.0，domain-model §3.33、prompts/session-insight.md）：回合结束后，Host 用会话当前的模型发一次不带工具的请求，
// 让它旁观会话、偶尔提出一件用户大概没注意到但有后果的事。这里是与引擎无关的部分：读提示词、频率限制、从事件组输入、整理输出。
// 发请求的是适配器的 `generateTitle`（同输入建议与离开后摘要），什么时候检查、写哪条事件在 SessionManager。

/** 同一个会话两次检查至少隔这么久：每次检查都是一次额外的模型请求，提示也不该频繁打断用户。 */
export const INSIGHT_MIN_INTERVAL_MS = 10 * 60_000;

/** 距上次检查，agent 至少又做了这么多事（命令、文件改动）才检查：只聊天、改一两处的回合没有什么可旁观的。 */
export const INSIGHT_MIN_NEW_ACTIONS = 3;

/** 等模型给出结果的时限；超时就当没有。 */
export const INSIGHT_TIMEOUT_MS = 60_000;

/** 从会话末尾往前读多少条事件来组输入。 */
export const INSIGHT_EVENT_WINDOW = 3000;

/** 输入里最多放几条（消息与动作），从最近的往前数。 */
export const INSIGHT_MAX_ITEMS = 60;

/** 输入的总上限（UTF-8 字节）。 */
export const INSIGHT_INPUT_MAX_BYTES = 16_000;

/** 单条的上限（按码点）：用户消息留开头；助手的回答两头都留（顺带一提的话常在中间被截掉，结论在最后）；动作留开头。 */
export const INSIGHT_USER_CHARS = 800;
export const INSIGHT_ASSISTANT_CHARS = 1200;
export const INSIGHT_ACTION_CHARS = 300;

/** 输入里列出的之前提过的与用户标为已知的条数（最近的）。 */
export const INSIGHT_MAX_OFFERED = 10;

/** 输出的 JSON Schema（session-insight.md「输出」）。字段全是必填的：有的引擎的结构化输出不接受可空或可选的字段。 */
export const INSIGHT_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    show: { type: 'boolean' },
    tag: { type: 'string' },
    summary: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['show', 'tag', 'summary', 'title', 'detail'],
  additionalProperties: false,
});

/**
 * 读 `session-insight.md` 作为说明：按 prompts/README.md 的模板语法删掉 HTML 注释（文件头的来源说明）与开头的空行；
 * 没有引入与变量，渲染结果残留 `{{` 就报错。
 */
export function loadInsightInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'session-insight.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('session-insight.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

const INPUT_KINDS: ReadonlySet<HistoryItem['kind']> = new Set([
  'user_message',
  'assistant_message',
  'command',
  'file_change',
  'error',
]);

const ACTION_KINDS: ReadonlySet<HistoryItem['kind']> = new Set(['command', 'file_change']);

/** 现在看得见的回合：撤回的（`turn.rewound`）去掉，撤销的（`turn.undone`）在重做（`turn.redone`）前不算。 */
function hiddenTurns(events: readonly WevirEvent[]): Set<string> {
  const hidden = new Set<string>();
  for (const event of events) {
    if (event.type === 'turn.rewound' || event.type === 'turn.undone') {
      hidden.add(event.payload.turnId);
    } else if (event.type === 'turn.redone') {
      hidden.delete(event.payload.turnId);
    }
  }
  return hidden;
}

/** 旁观的依据：看得见的回合里的用户消息、助手回答、命令、文件改动与错误，旧的在前。 */
export function insightItems(events: readonly WevirEvent[]): HistoryItem[] {
  const hidden = hiddenTurns(events);
  return historyItems(events).filter(
    (item) => INPUT_KINDS.has(item.kind) && (item.turnId === undefined || !hidden.has(item.turnId)),
  );
}

/** `afterSeq` 之后 agent 做了多少事（命令与文件改动）。 */
export function countActions(items: readonly HistoryItem[], afterSeq: number): number {
  return items.filter((item) => item.seq > afterSeq && ACTION_KINDS.has(item.kind)).length;
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 截到 `max` 个码点：`head` 留开头，`both` 留两头、中间写 `…`。 */
function clip(text: string, max: number, keep: 'head' | 'both'): string {
  const chars = Array.from(collapse(text));
  if (chars.length <= max) return chars.join('');
  if (keep === 'head') return `${chars.slice(0, max - 1).join('')}…`;
  const half = Math.floor((max - 1) / 2);
  return `${chars.slice(0, half).join('')}…${chars.slice(-half).join('')}`;
}

function render(item: HistoryItem): string {
  if (item.kind === 'user_message') {
    return `<message role="user">${escapeText(clip(item.text, INSIGHT_USER_CHARS, 'head'))}</message>`;
  }
  if (item.kind === 'assistant_message') {
    return `<message role="assistant">${escapeText(clip(item.text, INSIGHT_ASSISTANT_CHARS, 'both'))}</message>`;
  }
  return `<action>${escapeText(clip(item.text, INSIGHT_ACTION_CHARS, 'head'))}</action>`;
}

/** 组输入时需要的、会话里已有的“你应该知道”。 */
export interface InsightHistory {
  /** 之前提过的（任何状态）一句话提示，旧的在前。 */
  offered: readonly string[];
  /** 用户标为已知的标题，旧的在前。 */
  known: readonly string[];
}

/** 会话已有的“你应该知道”→ 输入里的 `<offered>` 与 `<known>`。 */
export function insightHistory(insights: readonly SessionInsight[]): InsightHistory {
  return {
    offered: insights.map((insight) => insight.summary),
    known: insights
      .filter((insight) => insight.status === 'known')
      .map((insight) => `${insight.title}：${insight.summary}`),
  };
}

function listBlock(tag: string, entries: readonly string[]): string {
  const lines = entries
    .slice(-INSIGHT_MAX_OFFERED)
    .map((entry) => `- ${escapeText(clip(entry, 200, 'head'))}`);
  return `<${tag}>\n${lines.length > 0 ? lines.join('\n') : '(none)'}\n</${tag}>`;
}

/**
 * 组输入（session-insight.md「输入」）：最近的 `INSIGHT_MAX_ITEMS` 条消息与动作，每条截短、转义（它们是判断的对象，不是指令），
 * 总长超过 `INSIGHT_INPUT_MAX_BYTES` 时从最早的开始丢（最新的一条总是留着），再加 `<state>`、`<offered>` 与 `<known>`。
 */
export function insightInput(
  items: readonly HistoryItem[],
  lastOutcome: TurnOutcome | undefined,
  history: InsightHistory,
): string {
  const tail = [
    `<state>\n${lastOutcome === undefined ? '' : `last_turn: ${lastOutcome}`}\n</state>`,
    listBlock('offered', history.offered),
    listBlock('known', history.known),
  ].join('\n');
  let budget = INSIGHT_INPUT_MAX_BYTES - Buffer.byteLength(tail, 'utf8') - 40;
  const kept: string[] = [];
  for (const item of items.slice(-INSIGHT_MAX_ITEMS).reverse()) {
    const line = render(item);
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (kept.length > 0 && size > budget) break;
    kept.push(line);
    budget -= size;
  }
  return `<conversation>\n${kept.reverse().join('\n')}\n</conversation>\n${tail}`;
}

/** 整理后的一条，等着写成 `SessionInsight`。 */
export interface ParsedInsight {
  tag: SessionInsightTag;
  summary: string;
  title: string;
  detail: string;
}

const TAGS: ReadonlySet<string> = new Set<SessionInsightTag>(['heads_up', 'should_know']);
const QUOTES = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/gu;

/** 单行的字段：折叠空白、去掉首尾引号与加粗记号。 */
function tidyLine(text: string): string {
  let out = collapse(text.replace(/\*\*|__/gu, ''));
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(QUOTES, '').trim();
  }
  return out;
}

/** 超长时截到 `max - 1` 个 UTF-16 code unit 加 `…`（不切开代理对）。 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/**
 * 解析模型的输出：取第一个 `{` 到最后一个 `}` 之间的 JSON。`show` 不是 `true`、`tag` 不认识、`summary` / `title` / `detail` 有一个
 * 为空，都算没有（undefined）——宁可不说，也不显示一条残缺的。整理：一句话与标题折叠成一行，说明只去掉首尾空白与外层的代码块；
 * 超长的截断；所有字段里像密钥的片段换成 `[REDACTED]`（提示词要求模型不要复制，这里再兜一道）。
 */
export function parseInsight(output: string): ParsedInsight | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.show !== true) return undefined;
  const { tag, summary, title, detail } = record;
  if (typeof tag !== 'string' || !TAGS.has(tag)) return undefined;
  if (typeof summary !== 'string' || typeof title !== 'string' || typeof detail !== 'string') {
    return undefined;
  }
  const redact = (text: string) => redactSecrets(text).text;
  const parsed: ParsedInsight = {
    tag: tag as SessionInsightTag,
    summary: cut(redact(tidyLine(summary)), SESSION_INSIGHT_SUMMARY_MAX_LENGTH),
    title: cut(
      redact(tidyLine(title).replace(/[。.!！?？]+$/u, '')),
      SESSION_INSIGHT_TITLE_MAX_LENGTH,
    ),
    detail: cut(
      redact(
        detail
          .replace(/^\s*```(?:markdown|md)?\s*\n/u, '')
          .replace(/\n\s*```\s*$/u, '')
          .trim(),
      ),
      SESSION_INSIGHT_DETAIL_MAX_LENGTH,
    ),
  };
  if (parsed.summary === '' || parsed.title === '' || parsed.detail === '') return undefined;
  return parsed;
}

/** 每个会话的频率限制状态（只在内存里；Host 重启后从会话里最近一条的 `throughSeq` 接着算）。 */
export interface InsightCheck {
  /** 上次检查开始的时刻（`Date.now()`）。 */
  at: number;
  /** 上次检查看到的事件位置。 */
  throughSeq: number;
}

/**
 * 这一次要不要检查：距上次至少 `INSIGHT_MIN_INTERVAL_MS`，并且之后 agent 又做了至少 `INSIGHT_MIN_NEW_ACTIONS` 件事。会话里有还没
 * 处理的一条时不检查（不叠着打断）。
 */
export function shouldCheck(options: {
  now: number;
  last: InsightCheck | undefined;
  items: readonly HistoryItem[];
  insights: readonly SessionInsight[];
}): boolean {
  const { now, last, items, insights } = options;
  if (insights.some((insight) => insight.status === 'open')) return false;
  if (last !== undefined && now - last.at < INSIGHT_MIN_INTERVAL_MS) return false;
  const since = last?.throughSeq ?? insights.at(-1)?.throughSeq ?? 0;
  return countActions(items, since) >= INSIGHT_MIN_NEW_ACTIONS;
}

/** 回合 `turnId` 怎么结束的；读不到时 undefined。 */
export function outcomeOf(events: readonly WevirEvent[], turnId: TurnId): TurnOutcome | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as WevirEvent;
    if (event.type === 'turn.finished' && event.payload.turnId === turnId) {
      return event.payload.outcome;
    }
  }
  return undefined;
}
