// 从其他应用导入（0.74.0，`import.*`）各家扫描器共用的部分：候选的内部形状、`key`、路径比较（含 Windows 写法）、记忆与 MCP 配置的
// 转换、密钥判断与 skills 扫描。扫描器只读用户自己的目录，不读 OAuth 令牌文件；导入时 Host 按 `key` 重新扫描再写入，不用客户端传的内容。

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ConnectorNameSchema,
  type ImportKind,
  type McpServerConfig,
  McpServerConfigSchema,
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_DESCRIPTION_MAX,
  type MemoryScope,
  type MemoryType,
  MemoryTypeSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import { record, scanSkills } from '../plugin-skills.js';
import { PENDING_CLIENT_SECRET } from '../plugins.js';
import { SECRET_PATTERNS } from '../secret-patterns.js';

/** Wevir 的一个项目：根目录加其他源文件夹（0.64.0）。 */
export interface ImportProject {
  id: WorkspaceId;
  folders: readonly string[];
}

export interface ScanContext {
  /** 用户主目录（测试里是假的）。 */
  userHome: string;
  /** 读 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`。 */
  env: Readonly<Record<string, string | undefined>>;
  projects: readonly ImportProject[];
}

interface DraftBase {
  key: string;
  /** 源文件的绝对路径。 */
  path: string;
  problem?: string;
  project?: string;
  /** 扫描器给定的建议勾选（Codex 的记忆一律不勾）；省略时按状态与问题算。 */
  recommended?: boolean;
}

export interface MemoryDraft extends DraftBase {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
}

export interface ConnectorDraft extends DraftBase {
  name: string;
  /** 环境变量与请求头的值都是空串；读不懂时没有。 */
  config?: McpServerConfig;
  /** 留空、要用户填的键。 */
  pending: string[];
  workspaceId?: WorkspaceId;
}

export interface SkillDraft extends DraftBase {
  name: string;
  description: string;
  /** skill 文件夹（SKILL.md 所在的目录）。 */
  folder: string;
  /** SKILL.md 内容的散列：同名时据此判断是不是同一份。 */
  hash: string;
}

export interface AppScan {
  home: string;
  found: boolean;
  memories: MemoryDraft[];
  connectors: ConnectorDraft[];
  skills: SkillDraft[];
  unsupported: ImportKind[];
}

/** 候选的 `key`：`<种类>:<源文件路径与条目标识的散列>`，同一份文件里的同一条每次都一样。 */
export function draftKey(kind: ImportKind, path: string, entry: string): string {
  return `${kind}:${createHash('sha256').update(`${path}\n${entry}`).digest('hex').slice(0, 40)}`;
}

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

// ── 路径 ────────────────────────────────────────────────────────────────────────────

/** Windows 写法的路径（`C:\…`、`C:/…` 或 UNC）：比较时不分大小写、不分斜杠方向。 */
export const isWindowsPath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);

function comparable(path: string): string {
  const windows = isWindowsPath(path);
  let value = path.replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/') && !/^[a-zA-Z]:\/$/.test(value))
    value = value.slice(0, -1);
  return windows ? value.toLowerCase() : value;
}

export const samePath = (a: string, b: string) => comparable(a) === comparable(b);

