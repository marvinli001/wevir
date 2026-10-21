import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 会话标题（R3，prompts/README.md「会话标题」、prompts/thread-title.md）：第一个回合开始后，Host 用会话当前的模型
// 生成标题与检索摘要。这里是与引擎无关的部分：读提示词、组输入、解析与整理输出。发请求的是适配器的
// `generateTitle`（不实现的引擎只用首条消息截断的标题）。

/**
 * Wevir 提示词目录：仓库根的 `prompts/`。`src/` 与 `dist/` 都在包目录下一层，同一个相对路径对两者都成立；安装包
 * 里由 wevir-host 经 `StartHostOptions.promptsDir` 给出（资源目录的 `prompts/`）。
 */
export function defaultPromptsDir(): string {
  return fileURLToPath(new URL('../../../prompts/', import.meta.url));
}

/**
 * 读 `thread-title.md` 作为说明：按 prompts/README.md 的模板语法删掉 HTML 注释（文件头的来源说明）与开头的空行。
 * 这份提示词没有引入与变量，渲染结果残留 `{{` 就报错（模板语法第 4 条）。
 */
export function loadTitleInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'thread-title.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('thread-title.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

/** 输入里用户消息的上限（UTF-8 字节），与 Codex 终端界面的做法一致（prompts/README.md：1 KB 左右）。 */
export const TITLE_INPUT_MAX_BYTES = 1000;

/** 整理之后标题的上限（按码点）：中文提示词要求不超过 16 个字，其他语言不超过 36 个字符，这里按后者兜底。 */
export const GENERATED_TITLE_MAX_LENGTH = 36;

/** 检索摘要的上限（按码点）：提示词要求中文不超过 60 个字、其他语言不超过 100 个字符。 */
export const TITLE_DESCRIPTION_MAX_LENGTH = 100;

/** 等模型生成标题的时限；超时就保留截断的标题。 */
export const TITLE_TIMEOUT_MS = 60_000;

/** 输出的 JSON Schema（thread-title.md「输出」）；引擎支持结构化输出时用它约束。 */
export const TITLE_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
  },
  required: ['title', 'description'],
  additionalProperties: false,
});

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 截到 `maxBytes`（UTF-8），不切开字符与转义序列。 */
function clipEscaped(escaped: string, maxBytes: number): string {
  let text = '';
  let bytes = 0;
  for (const piece of escaped.match(/&(?:amp|lt|gt|quot);|[\s\S]/gu) ?? []) {
    const size = Buffer.byteLength(piece, 'utf8');
    if (bytes + size > maxBytes) break;
    text += piece;
    bytes += size;
  }
  return text;
}

/**
 * 链接的内容（2026-10-21，thread-title.md「输入」）：请求几乎只是链接时，Host 先抓一下链接指的页面（只读，联网开着时），
 * 把页面标题与开头一段交给起标题的模型，让它按页面讲的东西起名，而不是写“某某 issue”。参照网上流传的 Codex 会话标题
 * 提示词“不透明的资源先用只读工具查清再起名”。
 */
export interface LinkPreview {
  url: string;
  title?: string;
  /** 页面开头的正文（Markdown 或原文）。 */
  excerpt: string;
}

/** 最多查几个链接。 */
export const TITLE_LINK_MAX = 2;

/** 去掉链接后剩下的文字（不算空白与标点）不超过这么多个码点，才算“几乎只是链接”。 */
export const TITLE_LINK_REST_MAX_LENGTH = 20;

/** 每个链接交给模型的正文上限（按码点）。 */
export const TITLE_LINK_EXCERPT_MAX_LENGTH = 300;

/** 等链接内容的时限；超时就不带链接内容起标题。 */
export const TITLE_LINK_TIMEOUT_MS = 8_000;

/** 链接在空白、引号、尖括号与中文标点处结束（中文里链接后面常直接跟“，”）。 */
const LINK_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、（）【】「」『』《》“”‘’]+/giu;

