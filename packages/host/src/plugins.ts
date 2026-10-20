import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import {
  type Connector,
  ConnectorNameSchema,
  type ImportedFrom,
  ImportedFromSchema,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpServerPatch,
  type Plugin,
  PluginConnectorNameSchema,
  PluginIdSchema,
  type PluginInput,
  PluginInputSchema,
  type PluginsList,
  type Skill,
  SkillSchema,
  WorkspaceIdSchema,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter, EnginePluginConfig } from '@wevir/runtime-adapter';
import { HostError } from './errors.js';
import { contained, copyPlugin, readSkills, stagePlugin } from './plugin-install.js';
import { expandConnector, inputRefs, readPluginPackage } from './plugin-packages.js';
import { record, scanSkills } from './plugin-skills.js';

interface StoredConnector {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** 只给这个项目的会话（0.74.0）；没有是全局的。 */
  workspaceId?: string;
  /** 从别的应用导入的（0.74.0）。 */
  importedFrom?: ImportedFrom;
  /**
   * 导入时留空、等用户填的环境变量或请求头的键（0.74.0）。还是空值的键就是 `missingInputs`，这时连接器不交给引擎；用
   * `connector.update` 给了值（或删掉这个键）就不再等它。
   */
  pending?: string[];
}
/** 散装连接器的额外属性（0.74.0 的项目范围与导入）。 */
export interface ConnectorExtra {
  workspaceId?: string;
  importedFrom?: ImportedFrom;
  pending?: string[];
}
/** Wevir 插件（0.42.0）。连接器存清单里的原样配置（含占位符），交给引擎前展开。 */
interface StoredPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  homepage?: string;
  icon?: string;
  source: Plugin['source'];
  enabled: boolean;
  inputs: PluginInput[];
  /** 输入项的值，密钥项同样只在 Host 的 0600 文件里。 */
  values: Record<string, string>;
  /** name 是清单里的名字；引擎里是 `<插件 id>_<name>`。 */
  connectors: StoredConnector[];
  skills: Skill[];
}
interface Registry {
  connectors: StoredConnector[];
  skills: Skill[];
  enabled: Record<string, boolean>;
  plugins: StoredPlugin[];
}

const engineName = (plugin: { id: string }, name: string) => `${plugin.id}_${name}`;
const ICON_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml' };

