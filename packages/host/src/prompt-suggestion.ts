import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_SUGGESTION_MAX_LENGTH, type WevirEvent } from '@wevir/protocol';
import { type HistoryItem, historyItems } from './handoff.js';
import { defaultPromptsDir } from './title.js';

// 输入建议（0.53.0，domain-model §3.23、prompts/prompt-suggestion.md）：回合正常结束后，Host 用会话当前的模型发一次不带工具的
// 请求，预测用户接着会发的一句话。这里是与引擎无关的部分：读提示词、从最近的事件组输入、整理输出。发请求的是适配器的
// `generateTitle`（同一条不带工具的单次生成路径，不另开引擎连接），决定什么时候生成、什么时候作废的是 SessionManager。

/**
 * 读 `prompt-suggestion.md` 作为说明：按 prompts/README.md 的模板语法删掉 HTML 注释（文件头的来源说明）与开头的空行。
 * 这份提示词没有引入与变量，渲染结果残留 `{{` 就报错（模板语法第 4 条）。
 */
export function loadSuggestionInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'prompt-suggestion.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('prompt-suggestion.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

/** 等模型给出建议的时限；超时就没有建议。建议是锦上添花，比标题等得短。 */
export const SUGGESTION_TIMEOUT_MS = 30_000;

/** 从会话末尾往前读多少条事件来找最近的对话（一个长回合的工具调用很多，但消息只占其中几条）。 */
export const SUGGESTION_EVENT_WINDOW = 800;

/** 输入里放几条（用户消息、助手回答、命令、文件改动、错误），从最近的往前数。 */
export const SUGGESTION_MAX_ITEMS = 8;

/** 输入的总上限（UTF-8 字节）。建议只靠最近的几句话，不需要整个会话。 */
export const SUGGESTION_INPUT_MAX_BYTES = 3000;

/** 单条的上限（按码点）：助手的回答留结尾（结论和邀请都在那里），其余留开头。 */
export const SUGGESTION_ITEM_MAX_CHARS = 700;

/** 整理之后建议的上限（按码点）与词数：提示词要求 2–12 个词（中文不超过 24 个字），这里留出余量，超过就丢弃而不是截断。 */
export const SUGGESTION_MAX_CHARS = 80;
export const SUGGESTION_MAX_WORDS = 15;

/** 输出的 JSON Schema（prompt-suggestion.md「输出」）；引擎支持结构化输出时用它约束。空串表示没有建议。 */
export const SUGGESTION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { suggestion: { type: 'string' } },
  required: ['suggestion'],
  additionalProperties: false,
});

const INPUT_KINDS: ReadonlySet<HistoryItem['kind']> = new Set([
  'user_message',
  'assistant_message',
  'command',
  'file_change',
  'error',
]);

/**
 * 回合结束后输入建议的依据：最近的一段对话（`historyItems` 整理过的事件，只留消息、命令、文件改动与错误）。这个回合没有助手
 * 的回答时返回 undefined（没有可预测的）；调用方据此省掉一次请求。
 */
export function suggestionItems(
  events: readonly WevirEvent[],
  turnId: string,
): HistoryItem[] | undefined {
  const items = historyItems(events).filter((item) => INPUT_KINDS.has(item.kind));
  if (!items.some((item) => item.turnId === turnId && item.kind === 'assistant_message')) {
    return undefined;
  }
  return items.slice(-SUGGESTION_MAX_ITEMS);
}

/**
 * 最近的对话 → `<conversation>` 输入：每条是 `<message role="user|assistant">` 或工具动作的 `<action>`，`&`、`<`、`>` 转义
 * （这是预测的依据，不是指令）。从最近的一条往前放，超过 `SUGGESTION_INPUT_MAX_BYTES` 就停（最后一条总是放，必要时再截短），
 * 不切开字符与转义序列。
 */
export function suggestionInput(items: readonly HistoryItem[]): string {
  const rendered: string[] = [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as HistoryItem;
    const text = shorten(item);
    let line = wrap(item, escapeText(text));
    let size = Buffer.byteLength(line, 'utf8');
    if (rendered.length > 0 && bytes + size > SUGGESTION_INPUT_MAX_BYTES) break;
    if (size > SUGGESTION_INPUT_MAX_BYTES) {
      line = wrap(
        item,
        fitBytes(
          text,
          SUGGESTION_INPUT_MAX_BYTES - Buffer.byteLength(wrap(item, '…'), 'utf8'),
          item.kind === 'assistant_message',
        ),
      );
      size = Buffer.byteLength(line, 'utf8');
    }
    rendered.push(line);
    bytes += size;
  }
  return `<conversation>\n${rendered.reverse().join('\n')}\n</conversation>`;
}

