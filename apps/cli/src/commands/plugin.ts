import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WevirClient } from '@wevir/client-sdk';
import type { McpServerConfig, PluginsList } from '@wevir/protocol';
import { type Context, findWorkspace, requireFeature, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { table, truncate } from '../format.js';
import { t } from '../i18n/index.js';

// `wevir plugin`（0.41.0 连接器与 skills，0.42.0 插件包）：Host 的插件、Skills 与连接器（MCP 服务器）。三者的 ID 互不相同，
// `enable` / `disable` / `remove` 按 ID 找是哪一种。`wevir mcp add` 加一个连接器。

type Item =
  | { kind: 'plugin'; id: string; name: string }
  | { kind: 'skill'; id: string; name: string }
  | { kind: 'connector'; id: string; name: string };

function withPlugins<T>(ctx: Context, fn: (client: WevirClient) => Promise<T>): Promise<T> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'plugins');
    return fn(client);
  });
}

function find(list: PluginsList, id: string): Item {
  const plugin = list.plugins?.find((p) => p.id === id);
  if (plugin) return { kind: 'plugin', id, name: plugin.name };
  const skill = list.skills.find((s) => s.id === id);
  if (skill) return { kind: 'skill', id, name: skill.name };
  const connector = list.connectors.find((c) => c.id === id);
  if (connector) return { kind: 'connector', id, name: connector.name };
  throw new CliError(t('plugin.notFound', { id }), t('plugin.notFound.hint'));
}

const onOff = (enabled: boolean): string => (enabled ? t('plugin.enabled') : t('plugin.disabled'));

/** `wevir plugin list [--json]`：插件、Skills 与连接器三张表。 */
export async function pluginList(ctx: Context, options: { json?: boolean }): Promise<number> {
  return withPlugins(ctx, async (client) => {
    const list = await client.request('plugins.list', {});
    if (options.json) {
      ctx.print(JSON.stringify(list, null, 2));
      return EXIT.ok;
    }
    const plugins = list.plugins ?? [];
    if (plugins.length + list.skills.length + list.connectors.length === 0) {
      ctx.print(t('plugin.none'));
      return EXIT.ok;
    }
    const section = (title: string, headers: string[], rows: string[][]) => {
      if (rows.length === 0) return;
      ctx.print(ctx.styles.bold(title));
      ctx.print(table(headers, rows));
      ctx.print();
    };
    section(
      t('plugin.section.plugins'),
      [
        'ID',
        t('plugin.col.name'),
        t('plugin.col.version'),
        t('plugin.col.state'),
        t('plugin.col.contents'),
      ],
      plugins.map((p) => [
        p.id,
        p.name,
        p.version,
        onOff(p.enabled),
        t('plugin.contents', { skills: p.skills.length, connectors: p.connectors.length }),
      ]),
    );
    section(
      t('plugin.section.skills'),
      [
        'ID',
        t('plugin.col.name'),
        t('plugin.col.source'),
        t('plugin.col.state'),
        t('plugin.col.description'),
      ],
      list.skills.map((s) => [
        s.id,
        s.name,
        s.pluginId ?? (s.builtin ? t('plugin.source.builtin') : t(`plugin.source.${s.source}`)),
        onOff(s.enabled),
        truncate(s.shortDescription ?? s.description, 48),
      ]),
    );
    section(
      t('plugin.section.connectors'),
      [
        'ID',
        t('plugin.col.name'),
        t('plugin.col.transport'),
        t('plugin.col.state'),
        t('plugin.col.tools'),
      ],
      list.connectors.map((c) => [
        c.id,
        c.name,
        c.config.transport,
        c.status === undefined ? onOff(c.enabled) : `${onOff(c.enabled)} · ${c.status}`,
        c.tools === undefined ? '-' : String(c.tools.length),
      ]),
    );
    return EXIT.ok;
  });
}

