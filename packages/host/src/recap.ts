import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_RECAP_MIN_AWAY_MS,
  type SessionRecap,
  type TurnId,
  type TurnOutcome,
  type WevirEvent,
} from '@wevir/protocol';
import { type HistoryItem, historyItems } from './handoff.js';
import { defaultPromptsDir } from './title.js';

// 离开后摘要（0.54.0，prompts/README.md「离开后摘要」、prompts/session-recap.md、domain-model §3.24）：用户离开一阵再回到
// 会话时，Host 用会话当前的模型生成一到三句话的小结。这里是与引擎无关的部分：读提示词、判断会话的状态、组输入、整理输出、
// 缓存。发请求的是适配器的 `generateTitle`（同标题，不新开引擎连接）；什么时候生成、拒绝哪些会话在 SessionManager.recap。

/** 离开不足这么久不生成（协议常量，客户端用同一个值先筛一遍）。 */
export const RECAP_MIN_AWAY_MS = SESSION_RECAP_MIN_AWAY_MS;

/** 看得见的完整回合少于这么多不生成：刚开始的会话没有什么可回顾的。 */
export const RECAP_MIN_TURNS = 2;

/** 等模型生成摘要的时限；超时按失败处理（静默）。 */
export const RECAP_TIMEOUT_MS = 30_000;

/** 输入里最近的消息条数。 */
export const RECAP_MAX_MESSAGES = 8;

/** 每条消息保留的长度（按码点）：用户消息留开头，助手消息留结尾（结论和向用户的提问在最后）。 */
export const RECAP_USER_CHARS = 400;
export const RECAP_ASSISTANT_CHARS = 700;

/** 输入的总长度上限（UTF-8 字节）；超了从最早的消息开始丢。 */
export const RECAP_INPUT_MAX_BYTES = 6000;

/** 输入里列出的未做完的清单项数。 */
export const RECAP_MAX_TODOS = 5;

/** 整理之后的上限：句数与字符数（按码点）。提示词要求 80 个汉字以内，这里留余量。 */
export const RECAP_MAX_SENTENCES = 3;
export const RECAP_MAX_CHARS = 240;

/** 缓存里最多留多少个会话的摘要。 */
export const RECAP_CACHE_SIZE = 64;

/** 输出的 JSON Schema（session-recap.md「输出」）；引擎支持结构化输出时用它约束。 */
export const RECAP_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { recap: { type: 'string', minLength: 1 } },
  required: ['recap'],
  additionalProperties: false,
});

/**
 * 读 `session-recap.md` 作为说明：按 prompts/README.md 的模板语法删掉 HTML 注释（文件头的来源说明）与开头的空行；
 * 没有引入与变量，渲染结果残留 `{{` 就报错。
 */
export function loadRecapInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'session-recap.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('session-recap.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

/** 从事件里看出的、决定要不要生成与生成什么的东西。 */
export interface RecapAnalysis {
  /** 看得见的完整回合数：结束了的、没被撤回、没被撤销的。 */
  turns: number;
  /** 最后一个看得见的回合的结束事件的 `seq`；缓存按它去重。没有回合时 undefined。 */
  marker: number | undefined;
  /** 最后一个看得见的回合怎么结束的。 */
  lastOutcome: TurnOutcome | undefined;
  /** 看得见的回合里的用户消息与助手回答，旧的在前。 */
  messages: HistoryItem[];
  /** 最近一份清单里还没做完的项（`completed`、`cancelled` 之外的）。 */
  openTodos: string[];
}

const DONE_TODO_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'canceled']);

/**
 * 读会话的事件：数出看得见的回合（撤回的、撤销的不算，重做的算回来），取这些回合里的用户消息与助手回答，以及最后一份清单里
 * 没做完的项。纯函数，不看会话现在的状态。
 */
