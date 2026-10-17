// 预设角色（domain-model §3.15 的“角色”一条）：`wevir_session_create` 的 `role` 给新会话一套事先定好的配置——模型、权限模式的上限、
// 一段任务说明，以及它能用哪些 Wevir 应用级工具。形态照 Claude Code 的自定义 agent：每个角色一个带 frontmatter 的 .md，
// 正文是给这个角色的说明。
//
// 来源（后面的盖住前面的同名角色）：随 Host 的内置角色 → `<数据目录>/roles/*.md`（用户的，所有项目）→ `<项目>/.wevir/roles/*.md`。
// 工具限制只管 Wevir 的应用级工具（会话、浏览器、进程、LSP……）：Host 在 `tools/list` 里不列、在 `tools/call` 里拒绝；引擎自己的
// 工具（shell、改文件、联网搜索）不归 Host 管，只能靠权限模式（上限）和说明。

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PermissionMode } from '@wevir/protocol';
import { parse as parseYaml } from 'yaml';

/** 角色名：小写字母、数字、连字符，文件名也用它。 */
export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 一句话说明的长度（字符）。 */
export const ROLE_DESCRIPTION_MAX = 300;
/** 说明正文上限（UTF-8 字节）。 */
export const ROLE_INSTRUCTIONS_MAX_BYTES = 8000;
/** 每个来源最多读几个角色文件。 */
export const ROLES_MAX = 100;
/** `tools` 里的关键字：所有只读的应用级工具（annotations 的 `readOnlyHint`）。 */
export const ROLE_READONLY_TOOLS = 'readonly';

const PERMISSION_MODES: readonly PermissionMode[] = ['on_request', 'auto_review', 'full_access'];
const TOOL_PREFIX = 'mcp__wevir__';

export type RoleSource = 'builtin' | 'user' | 'project';

export interface RoleDefinition {
  name: string;
  description: string;
  source: RoleSource;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: string;
  /** 权限模式的上限：新会话不会比它宽，也不会比开它的会话宽。 */
  permissionMode?: PermissionMode;
  /** 只许这些应用级工具：工具名、`前缀*` 或 `readonly`；省略表示都许。 */
  tools?: string[];
  /** 不许这些（写法同 `tools`），先于 `tools` 判断。 */
  disallowedTools?: string[];
  /** 给这个角色的任务说明，放在第一条消息前面。 */
  instructions: string;
}

/** 读不进来的角色文件：给用户和模型看原因，不拖垮别的角色。 */
export interface RoleProblem {
  source: RoleSource;
  file: string;
  message: string;
}

export const BUILTIN_ROLES: readonly RoleDefinition[] = Object.freeze([
  {
    name: 'explorer',
    description:
      'Investigate the code and report findings with file paths and line numbers; makes no changes.',
    source: 'builtin',
    permissionMode: 'on_request',
    tools: [ROLE_READONLY_TOOLS],
    instructions:
      'Investigate and report; do not change anything. Read, search and run read-only commands only: no edits, ' +
      'no installs, no commands that write files or touch the network beyond reading. Answer the question you were ' +
      'given with the evidence (file paths and line numbers), what you could not find, and anything surprising. ' +
      'Keep the report short enough to act on.',
  },
  {
    name: 'reviewer',
    description: 'Review a change for bugs and risks and report a ranked list; makes no changes.',
    source: 'builtin',
    permissionMode: 'on_request',
    tools: [ROLE_READONLY_TOOLS],
    instructions:
      'Review the change you were pointed at and report problems; do not fix them. Read the diff and the code it ' +
      'touches, run read-only checks if useful, and list what is wrong in order of severity: file and line, what ' +
      'breaks and under which input, how to fix it. Say plainly when you found nothing, and what you did not check.',
  },
  {
    name: 'worker',
    description:
      'Carry out one well-scoped task and report what changed; cannot open or steer other sessions.',
    source: 'builtin',
    disallowedTools: [
      'wevir_session_create',
      'wevir_session_send',
      'wevir_session_interrupt',
      'wevir_session_close',
      'wevir_session_archive',
      'wevir_plugin_install',
      'wevir_skill_install',
      'wevir_connector_add',
    ],
    instructions:
      'Do the task you were given and nothing beyond it. Stay inside its scope, check your work (build, tests) ' +
      'before you say it is done, and finish with a short report: what you changed, how you checked it, and what is ' +
      'left or uncertain. If the task is unclear or blocked, say so instead of guessing.',
  },
]);

export interface RoleStoreOptions {
  /** `<数据目录>/roles`。 */
  dir: string;
}

export class RoleStore {
  readonly #dir: string;

  constructor(options: RoleStoreOptions) {
    this.#dir = options.dir;
  }

