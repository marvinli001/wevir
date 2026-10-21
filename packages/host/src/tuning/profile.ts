// 调优的档案（0.85.0，domain-model §3.39，ADR-0014）：把 Wevir 交给引擎的“运行时周围的配置”采集成八层条目，算层散列与指纹。
//
// 每层的条目只记跨版本稳定的 `id`、显示名、范围与内容散列；层散列是条目（按 id 排）的 `[id, scope, hash]` 的 sha256，指纹是八个
// 层散列按层名排好后的 sha256，与显示名、路径、采集顺序无关。文本内容（规则文件、系统提示、说明、记忆、技能的 SKILL.md、角色）
// 交给调用方按散列存起来，供两版之间看 diff；连接器与插件只记名称、命令或地址、环境变量与请求头的键名和版本，不记值，不存文本。
//
// 读文件按路径缓存 mtime+size 与散列：没变的文件不再读；已经存过的文本也不再交出。读不了的文件记一个固定的散列，不让采集失败。

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  type ApprovalRule,
  type Connector,
  isOutputStyle,
  PROFILE_LAYERS,
  type ProfileItem,
  type ProfileLayer,
  type ProfileLayerKey,
  type Skill,
} from '@wevir/protocol';
import type { MemoryNote, MemorySummary } from '../memory.js';
import type { RoleDefinition } from '../roles.js';
import type { FoundRuleFile } from '../rule-files.js';

/** 比这大的文本不存（条目照样有散列，`text` 为 false）。 */
export const PROFILE_TEXT_MAX_BYTES = 1024 * 1024;
/** 一个技能目录至多看多少个文件。 */
const SKILL_FILES_MAX = 500;
/** 技能目录里不看的子目录。 */
const SKILL_SKIP_DIRS = new Set(['node_modules', '.git']);

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 读不了的文件的散列。 */
const UNREADABLE = sha256('wevir:unreadable');

/** 采集要用的来源；没给的层是空的。 */
export interface ProfileSources {
  /** 随包分发的 `prompts/`。 */
  promptsDir?: string;
  /** 用户的家目录：规则文件的用户级那几份，显示路径时缩写成 `~`。 */
  userHome: string;
  /** 找规则文件（rule-files.ts 的 `discoverRuleFiles`）。 */
  ruleFiles?: (cwd: string) => Promise<FoundRuleFile[]>;
  /** Host 设置里与档案有关的几项。 */
  settings?: () => { agentInstructions?: string; outputStyle?: string; autoMemory?: boolean };
  memory?: {
    list(workspaceId?: string): Promise<MemorySummary[]>;
    read(
      scope: MemorySummary['scope'],
      workspaceId: string | undefined,
      name: string,
    ): Promise<MemoryNote>;
  };
  /** 启用的技能（plugins.ts 的 `enabledSkills`）。 */
  skills?: () => Promise<Skill[]>;
  roles?: {
    list(projectRoot?: string): Promise<{ roles: RoleDefinition[] }>;
  };
  /** `<数据目录>/roles`：用户角色文件所在。 */
  rolesDir?: string;
  /** 对这个范围有效的审批规则（全局的，与项目的）。 */
  approvalRules?: (workspaceId: string | undefined) => ApprovalRule[];
  /** 连接器的脱敏视图（plugins.ts 的 `connectors`）。 */
  connectors?: () => Connector[];
  plugins?: () => { id: string; name: string; version: string; enabled: boolean }[];
}

/** 采集哪个范围：全局（`workspaceId` 省略）或一个项目（它的根目录与其他源文件夹）。 */
export interface ProfileScopeInput {
  workspaceId?: string;
  /** 项目的根目录（realpath）。 */
  rootPath?: string;
  /** 项目的其他源文件夹。 */
  extraFolders?: readonly string[];
}

