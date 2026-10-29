// 别的工具写的 agent 当作角色（roles.ts）：Claude Code 的子 agent 与 Codex 的自定义 agent，每次列角色时现读，改了文件下一次就生效，
// 不经导入（external-import/ 是一次性搬进 Wevir 存储的东西；agent 文件像规则文件一样跟着仓库与用户目录走，复制一份只会过期）。
//
// - Claude Code（Agent SDK 0.3.286 打包的版本）：用户级 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/agents/*.md`，项目级 `<项目>/.claude/agents/*.md`。
//   frontmatter 的 `name`、`description`、`tools`、`disallowedTools`、`model`（`inherit` 等于不写；`sonnet` 这类别名在 Wevir 里对不上
//   模型时不用）、`effort` 原样用；`permissionMode` 换成 Wevir 的上限：`default` 与 `plan` 是 `on_request`（`plan` 另关掉改文件），
//   `bypassPermissions` 是 `full_access`，别的不设。正文是说明。`skills`、`mcpServers`、`hooks`、`maxTurns` 等不读。
// - Codex（rust-v0.163.0 的 codex-rs/agent-roles）：用户级 `<CODEX_HOME 或 ~/.codex>/agents/*.toml`，项目级 `<项目>/.codex/agents/*.toml`。
//   `name`（缺省用文件名）、`description`、`developer_instructions`（说明）、`model`、`model_reasoning_effort` 原样用；`sandbox_mode`
//   `read-only` 关掉改文件，`danger-full-access` 是 `full_access` 的上限；`[features] shell_tool = false` 关掉命令；`web_search =
//   "disabled"` 关掉联网。config.toml 里 `[agents.<名字>]` 指向别处文件的写法不读。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PermissionMode } from '@wevir/protocol';
import { parse as parseToml } from 'smol-toml';
import {
  parseFrontmatter,
  ROLES_MAX,
  type RoleDefinition,
  type RoleProblem,
  type RoleSource,
  roleFromFields,
} from './roles.js';

export interface ExternalAgentHome {
  /** 用户主目录。 */
  userHome: string;
  /** 读 `CLAUDE_CONFIG_DIR` 与 `CODEX_HOME`。 */
  env: Readonly<Record<string, string | undefined>>;
}

type Dialect = NonNullable<RoleDefinition['importedFrom']>;

/** 一级（用户或项目）里要读的 agent 目录，先 Claude 后 Codex（同名时后者盖前者）。 */
export function externalAgentDirs(
  source: Exclude<RoleSource, 'builtin'>,
  root: string,
  home?: ExternalAgentHome,
): Array<{ dialect: Dialect; dir: string }> {
  if (source === 'project') {
    return [
      { dialect: 'claude', dir: join(root, '.claude', 'agents') },
      { dialect: 'codex', dir: join(root, '.codex', 'agents') },
    ];
  }
  if (home === undefined) return [];
  const claude = home.env.CLAUDE_CONFIG_DIR;
  const codex = home.env.CODEX_HOME;
  return [
    {
      dialect: 'claude',
      dir: join(
        claude !== undefined && claude !== '' ? claude : join(home.userHome, '.claude'),
        'agents',
      ),
    },
    {
      dialect: 'codex',
      dir: join(
        codex !== undefined && codex !== '' ? codex : join(home.userHome, '.codex'),
        'agents',
      ),
    },
  ];
}

/** 读一个目录里的 agent 文件；读不进来的另列（`file` 带上 `.claude/agents/` 这样的位置，分得清是哪个工具的）。 */
export async function readExternalAgents(
  source: Exclude<RoleSource, 'builtin'>,
  dialect: Dialect,
  dir: string,
): Promise<{ roles: RoleDefinition[]; problems: RoleProblem[] }> {
  const extension = dialect === 'claude' ? '.md' : '.toml';
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return { roles: [], problems: [] };
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(extension) && !name.startsWith('.'))
    .sort()
    .slice(0, ROLES_MAX);
  const roles: RoleDefinition[] = [];
  const problems: RoleProblem[] = [];
  const label = dialect === 'claude' ? '.claude/agents' : '.codex/agents';
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const parsed =
      dialect === 'claude'
        ? parseClaudeAgent(source, name, text)
        : parseCodexAgent(source, name, text);
    if ('message' in parsed)
      problems.push({ source, file: `${label}/${name}`, message: parsed.message });
    else roles.push(parsed);
  }
  return { roles, problems };
}

const CLAUDE_PERMISSION_MODES: Readonly<Record<string, PermissionMode>> = {
  default: 'on_request',
  plan: 'on_request',
  bypassPermissions: 'full_access',
};

/** Claude Code 的子 agent（`.claude/agents/<名字>.md`）。 */
export function parseClaudeAgent(
  source: RoleSource,
  file: string,
  text: string,
): RoleDefinition | { message: string } {
  const parsed = parseFrontmatter(text);
  if ('message' in parsed) return parsed;
  const { permissionMode, ...fields } = parsed.fields;
  const mode =
    typeof permissionMode === 'string' ? CLAUDE_PERMISSION_MODES[permissionMode] : undefined;
  const role = roleFromFields(
    source,
    file,
    {
      ...fields,
      ...(mode !== undefined && { permissionMode: mode }),
      // 计划模式只读：关掉改文件。
      ...(permissionMode === 'plan' && {
        disallowedTools: [...listOf(fields.disallowedTools), 'edit'],
      }),
    },
    parsed.body,
    'claude',
  );
  return role;
}

/** Codex 的自定义 agent（`agents/<名字>.toml`）。 */
export function parseCodexAgent(
  source: RoleSource,
  file: string,
  text: string,
): RoleDefinition | { message: string } {
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    return { message: `invalid TOML: ${error instanceof Error ? error.message : error}` };
  }
  const disallowed: string[] = [];
  let permissionMode: PermissionMode | undefined;
  if (toml.sandbox_mode === 'read-only') {
    disallowed.push('edit');
    permissionMode = 'on_request';
  } else if (toml.sandbox_mode === 'danger-full-access') {
    permissionMode = 'full_access';
  }
  const features = toml.features;
  if (
    typeof features === 'object' &&
    features !== null &&
    (features as Record<string, unknown>).shell_tool === false
  ) {
    disallowed.push('shell');
  }
  if (toml.web_search === 'disabled') disallowed.push('web');
  return roleFromFields(
    source,
    file,
    {
      ...(typeof toml.name === 'string' && { name: toml.name }),
      ...(typeof toml.description === 'string' && { description: toml.description }),
      ...(typeof toml.model === 'string' && { model: toml.model }),
      ...(typeof toml.model_reasoning_effort === 'string' && {
        reasoningEffort: toml.model_reasoning_effort,
      }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(disallowed.length > 0 && { disallowedTools: disallowed }),
    },
    typeof toml.developer_instructions === 'string' ? toml.developer_instructions : '',
    'codex',
  );
}

function listOf(value: unknown): string[] {
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
