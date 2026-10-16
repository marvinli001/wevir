// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 导入部分改写自 openai/codex codex-rs/core-plugins/src/manifest.rs（清单字段、默认 ./skills、./ 路径规则）与
// codex-rs/codex-mcp/src/agent_plugin_config.rs（`${PLUGIN_ROOT}` 指向插件目录），提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。
// 修改：TypeScript；读 Wevir 自己的 wevir-plugin.json（0.42.0），把 Codex / Claude 包转成 Wevir 插件：只取 skills 与 MCP，
// `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 换成 `${pluginDir}`，其余部分列为已忽略；不执行 hooks / 安装脚本。
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type McpServerConfig,
  McpServerConfigSchema,
  PLUGIN_DIR_PLACEHOLDER,
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_INPUT_PATTERN,
  PluginConnectorNameSchema,
  PluginIdSchema,
  type PluginInput,
  type Skill,
  WEVIR_PLUGIN_MANIFEST,
  WevirPluginManifestSchema,
} from '@wevir/protocol';
import { member, readManifest, readMcpServers } from './plugin-install.js';
import { record, scanSkills } from './plugin-skills.js';

export interface PluginPackage {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; url?: string };
  homepage?: string;
  /** 包内相对路径（`./…`），已检查存在、格式与大小。 */
  icon?: string;
  source: 'wevir' | 'claude' | 'codex';
  inputs: PluginInput[];
  connectors: Array<{ name: string; config: McpServerConfig }>;
  skills: Skill[];
  ignored: string[];
}

/** 导入时照收的清单字段：元数据与 skills / MCP；别的都报为已忽略。 */
const IMPORTED_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'interface',
  'skills',
  'mcpServers',
]);
/** Claude 包按约定放在根目录、不写进清单的部分。 */
const CONVENTION_DIRS = ['commands', 'agents', 'hooks', 'output-styles'];

const refs = (value: string) => [...value.matchAll(PLUGIN_INPUT_PATTERN)].map((match) => match[1]);

/** 连接器里引用的全部输入项。 */
export function inputRefs(config: McpServerConfig): string[] {
  const values =
    config.transport === 'stdio'
      ? [...(config.args ?? []), ...Object.values(config.env ?? {})]
      : [config.url, ...Object.values(config.headers ?? {})];
  return [...new Set(values.flatMap(refs))] as string[];
}

/** 占位符只能出现在规定的字段：`${input:…}` 在 args、env、headers、url，`${pluginDir}` 在 stdio 的 command、args、cwd、env。 */
function checkPlaceholders(name: string, config: McpServerConfig, keys: Set<string>): void {
  if (config.transport === 'stdio') {
    if (refs(config.command).length > 0 || refs(config.cwd ?? '').length > 0)
      throw new Error(`Connector "${name}": inputs can only be used in args, env, headers and url`);
  } else if (
    [config.url, ...Object.values(config.headers ?? {})].some((value) =>
      value.includes(PLUGIN_DIR_PLACEHOLDER),
    )
  )
    throw new Error(`Connector "${name}": \${pluginDir} is only available to stdio connectors`);
  for (const key of inputRefs(config))
    if (!keys.has(key)) throw new Error(`Connector "${name}" uses undeclared input "${key}"`);
}

/** 交给引擎前展开占位符；没填的输入项展开成空字符串（必填项缺失的连接器调用方先排除）。 */
export function expandConnector(
  config: McpServerConfig,
  values: Record<string, string>,
  pluginDir: string,
): McpServerConfig {
  const input = (value: string) =>
    value.replace(PLUGIN_INPUT_PATTERN, (_match, key: string) => values[key] ?? '');
  const dir = (value: string) => value.replaceAll(PLUGIN_DIR_PLACEHOLDER, pluginDir);
  const map = (items: Record<string, string> | undefined, fn: (value: string) => string) =>
    items && Object.fromEntries(Object.entries(items).map(([key, value]) => [key, fn(value)]));
  if (config.transport === 'stdio')
    return {
      ...config,
      command: dir(config.command),
      ...(config.args && { args: config.args.map((value) => dir(input(value))) }),
      ...(config.cwd !== undefined && { cwd: dir(config.cwd) }),
      ...(config.env && { env: map(config.env, (value) => dir(input(value))) }),
    };
  return {
    ...config,
    url: input(config.url),
    ...(config.headers && { headers: map(config.headers, input) }),
  };
}

function issue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const first = error.issues[0];
  return `Invalid ${WEVIR_PLUGIN_MANIFEST}${first?.path.length ? ` at ${first.path.join('.')}` : '`}: ${first?.message ?? `invalid'}`;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new Error(`Invalid JSON: ${file.split(/[\\/]/).at(-1)}`);
  }
}

