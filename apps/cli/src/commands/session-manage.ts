import type { WevirClient } from '@wevir/client-sdk';
import type { MethodParams, Session, SessionId, TurnId } from '@wevir/protocol';
import { type Context, requireFeature, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import {
  filesRestoreLabel,
  formatTime,
  permissionLabel,
  stateLabel,
  table,
  truncate,
} from '../format.js';
import { t } from '../i18n/index.js';
import { parsePermission } from './automation.js';
import { resolveSessionId } from './session.js';

// 会话的管理命令（不进入 attach）：详情、改名、归档、删除、分支、撤销 / 重做、换模型与权限、取消、关闭、压缩。都是 Host 已有的
// `session.*` 方法；会话 ID 可用唯一前缀（含已归档的）。

export interface JsonOption {
  json?: boolean;
}

function withSession<T>(
  ctx: Context,
  id: string,
  fn: (client: WevirClient, sessionId: SessionId) => Promise<T>,
): Promise<T> {
  return withClient(ctx, async (client) => fn(client, await resolveSessionId(client, id)));
}

const goalText = (session: Session): string =>
  session.goal === undefined
    ? '-'
    : t('session.goalText', {
        status: t(`goalStatus.${session.goal.status}`),
        objective: truncate(session.goal.objective, 60),
      });

/** `wevir session show <会话 ID> [--json]`：设置、目标、待处理的事与任务清单。`--json` 是整个快照。 */
export async function sessionShow(ctx: Context, id: string, options: JsonOption): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    const snapshot = await client.request('session.get', { sessionId });
    if (options.json) {
      ctx.print(JSON.stringify(snapshot, null, 2));
      return EXIT.ok;
    }
    const { session } = snapshot;
    const { workspaces } = await client.request('workspace.list');
    const workspace = workspaces.find((w) => w.id === session.workspaceId);
    const state = session.readOnly ? t('state.readOnly') : stateLabel(session.state);
    const pending = [
      session.pendingApprovalCount === undefined
        ? undefined
        : t('session.pendingApprovals', { count: session.pendingApprovalCount }),
      session.pendingQuestionCount === undefined
        ? undefined
        : t('session.pendingQuestions', { count: session.pendingQuestionCount }),
    ].filter((item): item is string => item !== undefined);
    const rows: Array<[string, string]> = [
      [t('session.field.state'), state],
      [t('session.field.workspace'), workspace?.displayName ?? session.workspaceId],
      [t('session.field.cwd'), session.cwd],
      [t('session.field.model'), `${session.providerId}/${session.modelId}`],
      [t('session.field.effort'), session.reasoningEffort ?? t('attach.effortDefault')],
      [t('session.field.permission'), permissionLabel(session.permissionMode ?? 'on_request')],
      ...(session.collaborationMode === 'plan'
        ? [[t('session.field.mode'), t('session.planMode')] as [string, string]]
        : []),
      [t('session.field.goal'), goalText(session)],
      [t('session.field.pending'), pending.length === 0 ? '-' : pending.join(t('list.separator'))],
      ...(session.parentSessionId === undefined
        ? []
        : [[t('session.field.parent'), session.parentSessionId] as [string, string]]),
      [t('session.field.created'), formatTime(session.createdAt)],
      [t('session.field.updated'), formatTime(session.updatedAt)],
      ...(session.archivedAt === undefined
        ? []
        : [[t('session.field.archived'), formatTime(session.archivedAt)] as [string, string]]),
      [t('session.field.events'), String(session.lastSeq)],
    ];
    ctx.print(
      ctx.styles.bold(`${session.title || t('session.untitled')}  ${ctx.styles.dim(session.id)}`),
    );
    ctx.print(table(['', ''], rows).split('\n').slice(1).join('\n'));
    const todos = snapshot.todos ?? [];
    if (todos.length > 0) {
      ctx.print();
      ctx.print(ctx.styles.bold(t('session.todos')));
      for (const item of todos) {
        const mark = item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐';
        ctx.print(`  ${mark} ${item.content}`);
      }
    }
    return EXIT.ok;
  });
}

/** `wevir session rename <会话 ID> <标题>`。 */
export async function sessionRename(ctx: Context, id: string, title: string): Promise<number> {
  const trimmed = title.trim();
  if (trimmed === '') throw new UsageError(t('usage.missingArgs'));
  return withSession(ctx, id, async (client, sessionId) => {
    await client.request('session.rename', { sessionId, title: trimmed });
    ctx.print(t('attach.renamed', { title: trimmed }));
    return EXIT.ok;
  });
}

/** `wevir session archive|unarchive <会话 ID>`：归档前先关闭；取消归档不恢复，下次发送时恢复。 */
export async function sessionArchive(ctx: Context, id: string, archived: boolean): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    const { worktrees } = await client.request('session.archive', { sessionId, archived });
    ctx.print(t(archived ? 'session.archived' : 'session.unarchived', { id: sessionId }));
    for (const worktree of worktrees ?? []) {
      ctx.print(
        ctx.styles.dim(
          `  ${t(`worktree.${worktree.status}`, { branch: worktree.branch, path: worktree.path })}`,
        ),
      );
    }
    return EXIT.ok;
  });
}