/** `child` 是 `parent` 本身或在它下面。 */
export function within(child: string, parent: string): boolean {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** 路径对得上的 Wevir 项目与它的那个文件夹；`nested` 时文件夹下面的路径也算。 */
export function matchProject(
  projects: readonly ImportProject[],
  path: string,
  nested = false,
): { workspaceId: WorkspaceId; folder: string } | undefined {
  for (const project of projects)
    for (const folder of project.folders)
      if (nested ? within(path, folder) : samePath(path, folder))
        return { workspaceId: project.id, folder };
  return undefined;
}

// ── 读文件 ──────────────────────────────────────────────────────────────────────────

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** 读一个普通文件；没有、太大或读不了时 `undefined`。 */
export async function readSource(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined;
    const text = await readFile(path, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// ── 记忆 ────────────────────────────────────────────────────────────────────────────

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** 规范成记忆的名字（小写字母、数字、连字符，最长 64）；转不出来时用 `fallback`。 */
export function memoryName(raw: string, fallback: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return name === '' ? fallback : name;
}

export function memoryType(value: unknown): MemoryType | undefined {
  const parsed = MemoryTypeSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  return parsed.success ? parsed.data : undefined;
}

/** 密钥不落地：像私钥、令牌的文本。 */
export const looksSecret = (text: string) => SECRET_PATTERNS.some((pattern) => pattern.test(text));

/**
 * 一条记忆候选：说明压成一行、截到上限，正文去掉首尾空白。没有说明或正文是 `invalid`，正文超过上限是 `too_large`，像密钥的是
 * `looks_secret`（这时不把正文带出去）。
 */
export function memoryDraft(input: {
  path: string;
  entry: string;
  name: string;
  type: MemoryType;
  description: string;
  content: string;
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
  project?: string;
  recommended?: boolean;
}): MemoryDraft {
  const description = Array.from(oneLine(input.description))
    .slice(0, MEMORY_DESCRIPTION_MAX)
    .join('');
  const content = input.content.trim();
  const problem =
    description === '' || content === ''
      ? 'invalid'
      : looksSecret(content) || looksSecret(description)
        ? 'looks_secret'
        : Buffer.byteLength(content) > MEMORY_CONTENT_MAX_BYTES
          ? 'too_large'
          : undefined;
  return {
    key: draftKey('memory', input.path, input.entry),
    path: input.path,
    name: input.name,
    type: input.type,
    description: problem === 'looks_secret' ? '' : description,
    content: problem === 'looks_secret' ? '' : content,
    scope: input.scope,
    ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
    ...(input.project !== undefined && { project: input.project }),
    ...(input.recommended !== undefined && { recommended: input.recommended }),
    ...(problem !== undefined && { problem }),
  };
}

/** 拆开 `---` 包着的 frontmatter；没有时 `fields` 为 `undefined`。 */
export function splitFrontmatter(text: string): { yaml?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return match === null ? { body: text } : { yaml: match[1] ?? '', body: match[2] ?? '' };
}

// ── MCP 服务器 ───────────────────────────────────────────────────────────────────────

/** MCP 配置的写法：`json` 是 Claude 的 `.mcp.json` / `.claude.json`；`codex` 是 config.toml；`antigravity` 另认 `serverUrl`。 */
export type McpFlavor = 'json' | 'codex' | 'antigravity';

const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamable_http', 'streamablehttp']);
const SECRET_FLAG =
  /^--?(?:api[-_]?key|apikey|token|access[-_]?token|auth[-_]?token|secret|client[-_]?secret|password|passwd|bearer)$/i;
const SECRET_FLAG_INLINE =
  /^--?(?:api[-_]?key|apikey|token|access[-_]?token|auth[-_]?token|secret|client[-_]?secret|password|passwd|bearer)=(.+)$/i;
const SECRET_QUERY =
  /[?&#](?:api[-_]?key|apikey|key|access[-_]?token|token|secret|password|auth|sig|signature)=[^&#\s]{6,}/i;

/** 参数里像密钥的：密钥模式，或 `--token xxx` / `--api-key=xxx` 这类带值的参数。 */
export function argsLookSecret(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    if (looksSecret(arg)) return true;
    const inline = SECRET_FLAG_INLINE.exec(arg);
    if (inline !== null && (inline[1] ?? '').length >= 6) return true;
    const next = args[index + 1];
    return SECRET_FLAG.test(arg) && next !== undefined && next.length >= 6 && !next.startsWith('-');
  });
}

/** 地址里像密钥的：密钥模式、带用户名密码，或查询参数里的 key / token 等。 */
export function urlLooksSecret(url: string): boolean {
  if (looksSecret(url) || SECRET_QUERY.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** 连接器的名字：小写，不合规的字符换成 `-`；转不出来或以 wevir 开头（保留）时另起一个。 */
export function connectorName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (name === '') return `server-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
  return ConnectorNameSchema.safeParse(name).success ? name : `imported-${name}`;
}

const scalar = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined;

function strings(value: unknown): string[] | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return false;
  const out: string[] = [];
  for (const item of value) {
    const text = scalar(item);
    if (text === undefined) return false;
    out.push(text);
  }
  return out;
}

/** 键值表只取键名（值不读）；不是对象时 `false`。 */
function keysOf(value: unknown): string[] | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).filter((key) => key !== '');
}

/**
 * 一个 MCP 服务器的配置转成 Wevir 的连接器配置：环境变量与请求头只留键名、值是空串（这些键要用户填，`pending`）。SSE 等 Wevir 不支持
 * 的传输是 `unsupported_transport`，参数或地址像密钥的是 `looks_secret`，别的读不懂是 `invalid`。
 *
 * Codex 的字段（codex-rs/config/src/mcp_types.rs，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d）：`env_vars`（从父进程转过去的变量名）
 * 也算环境变量；`http_headers`、`env_http_headers` 是请求头；`bearer_token_env_var`（与旧的 `bearer_token`）变成 `Authorization`。
 */
export function convertMcp(
  value: unknown,
  flavor: McpFlavor,
): { config?: McpServerConfig; pending: string[]; problem?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { pending: [], problem: 'invalid' };
  const entry = record(value);
  const type = scalar(entry.type) ?? scalar(entry.transport);
  const url =
    scalar(entry.url) ??
    (flavor === 'antigravity' ? (scalar(entry.serverUrl) ?? scalar(entry.httpUrl)) : undefined);
  const command = scalar(entry.command);
  let kind: 'stdio' | 'http';
  if (type !== undefined) {
    const lowered = type.toLowerCase();
    if (lowered === 'stdio') kind = 'stdio';
    else if (HTTP_TYPES.has(lowered)) kind = 'http';
    else return { pending: [], problem: 'unsupported_transport' };
  } else if (command !== undefined) kind = 'stdio';
  else if (url !== undefined) kind = 'http';
  else return { pending: [], problem: 'invalid' };

  const common: { enabled?: boolean; toolTimeoutSec?: number } = {};
  if (typeof entry.enabled === 'boolean') common.enabled = entry.enabled;
  if (entry.disabled === true) common.enabled = false;
  const timeout = entry.toolTimeoutSec ?? entry.tool_timeout_sec;
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
    common.toolTimeoutSec = timeout;

  if (kind === 'stdio') {
    if (command === undefined) return { pending: [], problem: 'invalid' };
    const args = strings(entry.args);
    const env = keysOf(entry.env);
    const envVars = flavor === 'codex' ? envVarNames(entry.env_vars) : undefined;
    if (args === false || env === false || envVars === false)
      return { pending: [], problem: 'invalid' };
    if (looksSecret(command) || argsLookSecret(args ?? []))
      return { pending: [], problem: 'looks_secret' };
    const keys = [...new Set([...(env ?? []), ...(envVars ?? [])])];
    const cwd = scalar(entry.cwd);
    const parsed = McpServerConfigSchema.safeParse({
      transport: 'stdio',
      command,
      ...(args !== undefined && { args }),
      ...(keys.length > 0 && { env: Object.fromEntries(keys.map((key) => [key, ''])) }),
      ...(cwd !== undefined && cwd !== '' && { cwd }),
      ...common,
    });
    return parsed.success
      ? { config: parsed.data, pending: keys }
      : { pending: [], problem: 'invalid' };
  }
  if (url === undefined) return { pending: [], problem: 'invalid' };
  if (urlLooksSecret(url)) return { pending: [], problem: 'looks_secret' };
  const headers = keysOf(entry.headers ?? entry.http_headers);
  const envHeaders = flavor === 'codex' ? keysOf(entry.env_http_headers) : undefined;
  if (headers === false || envHeaders === false) return { pending: [], problem: 'invalid' };
  const bearer =
    flavor === 'codex' &&
    (scalar(entry.bearer_token_env_var) !== undefined || scalar(entry.bearer_token) !== undefined)
      ? ['Authorization']
      : [];
  const keys = [...new Set([...(headers ?? []), ...(envHeaders ?? []), ...bearer])];
  const oauth = flavor === 'codex' ? codexOAuth(entry) : undefined;
  if (oauth === false) return { pending: [], problem: 'invalid' };
  const parsed = McpServerConfigSchema.safeParse({
    transport: 'http',
    url,
    ...(keys.length > 0 && { headers: Object.fromEntries(keys.map((key) => [key, ''])) }),
    ...(oauth?.config !== undefined && { auth: 'oauth', oauth: oauth.config }),
    ...common,
  });
  return parsed.success
    ? { config: parsed.data, pending: [...keys, ...(oauth?.pending ?? [])] }
    : { pending: [], problem: 'invalid' };
}

/**
 * Codex 的 OAuth 字段（0.97.0，mcp_types.rs 的 `scopes`、`oauth.{client_id,client_secret,callback_port,callback_url}`、
 * `oauth_resource`）：有 `oauth` 表时记成 `auth: "oauth"`；`client_secret` 不导入值，留给用户填（`pending`）。没有这些字段时
 * undefined（加连接器时自动判断）。Codex 的 OAuth 令牌文件不读。
 */
function codexOAuth(
  entry: Record<string, unknown>,
): { config?: Record<string, unknown>; pending: string[] } | undefined | false {
  const table = entry.oauth;
  const scopes = strings(entry.scopes);
  const resource = scalar(entry.oauth_resource);
  if (scopes === false || (table !== undefined && (table === null || typeof table !== 'object')))
    return false;
  if (table === undefined && scopes === undefined && resource === undefined) return undefined;
  const oauth = record(table ?? {});
  const clientId = scalar(oauth.client_id);
  const callbackUrl = scalar(oauth.callback_url);
  const port = oauth.callback_port;
  const config: Record<string, unknown> = {
    ...(clientId !== undefined && clientId !== '' && { clientId }),
    ...(scopes !== undefined && scopes.length > 0 && { scopes }),
    ...(resource !== undefined && resource !== '' && { resource }),
    ...(typeof port === 'number' && { callbackPort: port }),
    ...(callbackUrl !== undefined && callbackUrl !== '' && { callbackUrl }),
  };
  const secret = oauth.client_secret !== undefined && oauth.client_secret !== null;
  return {
    ...((table !== undefined || Object.keys(config).length > 0) && { config }),
    pending: secret ? [PENDING_CLIENT_SECRET] : [],
  };
}

/** Codex 的 `env_vars`：名字，或 `{ name, source }`。 */
function envVarNames(value: unknown): string[] | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return false;
  const names: string[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : scalar(record(item).name);
    if (name === undefined || name === '') return false;
    names.push(name);
  }
  return names;
}

/** 一张 MCP 服务表转成候选（源文件里的名字作条目标识）。 */
export function connectorDrafts(
  servers: Record<string, unknown>,
  flavor: McpFlavor,
  source: {
    path: string;
    /** 条目标识的前缀：同一份文件里不同表的同名服务器（`.claude.json` 的各个项目）分开。 */
    entry?: string;
    workspaceId?: WorkspaceId;
    project?: string;
    recommended?: boolean;
  },
): ConnectorDraft[] {
  return Object.entries(servers).map(([raw, value]) => {
    const converted = convertMcp(value, flavor);
    return {
      key: draftKey('connector', source.path, `${source.entry ?? ''}${raw}`),
      path: source.path,
      name: connectorName(raw),
      pending: converted.pending,
      ...(converted.config !== undefined && { config: converted.config }),
      ...(converted.problem !== undefined && { problem: converted.problem }),
      ...(source.workspaceId !== undefined && { workspaceId: source.workspaceId }),
      ...(source.project !== undefined && { project: source.project }),
      ...(source.recommended !== undefined && { recommended: source.recommended }),
    };
  });
}

// ── skills ──────────────────────────────────────────────────────────────────────────

/** 几个目录下的 skills（`<目录>/<名字>/SKILL.md`，以 `.` 开头的目录不看）；同一个 SKILL.md 只算一次。 */
export async function skillDrafts(roots: readonly string[]): Promise<SkillDraft[]> {
  const drafts: SkillDraft[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let found: Awaited<ReturnType<typeof scanSkills>>;
    try {
      found = await scanSkills(root, 'user');
    } catch {
      continue;
    }
    for (const skill of found) {
      const path = await realpath(skill.path).catch(() => skill.path);
      if (seen.has(path)) continue;
      seen.add(path);
      const text = await readSource(path);
      if (text === undefined) continue;
      drafts.push({
        key: draftKey('skill', path, ''),
        path,
        name: skill.name,
        description: skill.description,
        folder: dirname(path),
        hash: contentHash(text),
      });
    }
  }
  return drafts;
}