/** 全局注册表。JSON 只在 Host 内读写；所有返回值经 view 脱敏。 */
export class PluginRegistry {
  #dir: string;
  #skillsRoot: string;
  #packagesRoot: string;
  get dir(): string {
    return this.#dir;
  }
  get skillsRoot(): string {
    return this.#skillsRoot;
  }
  get packagesRoot(): string {
    return this.#packagesRoot;
  }
  readonly #roots: () => string[];
  readonly #userHome: string;
  readonly #adapter: AgentRuntimeAdapter;
  readonly #warning: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  #state: Registry = { connectors: [], skills: [], enabled: {}, plugins: [] };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    home: string;
    roots: () => string[];
    adapter: AgentRuntimeAdapter;
    userHome?: string;
    onWarning?: (message: string) => void;
  }) {
    this.#dir = join(options.home, 'plugins');
    this.#skillsRoot = join(this.dir, 'skills');
    this.#packagesRoot = join(this.dir, 'packages');
    this.#roots = options.roots;
    this.#adapter = options.adapter;
    this.#userHome = options.userHome ?? homedir();
    this.#warning = options.onWarning ?? (() => {});
  }

  async load(): Promise<void> {
    await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.packagesRoot, { recursive: true, mode: 0o700 });
    this.#dir = await realpath(this.dir);
    this.#skillsRoot = await realpath(this.skillsRoot);
    this.#packagesRoot = await realpath(this.packagesRoot);
    await chmod(this.dir, 0o700);
    await chmod(this.skillsRoot, 0o700);
    await chmod(this.packagesRoot, 0o700);
    try {
      const raw = record(JSON.parse(await readFile(join(this.dir, 'registry.json'), 'utf8')));
      if (!Array.isArray(raw.connectors) || !Array.isArray(raw.skills))
        throw new Error('Invalid plugin registry');
      const connectors = raw.connectors.map((value) => storedConnector(value, ConnectorNameSchema));
      // P1 的注册表没有 plugins（0.42.0 前没有发布过，不需要迁移）。
      const plugins = (Array.isArray(raw.plugins) ? raw.plugins : []).map((value) =>
        storedPlugin(value, this.packagesRoot),
      );
      const skills = raw.skills.map((value) => SkillSchema.parse(value));
      if (
        skills.some((skill) => skill.source !== 'wevir' || !contained(this.skillsRoot, skill.path))
      )
        throw new Error('Invalid managed skill path');
      const enabled = record(raw.enabled);
      if (Object.values(enabled).some((value) => typeof value !== 'boolean'))
        throw new Error('Invalid skill enablement');
      this.#state = { connectors, skills, enabled: enabled as Record<string, boolean>, plugins };
      await chmod(join(this.dir, 'registry.json'), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not load the plugin registry');
    }
    this.#adapter.bindPlugins?.({
      read: (cwd) => this.engineConfig(cwd),
      changed: () => this.changed(),
    });
  }

  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  changed(): void {
    for (const listener of this.#listeners) listener();
  }

  async #skills(cwd?: string, state: Registry = this.#state): Promise<Skill[]> {
    const items = new Map(
      [...state.skills, ...state.plugins.flatMap((plugin) => plugin.skills)].map((skill) => [
        skill.path,
        { ...skill },
      ]),
    );
    const roots = new Map<string, Skill['source']>([
      [join(this.#userHome, '.agents', 'skills'), 'user'],
    ]);
    const userHome = resolve(this.#userHome);
    for (const project of [...this.#roots(), ...(cwd === undefined ? [] : [cwd])]) {
      let dir = resolve(project);
      for (;;) {
        // 项目在用户目录下时往上会走到用户目录：那里的 skills 是用户的，不是项目的。
        const source = dir === userHome ? 'user' : 'project';
        for (const root of [join(dir, '.agents', 'skills'), join(dir, '.codex', 'skills')]) {
          if (!roots.has(root)) roots.set(root, source);
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    for (const [root, source] of roots) {
      for (const skill of await scanSkills(root, source)) {
        if (!items.has(skill.path))
          items.set(skill.path, {
            ...skill,
            id: `ext_${createHash('sha256').update(skill.path).digest('hex').slice(0, 24)}`,
            enabled: state.enabled[skill.path] === true,
          });
      }
    }
    return [...items.values()];
  }

  async engineConfig(cwd?: string): Promise<EnginePluginConfig> {
    const state = this.#state;
    // 项目的连接器（0.74.0）不在这里：只交给那个项目的会话（`projectConnectors`）。
    const connectors: EnginePluginConfig['connectors'] = engineConnectors(
      state.connectors.filter((item) => item.workspaceId === undefined),
    );
    const secrets: string[] = [];
    const off = new Set<string>();
    for (const plugin of state.plugins) {
      for (const input of plugin.inputs) {
        const value = plugin.values[input.key];
        if (input.secret && value) secrets.push(value);
      }
      if (!plugin.enabled) {
        for (const skill of plugin.skills) off.add(skill.path);
        continue;
      }
      for (const skill of plugin.skills) if (!skill.enabled) off.add(skill.path);
      for (const item of plugin.connectors) {
        if (missingInputs(plugin, item.config).length > 0) continue;
        const parsed = McpServerConfigSchema.safeParse(
          expandConnector(item.config, plugin.values, join(this.packagesRoot, plugin.id)),
        );
        if (!parsed.success) {
          this.#warning(`Connector ${engineName(plugin, item.name)} has an invalid configuration`);
          continue;
        }
        connectors.push({
          name: engineName(plugin, item.name),
          config: { ...parsed.data, enabled: item.enabled },
          enabled: item.enabled,
        });
      }
    }
    return {
      skillsRoot: this.skillsRoot,
      connectors,
      skills: (await this.#skills(cwd, state)).map(({ name, path, enabled }) => ({
        name,
        path,
        enabled: enabled && !off.has(path),
      })),
      ...(secrets.length > 0 && { secrets }),
    };
  }

  /**
   * 只给这个项目的会话的连接器（0.74.0）：Host 建立或恢复会话时按会话所在的项目取（`SessionConfig.connectors`），不看 cwd，
   * worktree 里的会话也拿得到。还有键没填的不给。
   */
  projectConnectors(workspaceId: string): EnginePluginConfig['connectors'] {
    return engineConnectors(
      this.#state.connectors.filter((item) => item.workspaceId === workspaceId),
    );
  }

  /** 已知的全部 skills（受管的、插件里的与外部的），不问引擎状态（0.74.0 导入比对用）。 */
  skills(): Promise<Skill[]> {
    return this.#skills(undefined, this.#state);
  }

  /** 全部连接器的视图（散装的与插件里的），不问引擎状态（0.74.0 导入比对用）。 */
  connectors(): Connector[] {
    const state = this.#state;
    return [
      ...state.connectors.map((item) => view(item)),
      ...state.plugins.flatMap((plugin) =>
        plugin.connectors.map((item) => ({
          ...view(item, engineName(plugin, item.name)),
          pluginId: plugin.id,
        })),
      ),
    ];
  }

  async list(): Promise<PluginsList> {
    const state = this.#state;
    const connectors = [
      ...state.connectors.map((item) => view(item)),
      ...state.plugins.flatMap((plugin) =>
        plugin.connectors.map((item) => {
          const missing = missingInputs(plugin, item.config);
          return {
            ...view(item, engineName(plugin, item.name)),
            pluginId: plugin.id,
            ...(missing.length > 0 && { missingInputs: missing }),
          };
        }),
      ),
    ];
    const skills = await this.#skills(undefined, state);
    const plugins = await Promise.all(state.plugins.map((plugin) => this.#plugin(plugin)));
    try {
      const statuses = (await this.#adapter.listConnectorStatus?.()) ?? [];
      for (const connector of connectors) {
        const matches = statuses.filter((item) => item.name === connector.name);
        const status = matches.find((item) => item.status === 'connected') ?? matches[0];
        if (status) {
          const { name: _name, ...data } = status;
          Object.assign(connector, data);
        }
      }
    } catch {
      this.#warning('Could not read connector runtime status');
    }
    return { connectors, skills, plugins };
  }

  /** 仅限进程内的应用工具脱敏，含禁用项；不能放进 RPC 结果或日志。 */
  appToolSecrets(): string[] {
    const state = this.#state;
    const configs = [...state.connectors, ...state.plugins.flatMap((plugin) => plugin.connectors)];
    return [
      ...new Set([
        ...configs.flatMap(({ config }) =>
          Object.values(config.transport === 'stdio' ? (config.env ?? {}) : (config.headers ?? {})),
        ),
        ...state.plugins.flatMap((plugin) =>
          plugin.inputs.flatMap((input) =>
            input.secret && plugin.values[input.key] ? [plugin.values[input.key] as string] : [],
          ),
        ),
      ]),
    ].filter((value) => value !== '');
  }

  async #plugin(plugin: StoredPlugin): Promise<Plugin> {
    const path = join(this.packagesRoot, plugin.id);
    let iconUrl: string | undefined;
    if (plugin.icon !== undefined) {
      try {
        const data = await readFile(join(path, plugin.icon));
        iconUrl = `data:${ICON_TYPES[extname(plugin.icon).toLowerCase()]};base64,${data.toString('base64')}`;
      } catch {
        this.#warning(`Could not read the icon of plugin ${plugin.id}`);
      }
    }
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      ...(plugin.description !== undefined && { description: plugin.description }),
      ...(plugin.author && { author: plugin.author }),
      ...(plugin.homepage !== undefined && { homepage: plugin.homepage }),
      ...(iconUrl !== undefined && { iconUrl }),
      source: plugin.source,
      enabled: plugin.enabled,
      path,
      inputs: plugin.inputs.map((input) => {
        const value = plugin.values[input.key];
        return {
          key: input.key,
          label: input.label,
          ...(input.description !== undefined && { description: input.description }),
          secret: input.secret === true,
          required: input.required === true,
          set: value !== undefined,
          ...(!input.secret && value !== undefined && { value }),
        };
      }),
      connectors: plugin.connectors.map((item) => item.id),
      skills: plugin.skills.map((item) => item.id),
    };
  }

  #pluginOf(state: Registry, id: string): StoredPlugin {
    const plugin = state.plugins.find((item) => item.id === id);
    if (!plugin) throw invalid('Plugin not found');
    return plugin;
  }

  setPluginEnabled(id: string, enabled: boolean): Promise<Plugin> {
    return this.#mutate(async (next) => {
      const plugin = this.#pluginOf(next, id);
      plugin.enabled = enabled;
      return plugin;
    }).then((plugin) => this.#plugin(plugin));
  }

  setPluginInputs(id: string, values: Record<string, string | null>): Promise<Plugin> {
    return this.#mutate(async (next) => {
      const plugin = this.#pluginOf(next, id);
      plugin.values = mergeInputs(plugin, plugin.values, values);
      return plugin;
    }).then((plugin) => this.#plugin(plugin));
  }

  removePlugin(id: string): Promise<void> {
    return this.#mutate(
      async (next) => {
        this.#pluginOf(next, id);
        const folder = join(this.packagesRoot, id);
        const trash = join(this.dir, `.removed-${randomUUID()}`);
        await rename(folder, trash);
        next.plugins = next.plugins.filter((item) => item.id !== id);
        return { folder, trash };
      },
      ({ folder, trash }) => rename(trash, folder),
    ).then(async ({ trash }) => {
      await rm(trash, { recursive: true, force: true });
    });
  }

  /** 装 Wevir 插件包或导入 Claude / Codex 包（文件夹或 ZIP）；同 id 已装时 replace 升级，保留输入项与各项开关。 */
  async installPlugin(
    path: string,
    options: { inputs?: Record<string, string>; replace?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ plugin: Plugin; ignored: string[] }> {
    const result = await this.#mutate(
      async (next) => {
        const stage = await mkdtemp(join(this.dir, '.install-'));
        let moved: { target: string; trash?: string } | undefined;
        try {
          const info = await lstat(resolve(path));
          if (!info.isDirectory() && !(info.isFile() && path.toLowerCase().endsWith('.zip')))
            throw invalid('Install a plugin folder or ZIP');
          const root = await stagePlugin(path, join(stage, 'source'));
          const pkg = await readPluginPackage(root);
          const old = next.plugins.find((item) => item.id === pkg.id);
          if (old && !options.replace)
            throw invalid(`Plugin "${pkg.id}" is already installed; pass replace to upgrade it`);
          const others = { ...next, plugins: next.plugins.filter((item) => item !== old) };
          const names = new Set((await this.#skills(undefined, others)).map((item) => item.name));
          for (const skill of pkg.skills)
            if (names.has(skill.name))
              throw invalid(`Skill "${skill.name}" conflicts with an installed skill`);
          for (const item of pkg.connectors) {
            const name = engineName(pkg, item.name);
            if (!ConnectorNameSchema.safeParse(name).success)
              throw invalid(`Invalid connector name "${item.name}"`);
            if (others.connectors.some((connector) => connector.name === name))
              throw invalid(`Connector "${name}" conflicts with an installed connector`);
          }
          const target = join(this.packagesRoot, pkg.id);
          moved = { target };
          if (old) {
            moved.trash = join(this.dir, `.removed-${randomUUID()}`);
            await rename(target, moved.trash);
          } else {
            try {
              await lstat(target);
              throw invalid(`A plugin folder named "${pkg.id}" already exists`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          await rename(root, target);
          const plugin: StoredPlugin = {
            id: pkg.id,
            name: pkg.name,
            version: pkg.version,
            ...(pkg.description !== undefined && { description: pkg.description }),
            ...(pkg.author && { author: pkg.author }),
            ...(pkg.homepage !== undefined && { homepage: pkg.homepage }),
            ...(pkg.icon !== undefined && { icon: pkg.icon }),
            source: pkg.source,
            enabled: old?.enabled ?? true,
            inputs: pkg.inputs,
            values: {},
            connectors: pkg.connectors.map((item) => {
              const before = old?.connectors.find((connector) => connector.name === item.name);
              const enabled = before?.enabled ?? item.config.enabled ?? true;
              return {
                id: before?.id ?? `con_${randomUUID()}`,
                name: item.name,
                config: { ...item.config, enabled },
                enabled,
              };
            }),
            skills: [],
          };
          for (const skill of pkg.skills) {
            const before = old?.skills.find((item) => item.name === skill.name);
            plugin.skills.push({
              ...skill,
              id: before?.id ?? `skl_${randomUUID()}`,
              path: await realpath(join(target, relative(root, skill.path))),
              enabled: before?.enabled ?? true,
              pluginId: pkg.id,
            });
          }
          const kept = Object.fromEntries(
            Object.entries(old?.values ?? {}).filter(([key]) =>
              pkg.inputs.some((input) => input.key === key),
            ),
          );
          plugin.values = mergeInputs(plugin, kept, options.inputs ?? {});
          next.plugins = [...others.plugins, plugin];
          return { plugin, ignored: pkg.ignored, moved };
        } catch (error) {
          if (moved) {
            await rm(moved.target, { recursive: true, force: true });
            if (moved.trash) await rename(moved.trash, moved.target);
          }
          throw error instanceof HostError
            ? error
            : invalid(error instanceof Error ? error.message : 'Plugin installation failed');
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      },
      async ({ moved }) => {
        await rm(moved.target, { recursive: true, force: true });
        if (moved.trash) await rename(moved.trash, moved.target);
      },
      options.signal,
    );
    if (result.moved.trash) await rm(result.moved.trash, { recursive: true, force: true });
    return { plugin: await this.#plugin(result.plugin), ignored: result.ignored };
  }

  /**
   * 加一个散装连接器。`extra.workspaceId`（0.74.0）只给那个项目（调用方先确认项目在）；名字在全局与同一项目之间唯一。
   * 导入的带 `importedFrom` 与 `pending`（留空等用户填的键）。
   */
  add(
    name: string,
    config: McpServerConfig,
    enabled?: boolean,
    signal?: AbortSignal,
    extra: ConnectorExtra = {},
  ): Promise<Connector> {
    return this.#mutate(
      async (next) => {
        this.#checkName(next, name, extra.workspaceId);
        const parsed = McpServerConfigSchema.safeParse(config);
        if (!parsed.success) throw invalid('Invalid connector configuration');
        if (
          extra.workspaceId !== undefined &&
          !WorkspaceIdSchema.safeParse(extra.workspaceId).success
        )
          throw invalid('Invalid workspace id');
        const item: StoredConnector = {
          id: `con_${randomUUID()}`,
          name,
          config: { ...parsed.data, enabled: enabled ?? config.enabled ?? true },
          enabled: enabled ?? config.enabled ?? true,
          ...(extra.workspaceId !== undefined && { workspaceId: extra.workspaceId }),
          ...(extra.importedFrom !== undefined && { importedFrom: extra.importedFrom }),
          ...(extra.pending !== undefined &&
            extra.pending.length > 0 && { pending: [...extra.pending] }),
        };
        next.connectors.push(item);
        return view(item);
      },
      undefined,
      signal,
    );
  }

  update(
    id: string,
    patch: { name?: string; config?: McpServerPatch; enabled?: boolean },
  ): Promise<Connector> {
    return this.#mutate(async (next) => {
      for (const plugin of next.plugins) {
        const owned = plugin.connectors.find((value) => value.id === id);
        if (!owned) continue;
        if (patch.name !== undefined || patch.config !== undefined)
          throw invalid(`Connector belongs to plugin "${plugin.id}"; only enabled can change`);
        owned.enabled = patch.enabled ?? owned.enabled;
        owned.config.enabled = owned.enabled;
        return {
          ...view(owned, engineName(plugin, owned.name)),
          pluginId: plugin.id,
          ...(missingInputs(plugin, owned.config).length > 0 && {
            missingInputs: missingInputs(plugin, owned.config),
          }),
        };
      }
      const item = next.connectors.find((value) => value.id === id);
      if (!item) throw invalid('Connector not found');
      if (patch.name !== undefined && patch.name !== item.name) {
        this.#checkName(next, patch.name, item.workspaceId, item.id);
        item.name = patch.name;
      }
      if (patch.config !== undefined) {
        const old = item.config;
        const config = patch.config;
        // 导入时留空的键：给了值或删掉就不再等（0.74.0）；又给成空串的继续等。
        if (item.pending !== undefined) {
          const touched = config.transport === 'stdio' ? config.env : config.headers;
          const pending = item.pending.filter((key) => {
            const value = touched?.[key];
            return value === undefined || value === '';
          });
          if (pending.length > 0) item.pending = pending;
          else delete item.pending;
        }
        const merged = { ...(old.transport === config.transport ? old : {}), ...config };
        if (config.transport === 'stdio')
          Object.assign(merged, {
            env: mergeSecrets(old.transport === 'stdio' ? old.env : undefined, config.env),
          });
        else
          Object.assign(merged, {
            headers: mergeSecrets(
              old.transport === 'http' ? old.headers : undefined,
              config.headers,
            ),
          });
        const parsed = McpServerConfigSchema.safeParse(merged);
        if (!parsed.success) throw invalid('Invalid connector configuration');
        item.config = parsed.data;
      }
      item.enabled = patch.enabled ?? patch.config?.enabled ?? item.enabled;
      item.config.enabled = item.enabled;
      return view(item);
    });
  }

  /**
   * 导入一个 skill 文件夹（0.74.0）：同 `skill.install` 复制进 Wevir 的 skills 目录，记下 `importedFrom`。已有同名的 skill 时不导入，
   * 返回 `exists`。
   */
  async importSkill(
    folder: string,
    importedFrom: ImportedFrom,
    signal?: AbortSignal,
  ): Promise<{ skill: Skill } | { exists: true }> {
    const result = await this.#mutate(
      async (next) => {
        const stage = await mkdtemp(join(this.dir, '.install-'));
        const published: string[] = [];
        try {
          const root = await stagePlugin(folder, join(stage, 'source'));
          const skills = await readSkills(root);
          const skill = skills[0];
          if (skills.length !== 1 || skill === undefined) throw invalid('Not a single skill');
          if ((await this.#skills(undefined, next)).some((item) => item.name === skill.name))
            return { exists: true as const, published };
          const item = await this.#publishSkill(skill, published, importedFrom);
          next.skills.push(item);
          return { skill: item, published };
        } catch (error) {
          for (const path of published) await rm(path, { recursive: true, force: true });
          throw error instanceof HostError
            ? error
            : invalid(error instanceof Error ? error.message : 'Skill import failed');
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      },
      async (result) => {
        for (const path of result.published) await rm(path, { recursive: true, force: true });
      },
      signal,
    );
    return 'exists' in result ? { exists: true } : { skill: result.skill };
  }

  /** 把暂存区里的一个 skill 复制进 Wevir 的 skills 目录；新目录记进 `published`（出错时由调用方删掉）。 */
  async #publishSkill(
    skill: Skill,
    published: string[],
    importedFrom?: ImportedFrom,
  ): Promise<Skill> {
    const encoded = encodeURIComponent(skill.name);
    const folderName =
      encoded.length <= 180 && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(encoded)
        ? encoded
        : `skill-${createHash('sha256').update(skill.name).digest('hex').slice(0, 24)}`;
    const folder = join(this.skillsRoot, folderName);
    try {
      await lstat(folder);
      throw invalid('A skill folder with this name already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    published.push(folder);
    await copyPlugin(dirname(skill.path), folder);
    return {
      ...skill,
      id: `skl_${randomUUID()}`,
      path: await realpath(join(folder, 'SKILL.md')),
      enabled: true,
      ...(importedFrom !== undefined && { importedFrom }),
    };
  }

  removeConnector(id: string): Promise<void> {
    return this.#mutate(async (next) => {
      const plugin = next.plugins.find((item) => item.connectors.some((c) => c.id === id));
      if (plugin)
        throw invalid(`Connector belongs to plugin "${plugin.id}"; remove the plugin instead`);
      if (!next.connectors.some((item) => item.id === id)) throw invalid('Connector not found');
      next.connectors = next.connectors.filter((item) => item.id !== id);
    });
  }

  setSkillEnabled(id: string, enabled: boolean): Promise<Skill> {
    return this.#mutate(async (next) => {
      const skill = (await this.#skills(undefined, next)).find((item) => item.id === id);
      if (!skill) throw invalid('Skill not found');
      const managed =
        next.skills.find((item) => item.id === id) ??
        next.plugins.flatMap((plugin) => plugin.skills).find((item) => item.id === id);
      if (managed) managed.enabled = enabled;
      else next.enabled[skill.path] = enabled;
      return { ...skill, enabled };
    });
  }

  removeSkill(id: string): Promise<void> {
    return this.#mutate(
      async (next) => {
        const plugin = next.plugins.find((item) => item.skills.some((value) => value.id === id));
        if (plugin)
          throw invalid(`Skill belongs to plugin "${plugin.id}"; remove the plugin instead`);
        const skill = next.skills.find((item) => item.id === id);
        if (!skill) throw invalid('Only Wevir-installed skills can be removed');
        const folder = dirname(skill.path);
        const trash = join(this.dir, `.removed-${randomUUID()}`);
        await rename(folder, trash);
        next.skills = next.skills.filter((item) => item.id !== id);
        return { folder, trash };
      },
      ({ folder, trash }) => rename(trash, folder),
    ).then(async ({ trash }) => {
      await rm(trash, { recursive: true, force: true });
    });
  }

  async install(path: string, signal?: AbortSignal): Promise<PluginsList> {
    await this.#mutate(
      async (next) => {
        const stage = await mkdtemp(join(this.dir, '.install-'));
        const published: string[] = [];
        try {
          const root = await stagePlugin(path, join(stage, 'source'));
          const bundle = { skills: await readSkills(root) };
          if (bundle.skills.length === 0) throw invalid('No skills found');
          const names = new Set((await this.#skills(undefined, next)).map((skill) => skill.name));
          for (const skill of bundle.skills) {
            if (names.has(skill.name)) throw invalid('A skill with this name already exists');
            names.add(skill.name);
            if (['.', '..'].includes(skill.name)) throw invalid('Invalid skill name');
          }
          for (const skill of bundle.skills)
            next.skills.push(await this.#publishSkill(skill, published));
          // #mutate 的 save 也在本事务里；出错时由 rollback 清理新目录。
          return { published };
        } catch (error) {
          for (const folder of published) await rm(folder, { recursive: true, force: true });
          throw error instanceof HostError
            ? error
            : invalid(error instanceof Error ? error.message : 'Plugin installation failed');
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      },
      async (result) => {
        for (const folder of result.published) await rm(folder, { recursive: true, force: true });
      },
      signal,
    );
    return this.list();
  }

  /**
   * 名字在“全局 ∪ 同一项目”里唯一（0.74.0）：项目的连接器不能与全局的或同一项目的重名，全局的不能与任何项目里的重名（会一起交给
   * 那个项目的会话）；不同项目之间可以重名。`self` 是改名的那一个。
   */
  #checkName(state: Registry, name: string, workspaceId?: string, self?: string): void {
    if (!ConnectorNameSchema.safeParse(name).success)
      throw invalid('Invalid or reserved connector name');
    if (
      state.connectors.some(
        (item) =>
          item.id !== self &&
          item.name === name &&
          (workspaceId === undefined ||
            item.workspaceId === undefined ||
            item.workspaceId === workspaceId),
      ) ||
      state.plugins.some((plugin) =>
        plugin.connectors.some((item) => engineName(plugin, item.name) === name),
      )
    )
      throw invalid('Connector name already exists');
  }

  #mutate<T>(
    op: (next: Registry) => Promise<T>,
    rollback?: (result: T) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<T> {
    const operation = this.#queue.then(async () => {
      signal?.throwIfAborted();
      const next = structuredClone(this.#state);
      const result = await op(next);
      try {
        signal?.throwIfAborted();
        await this.#save(next, signal);
      } catch (error) {
        await rollback?.(result);
        throw error;
      }
      this.#state = next;
      this.changed();
      try {
        await this.#adapter.reloadPlugins?.();
      } catch {
        this.#warning(
          'Plugin configuration saved; engine reload will retry before the next session or turn',
        );
      }
      return result;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #save(next: Registry, signal?: AbortSignal): Promise<void> {
    const temp = join(this.dir, `.registry-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      await rename(temp, join(this.dir, 'registry.json'));
    } finally {
      await rm(temp, { force: true });
    }
  }
}

/** 还在等用户填的键（0.74.0）：`pending` 里值仍是空串的。 */
function pendingKeys(item: StoredConnector): string[] {
  const values = item.config.transport === 'stdio' ? item.config.env : item.config.headers;
  return (item.pending ?? []).filter((key) => values?.[key] === '');
}
/** 交给引擎的散装连接器：键还没填完的不给。 */
function engineConnectors(items: readonly StoredConnector[]): EnginePluginConfig['connectors'] {
  return items
    .filter((item) => pendingKeys(item).length === 0)
    .map((item) => ({
      name: item.name,
      config: structuredClone(item.config),
      enabled: item.enabled,
    }));
}
function view(item: StoredConnector, name = item.name): Connector {
  const missing = item.pending === undefined ? [] : pendingKeys(item);
  const scope = {
    ...(missing.length > 0 && { missingInputs: missing }),
    ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
    ...(item.importedFrom !== undefined && { importedFrom: item.importedFrom }),
  };
  const config = structuredClone(item.config);
  if (config.transport === 'stdio') {
    const { env, ...rest } = config;
    return {
      id: item.id,
      name,
      enabled: item.enabled,
      ...scope,
      config: {
        ...rest,
        ...(env !== undefined && {
          env: Object.fromEntries(Object.keys(env).map((key) => [key, true as const])),
        }),
      },
    };
  }
  const { headers, ...rest } = config;
  return {
    id: item.id,
    name,
    enabled: item.enabled,
    ...scope,
    config: {
      ...rest,
      ...(headers !== undefined && {
        headers: Object.fromEntries(Object.keys(headers).map((key) => [key, true as const])),
      }),
    },
  };
}
function mergeSecrets(
  old: Record<string, string> | undefined,
  patch: Record<string, string | null> | undefined,
): Record<string, string> {
  const next = { ...old };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
function missingInputs(plugin: StoredPlugin, config: McpServerConfig): string[] {
  return inputRefs(config).filter(
    (key) =>
      plugin.values[key] === undefined &&
      plugin.inputs.some((input) => input.key === key && input.required),
  );
}
/** 只认清单声明的键；null 或空字符串清除。 */
function mergeInputs(
  plugin: { id: string; inputs: PluginInput[] },
  old: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...old };
  for (const [key, value] of Object.entries(patch)) {
    if (!plugin.inputs.some((input) => input.key === key))
      throw invalid(`Plugin "${plugin.id}" has no input "${key}"`);
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  return next;
}
function storedConnector(
  value: unknown,
  names: { safeParse(value: unknown): { success: boolean } },
): StoredConnector {
  const item = record(value);
  if (
    typeof item.id !== 'string' ||
    !names.safeParse(item.name).success ||
    typeof item.enabled !== 'boolean'
  )
    throw new Error('Invalid connector registry');
  if (
    (item.workspaceId !== undefined && !WorkspaceIdSchema.safeParse(item.workspaceId).success) ||
    (item.pending !== undefined &&
      (!Array.isArray(item.pending) || item.pending.some((key) => typeof key !== 'string')))
  )
    throw new Error('Invalid connector registry');
  return {
    id: item.id,
    name: item.name as string,
    enabled: item.enabled,
    config: McpServerConfigSchema.parse(item.config),
    ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId as string }),
    ...(item.importedFrom !== undefined && {
      importedFrom: ImportedFromSchema.parse(item.importedFrom),
    }),
    ...(item.pending !== undefined && { pending: item.pending as string[] }),
  };
}
function storedPlugin(value: unknown, packagesRoot: string): StoredPlugin {
  const item = record(value);
  const strings = (data: unknown) =>
    Object.values(record(data)).every((entry) => typeof entry === 'string');
  if (
    !PluginIdSchema.safeParse(item.id).success ||
    typeof item.name !== 'string' ||
    typeof item.version !== 'string' ||
    !['wevir', 'claude', 'codex'].includes(item.source as string) ||
    typeof item.enabled !== 'boolean' ||
    !Array.isArray(item.inputs) ||
    !Array.isArray(item.connectors) ||
    !Array.isArray(item.skills) ||
    !strings(item.values) ||
    (item.icon !== undefined && typeof item.icon !== 'string')
  )
    throw new Error('Invalid plugin registry');
  const id = item.id as string;
  const folder = join(packagesRoot, id);
  const skills = item.skills.map((skill) => SkillSchema.parse(skill));
  if (skills.some((skill) => skill.pluginId !== id || !contained(folder, skill.path)))
    throw new Error('Invalid plugin skill path');
  if (typeof item.icon === 'string' && !contained(folder, join(folder, item.icon)))
    throw new Error('Invalid plugin icon path');
  return {
    ...(item as unknown as StoredPlugin),
    inputs: item.inputs.map((input) => PluginInputSchema.parse(input)),
    values: record(item.values) as Record<string, string>,
    connectors: item.connectors.map((connector) =>
      storedConnector(connector, PluginConnectorNameSchema),
    ),
    skills,
  };
}
const invalid = (message: string) =>
  new HostError('INVALID_PARAMS', message, { issues: [{ path: [], message }] });