/** `wevir plugin enable|disable <ID>`：插件、Skill 或连接器。 */
export async function pluginSetEnabled(
  ctx: Context,
  id: string,
  enabled: boolean,
): Promise<number> {
  return withPlugins(ctx, async (client) => {
    const item = find(await client.request('plugins.list', {}), id);
    if (item.kind === 'plugin') await client.request('plugin.setEnabled', { id, enabled });
    else if (item.kind === 'skill') await client.request('skill.setEnabled', { id, enabled });
    else await client.request('connector.setEnabled', { id, enabled });
    ctx.print(t(enabled ? 'plugin.turnedOn' : 'plugin.turnedOff', { name: item.name }));
    return EXIT.ok;
  });
}

/** `wevir plugin remove <ID>`：插件连同它带的 Skills 与连接器一起删。 */
export async function pluginRemove(ctx: Context, id: string): Promise<number> {
  return withPlugins(ctx, async (client) => {
    const item = find(await client.request('plugins.list', {}), id);
    if (item.kind === 'plugin') await client.request('plugin.remove', { id });
    else if (item.kind === 'skill') await client.request('skill.remove', { id });
    else await client.request('connector.remove', { id });
    ctx.print(t('plugin.removed', { name: item.name }));
    return EXIT.ok;
  });
}

/**
 * `wevir plugin install <路径>`：目录里有 `wevir-plugin.json`（或 Claude / Codex 的插件清单）时装成插件，有 `SKILL.md` 时装成
 * Skill。路径在 Host 那台电脑上，所以不能 `--remote`。
 */
export async function pluginInstall(ctx: Context, path: string): Promise<number> {
  const dir = resolve(ctx.io.cwd, path);
  const isSkill = existsSync(join(dir, 'SKILL.md')) && !existsSync(join(dir, 'wevir-plugin.json'));
  return withPlugins(ctx, async (client) => {
    if (isSkill) {
      // Host 把 Skill 复制进自己的目录：按安装前后的差别找到新装的那个。
      const before = new Set((await client.request('plugins.list', {})).skills.map((s) => s.id));
      const { skills } = await client.request('skill.install', { path: dir });
      const added = skills.filter((s) => !before.has(s.id));
      for (const skill of added) ctx.print(t('plugin.installedSkill', { name: skill.name }));
      if (added.length === 0) ctx.print(t('plugin.installedSkill', { name: path }));
      return EXIT.ok;
    }
    requireFeature(client, 'plugin_packages');
    const { plugin, ignored } = await client.request('plugin.install', { path: dir });
    ctx.print(t('plugin.installed', { name: plugin.name, version: plugin.version, id: plugin.id }));
    for (const item of ignored) ctx.print(ctx.styles.dim(`  ${t('plugin.ignored', { item })}`));
    const missing = plugin.inputs.filter((input) => input.required && !input.set);
    if (missing.length > 0) {
      ctx.print(ctx.styles.yellow(t('plugin.missingInputs', { count: missing.length })));
    }
    return EXIT.ok;
  });
}

export interface McpAddFlags {
  url?: string;
  workspace?: string;
  disabled?: boolean;
}

/**
 * `wevir mcp add <名称> --url <地址>` 或 `wevir mcp add <名称> -- <命令> [参数…]`：加一个连接器（MCP 服务器），全局的或 `-w` 指向
 * 的项目的。
 */
export async function mcpAdd(
  ctx: Context,
  name: string,
  command: string[],
  flags: McpAddFlags,
): Promise<number> {
  if ((flags.url === undefined) === (command.length === 0)) {
    throw new UsageError(t('mcp.needOne'), t('usage.seeCommandHelp', { command: 'mcp add' }));
  }
  const config: McpServerConfig =
    flags.url !== undefined
      ? { transport: 'http', url: flags.url }
      : {
          transport: 'stdio',
          command: command[0] as string,
          ...(command.length > 1 && { args: command.slice(1) }),
        };
  return withPlugins(ctx, async (client) => {
    let workspaceId: string | undefined;
    if (flags.workspace !== undefined) {
      const { workspaces } = await client.request('workspace.list');
      workspaceId = (await findWorkspace(ctx, workspaces, flags.workspace)).id;
    }
    const { connector } = await client.request('connector.add', {
      name,
      config,
      ...(flags.disabled && { enabled: false }),
      ...(workspaceId !== undefined && { workspaceId }),
    });
    ctx.print(t('mcp.added', { name: connector.name, id: connector.id }));
    return EXIT.ok;
  });
}
