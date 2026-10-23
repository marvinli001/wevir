import type { WevirClient } from '@wevir/client-sdk';
import {
  type MemoryNote,
  type MemoryScope,
  type MemorySummary,
  type MemoryType,
  MemoryTypeSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import { type Context, findWorkspace, requireFeature, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, table, truncate } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import { readStdin } from '../prompt.js';

// `wevir memory`（0.57.0，Host 功能 `memory`，domain-model §3.21）：Agent 跨会话记下的笔记。全局的对所有项目有效，`-w` 指向项目的。
// 笔记由 Agent 新建；用户能看、改、停用与删除。改与删带读到的版本，期间被别处改过就不写（`conflict`）。

export interface MemoryOptions {
  /** 项目的笔记（`-w <路径>`）；省略是全局的。 */
  workspace?: string;
  json?: boolean;
}

export function memoryOptions(workspace: string | undefined, json: boolean): MemoryOptions {
  return { ...(workspace !== undefined && { workspace }), json };
}

interface Target {
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
}

function withMemory<T>(
  ctx: Context,
  options: MemoryOptions,
  fn: (client: WevirClient, target: Target) => Promise<T>,
): Promise<T> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'memory');
    if (options.workspace === undefined) return fn(client, { scope: 'global' });
    const { workspaces } = await client.request('workspace.list');
    const workspace = await findWorkspace(ctx, workspaces, options.workspace);
    return fn(client, { scope: 'project', workspaceId: workspace.id });
  });
}

const scopeLabel = (scope: MemoryScope): string => t(`memory.scope.${scope}`);

export function memoryRow(note: MemorySummary): string[] {
  return [
    note.name,
    scopeLabel(note.scope),
    t(`memory.type.${note.type}`),
    note.enabled ? t('memory.enabled') : t('memory.disabled'),
    truncate(note.description, 50),
    formatTime(note.updatedAt),
  ];
}

/** `wevir memory list [-w <路径>] [--json]`：全局的；`-w` 时另加这个项目的。 */
export async function memoryList(ctx: Context, options: MemoryOptions): Promise<number> {
  return withMemory(ctx, options, async (client, target) => {
    const { notes, unreadable } = await client.request(
      'memory.list',
      target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId },
    );
    if (options.json) {
      ctx.print(JSON.stringify({ notes, unreadable }, null, 2));
      return EXIT.ok;
    }
    if (notes.length === 0 && unreadable.length === 0) {
      ctx.print(t('memory.none'));
      return EXIT.ok;
    }
    if (notes.length > 0) {
      ctx.print(
        table(
          [
            t('memory.col.name'),
            t('memory.col.scope'),
            t('memory.col.type'),
            t('memory.col.state'),
            t('memory.col.description'),
            t('memory.col.updated'),
          ],
          notes.map(memoryRow),
        ),
      );
    }
    for (const item of unreadable) {
      ctx.print(
        ctx.styles.yellow(
          t('memory.unreadable', { name: item.name, scope: scopeLabel(item.scope) }),
        ),
      );
    }
    return EXIT.ok;
  });
}

async function read(client: WevirClient, target: Target, name: string): Promise<MemoryNote> {
  const { note } = await client.request('memory.read', { ...target, name });
  return note;
}

/** `wevir memory show <名称> [-w <路径>] [--json]`。 */
export async function memoryShow(
  ctx: Context,
  name: string,
  options: MemoryOptions,
): Promise<number> {
  return withMemory(ctx, options, async (client, target) => {
    const note = await read(client, target, name);
    if (options.json) {
      ctx.print(JSON.stringify(note, null, 2));
      return EXIT.ok;
    }
    const state = note.enabled ? t('memory.enabled') : t('memory.disabled');
    ctx.print(
      ctx.styles.bold(
        `${note.name}  ${ctx.styles.dim(`${t(`memory.type.${note.type}`)} · ${state}`)}`,
      ),
    );
    ctx.print(note.description);
    ctx.print(ctx.styles.dim(t('memory.updated', { time: formatTime(note.updatedAt) })));
    ctx.print();
    ctx.print(note.content);
    return EXIT.ok;
  });
}

export interface MemoryEditFlags extends MemoryOptions {
  description?: string;
  type?: string;
  content?: string;
  /** 正文从 stdin 读到结束。 */
  stdin?: boolean;
}

/** `wevir memory edit <名称> [--description …] [--type …] [--content … | --stdin] [-w <路径>]`。 */
export async function memoryEdit(
  ctx: Context,
  name: string,
  flags: MemoryEditFlags,
): Promise<number> {
  if (flags.content !== undefined && flags.stdin) throw new UsageError(t('memory.contentConflict'));
  let type: MemoryType | undefined;
  if (flags.type !== undefined) {
    const parsed = MemoryTypeSchema.safeParse(flags.type);
    if (!parsed.success) {
      throw new UsageError(
        t('memory.badType', { type: flags.type }),
        t('memory.badType.hint', { types: joinList(MemoryTypeSchema.options) }),
      );
    }
    type = parsed.data;
  }
  const content = flags.stdin ? await readStdin(ctx.io) : flags.content;
  if (flags.description === undefined && type === undefined && content === undefined) {
    throw new UsageError(
      t('memory.nothingToEdit'),
      t('usage.seeCommandHelp', { command: 'memory edit' }),
    );
  }
  return withMemory(ctx, flags, async (client, target) => {
    const current = await read(client, target, name);
    const { note, conflict } = await client.request('memory.update', {
      ...target,
      name,
      revision: current.revision,
      ...(type !== undefined && { type }),
      ...(flags.description !== undefined && { description: flags.description }),
      ...(content !== undefined && { content }),
    });
    if (conflict) throw new CliError(t('memory.conflict', { name }), t('memory.conflict.hint'));
    ctx.print(t('memory.saved', { name: note.name }));
    return EXIT.ok;
  });
}

/** `wevir memory enable|disable <名称> [-w <路径>]`：停用的笔记 Agent 看不到。 */
export async function memorySetEnabled(
  ctx: Context,
  name: string,
  enabled: boolean,
  options: MemoryOptions,
): Promise<number> {
  return withMemory(ctx, options, async (client, target) => {
    await client.request('memory.setEnabled', { ...target, name, enabled });
    ctx.print(t(enabled ? 'memory.turnedOn' : 'memory.turnedOff', { name }));
    return EXIT.ok;
  });
}

/** `wevir memory delete <名称> [-w <路径>]`：读不出来的文件不带版本删。 */
export async function memoryDelete(
  ctx: Context,
  name: string,
  options: MemoryOptions,
): Promise<number> {
  return withMemory(ctx, options, async (client, target) => {
    const { unreadable } = await client.request(
      'memory.list',
      target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId },
    );
    const broken = unreadable.some((item) => item.name === name && item.scope === target.scope);
    const revision = broken ? undefined : (await read(client, target, name)).revision;
    const { conflict } = await client.request('memory.delete', {
      ...target,
      name,
      ...(revision !== undefined && { revision }),
    });
    if (conflict) throw new CliError(t('memory.conflict', { name }), t('memory.conflict.hint'));
    ctx.print(t('memory.deleted', { name }));
    return EXIT.ok;
  });
}