export function analyzeSession(events: readonly WevirEvent[]): RecapAnalysis {
  const finished: Array<{ turnId: TurnId; seq: number; outcome: TurnOutcome }> = [];
  const hidden = new Set<TurnId>();
  for (const event of events) {
    if (event.type === 'turn.finished') {
      finished.push({
        turnId: event.payload.turnId,
        seq: event.seq,
        outcome: event.payload.outcome,
      });
    } else if (event.type === 'turn.rewound') {
      const index = finished.findIndex((turn) => turn.turnId === event.payload.turnId);
      if (index >= 0) finished.splice(index, 1);
      hidden.delete(event.payload.turnId);
    } else if (event.type === 'turn.undone') {
      hidden.add(event.payload.turnId);
    } else if (event.type === 'turn.redone') {
      hidden.delete(event.payload.turnId);
    }
  }
  const visible = finished.filter((turn) => !hidden.has(turn.turnId));
  const visibleIds = new Set(visible.map((turn) => turn.turnId));
  const messages = historyItems(events).filter(
    (item) =>
      (item.kind === 'user_message' || item.kind === 'assistant_message') &&
      item.turnId !== undefined &&
      visibleIds.has(item.turnId as TurnId),
  );
  let openTodos: string[] = [];
  for (const event of events) {
    if (event.type !== 'todo.updated' || !visibleIds.has(event.payload.turnId)) continue;
    openTodos = event.payload.items
      .filter((todo) => !DONE_TODO_STATUSES.has(todo.status))
      .map((todo) => todo.content);
  }
  const last = visible.at(-1);
  return {
    turns: visible.length,
    marker: last?.seq,
    lastOutcome: last?.outcome,
    messages,
    openTodos,
  };
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 留开头（`head`）或结尾（`tail`）的 `max` 个码点，被截掉的一端写 `…`。 */
function clip(text: string, max: number, keep: 'head' | 'tail'): string {
  const chars = Array.from(collapse(text));
  if (chars.length <= max) return chars.join('');
  return keep === 'head' ? `${chars.slice(0, max).join('')}…` : `…${chars.slice(-max).join('')}`;
}

/**
 * 组输入（session-recap.md「输入」）：最近 `RECAP_MAX_MESSAGES` 条用户与助手消息，每条截短（`<`、`>`、`&` 转义，它们是要概括的对象，
 * 不是指令），总长超过 `RECAP_INPUT_MAX_BYTES` 时从最早的开始丢，再加 `<state>`：最近一个回合的结局和没做完的清单项。
 */
export function recapInput(analysis: RecapAnalysis): string {
  const state: string[] = [];
  if (analysis.lastOutcome !== undefined) state.push(`last_turn: ${analysis.lastOutcome}`);
  if (analysis.openTodos.length > 0) {
    state.push('open_todos:');
    for (const todo of analysis.openTodos.slice(0, RECAP_MAX_TODOS)) {
      state.push(`- ${escapeXml(clip(todo, 120, 'head'))}`);
    }
  }
  const stateBlock = `<state>\n${state.join('\n')}\n</state>`;
  const lines = analysis.messages.slice(-RECAP_MAX_MESSAGES).map((item) => {
    const user = item.role === 'user';
    const text = escapeXml(
      clip(item.text, user ? RECAP_USER_CHARS : RECAP_ASSISTANT_CHARS, user ? 'head' : 'tail'),
    );
    return `<message role="${item.role}">${text}</message>`;
  });
  const fixed = Buffer.byteLength(stateBlock, 'utf8') + 40;
  let budget = RECAP_INPUT_MAX_BYTES - fixed;
  const kept: string[] = [];
  for (const line of lines.reverse()) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    // 最新的一条总是留着（单条已经截短过，不会撑破预算太多）。
    if (kept.length > 0 && size > budget) break;
    kept.push(line);
    budget -= size;
  }
  return `<conversation>\n${kept.reverse().join('\n')}\n</conversation>\n${stateBlock}`;
}

