// “添加连接器”的“粘贴 JSON”（0.42.0，desktop-layout.md §23）：认 Claude / Cursor / VS Code 常见的 MCP 配置写法，一次导入多个，转成
// 协议的 `McpServerConfig`（stdio：command、args、env、cwd；http：url、headers）。纯函数，名字规则与校验用协议的 zod。

import { ConnectorNameSchema, type McpServerConfig, McpServerConfigSchema } from '@wevir/protocol';
import { isHttpUrl } from './connector-form';

export interface ImportEntry {
  /** 转换后的连接器名字（`[a-z0-9_-]`）。 */
  name: string;
  /** JSON 里原来的名字。 */
  source: string;
  config: McpServerConfig;
  /** 认不出、没有导入的字段（timeout、autoApprove 等）。 */
  ignored: string[];
}

export type ImportIssueReason =
  /** 不是 JSON。 */
  | 'syntax'
  /** 不是对象，或找不到 mcpServers。 */
  | 'shape'
  /** 服务表是空的。 */
  | 'empty'
  /** 名字转不出合法的连接器名。 */
  | 'name'
  /** 名字以 wevir 开头，保留给内置服务。 */
  | 'reserved'
  /** 转换后与同一份 JSON 里前面的重名。 */
  | 'duplicate'
  /** 与已有的连接器重名。 */
  | 'exists'
  /** 只有 Streamable HTTP，不支持 SSE。 */
  | 'sse'
  /** 既没有 command 也没有 url，或 type 认不出。 */
  | 'transport'
  /** 字段的类型不对或校验失败，`detail` 是出问题的字段。 */
  | 'invalid';

export interface ImportIssue {
  reason: ImportIssueReason;
  /** 出问题的服务（JSON 里的名字）。 */
  name?: string;
  detail?: string;
}

export interface ImportResult {
  entries: ImportEntry[];
  issues: ImportIssue[];
}

/** 连接器名：小写，不合规的字符换成 `-`，首尾的 `-` 去掉，最长 128；转不出来是空串。 */
export function normalizeConnectorName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

const SERVER_TABLES = ['mcpServers', 'servers', 'mcp_servers'] as const;
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamable_http', 'streamablehttp']);
const COMMON_KEYS = [
  'type',
  'transport',
  'enabled',
  'disabled',
  'toolTimeoutSec',
  'tool_timeout_sec',
];
const KNOWN_KEYS = {
  stdio: new Set([...COMMON_KEYS, 'command', 'args', 'env', 'cwd']),
  http: new Set([...COMMON_KEYS, 'url', 'headers', 'http_headers']),
} as const;

/** 解析粘贴的文本。空白文本没有条目也没有问题（对话框里什么都不显示）。 */
export function parseConnectorJson(text: string): ImportResult {
  const result: ImportResult = { entries: [], issues: [] };
  if (text.trim() === '') return result;
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    result.issues.push({ reason: 'syntax' });
    return result;
  }
  const table = isRecord(data) ? serverTable(data) : undefined;
  if (table === undefined) {
    result.issues.push({ reason: 'shape' });
    return result;
  }
  const names = Object.keys(table);
  if (names.length === 0) {
    result.issues.push({ reason: 'empty' });
    return result;
  }
  const seen = new Set<string>();
  for (const source of names) {
    const name = normalizeConnectorName(source);
    if (name === '') {
      result.issues.push({ reason: 'name', name: source });
      continue;
    }
    if (!ConnectorNameSchema.safeParse(name).success) {
      result.issues.push({ reason: 'reserved', name: source });
      continue;
    }
    if (seen.has(name)) {
      result.issues.push({ reason: 'duplicate', name: source });
      continue;
    }
    seen.add(name);
    const converted = convertServer(table[source]);
    if ('issue' in converted) {
      result.issues.push({ ...converted.issue, name: source });
      continue;
    }
    result.entries.push({ name, source, ...converted });
  }
  return result;
}

/** 与已有的连接器重名的条目记成问题（同一份 JSON 里的重名在解析时已经记了）。 */
export function withExisting(result: ImportResult, existing: ReadonlySet<string>): ImportResult {
  const issues = [...result.issues];
  for (const entry of result.entries) {
    if (existing.has(entry.name)) issues.push({ reason: 'exists', name: entry.source });
  }
  return { entries: result.entries, issues };
}

/**
 * 导入过程中已经成功添加的（按转换后的名字）从结果里去掉：它们的条目、以及它们因为“已存在”记的问题。剩下的失败项可以直接重试，
 * 不用先改 JSON。
 */