/**
 * 请求里值得先查清的链接：去掉链接后剩下的文字很短（“看看这个”“修一下这个 PR”）时，返回前 `TITLE_LINK_MAX` 个不重复的
 * http(s) 链接（去掉结尾的标点）；请求本身已经说清了主题时返回空数组。
 */
export function opaqueLinks(prompt: string): string[] {
  const links = (prompt.match(LINK_PATTERN) ?? []).map((link) =>
    link.replace(/[.,;:!?)\]}]+$/u, ''),
  );
  if (links.length === 0) return [];
  const rest = prompt.replace(LINK_PATTERN, '').replace(/[\s\p{P}\p{S}]/gu, '');
  if (Array.from(rest).length > TITLE_LINK_REST_MAX_LENGTH) return [];
  return [...new Set(links)].slice(0, TITLE_LINK_MAX);
}

/** `<link_context>`：每个查到的链接一条 `<link>`，属性与正文转义，正文折叠空白、截到上限。 */
export function linkContext(previews: readonly LinkPreview[]): string {
  if (previews.length === 0) return '';
  const links = previews.map((preview) => {
    const title =
      preview.title === undefined || preview.title.trim() === ''
        ? ''
        : ` title="${escapeXml(preview.title.replace(/\s+/g, ' ').trim()).replaceAll('"', '&quot;')}"`;
    const excerpt = Array.from(preview.excerpt.replace(/\s+/g, ' ').trim())
      .slice(0, TITLE_LINK_EXCERPT_MAX_LENGTH)
      .join('');
    return `<link url="${escapeXml(preview.url).replaceAll('"', '&quot;')}"${title}>\n${escapeXml(excerpt)}\n</link>`;
  });
  return `<link_context>\n${links.join('\n')}\n</link_context>`;
}

/**
 * 第一条用户消息 → `<user_prompt>` 输入：`&`、`<`、`>` 转义（它是要命名的对象，不是指令），超过
 * `TITLE_INPUT_MAX_BYTES` 时截断，不切开字符与转义序列。查到了链接的内容时接上 `<link_context>`。
 */
export function titleInput(prompt: string, links: readonly LinkPreview[] = []): string {
  const text = clipEscaped(escapeXml(prompt.trim()), TITLE_INPUT_MAX_BYTES);
  const context = linkContext(links);
  return `<user_prompt>\n${text}\n</user_prompt>${context === '' ? '' : `\n${context}`}`;
}

export interface GeneratedTitle {
  title: string;
  description?: string;
}

/**
 * 解析模型的输出：取第一个 `{` 到最后一个 `}` 之间的 JSON（模型可能加了代码块），`title` 必须是字符串。整理：
 * 空白折叠成一个空格，去掉首尾引号与结尾标点，按长度截断；整理后为空就算失败（返回 undefined）。
 */
export function parseGeneratedTitle(output: string): GeneratedTitle | undefined {
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
  const { title, description } = value as Record<string, unknown>;
  if (typeof title !== 'string') return undefined;
  const cleanTitle = tidy(title, GENERATED_TITLE_MAX_LENGTH);
  if (cleanTitle === '') return undefined;
  const result: GeneratedTitle = { title: cleanTitle };
  if (typeof description === 'string') {
    const cleanDescription = tidy(description, TITLE_DESCRIPTION_MAX_LENGTH);
    if (cleanDescription !== '') result.description = cleanDescription;
  }
  return result;
}

const QUOTES = /^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/gu;
const TRAILING_PUNCTUATION = /[\s.。!！?？,，;；:：、…]+$/u;

function tidy(text: string, maxLength: number): string {
  let out = text.replace(/\s+/g, ' ').trim();
  // 引号与结尾标点可能交替出现（“…。”），去到不再变化为止。
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(QUOTES, '').replace(TRAILING_PUNCTUATION, '').trim();
  }
  return Array.from(out).slice(0, maxLength).join('').trim();
}
