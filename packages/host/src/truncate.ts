import {
  JSON_PREVIEW_LENGTH,
  JSON_STRING_MAX_LENGTH,
  JSON_VALUE_MAX_LENGTH,
  TOOL_OUTPUT_MAX_LENGTH,
  type ToolOutput,
  type TruncatedJson,
} from '@wevir/protocol';

// 入库前的截断（host-api.md §11）。回放与实时推送用的都是截断后的同一份数据。长度一律按 UTF-16
// code unit（`string.length`）计，切点不落在代理对中间。

/**
 * 工具输出超过 `TOOL_OUTPUT_MAX_LENGTH` 时保留开头与结尾各一半，中间插入一行
 * `[… N chars truncated …]`，并标记 `truncated` 与截断前的 `originalLength`。没超过时原样返回。
 */
export function truncateToolOutput(output: ToolOutput): ToolOutput {
  const { text } = output;
  if (text.length <= TOOL_OUTPUT_MAX_LENGTH) return output;
  const half = TOOL_OUTPUT_MAX_LENGTH / 2;
  const start = head(text, half);
  const end = tail(text, half);
  const omitted = text.length - start.length - end.length;
  return {
    text: `${start}\n[… ${omitted} chars truncated …]\n${end}`,
    truncated: true,
    // 适配器已经截过一次时，保留它给的更大的原长。
    originalLength: Math.max(text.length, output.originalLength ?? 0),
  };
}

/**
 * JSON 值（工具 `input`、`engine.raw.params` 等）：先把每个超过 `JSON_STRING_MAX_LENGTH` 的字符串
 * 截成开头一段并追加 `…[+N chars]`；之后整体序列化仍超过 `JSON_VALUE_MAX_LENGTH` 时，整体换成
 * `TruncatedJson`（原值的序列化长度与开头预览）。没有需要截断的内容时返回原值本身。
 */
export function truncateJson(value: unknown): unknown {
  const shortened = truncateStrings(value);
  const serialized = JSON.stringify(shortened);
  if (serialized === undefined || serialized.length <= JSON_VALUE_MAX_LENGTH) return shortened;
  const original = JSON.stringify(value);
  const truncated: TruncatedJson = {
    $truncated: true,
    originalLength: original.length,
    preview: head(original, JSON_PREVIEW_LENGTH),
  };
  return truncated;
}

function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= JSON_STRING_MAX_LENGTH) return value;
    const kept = head(value, JSON_STRING_MAX_LENGTH);
    return `${kept}…[+${value.length - kept.length} chars]`;
  }
  if (Array.isArray(value)) {
    const items = value.map(truncateStrings);
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const next = truncateStrings(item);
      if (next !== item) changed = true;
      return [key, next] as const;
    });
    // Object.fromEntries 用 CreateDataProperty，`__proto__` 这样的键也只会成为普通属性。
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

/** 开头至多 `length` 个 code unit；切点落在代理对中间时少取一个。 */
function head(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(length - 1)) ? length - 1 : length);
}

/** 结尾至多 `length` 个 code unit；切点落在代理对中间时少取一个。 */
function tail(text: string, length: number): string {
  if (text.length <= length) return text;
  const start = text.length - length;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