/**
 * `wevir session delete <会话 ID> [--force]`：永久删除一个已归档的会话（连同子会话、支线与 Host 开的 worktree）。worktree 有没提交的改动时
 * 要 `--force`。
 */
export async function sessionDelete(
  ctx: Context,
  id: string,
  options: { force?: boolean },
): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    requireFeature(client, 'session_delete');
    const result = await client.request('session.delete', {
      sessionId,
      ...(options.force && { force: true }),
    });
    ctx.print(t('session.deleted', { count: result.sessionIds.length }));
    for (const branch of result.keptBranches ?? []) {
      ctx.print(ctx.styles.dim(`  ${t('session.keptBranch', { branch })}`));
    }
    if (result.engineDataKept) ctx.print(ctx.styles.dim(`  ${t('session.engineDataKept')}`));
    return EXIT.ok;
  });
}

/** `wevir session fork <会话 ID> [--turn <回合 ID>] [--json]`：分支到新会话，带着到那个完成的回合为止的历史。 */
export async function sessionFork(
  ctx: Context,
  id: string,
  options: JsonOption & { turn?: string },
): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    requireFeature(client, 'session_branches');
    const { session } = await client.request('session.fork', {
      sessionId,
      ...(options.turn !== undefined && { turnId: options.turn as TurnId }),
    });
    if (options.json) {
      ctx.print(JSON.stringify(session, null, 2));
      return EXIT.ok;
    }
    ctx.print(t('attach.forked', { id: session.id }));
    return EXIT.ok;
  });
}

/** `wevir session undo|redo <会话 ID>`：撤销最后一个回合（还原文件），或重做刚撤销的。 */
export async function sessionUndo(ctx: Context, id: string, redo: boolean): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    requireFeature(client, 'session_undo');
    const { turnId, files } = await client.request(redo ? 'session.redo' : 'session.undo', {
      sessionId,
    });
    ctx.print(
      t(redo ? 'session.redone' : 'session.undone', {
        turn: turnId,
        files: filesRestoreLabel(files),
      }),
    );
    return EXIT.ok;
  });
}

export interface ConfigFlags extends JsonOption {
  provider?: string;
  model?: string;
  effort?: string;
  defaultEffort?: boolean;
  permission?: string;
}

/**
 * `wevir session config <会话 ID> [--model …] [--effort …|--default-effort] [--permission …] [--provider …]`：从下一个回合起生效。
 * `--provider` 换到别的来源（接力）。不带选项时显示现在的设置。
 */
export async function sessionConfig(ctx: Context, id: string, flags: ConfigFlags): Promise<number> {
  if (flags.effort !== undefined && flags.defaultEffort) {
    throw new UsageError(t('session.effortConflict'));
  }
  const change: Omit<MethodParams<'session.configure'>, 'sessionId'> = {
    ...(flags.provider !== undefined && { providerId: flags.provider }),
    ...(flags.model !== undefined && { modelId: flags.model }),
    ...(flags.effort !== undefined && { reasoningEffort: flags.effort }),
    ...(flags.defaultEffort && { reasoningEffort: null }),
    ...(flags.permission !== undefined && { permissionMode: parsePermission(flags.permission) }),
  };
  return withSession(ctx, id, async (client, sessionId) => {
    const session =
      Object.keys(change).length === 0
        ? (await client.request('session.get', { sessionId })).session
        : (await client.request('session.configure', { sessionId, ...change })).session;
    if (flags.json) {
      ctx.print(JSON.stringify(session, null, 2));
      return EXIT.ok;
    }
    ctx.print(
      t('attach.config', {
        model: `${session.providerId}/${session.modelId}`,
        effort: session.reasoningEffort ?? t('attach.effortDefault'),
        permission: permissionLabel(session.permissionMode ?? 'on_request'),
      }),
    );
    return EXIT.ok;
  });
}

/** `wevir session cancel <会话 ID>`：取消当前运行。 */
export async function sessionCancel(ctx: Context, id: string): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    const { session } = await client.request('session.get', { sessionId });
    if (session.state !== 'running' && session.state !== 'awaiting_approval') {
      throw new CliError(t('session.notRunning', { id: sessionId }));
    }
    await client.request('session.cancel', { sessionId });
    ctx.print(t('session.cancelRequested', { id: sessionId }));
    return EXIT.ok;
  });
}

/** `wevir session close <会话 ID>`：关掉引擎会话；下次发送时恢复。 */
export async function sessionClose(ctx: Context, id: string): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    await client.request('session.close', { sessionId });
    ctx.print(t('session.closed', { id: sessionId }));
    return EXIT.ok;
  });
}

/** `wevir session compact <会话 ID>`：压缩上下文，开始一个由命令开始的回合。 */
export async function sessionCompact(ctx: Context, id: string): Promise<number> {
  return withSession(ctx, id, async (client, sessionId) => {
    const { turnId } = await client.request('session.compact', { sessionId });
    ctx.print(t('session.compacting', { turn: turnId }));
    return EXIT.ok;
  });
}