export interface CollectedProfile {
  fingerprint: string;
  layers: ProfileLayer[];
  /** 这次读到、还要存的文本，按散列。 */
  texts: Map<string, string>;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  hash: string;
}

/** 按 mtime+size 缓存文件的散列。`known(hash)` 说这段文本已经存过：命中缓存且已存过的文件不再读。 */
export class FileHashCache {
  readonly #files = new Map<string, CachedFile>();

  /** 文件的散列与（要存时）正文；不存在时 `undefined`。 */
  async read(
    path: string,
    known: (hash: string) => boolean,
  ): Promise<{ hash: string; size: number; text?: string } | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      this.#files.delete(path);
      return undefined;
    }
    const cached = this.#files.get(path);
    if (
      cached !== undefined &&
      cached.mtimeMs === info.mtimeMs &&
      cached.size === info.size &&
      (cached.size > PROFILE_TEXT_MAX_BYTES || known(cached.hash))
    ) {
      return { hash: cached.hash, size: cached.size };
    }
    const data = await readFile(path).catch(() => undefined);
    if (data === undefined) return { hash: UNREADABLE, size: info.size };
    const hash = sha256(data);
    this.#files.set(path, { mtimeMs: info.mtimeMs, size: info.size, hash });
    return data.byteLength > PROFILE_TEXT_MAX_BYTES
      ? { hash, size: data.byteLength }
      : { hash, size: data.byteLength, text: data.toString('utf8') };
  }
}

/** 层散列：条目按 id 排，取 `[id, scope, hash]`。 */
export function layerHash(items: readonly ProfileItem[]): string {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(JSON.stringify(sorted.map((item) => [item.id, item.scope, item.hash])));
}

/** 档案指纹：层名排序后的 `[key, hash]`。 */
export function fingerprintOf(layers: readonly Pick<ProfileLayer, 'key' | 'hash'>[]): string {
  const sorted = [...layers].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha256(JSON.stringify(sorted.map((layer) => [layer.key, layer.hash])));
}

/** 规范化的 JSON：对象的键排序，`undefined` 去掉。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

/** 采集档案。`known(hash)` 为 true 的文本不再交出（已经存过）。 */
export class ProfileCollector {
  readonly #sources: ProfileSources;
  readonly #files = new FileHashCache();
  /** 记忆的 revision → 正文的散列：没改的笔记不再读。 */
  readonly #memoryHashes = new Map<string, string>();

  constructor(sources: ProfileSources) {
    this.#sources = sources;
  }

  async collect(
    scope: ProfileScopeInput,
    known: (hash: string) => boolean = () => false,
  ): Promise<CollectedProfile> {
    const texts = new Map<string, string>();
    const keep = (hash: string, text: string | undefined) => {
      if (text !== undefined && !known(hash)) texts.set(hash, text);
      return text !== undefined || known(hash);
    };
    const context: LayerContext = { scope, known, keep, files: this.#files };
    const collectors: Record<ProfileLayerKey, (c: LayerContext) => Promise<ProfileItem[]>> = {
      system: (c) => this.#system(c),
      rules: (c) => this.#rules(c),
      instructions: async (c) => this.#instructions(c),
      memory: (c) => this.#memory(c),
      skills: (c) => this.#skills(c),
      roles: (c) => this.#roles(c),
      guardrails: async (c) => this.#guardrails(c),
      connectors: async (c) => this.#connectors(c),
    };
    const layers = await Promise.all(
      PROFILE_LAYERS.map(async (key) => {
        const items = await collectors[key](context);
        return { key, hash: layerHash(items), items };
      }),
    );
    return { fingerprint: fingerprintOf(layers), layers, texts };
  }

  /** 系统提示：`prompts/` 下的文件（README.md 只是写法说明，不算）。 */
  async #system({ files, known, keep }: LayerContext): Promise<ProfileItem[]> {
    const root = this.#sources.promptsDir;
    if (root === undefined) return [];
    const items: ProfileItem[] = [];
    for (const path of await listFiles(root, 200)) {
      const rel = relative(root, path).split(sep).join('/');
      if (rel === 'README.md') continue;
      const file = await files.read(path, known);
      if (file === undefined) continue;
      items.push({
        id: rel,
        label: rel,
        scope: 'global',
        hash: file.hash,
        ...(keep(file.hash, file.text) && { text: true }),
        path,
      });
    }
    return items;
  }