export function withoutAdded(result: ImportResult, added: ReadonlySet<string>): ImportResult {
  const sources = new Set(
    result.entries.filter((entry) => added.has(entry.name)).map((e) => e.source),
  );
  return {
    entries: result.entries.filter((entry) => !added.has(entry.name)),
    issues: result.issues.filter(
      (issue) =>
        !(issue.reason === 'exists' && issue.name !== undefined && sources.has(issue.name)),
    ),
  };
}

/** 服务表：`mcpServers`（Claude、Cursor）、`servers`（VS Code）；没有外壳时，每个值都是带 command 或 url 的对象的整张表。 */
function serverTable(data: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of SERVER_TABLES) {
    const value = data[key];
    if (isRecord(value)) return value;
  }
  const values = Object.values(data);
  return values.length > 0 && values.every((v) => isRecord(v) && ('command' in v || 'url' in v))
    ? data
    : undefined;
}

type Converted = { config: McpServerConfig; ignored: string[] } | { issue: ImportIssue };

function convertServer(value: unknown): Converted {
  if (!isRecord(value)) return { issue: { reason: 'invalid' } };
  const type = typeof value.type === 'string' ? value.type : value.transport;
  const kind = transportOf(value, type);
  if (kind === 'sse') return { issue: { reason: 'sse' } };
  if (kind === undefined) {
    return {
      issue: {
        reason: 'transport',
        ...(typeof type === 'string' && { detail: type }),
      },
    };
  }
  const common: Record<string, unknown> = {};
  if (typeof value.enabled === 'boolean') common.enabled = value.enabled;
  if (value.disabled === true) common.enabled = false;
  const timeout = value.toolTimeoutSec ?? value.tool_timeout_sec;
  if (timeout !== undefined) common.toolTimeoutSec = timeout;

  let draft: Record<string, unknown>;
  if (kind === 'stdio') {
    const args = strings(value.args, 'args');
    const env = table(value.env, 'env');
    if ('invalid' in args) return invalid(args.invalid);
    if ('invalid' in env) return invalid(env.invalid);
    draft = {
      transport: 'stdio',
      command: value.command,
      ...(args.value !== undefined && { args: args.value }),
      ...(env.value !== undefined && { env: env.value }),
      ...(value.cwd !== undefined && { cwd: value.cwd }),
      ...common,
    };
  } else {
    const headers = table(value.headers ?? value.http_headers, 'headers');
    if ('invalid' in headers) return invalid(headers.invalid);
    if (typeof value.url === 'string' && !isHttpUrl(value.url)) return invalid('url');
    draft = {
      transport: 'http',
      url: value.url,
      ...(headers.value !== undefined && { headers: headers.value }),
      ...common,
    };
  }
  const parsed = McpServerConfigSchema.safeParse(draft);
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.path.map(String).join('.') || undefined);
  }
  const ignored = Object.keys(value).filter((key) => !KNOWN_KEYS[kind].has(key));
  return { config: parsed.data, ignored };
}

function transportOf(
  value: Record<string, unknown>,
  type: unknown,
): 'stdio' | 'http' | 'sse' | undefined {
  if (typeof type === 'string') {
    const lowered = type.toLowerCase();
    if (lowered === 'stdio') return 'stdio';
    if (HTTP_TYPES.has(lowered)) return 'http';
    return lowered === 'sse' ? 'sse' : undefined;
  }
  if (type !== undefined) return undefined;
  if (typeof value.url === 'string') return 'http';
  return typeof value.command === 'string' ? 'stdio' : undefined;
}

function invalid(detail?: string): { issue: ImportIssue } {
  return { issue: { reason: 'invalid', ...(detail && { detail }) } };
}

/** 字符串数组；数字与布尔转成字符串，别的写法算无效。 */
function strings(
  value: unknown,
  field: string,
): { value: string[] | undefined } | { invalid: string } {
  if (value === undefined) return { value: undefined };
  if (!Array.isArray(value)) return { invalid: field };
  const out: string[] = [];
  for (const item of value) {
    const text = scalar(item);
    if (text === undefined) return { invalid: field };
    out.push(text);
  }
  return { value: out };
}

/** 键值表（env、headers）；值是字符串、数字或布尔，数字与布尔转成字符串。 */
function table(
  value: unknown,
  field: string,
): { value: Record<string, string> | undefined } | { invalid: string } {
  if (value === undefined) return { value: undefined };
  if (!isRecord(value)) return { invalid: field };
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const text = scalar(item);
    if (text === undefined || key === '') return { invalid: field };
    out[key] = text;
  }
  return { value: out };
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
