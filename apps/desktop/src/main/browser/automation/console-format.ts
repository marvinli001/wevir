// 把 CDP 的控制台事件（Runtime.consoleAPICalled、Runtime.exceptionThrown、Log.entryAdded）写成 browser_logs 的一条记录：
// 级别用页面调用的方法名（console.log 是 `log`，不再和 console.info 一样记成 Electron 的 `info`），对象参数按 CDP 的预览写成
// JSON 样子的文字（不再是 `[object Object]`），带 %s 一类占位符的照 console 的规则代入。

import type { BrowserConsoleEntry } from '@wevir/protocol';

/** 一条消息最长多少字符（多出的截掉）。 */
const MAX_MESSAGE_CHARS = 4_000;

interface PropertyPreview {
  name?: unknown;
  type?: unknown;
  value?: unknown;
  subtype?: unknown;
}

interface ObjectPreview {
  type?: unknown;
  subtype?: unknown;
  description?: unknown;
  overflow?: unknown;
  properties?: unknown;
  entries?: unknown;
}

interface RemoteObject {
  type?: unknown;
  subtype?: unknown;
  className?: unknown;
  value?: unknown;
  unserializableValue?: unknown;
  description?: unknown;
  preview?: ObjectPreview;
}

interface CallFrame {
  url?: unknown;
  lineNumber?: unknown;
}

/** Runtime.consoleAPICalled → 一条记录。 */
export function consoleApiEntry(params: Record<string, unknown>): BrowserConsoleEntry {
  const args = Array.isArray(params.args) ? (params.args as RemoteObject[]) : [];
  const frame = firstCallFrame(params.stackTrace);
  return entry(
    typeof params.type === 'string' ? params.type : 'log',
    formatArgs(args),
    frame,
    params.timestamp,
  );
}

/** Runtime.exceptionThrown（页面里没被捕获的异常）→ 一条 `error`。 */
export function exceptionEntry(params: Record<string, unknown>): BrowserConsoleEntry {
  const details = (params.exceptionDetails ?? {}) as {
    text?: unknown;
    exception?: RemoteObject;
    url?: unknown;
    lineNumber?: unknown;
    stackTrace?: unknown;
  };
  const description =
    typeof details.exception?.description === 'string'
      ? details.exception.description
      : details.exception
        ? formatValue(details.exception)
        : '';
  const text = typeof details.text === 'string' ? details.text : 'Uncaught';
  const frame = firstCallFrame(details.stackTrace) ?? {
    url: details.url,
    lineNumber: details.lineNumber,
  };
  return entry('error', description ? `${text} ${description}` : text, frame, params.timestamp);
}

/** Log.entryAdded（浏览器自己的消息：资源载入失败、违规提示等）→ 一条记录。 */
export function logEntry(params: Record<string, unknown>): BrowserConsoleEntry {
  const record = (params.entry ?? {}) as {
    level?: unknown;
    text?: unknown;
    url?: unknown;
    lineNumber?: unknown;
    timestamp?: unknown;
  };
  return entry(
    typeof record.level === 'string' ? record.level : 'info',
    typeof record.text === 'string' ? record.text : '',
    { url: record.url, lineNumber: record.lineNumber },
    record.timestamp,
  );
}

function entry(
  level: string,
  message: string,
  frame: CallFrame | undefined,
  timestamp: unknown,
): BrowserConsoleEntry {
  return {
    level,
    message:
      message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message,
    ...(typeof frame?.url === 'string' && frame.url.length > 0 && { source: frame.url }),
    // CDP 的行号从 0 起。
    ...(typeof frame?.lineNumber === 'number' && { line: frame.lineNumber + 1 }),
    timestamp: typeof timestamp === 'number' && timestamp > 0 ? Math.round(timestamp) : Date.now(),
  };
}

function firstCallFrame(stackTrace: unknown): CallFrame | undefined {
  const frames = (stackTrace as { callFrames?: unknown } | undefined)?.callFrames;
  return Array.isArray(frames) && frames.length > 0 ? (frames[0] as CallFrame) : undefined;
}