const QUOTES = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/gu;
const LABEL = /^(?:摘要|回顾|小结|总结|recap|summary)\s*[:：]\s*/iu;
const INLINE_MARKDOWN = /\*\*|__|`/gu;
const LINE_MARKDOWN = /^(?:#{1,6}|[-*>])\s+/gmu;
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…']);

/** 切成句子：中文句末标点之后，或后面跟空白（或结尾）的英文句号 / 感叹号 / 问号。 */
export function splitSentences(text: string): string[] {
  const chars = Array.from(text);
  const sentences: string[] = [];
  let current = '';
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] as string;
    current += char;
    const next = chars[i + 1];
    const ends =
      SENTENCE_END.has(char) || (char === '.' && (next === undefined || /\s/u.test(next)));
    // 连续的句末标点（“？！”“...”）算同一个句末。
    if (ends && (next === undefined || !SENTENCE_END.has(next))) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') sentences.push(current.trim());
  return sentences.filter((sentence) => sentence !== '');
}

/**
 * 解析模型的输出：取第一个 `{` 到最后一个 `}` 之间的 JSON，`recap` 必须是字符串；没有 JSON 时（网关路径不强制结构化输出）
 * 把整段输出当作摘要。整理：去掉代码块与 Markdown 记号、`摘要：` 这类前缀、首尾引号，空白折叠成一个空格，最多留
 * `RECAP_MAX_SENTENCES` 句、`RECAP_MAX_CHARS` 个字符（超出时在句末截，没有句末就硬截加 `…`）；整理后为空算失败（undefined）。
 */
export function parseRecap(output: string): string | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  let raw: string | undefined;
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(output.slice(start, end + 1));
      if (typeof value === 'object' && value !== null) {
        const recap = (value as Record<string, unknown>).recap;
        if (typeof recap === 'string') raw = recap;
      }
    } catch {
      // 不是 JSON，按纯文本处理。
    }
  }
  // 看着是 JSON 却没有可用的 recap（缺字段、被截断）：不把原文当摘要显示。
  if (raw === undefined && /^\s*(?:```\w*\s*)?\{/u.test(output)) return undefined;
  raw ??= output.replace(/```\w*/gu, '');
  let text = collapse(raw.replace(LINE_MARKDOWN, '').replace(INLINE_MARKDOWN, ''));
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(QUOTES, '').replace(LABEL, '').trim();
  }
  if (text === '') return undefined;
  let result = '';
  let count = 0;
  for (const sentence of splitSentences(text)) {
    if (count >= RECAP_MAX_SENTENCES) break;
    const joined =
      result === '' ? sentence : `${result}${/[。！？…]$/u.test(result) ? '' : ' '}${sentence}`;
    if (Array.from(joined).length > RECAP_MAX_CHARS) break;
    result = joined;
    count += 1;
  }
  if (result === '') {
    // 第一句就超长：硬截。
    result = `${Array.from(text)
      .slice(0, RECAP_MAX_CHARS - 1)
      .join('')
      .trim()}…`;
  }
  return result;
}

/** 按会话缓存摘要，同一个位置只生成一次：已有的摘要，加上正在生成的（并发的请求共用同一个 promise）。 */
export class RecapCache {
  readonly #done = new Map<string, SessionRecap>();
  readonly #pending = new Map<
    string,
    { marker: number; promise: Promise<SessionRecap | undefined> }
  >();

  /** 这个会话在 `marker` 这个位置的摘要。 */
  get(sessionId: string, marker: number): SessionRecap | undefined {
    const recap = this.#done.get(sessionId);
    return recap?.throughSeq === marker ? recap : undefined;
  }

  /** 正在生成 `marker` 这个位置的摘要时返回它的 promise。 */
  pending(sessionId: string, marker: number): Promise<SessionRecap | undefined> | undefined {
    const entry = this.#pending.get(sessionId);
    return entry?.marker === marker ? entry.promise : undefined;
  }

  /** 登记一次生成；完成（成功、失败都一样）后清掉登记，成功的存进缓存。返回传入的 promise。 */
  track(
    sessionId: string,
    marker: number,
    promise: Promise<SessionRecap | undefined>,
  ): Promise<SessionRecap | undefined> {
    const entry = { marker, promise };
    this.#pending.set(sessionId, entry);
    const settle = (recap: SessionRecap | undefined) => {
      if (this.#pending.get(sessionId) === entry) this.#pending.delete(sessionId);
      if (recap === undefined) return;
      this.#done.delete(sessionId);
      this.#done.set(sessionId, recap);
      while (this.#done.size > RECAP_CACHE_SIZE) {
        const oldest = this.#done.keys().next().value;
        if (oldest === undefined) break;
        this.#done.delete(oldest);
      }
    };
    promise.then(settle, () => settle(undefined));
    return promise;
  }

  forget(sessionId: string): void {
    this.#done.delete(sessionId);
    this.#pending.delete(sessionId);
  }

  clear(): void {
    this.#done.clear();
    this.#pending.clear();
  }
}