/** 折叠空白，超过 `SUGGESTION_ITEM_MAX_CHARS` 个码点时助手的回答留结尾、其余留开头，截掉的一头写 `…`。 */
function shorten(item: HistoryItem): string {
  const chars = Array.from(item.text.replace(/\s+/g, ' ').trim());
  if (chars.length <= SUGGESTION_ITEM_MAX_CHARS) return chars.join('');
  if (item.kind === 'assistant_message') {
    return `…${chars.slice(-(SUGGESTION_ITEM_MAX_CHARS - 1)).join('')}`;
  }
  return `${chars.slice(0, SUGGESTION_ITEM_MAX_CHARS - 1).join('')}…`;
}

/** 转义后还超出字节预算时再截一次（逐个码点，不切开转义序列）；`tail` 留结尾。 */
function fitBytes(text: string, budget: number, tail: boolean): string {
  const pieces = escapeText(text).match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? [];
  const kept: string[] = [];
  let used = 0;
  for (const piece of tail ? pieces.reverse() : pieces) {
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (used + pieceBytes > budget) break;
    kept.push(piece);
    used += pieceBytes;
  }
  if (tail) kept.reverse();
  return tail ? `…${kept.join('')}` : `${kept.join('')}…`;
}

function wrap(item: HistoryItem, text: string): string {
  if (item.kind === 'user_message') return `<message role="user">${text}</message>`;
  if (item.kind === 'assistant_message') return `<message role="assistant">${text}</message>`;
  return `<action>${text}</action>`;
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const QUOTES = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/gu;

/** 模型想说“没有”时可能写出来的占位。 */
const EMPTY_WORDS = /^(?:none|null|n\/a|nothing|no suggestion|empty|无|没有|空|无建议|没有建议)$/iu;

/** 助手的口吻（提示词要求不要）：用户不会这样开口。 */
const ASSISTANT_VOICE =
  /^(?:让我|我来|我会|我将|我可以|我帮你|我先|let me\b|i['’]ll\b|i will\b|i can\b|i['’]d\b|i would\b|i['’]m going to\b)/iu;

/** 评价与致谢（提示词要求不要）：不是下一步要做的事。 */
const PRAISE =
  /^(?:谢谢|多谢|感谢|太棒了|很棒|不错|看起来不错|看着不错|很好|挺好|完美|thanks?\b|thank you\b|looks? good\b|looks? great\b|great\b|nice\b|awesome\b|perfect\b)/iu;

const QUESTION_END = /[?？]\s*$/u;

/**
 * 整理模型的输出，得到可以放进输入框的一句话；没有建议（模型留空、写了“无”）或不合格（太长、是提问、是助手的口吻、是评价、
 * 带格式符号）时返回 undefined——宁可没有，也不显示一个怪的。
 *
 * 输出应当是 `{"suggestion": "…"}`（取第一个 `{` 到最后一个 `}` 之间的 JSON，模型可能加了代码块）；不是 JSON、也没有花括号时，
 * 把整段当作建议，但只收一行（模型没按格式、直接写了句子）。整理：空白折叠成一个空格，去掉首尾引号。
 */
export function parseSuggestion(output: string): string | undefined {
  let raw: string;
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start >= 0 && end > start) {
    let value: unknown;
    try {
      value = JSON.parse(output.slice(start, end + 1));
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const { suggestion } = value as Record<string, unknown>;
    if (typeof suggestion !== 'string') return undefined;
    raw = suggestion;
  } else {
    // 没有成对的花括号：残缺的 JSON（被截断的输出）不要；纯文本只收单行的。
    const trimmed = output.trim();
    if (trimmed.includes('\n') || /[{}]/u.test(trimmed) || trimmed.startsWith('['))
      return undefined;
    raw = trimmed;
  }
  // Markdown 的代码块、标题、列表或加粗：输入框里是纯文本。包着整句的反引号（`pnpm test`）下面会和引号一起去掉，但代码块不行。
  if (/```|^\s*#{1,6}\s|^\s*[-*+]\s|\*\*/u.test(raw)) return undefined;
  const text = tidy(raw);
  if (text === '' || EMPTY_WORDS.test(text)) return undefined;
  const chars = Array.from(text);
  if (chars.length > SUGGESTION_MAX_CHARS || chars.length > PROMPT_SUGGESTION_MAX_LENGTH) {
    return undefined;
  }
  if (text.split(/\s+/u).length > SUGGESTION_MAX_WORDS) return undefined;
  if (QUESTION_END.test(text)) return undefined;
  if (ASSISTANT_VOICE.test(text) || PRAISE.test(text)) return undefined;
  return text;
}

function tidy(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  // 引号可能嵌套（“‘…’”），去到不再变化为止。
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(QUOTES, '').trim();
  }
  return out;
}