/** 照 console 的规则：第一个参数是字符串时代入 %s %d %i %f %o %O %c，其余参数用空格接上。 */
export function formatArgs(args: readonly RemoteObject[]): string {
  if (args.length === 0) return '';
  const [first, ...rest] = args;
  const parts: string[] = [];
  if (first?.type === 'string' && typeof first.value === 'string' && rest.length > 0) {
    const remaining = [...rest];
    const head = first.value.replace(/%([sdifoOc%])/g, (match, spec: string) => {
      if (spec === '%') return '%';
      if (remaining.length === 0) return match;
      const arg = remaining.shift() as RemoteObject;
      if (spec === 'c') return '';
      if (spec === 'd' || spec === 'i') {
        const number = Number(arg.value ?? arg.description);
        return Number.isFinite(number) ? String(Math.trunc(number)) : 'NaN';
      }
      if (spec === 'f') return String(Number(arg.value ?? arg.description));
      return formatValue(arg, spec === 's');
    });
    parts.push(head, ...remaining.map((arg) => formatValue(arg)));
  } else {
    parts.push(...args.map((arg) => formatValue(arg)));
  }
  return parts.join(' ');
}

function formatValue(object: RemoteObject, plainString = true): string {
  switch (object.type) {
    case 'string':
      return plainString ? String(object.value ?? '') : JSON.stringify(object.value ?? '');
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
      return String(object.unserializableValue ?? object.value);
    case 'bigint':
      return String(object.unserializableValue ?? object.description ?? '');
    case 'symbol':
    case 'function':
      return String(object.description ?? object.type);
    default:
      break;
  }
  if (object.subtype === 'null') return 'null';
  if (object.subtype === 'error' && typeof object.description === 'string') {
    return object.description;
  }
  if (object.preview) return formatPreview(object.preview);
  if (object.value !== undefined) {
    try {
      return JSON.stringify(object.value);
    } catch {
      // 落到下面的描述。
    }
  }
  return String(object.description ?? object.className ?? 'Object');
}

/** CDP 的对象预览写成 JSON 样子：`{"a":1,"b":"x"}`、`[1,2]`；放不下的写 `…`，更深的对象写它的描述（`Object`、`Array(3)`）。 */
function formatPreview(preview: ObjectPreview): string {
  const properties = Array.isArray(preview.properties)
    ? (preview.properties as PropertyPreview[])
    : [];
  const more = preview.overflow === true ? ['…'] : [];
  if (preview.subtype === 'array' || preview.subtype === 'typedarray') {
    const items = properties.map(formatProperty);
    return `[${[...items, ...more].join(',')}]`;
  }
  if (preview.subtype === 'map' || preview.subtype === 'set') {
    const entries = Array.isArray(preview.entries)
      ? (preview.entries as Array<{ key?: ObjectPreview; value?: ObjectPreview }>)
      : [];
    const items = entries.map((item) =>
      item.key
        ? `${formatPreviewValue(item.key)} => ${formatPreviewValue(item.value)}`
        : formatPreviewValue(item.value),
    );
    const name = typeof preview.description === 'string' ? preview.description : '';
    return `${name} {${[...items, ...more].join(', ')}}`.trim();
  }
  if (preview.type === 'object' && preview.subtype === undefined && properties.length === 0) {
    const name = typeof preview.description === 'string' ? preview.description : 'Object';
    return name === 'Object' ? '{}' : name;
  }
  const items = properties.map(
    (property) => `${JSON.stringify(String(property.name ?? ''))}:${formatProperty(property)}`,
  );
  return `{${[...items, ...more].join(',')}}`;
}

function formatProperty(property: PropertyPreview): string {
  const value = typeof property.value === 'string' ? property.value : '';
  if (property.type === 'string') return JSON.stringify(value);
  if (property.type === 'object' && property.subtype === 'null') return 'null';
  return value || String(property.type ?? '');
}

function formatPreviewValue(preview: ObjectPreview | undefined): string {
  if (!preview) return 'undefined';
  if (preview.type === 'object' && (preview.properties || preview.entries)) {
    return formatPreview(preview);
  }
  return typeof preview.description === 'string' ? preview.description : String(preview.type);
}
