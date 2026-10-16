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
import { dirname, join, resolve } from 'node:path';
import {
  type Connector,
  ConnectorNameSchema,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpServerPatch,
  type PluginsList,
  type Skill,
  SkillSchema,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter, EnginePluginConfig } from '@wevir/runtime-adapter';
import { HostError } from './errors.js';
import { contained, copyPlugin, readPackage, stagePlugin } from './plugin-install.js';
import { record, scanSkills } from './plugin-skills.js';

interface StoredConnector {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
}
interface Registry {
  connectors: StoredConnector[];
  skills: Skill[];
  enabled: Record<string, boolean>;
}

/** 全局注册表。JSON 只在 Host 内读写；所有返回值经 view 脱敏。 */
export class PluginRegistry {
  #dir: string;
  #skillsRoot: string;
  get dir(): string {
    return this.#dir;
  }
  get skillsRoot(): string {
    return this.#skillsRoot;
  }
  readonly #roots: () => string[];
  readonly #userHome: string;
  readonly #adapter: AgentRuntimeAdapter;
  readonly #warning: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  #state: Registry = { connectors: [], skills: [], enabled: {} };
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
    this.#roots = options.roots;
    this.#adapter = options.adapter;
    this.#userHome = options.userHome ?? homedir();
    this.#warning = options.onWarning ?? (() => {});
  }

  async load(): Promise<void> {
    await mkdir(this.skillsRoot, { recursive: true, mode: 0o700 });
    this.#dir = await realpath(this.dir);
    this.#skillsRoot = await realpath(this.skillsRoot);
    await chmod(this.dir, 0o700);
    await chmod(this.skillsRoot, 0o700);
    try {
      const raw = record(JSON.parse(await readFile(join(this.dir, 'registry.json'), 'utf8')));
      if (!Array.isArray(raw.connectors) || !Array.isArray(raw.skills))
        throw new Error('Invalid plugin registry');
      const connectors = raw.connectors.map((value) => {
        const item = record(value);
        if (
          typeof item.id !== 'string' ||
          !ConnectorNameSchema.safeParse(item.name).success ||
          typeof item.enabled !== 'boolean'
        )
          throw new Error('Invalid connector registry');
        return {
          id: item.id,
          name: item.name as string,
          enabled: item.enabled,
          config: McpServerConfigSchema.parse(item.config),
        };
      });
      const skills = raw.skills.map((value) => SkillSchema.parse(value));
      if (
        skills.some((skill) => skill.source !== 'wevir' || !contained(this.skillsRoot, skill.path))
      )
        throw new Error('Invalid managed skill path');
      const enabled = record(raw.enabled);
      if (Object.values(enabled).some((value) => typeof value !== 'boolean'))
        throw new Error('Invalid skill enablement');
      this.#state = { connectors, skills, enabled: enabled as Record<string, boolean> };
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

  async #skills(cwd?: string): Promise<Skill[]> {
    const items = new Map(this.#state.skills.map((skill) => [skill.path, { ...skill }]));
    const roots = new Map<string, Skill['source']>([
      [join(this.#userHome, '.agents', 'skills'), 'user'],
    ]);
    for (const project of [...this.#roots(), ...(cwd === undefined ? [] : [cwd])]) {
      let dir = resolve(project);
      for (;;) {
        if (!roots.has(join(dir, '.agents', 'skills')))
          roots.set(join(dir, '.agents', 'skills'), 'project');
        roots.set(join(dir, '.codex', 'skills'), 'project');
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
            enabled: this.#state.enabled[skill.path] === true,
          });
      }
    }
    return [...items.values()];
  }

  async engineConfig(cwd?: string): Promise<EnginePluginConfig> {
    return {
      skillsRoot: this.skillsRoot,
      connectors: structuredClone(this.#state.connectors),
      skills: (await this.#skills(cwd)).map(({ name, path, enabled }) => ({ name, path, enabled })),
    };
  }

  async list(): Promise<PluginsList> {
    const connectors = this.#state.connectors.map(view);
    const skills = await this.#skills();
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
    return { connectors, skills };
  }

  add(name: string, config: McpServerConfig, enabled?: boolean): Promise<Connector> {
    return this.#mutate(async (next) => {
      this.#checkName(next, name);
      const parsed = McpServerConfigSchema.safeParse(config);
      if (!parsed.success) throw invalid('Invalid connector configuration');
      const item = {
        id: `con_${randomUUID()}`,
        name,
        config: { ...parsed.data, enabled: enabled ?? config.enabled ?? true },
        enabled: enabled ?? config.enabled ?? true,
      };
      next.connectors.push(item);
      return view(item);
    });
  }

  update(
    id: string,
    patch: { name?: string; config?: McpServerPatch; enabled?: boolean },
  ): Promise<Connector> {
    return this.#mutate(async (next) => {
      const item = next.connectors.find((value) => value.id === id);
      if (!item) throw invalid('Connector not found');
      if (patch.name !== undefined && patch.name !== item.name) {
        this.#checkName(next, patch.name);
        item.name = patch.name;
      }
      if (patch.config !== undefined) {
        const old = item.config;
        const config = patch.config;
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

  removeConnector(id: string): Promise<void> {
    return this.#mutate(async (next) => {
      if (!next.connectors.some((item) => item.id === id)) throw invalid('Connector not found');
      next.connectors = next.connectors.filter((item) => item.id !== id);
    });
  }

  setSkillEnabled(id: string, enabled: boolean): Promise<Skill> {
    return this.#mutate(async (next) => {
      const skill = (await this.#skills()).find((item) => item.id === id);
      if (!skill) throw invalid('Skill not found');
      const managed = next.skills.find((item) => item.id === id);
      if (managed) managed.enabled = enabled;
      else next.enabled[skill.path] = enabled;
      return { ...skill, enabled };
    });
  }

  removeSkill(id: string): Promise<void> {
    return this.#mutate(
      async (next) => {
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

  async install(path: string): Promise<PluginsList> {
    await this.#mutate(
      async (next) => {
        const stage = await mkdtemp(join(this.dir, '.install-'));
        const published: string[] = [];
        try {
          const root = await stagePlugin(path, join(stage, 'source'));
          const bundle = await readPackage(root);
          if (bundle.skills.length === 0 && bundle.connectors.length === 0)
            throw invalid('No skills or connectors found');
          const names = new Set((await this.#skills()).map((skill) => skill.name));
          for (const skill of bundle.skills) {
            if (names.has(skill.name)) throw invalid('A skill with this name already exists');
            names.add(skill.name);
            if (['.', '..'].includes(skill.name)) throw invalid('Invalid skill name');
          }
          for (const item of bundle.connectors) {
            this.#checkName(next, item.name);
            next.connectors.push({
              ...item,
              id: `con_${randomUUID()}`,
              enabled: item.config.enabled ?? true,
            });
          }
          for (const skill of bundle.skills) {
            const encoded = encodeURIComponent(skill.name);
            const folderName =
              encoded.length <= 180 &&
              !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(encoded)
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
            next.skills.push({
              ...skill,
              id: `skl_${randomUUID()}`,
              path: await realpath(join(folder, 'SKILL.md')),
              enabled: true,
            });
          }
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
    );
    return this.list();
  }

  #checkName(state: Registry, name: string): void {
    if (!ConnectorNameSchema.safeParse(name).success)
      throw invalid('Invalid or reserved connector name');
    if (state.connectors.some((item) => item.name === name))
      throw invalid('Connector name already exists');
  }

  #mutate<T>(
    op: (next: Registry) => Promise<T>,
    rollback?: (result: T) => Promise<void>,
  ): Promise<T> {
    const operation = this.#queue.then(async () => {
      const next = structuredClone(this.#state);
      const result = await op(next);
      try {
        await this.#save(next);
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

  async #save(next: Registry): Promise<void> {
    const temp = join(this.dir, `.registry-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, join(this.dir, 'registry.json'));
    } finally {
      await rm(temp, { force: true });
    }
  }
}

function view(item: StoredConnector): Connector {
  const config = structuredClone(item.config);
  if (config.transport === 'stdio') {
    const { env, ...rest } = config;
    return {
      id: item.id,
      name: item.name,
      enabled: item.enabled,
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
    name: item.name,
    enabled: item.enabled,
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
const invalid = (message: string) =>
  new HostError('INVALID_PARAMS', message, { issues: [{ path: [], message }] });
