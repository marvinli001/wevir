import type { WevirClient } from '@wevir/client-sdk';
import {
  type PermissionMode,
  type ProviderProfile,
  type SessionId,
  SessionIdSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import { attachSession } from '../attach.js';
import { type Context, connect, findWorkspace, withClient, workspacePath } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, stateLabel, table, truncate } from '../format.js';
import { joinList, t } from '../i18n/index.js';

export interface SessionNewOptions {
  /** 省略（0.39.0，Host 功能 `chat_sessions`）：不在项目里的对话。 */
  workspace?: string;
  provider?: string;
  model?: string;
  effort?: string;
  permission?: PermissionMode;
  /** 给这个会话新开一个 git worktree（0.18.0）。 */
  worktree?: boolean;
  /** 只创建并发送，不进入 attach。 */
  detach?: boolean;
  /** 提示在计划模式里发送（0.36.0）。 */
  plan?: boolean;
}

/**
 * `wevir session new [-w <路径>] "<提示>"`：登记工作区（已登记则复用）、建会话、发送提示，默认进入 attach。省略 `-w` 时建在
 * Host 的“对话”里（不在项目里的会话）。
 */
export async function sessionNew(
  ctx: Context,
  prompt: string | undefined,
  options: SessionNewOptions,
): Promise<number> {
  if (options.detach && prompt === undefined) {
    throw new UsageError(t('session.detachNeedsPrompt'), t('session.detachNeedsPrompt.hint'));
  }
  const client = await connect(ctx);
  try {
    let workspaceId: WorkspaceId | undefined;
    if (options.workspace === undefined) {
      if (!client.supports('chat_sessions')) {
        throw new UsageError(t('usage.missingWorkspace'), t('usage.missingWorkspace.hint'));
      }
      if (options.worktree) throw new UsageError(t('session.worktreeNeedsWorkspace'));
    } else {
      const { workspace, created } = await client.request('workspace.add', {
        rootPath: workspacePath(ctx, options.workspace),
      });
      if (created) {
        ctx.print(
          ctx.styles.dim(
            t('session.workspaceAdded', { name: workspace.displayName, path: workspace.rootPath }),
          ),
        );
      }
      workspaceId = workspace.id;
    }
    const { providers } = await client.request('provider.list');
    const provider = pickProvider(providers, options.provider);
    const { session } = await client.request('session.create', {
      ...(workspaceId !== undefined && { workspaceId }),
      providerId: provider.id,
      ...(options.model !== undefined && { modelId: options.model }),
      ...(options.effort !== undefined && { reasoningEffort: options.effort }),
      ...(options.permission !== undefined && { permissionMode: options.permission }),
      ...(options.worktree && { worktree: 'new' as const }),
    });
    ctx.print(t('session.created', { id: session.id }));
    if (options.detach) {
      await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: prompt as string }],
        ...(options.plan && { collaborationMode: 'plan' as const }),
      });
      ctx.print(ctx.styles.dim(t('session.sent', { id: session.id })));
      return EXIT.ok;
    }
    return await attachSession(ctx, client, session.id, {
      ...(prompt !== undefined && { firstMessage: prompt }),
      ...(options.plan && { firstMode: 'plan' as const }),
    });
  } finally {
    client.close();
  }
}

export function pickProvider(
  providers: ProviderProfile[],
  wanted: string | undefined,
): ProviderProfile {
  if (wanted !== undefined) {
    const found = providers.find((p) => p.id === wanted);
    if (!found) {
      throw new CliError(
        t('session.noSuchProvider', { id: wanted }),
        t('session.noSuchProvider.hint'),
      );
    }
    return found;
  }
  if (providers.length === 0) {
    throw new CliError(t('session.noProviders'), t('session.noProviders.hint'));
  }
  if (providers.length > 1) {
    throw new UsageError(
      t('session.manyProviders', {
        count: providers.length,
        ids: joinList(providers.map((p) => p.id)),
      }),
    );
  }
  return providers[0] as ProviderProfile;
}

export async function sessionList(
  ctx: Context,
  options: { workspace?: string; archived?: boolean; json?: boolean },
): Promise<number> {
  return withClient(ctx, async (client) => {
    const { workspaces } = await client.request('workspace.list');
    const workspaceId =
      options.workspace === undefined
        ? undefined
        : (await findWorkspace(ctx, workspaces, options.workspace)).id;
    const { sessions } = await client.request('session.list', {
      ...(workspaceId !== undefined && { workspaceId }),
      ...(options.archived && { archived: true }),
    });
    if (options.json) {
      ctx.print(JSON.stringify(sessions, null, 2));
      return EXIT.ok;
    }
    if (sessions.length === 0) {
      ctx.print(t(options.archived ? 'session.noneArchived' : 'session.none'));
      return EXIT.ok;
    }
    const names = new Map(workspaces.map((w) => [w.id, w.displayName]));
    ctx.print(
      table(
        [
          t('session.col.id'),
          t('session.col.state'),
          t('session.col.title'),
          t('session.col.workspace'),
          t('session.col.model'),
          t('session.col.events'),
          t('session.col.updated'),
        ],
        sessions.map((s) => [
          s.id,
          s.readOnly ? t('state.readOnly') : stateLabel(s.state),
          truncate(s.title || t('session.untitled'), 30),
          names.get(s.workspaceId) ?? s.cwd,
          `${s.providerId}/${s.modelId}`,
          String(s.lastSeq),
          formatTime(s.updatedAt),
        ]),
      ),
    );
    return EXIT.ok;
  });
}

export async function sessionAttach(ctx: Context, id: string): Promise<number> {
  const client = await connect(ctx);
  try {
    const sessionId = await resolveSessionId(client, id);
    return await attachSession(ctx, client, sessionId);
  } finally {
    client.close();
  }
}

/** `wevir session send <会话 ID> "<消息>" [--plan]`：给会话发一条消息，不进入 attach。 */
export async function sessionSend(
  ctx: Context,
  id: string,
  text: string,
  options: { plan?: boolean } = {},
): Promise<number> {
  return withClient(ctx, async (client) => {
    const sessionId = await resolveSessionId(client, id);
    await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text }],
      ...(options.plan && { collaborationMode: 'plan' as const }),
    });
    ctx.print(ctx.styles.dim(t('session.sent', { id: sessionId })));
    return EXIT.ok;
  });
}

/** 完整的会话 ID 原样使用；否则按前缀（可省略 `ses_`）在会话列表（含已归档的）里找唯一的一个。 */
export async function resolveSessionId(client: WevirClient, id: string): Promise<SessionId> {
  if (SessionIdSchema.safeParse(id).success && id.length >= 30) return id as SessionId;
  const lists = await Promise.all([
    client.request('session.list', {}),
    client.request('session.list', { archived: true }),
  ]);
  // 旧 Host 不认 `archived`，两次列出的一样：按 ID 去重。
  const sessions = [
    ...new Map(lists.flatMap((list) => list.sessions).map((s) => [s.id, s])).values(),
  ];
  const matches = sessions.filter((s) => s.id.startsWith(id) || s.id.startsWith(`ses_${id}`));
  if (matches.length === 1) return (matches[0] as (typeof sessions)[number]).id;
  if (matches.length === 0) {
    throw new CliError(t('session.notFound', { id }), t('err.sessionNotFound.hint'));
  }
  const ids = joinList(matches.slice(0, 5).map((s) => s.id));
  throw new CliError(
    matches.length > 5
      ? t('session.ambiguousMore', { id, ids })
      : t('session.ambiguous', { id, ids }),
    t('session.ambiguous.hint'),
  );
}