  /** 这个项目能用的角色（内置 < 用户 < 项目，同名的后者盖前者），按名字排；读不进来的文件另列。 */
  async list(projectRoot?: string): Promise<{ roles: RoleDefinition[]; problems: RoleProblem[] }> {
    const byName = new Map<string, RoleDefinition>(BUILTIN_ROLES.map((role) => [role.name, role]));
    const problems: RoleProblem[] = [];
    const sources: Array<[RoleSource, string]> = [['user', this.#dir]];
    if (projectRoot !== undefined) sources.push(['project', join(projectRoot, '.wevir', 'roles')]);
    for (const [source, dir] of sources) {
      for (const file of await markdownFiles(dir)) {
        const text = await readFile(join(dir, file), 'utf8').catch(() => undefined);
        if (text === undefined) continue;
        const parsed = parseRole(source, file, text);
        if ('message' in parsed) problems.push({ source, file, message: parsed.message });
        else byName.set(parsed.name, parsed);
      }
    }
    return {
      roles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      problems,
    };
  }

  async get(name: string, projectRoot?: string): Promise<RoleDefinition | undefined> {
    return (await this.list(projectRoot)).roles.find((role) => role.name === name);
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .slice(0, ROLES_MAX);
}

function stringList(value: unknown, field: string): string[] | { message: string } {
  const items =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? (value as string[])
        : undefined;
  if (items === undefined) return { message: `${field} must be a list of tool names` };
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** 解析一个角色文件；不合规时返回原因。文件名（去掉 .md）是 `name` 的默认值。 */
export function parseRole(
  source: RoleSource,
  file: string,
  text: string,
): RoleDefinition | { message: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (match === null) return { message: 'needs YAML frontmatter (--- … ---) with a description' };
  let front: unknown;
  try {
    front = parseYaml(match[1] ?? '');
  } catch (error) {
    return {
      message: `invalid YAML frontmatter: ${error instanceof Error ? error.message : error}`,
    };
  }
  if (front === null || typeof front !== 'object' || Array.isArray(front)) {
    return { message: 'frontmatter must be a mapping' };
  }
  const fields = front as Record<string, unknown>;
  const name = typeof fields.name === 'string' ? fields.name.trim() : basename(file, '.md');
  if (!ROLE_NAME_PATTERN.test(name)) {
    return { message: `name "${name}" must be lowercase letters, digits and hyphens` };
  }
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (description === '') return { message: 'description is required' };
  if (Array.from(description).length > ROLE_DESCRIPTION_MAX) {
    return { message: `description is longer than ${ROLE_DESCRIPTION_MAX} characters` };
  }
  const instructions = (match[2] ?? '').trim();
  if (Buffer.byteLength(instructions, 'utf8') > ROLE_INSTRUCTIONS_MAX_BYTES) {
    return { message: `instructions are longer than ${ROLE_INSTRUCTIONS_MAX_BYTES} bytes` };
  }
  const role: RoleDefinition = { name, description, source, instructions };
  for (const [key, target] of [
    ['provider', 'providerId'],
    ['model', 'modelId'],
    ['reasoningEffort', 'reasoningEffort'],
  ] as const) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return { message: `${key} must be a non-empty string` };
    }
    role[target] = value.trim();
  }
  if (fields.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly unknown[]).includes(fields.permissionMode)) {
      return { message: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}` };
    }
    role.permissionMode = fields.permissionMode as PermissionMode;
  }
  for (const key of ['tools', 'disallowedTools'] as const) {
    if (fields[key] === undefined || fields[key] === null) continue;
    const list = stringList(fields[key], key);
    if ('message' in list) return list;
    role[key] = list;
  }
  return role;
}

function matches(pattern: string, tool: { name: string; readOnly: boolean }): boolean {
  const wanted = pattern.startsWith(TOOL_PREFIX) ? pattern.slice(TOOL_PREFIX.length) : pattern;
  if (wanted === ROLE_READONLY_TOOLS) return tool.readOnly;
  if (wanted.endsWith('*')) return tool.name.startsWith(wanted.slice(0, -1));
  return tool.name === wanted;
}

/** 这个角色的会话能不能用这个应用级工具；没有角色（普通会话）都能用。 */
export function roleAllowsTool(
  role: Pick<RoleDefinition, 'tools' | 'disallowedTools'> | undefined,
  tool: { name: string; annotations: { readOnlyHint?: boolean } },
): boolean {
  if (role === undefined) return true;
  const probe = { name: tool.name, readOnly: tool.annotations.readOnlyHint === true };
  if (role.disallowedTools?.some((pattern) => matches(pattern, probe))) return false;
  if (role.tools === undefined) return true;
  return role.tools.some((pattern) => matches(pattern, probe));
}
