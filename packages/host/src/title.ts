import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 会话标题（R3，prompts/README.md「会话标题」、prompts/thread-title.md）：第一个回合开始后，Host 用会话当前的模型
// 生成标题与检索摘要。这里是与引擎无关的部分：读提示词、组输入、解析与整理输出。发请求的是适配器的
// `generateTitle`（不实现的引擎只用首条消息截断的标题）。

/**
 * Wevir 提示词目录：仓库根的 `prompts/`。`src/` 与 `dist/` 都在包目录下一层，同一个相对路径对两者都成立；打包后
 * 的位置由 R9 定（`StartHostOptions.promptsDir`）。
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

/**
 * 第一条用户消息 → `<user_prompt>` 输入：`&`、`<`、`>` 转义（它是要命名的对象，不是指令），超过
 * `TITLE_INPUT_MAX_BYTES` 时截断，不切开字符与转义序列。
 */
export function titleInput(prompt: string): string {
  const escaped = prompt
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  let text = '';
  let bytes = 0;
  for (const piece of escaped.match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? []) {
    const size = Buffer.byteLength(piece, 'utf8');
    if (bytes + size > TITLE_INPUT_MAX_BYTES) break;
    text += piece;
    bytes += size;
  }
  return `<user_prompt>\n${text}\n</user_prompt>`;
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