async function readWevir(root: string, raw: unknown): Promise<PluginPackage> {
  const parsed = WevirPluginManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(issue(parsed.error));
  const manifest = parsed.data;
  const inputs = manifest.inputs ?? [];
  const keys = new Set(inputs.map((item) => item.key));
  let servers: Record<string, McpServerConfig> = {};
  if (typeof manifest.connectors === 'string') {
    const file = member(root, manifest.connectors);
    let data: unknown;
    try {
      data = await readJson(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`Connector file not found: ${manifest.connectors}`);
      throw error;
    }
    const entries = Object.entries(record(data));
    if (entries.length === 0 && (data === null || typeof data !== 'object' || Array.isArray(data)))
      throw new Error(`Invalid connector file: ${manifest.connectors}`);
    for (const [name, value] of entries) {
      const config = McpServerConfigSchema.safeParse(value);
      if (!PluginConnectorNameSchema.safeParse(name).success || !config.success)
        throw new Error(`Invalid connector "${name}" in ${manifest.connectors}`);
      servers[name] = config.data;
    }
  } else if (manifest.connectors) servers = manifest.connectors;
  const connectors = Object.entries(servers).map(([name, config]) => {
    checkPlaceholders(name, config, keys);
    return { name, config };
  });
  if (manifest.icon !== undefined) await checkIcon(root, manifest.icon);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined && { description: manifest.description }),
    ...(manifest.author && { author: manifest.author }),
    ...(manifest.homepage !== undefined && { homepage: manifest.homepage }),
    ...(manifest.icon !== undefined && { icon: manifest.icon }),
    source: 'wevir',
    inputs,
    connectors,
    skills: await scanSkills(member(root, manifest.skills ?? './skills'), 'wevir', true),
    ignored: [],
  };
}

async function checkIcon(root: string, path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(member(root, path));
  } catch {
    throw new Error(`Plugin icon not found: ${path}`);
  }
  if (!info.isFile()) throw new Error(`Plugin icon must be a file: ${path}`);
  if (info.size > PLUGIN_ICON_MAX_BYTES) throw new Error('Plugin icon exceeds 128 KiB');
}

const httpUrl = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
};
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** Claude / Codex 包转成 Wevir 插件。 */
async function readImported(
  root: string,
  format: 'claude' | 'codex',
  manifest: Record<string, unknown>,
): Promise<PluginPackage> {
  const raw = manifest.name as string;
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  if (!PluginIdSchema.safeParse(id).success)
    throw new Error(`Plugin name "${raw}" cannot be used as a Wevir plugin id`);
  const ui = record(manifest.interface);
  const author = record(manifest.author);
  const authorName = text(author.name, 128) ?? text(ui.developerName, 128);
  const authorUrl = httpUrl(author.url);
  const homepage = httpUrl(manifest.homepage) ?? httpUrl(ui.websiteUrl ?? ui.websiteURL);
  const description = text(manifest.description, 1024) ?? text(ui.shortDescription, 1024);
  let icon: string | undefined;
  if (typeof ui.logo === 'string' && /^\.\/.*\.(?:png|svg)$/.test(ui.logo)) {
    try {
      await checkIcon(root, ui.logo);
      icon = ui.logo;
    } catch {}
  }
  const variable = format === 'claude' ? `\${CLAUDE_PLUGIN_ROOT}` : `\${PLUGIN_ROOT}`;
  const swap = (value: string) => value.replaceAll(variable, PLUGIN_DIR_PLACEHOLDER);
  const connectors = (await readMcpServers(root, manifest, PluginConnectorNameSchema)).map(
    ({ name, config }) => {
      if (config.transport === 'stdio') {
        config = {
          ...config,
          command: swap(config.command),
          ...(config.args && { args: config.args.map(swap) }),
          ...(config.cwd !== undefined && { cwd: swap(config.cwd) }),
          ...(config.env && {
            env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, swap(v)])),
          }),
        };
      }
      // 导入的包没有 inputs：`${input:…}` 一律算未声明。
      checkPlaceholders(name, config, new Set());
      return { name, config };
    },
  );
  const paths =
    manifest.skills === undefined
      ? ['./skills']
      : Array.isArray(manifest.skills)
        ? manifest.skills
        : [manifest.skills];
  const skills: Skill[] = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path.startsWith('./'))
      throw new Error('Plugin paths must start with ./');
    skills.push(...(await scanSkills(member(root, path), 'wevir', true)));
  }
  const ignored = Object.keys(manifest).filter((key) => !IMPORTED_FIELDS.has(key));
  for (const dir of CONVENTION_DIRS) {
    if (ignored.includes(dir)) continue;
    try {
      if ((await lstat(join(root, dir))).isDirectory()) ignored.push(dir);
    } catch {}
  }
  return {
    id,
    name: text(ui.displayName, 128) ?? raw.trim().slice(0, 128),
    version: text(manifest.version, 128) ?? '0.0.0',
    ...(description !== undefined && { description }),
    ...(authorName !== undefined && {
      author: { name: authorName, ...(authorUrl !== undefined && { url: authorUrl }) },
    }),
    ...(homepage !== undefined && { homepage }),
    ...(icon !== undefined && { icon }),
    source: format,
    inputs: [],
    connectors,
    skills,
    ignored: ignored.sort(),
  };
}

/** 读暂存好的包：wevir-plugin.json 优先，其次 .codex-plugin / .claude-plugin。 */
export async function readPluginPackage(root: string): Promise<PluginPackage> {
  let raw: unknown;
  try {
    raw = await readJson(join(root, WEVIR_PLUGIN_MANIFEST));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pkg =
    raw !== undefined
      ? await readWevir(root, raw)
      : await (async () => {
          const found = await readManifest(root);
          if (!found)
            throw new Error(
              `Not a plugin package: ${WEVIR_PLUGIN_MANIFEST}, .codex-plugin/plugin.json or .claude-plugin/plugin.json is required`,
            );
          return readImported(root, found.format, found.manifest);
        })();
  const names = new Set<string>();
  for (const skill of pkg.skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate skill "${skill.name}" in the plugin`);
    names.add(skill.name);
  }
  if (pkg.skills.length === 0 && pkg.connectors.length === 0)
    throw new Error('No skills or connectors found');
  return pkg;
}