  /** 规则文件：用户级的，与项目根目录一路找到的（不看会话目录；worktree 里的会话读的是 worktree 那份）。 */
  async #rules({ scope, files, known, keep }: LayerContext): Promise<ProfileItem[]> {
    const discover = this.#sources.ruleFiles;
    if (discover === undefined) return [];
    const found = await discover(scope.rootPath ?? this.#sources.userHome);
    const items: ProfileItem[] = [];
    for (const rule of found) {
      if (scope.rootPath === undefined && rule.scope !== 'user') continue;
      const file = rule.unreadable === true ? undefined : await files.read(rule.real, known);
      // Cursor 的 .mdc 只算 frontmatter 之后的正文：按交给引擎的那段算散列。
      const text = rule.kind === 'cursor' ? rule.text : file?.text;
      const hash =
        rule.unreadable === true || file === undefined
          ? UNREADABLE
          : rule.kind === 'cursor'
            ? sha256(rule.text)
            : file.hash;
      items.push({
        id: rule.path,
        label: this.#display(rule.path, scope),
        scope: rule.scope === 'user' ? 'global' : 'project',
        hash,
        ...(hash !== UNREADABLE && keep(hash, text) && { text: true }),
        path: rule.path,
      });
    }
    return items;
  }

  /** 说明与风格：给 Agent 的说明（正文存文本）与输出风格（风格的正文在系统提示层）。 */
  #instructions({ keep }: LayerContext): ProfileItem[] {
    const settings = this.#sources.settings?.();
    if (settings === undefined) return [];
    const items: ProfileItem[] = [];
    const instructions = settings.agentInstructions?.trim();
    if (instructions !== undefined && instructions !== '') {
      const hash = sha256(instructions);
      items.push({
        id: 'agentInstructions',
        label: 'agentInstructions',
        scope: 'global',
        hash,
        ...(keep(hash, instructions) && { text: true }),
      });
    }
    const style = settings.outputStyle;
    if (style !== undefined && style !== 'default' && isOutputStyle(style)) {
      items.push({
        id: 'outputStyle',
        label: 'outputStyle',
        scope: 'global',
        hash: sha256(`outputStyle:${style}`),
        detail: style,
      });
    }
    return items;
  }

  /** 记忆：启用中的条目（全局的与本项目的）；记忆关着时为空。按 revision 缓存正文的散列。 */
  async #memory({ scope, known, keep }: LayerContext): Promise<ProfileItem[]> {
    const memory = this.#sources.memory;
    if (memory === undefined || this.#sources.settings?.().autoMemory === false) return [];
    const items: ProfileItem[] = [];
    for (const note of await memory.list(scope.workspaceId)) {
      if (!note.enabled) continue;
      const cached = this.#memoryHashes.get(note.revision);
      let hash = cached;
      let text: string | undefined;
      if (hash === undefined || !known(hash)) {
        const full = await memory
          .read(note.scope, scope.workspaceId, note.name)
          .catch(() => undefined);
        if (full === undefined) continue;
        text = `type: ${full.type}\ndescription: ${full.description}\n\n${full.content}`;
        hash = sha256(text);
        this.#memoryHashes.set(note.revision, hash);
      }
      items.push({
        id: `${note.scope}/${note.name}`,
        label: note.name,
        scope: note.scope === 'global' ? 'global' : 'project',
        hash,
        ...(keep(hash, text) && { text: true }),
        detail: note.type,
      });
    }
    return items;
  }
  /**
   * 技能：启用的；项目的只算在这个项目的文件夹里（或它们的上层目录里）的，别的项目的不算。散列是技能目录里每个文件的相对路径
   * 与散列，文本存 SKILL.md。
   */
  async #skills({ scope, files, known, keep }: LayerContext): Promise<ProfileItem[]> {
    const list = this.#sources.skills;
    if (list === undefined) return [];
    const roots =
      scope.rootPath === undefined ? [] : [scope.rootPath, ...(scope.extraFolders ?? [])];
    const items: ProfileItem[] = [];
    for (const skill of await list()) {
      const project = skill.source === 'project';
      if (project && !roots.some((root) => ownsSkill(root, skill.path))) continue;
      const dir = dirname(skill.path);
      const entries: [string, string][] = [];
      let text: string | undefined;
      let skillHash: string | undefined;
      for (const path of await listFiles(dir, SKILL_FILES_MAX, SKILL_SKIP_DIRS)) {
        const file = await files.read(path, known);
        if (file === undefined) continue;
        entries.push([relative(dir, path).split(sep).join('/'), file.hash]);
        if (path === skill.path) {
          text = file.text;
          skillHash = file.hash;
        }
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const hasText = skillHash !== undefined && keep(skillHash, text);
      items.push({
        id: skill.path,
        label: skill.name,
        scope: project ? 'project' : 'global',
        hash: sha256(JSON.stringify(entries)),
        // 散列是整个目录的；文本是 SKILL.md，按它自己的散列存。
        ...(hasText && skillHash !== undefined && { text: true, textHash: skillHash }),
        path: dir,
      });
    }
    return items;
  }

  /** 角色：内置、`<数据目录>/roles` 与项目 `.wevir/roles`，同名的后者盖前者；散列与文本是生效的定义。 */
  async #roles({ scope, keep }: LayerContext): Promise<ProfileItem[]> {
    const roles = this.#sources.roles;
    if (roles === undefined) return [];
    const { roles: list } = await roles.list(scope.rootPath);
    const items: ProfileItem[] = [];
    for (const role of list) {
      const text = roleText(role);
      const hash = sha256(text);
      const dir =
        role.source === 'project'
          ? scope.rootPath === undefined
            ? undefined
            : join(scope.rootPath, '.wevir', 'roles')
          : role.source === 'user'
            ? this.#sources.rolesDir
            : undefined;
      const path = dir === undefined ? undefined : join(dir, `${role.name}.md`);
      const exists = path !== undefined && (await stat(path).catch(() => undefined))?.isFile();
      items.push({
        id: role.name,
        label: role.name,
        scope: role.source === 'project' ? 'project' : 'global',
        hash,
        ...(keep(hash, text) && { text: true }),
        ...(exists === true && path !== undefined && { path }),
        detail: role.source,
      });
    }
    return items;
  }

  /** 护栏：现在只有审批规则（`approval:` 开头的 id）；使用次数不进散列。 */
  #guardrails({ scope }: LayerContext): ProfileItem[] {
    const rules = this.#sources.approvalRules?.(scope.workspaceId) ?? [];
    const seen = new Set<string>();
    const items: ProfileItem[] = [];
    for (const rule of rules) {
      const ruleScope = rule.workspaceId === undefined ? 'global' : 'project';
      const id = `approval:${ruleScope}:${rule.kind}:${JSON.stringify(rule.prefix)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        label: rule.prefix.join(' '),
        scope: ruleScope,
        hash: sha256(canonicalJson({ kind: rule.kind, prefix: rule.prefix })),
        detail: 'approval',
      });
    }
    return items;
  }

  /**
   * 连接器与插件：启用的连接器（全局的与本项目的；插件停用时它的连接器不算）与启用的插件。条目里只有名称、命令或地址（去掉查询串
   * 与用户信息）与插件版本；参数、完整地址与环境变量和请求头的键名只进散列，值一概不碰（脱敏视图里本来就没有）。
   */
  #connectors({ scope }: LayerContext): ProfileItem[] {
    const plugins = this.#sources.plugins?.() ?? [];
    const pluginOn = new Map(plugins.map((plugin) => [plugin.id, plugin.enabled]));
    const items: ProfileItem[] = [];
    for (const connector of this.#sources.connectors?.() ?? []) {
      if (!connector.enabled) continue;
      if (connector.pluginId !== undefined && pluginOn.get(connector.pluginId) !== true) continue;
      if (connector.workspaceId !== undefined && connector.workspaceId !== scope.workspaceId)
        continue;
      const config = connector.config;
      const shape =
        config.transport === 'stdio'
          ? {
              transport: 'stdio',
              command: config.command,
              args: config.args ?? [],
              cwd: config.cwd,
              envKeys: Object.keys(config.env ?? {}).sort(),
            }
          : {
              transport: 'http',
              url: config.url,
              headerKeys: Object.keys(config.headers ?? {}).sort(),
            };
      const detail = config.transport === 'stdio' ? config.command : safeUrl(config.url);
      items.push({
        id: `connector:${connector.name}`,
        label: connector.name,
        scope: connector.workspaceId === undefined ? 'global' : 'project',
        hash: sha256(canonicalJson(shape)),
        ...(detail !== undefined && detail !== '' && { detail }),
      });
    }
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      items.push({
        id: `plugin:${plugin.id}`,
        label: plugin.name,
        scope: 'global',
        hash: sha256(canonicalJson({ id: plugin.id, version: plugin.version })),
        detail: plugin.version,
      });
    }
    return items;
  }

  /** 显示用的路径：项目里的相对项目根，家目录里的写成 `~/…`。 */
  #display(path: string, scope: ProfileScopeInput): string {
    if (scope.rootPath !== undefined && isInside(scope.rootPath, path)) {
      return relative(scope.rootPath, path).split(sep).join('/');
    }
    const home = this.#sources.userHome;
    if (isInside(home, path)) return `~/${relative(home, path).split(sep).join('/')}`;
    return path;
  }
}

interface LayerContext {
  scope: ProfileScopeInput;
  known: (hash: string) => boolean;
  /** 记下要存的文本；返回这段文本可取（这次交出或之前已存）。 */
  keep: (hash: string, text: string | undefined) => boolean;
  files: FileHashCache;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/** 技能属于这个文件夹：它所在的 `.agents/skills` 或 `.codex/skills` 在这个文件夹里，或在它的上层目录里。 */
function ownsSkill(root: string, skillPath: string): boolean {
  const marker = [`${sep}.agents${sep}skills${sep}`, `${sep}.codex${sep}skills${sep}`]
    .map((item) => skillPath.indexOf(item))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (marker === undefined) return isInside(root, skillPath);
  const base = skillPath.slice(0, marker);
  return base === root || isInside(base, root) || isInside(root, base);
}

/** 只留地址的协议、主机与路径。 */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

/** 角色生效定义的文本：frontmatter 风格的字段加说明正文。 */
function roleText(role: RoleDefinition): string {
  const fields: [string, string | undefined][] = [
    ['name', role.name],
    ['description', role.description],
    ['source', role.source],
    ['provider', role.providerId],
    ['model', role.modelId],
    ['reasoning-effort', role.reasoningEffort],
    ['permission-mode', role.permissionMode],
    ['tools', role.tools?.join(', ')],
    ['disallowed-tools', role.disallowedTools?.join(', ')],
  ];
  const head = fields
    .filter((field): field is [string, string] => field[1] !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `---\n${head}\n---\n\n${role.instructions}`;
}

/** 目录里的普通文件（递归，按路径排序），至多 `max` 个；不跟符号链接目录。 */
async function listFiles(
  root: string,
  max: number,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= max) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };
  await walk(root);
  return out;
}
