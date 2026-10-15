import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WevirClient } from '@wevir/client-sdk';
import { type ProviderProfile, type SessionId, SessionIdSchema } from '@wevir/protocol';
import { attachSession } from '../attach.js';
import { type Context, connect, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, stateLabel, table, truncate } from '../format.js';
import { joinList, t } from '../i18n/index.js';

export interface SessionNewOptions {
  workspace: string;
  provider?: string;
  model?: string;
  /** 只创建并发送，不进入 attach。 */
  detach?: boolean;
}

/** `wevir session new -w <路径> "<提示>"`：登记工作区（已登记则复用）、建会话、发送提示，默认进入 attach。 */
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
    const { workspace, created } = await client.request('workspace.add', {
      rootPath: resolve(ctx.io.cwd, options.workspace),
    });
    if (created) {
      ctx.print(
        ctx.styles.dim(
          t('session.workspaceAdded', { name: workspace.displayName, path: workspace.rootPath }),
        ),
      );
    }
    const { providers } = await client.request('provider.list');
    const provider = pickProvider(providers, options.provider);
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: provider.id,
      ...(options.model !== undefined && { modelId: options.model }),
    });
    ctx.print(t('session.created', { id: session.id }));
    if (options.detach) {
      await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: prompt as string }],
      });
      ctx.print(ctx.styles.dim(t('session.sent', { id: session.id })));
      return EXIT.ok;
    }
    return await attachSession(ctx, client, session.id, {
      ...(prompt !== undefined && { firstMessage: prompt }),
    });
  } finally {
    client.close();
  }
}

function pickProvider(providers: ProviderProfile[], wanted: string | undefined): ProviderProfile {
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

export async function sessionList(ctx: Context, options: { workspace?: string }): Promise<number> {
  return withClient(ctx, async (client) => {
    const { workspaces } = await client.request('workspace.list');
    let workspaceId: (typeof workspaces)[number]['id'] | undefined;
    if (options.workspace !== undefined) {
      const path = resolve(ctx.io.cwd, options.workspace);
      // Host 按 realpath 存工作区；目录不存在时按原样比较。
      const real = await realpath(path).catch(() => path);
      const found = workspaces.find((w) => w.rootPath === real);
      if (!found) {
        throw new CliError(t('session.notWorkspace', { path }), t('session.notWorkspace.hint'));
      }
      workspaceId = found.id;
    }
    const { sessions } = await client.request(
      'session.list',
      workspaceId === undefined ? {} : { workspaceId },
    );
    if (sessions.length === 0) {
      ctx.print(t('session.none'));
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

/** 完整的会话 ID 原样使用；否则按前缀（可省略 `ses_`）在会话列表里找唯一的一个。 */
async function resolveSessionId(client: WevirClient, id: string): Promise<SessionId> {
  if (SessionIdSchema.safeParse(id).success && id.length >= 30) return id as SessionId;
  const { sessions } = await client.request('session.list', {});
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
