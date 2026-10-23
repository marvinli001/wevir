// 会话行的动作（U34，0.23.0 起；右键菜单补全后）：改名、归档与删除经 Host（`session.rename`、`session.archive`、`session.delete`），
// 分支经 `session.fork`，置顶与未读只记在本机。左栏的行（悬停的按钮与右键菜单）、斜杠命令与设置 → 已归档共用这里。改名与删除
// 的对话框由 `requestRename`、`requestDelete` 打开（rename-dialog.tsx、delete-session-dialog.tsx 挂在根上）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type {
  HostFeatures,
  Session,
  SessionId,
  SessionMoveTarget,
  SessionWorktreeArchive,
} from '@wevir/protocol';
import { openAutomationDialog } from '@/automations/automation-dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createPersistedStore, createStore } from '@/lib/store';
import { capabilities, platformApi } from '@/platform/platform';
import { paths } from '@/routes/paths';
import { router } from '@/routes/router';
import { engineFeaturesOf } from '@/session/handoff-model';
import { reportActionFailure } from './action-notices';
import { markSeen, markUnread, useUnread } from './seen-sessions';
import { useWorkbenchProviders, useWorkbenchStore } from './workbench-data';
import { isChats } from './workbench-model';
import type { WorkbenchStore } from './workbench-store';

/** Host 能改名、能归档（0.23.0）、能永久删除（0.43.0）。 */
export function useSessionManagement(): { rename: boolean; archive: boolean; remove: boolean } {
  const { view } = useHostConnection();
  if (view.status !== 'connected') return { rename: false, archive: false, remove: false };
  return {
    rename: hostSupports(view.hello.features, 'session_rename'),
    archive: hostSupports(view.hello.features, 'session_archive'),
    remove: hostSupports(view.hello.features, 'session_delete'),
  };
}

// ── 置顶（本机） ───────────────────────────────────────────────────

export const pinnedSessions = createPersistedStore<readonly string[]>(
  'wevir.pinned-sessions.v1',
  [],
  (raw) =>
    Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : undefined,
);

export const usePinnedSessions = pinnedSessions.use;

export function togglePinned(sessionId: string): void {
  pinnedSessions.set((current) =>
    current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [sessionId, ...current],
  );
}

function unpin(sessionId: string): void {
  pinnedSessions.set((current) =>
    current.includes(sessionId) ? current.filter((id) => id !== sessionId) : current,
  );
}

// ── 改名 ─────────────────────────────────────────────────────────

export interface RenameRequest {
  sessionId: SessionId;
  title: string;
}

export const renameRequest = createStore<RenameRequest | undefined>(undefined);

/** 打开改名的对话框。 */
export function requestRename(session: Pick<Session, 'id' | 'title'>): void {
  renameRequest.set({ sessionId: session.id as SessionId, title: session.title });
}

export async function renameSession(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  sessionId: SessionId,
  title: string,
): Promise<void> {
  const { session } = await client.request('session.rename', { sessionId, title });
  store?.upsertSession(session);
}

// ── 归档 ─────────────────────────────────────────────────────────

/** 归档之后的收尾：取消置顶；正在看其中一个时回到首页；重读列表。 */
async function afterArchive(
  store: WorkbenchStore | undefined,
  sessionIds: readonly SessionId[],
): Promise<void> {
  for (const sessionId of sessionIds) unpin(sessionId);
  const viewing = router.state.matches.some((match) =>
    sessionIds.includes(match.params.sessionId as SessionId),
  );
  if (viewing) void router.navigate(paths.home());
  await store?.refresh();
}

/** 归档或取消归档；归档掉正在看的会话时回到首页，并取消置顶。取消归档时没能恢复的 worktree（0.81.0）逐个提示。 */
export async function archiveSession(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  sessionId: SessionId,
  archived: boolean,
): Promise<void> {
  const { worktrees } = await client.request('session.archive', { sessionId, archived });
  if (archived) await afterArchive(store, [sessionId]);
  else await store?.refresh();
  for (const text of worktreeRestoreNotices(worktrees ?? [])) reportActionFailure(text);
}

/** 取消归档时要告诉用户的 worktree：没恢复的，与分支有了新提交、改动没放回的。 */
export function worktreeRestoreNotices(worktrees: readonly SessionWorktreeArchive[]): string[] {
  return worktrees.flatMap((worktree) => {
    if (worktree.status === 'failed') {
      return [
        t('session.worktreeRestoreFailed', {
          branch: worktree.branch,
          error: worktree.message ?? worktree.reason ?? '',
        }),
      ];
    }
    if (worktree.status === 'restored' && worktree.reason === 'branch_moved') {
      return [
        t('session.worktreeChangesKept', { branch: worktree.branch, ref: worktree.ref ?? '' }),
      ];
    }
    return [];
  });
}

/** 依次归档一批会话（项目菜单的“归档会话”）；一个失败不影响其余的，返回第一个失败的原因与失败的个数。 */
export async function archiveSessions(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  sessionIds: readonly SessionId[],
): Promise<{ failed: number; firstError?: unknown }> {
  const done: SessionId[] = [];
  let failed = 0;
  let firstError: unknown;
  for (const sessionId of sessionIds) {
    try {
      await client.request('session.archive', { sessionId, archived: true });
      done.push(sessionId);
    } catch (error) {
      failed += 1;
      firstError ??= error;
    }
  }
  await afterArchive(store, done);
  return { failed, ...(firstError !== undefined && { firstError }) };
}

// ── 分支 ─────────────────────────────────────────────────────────

/**
 * 会话能不能在菜单里分支到新会话（0.38.0）：Host 声明了 `session_branches`、会话当前的引擎能分支（`engineFeatures` 的 `branch`），
 * 且是可写的顶层会话。有没有结束的回合只有 Host 知道，没有时 `session.fork` 报 `INVALID_STATE`，由调用方提示。
 */
export function canBranchSession(
  session: Pick<Session, 'parentSessionId' | 'side' | 'readOnly'>,
  features: HostFeatures,
  engine: { branch?: boolean } | undefined,
): boolean {
  return (
    hostSupports(features, 'session_branches') &&
    engine?.branch === true &&
    session.parentSessionId === undefined &&
    !session.side &&
    session.readOnly === undefined
  );
}

/** 分支到新会话（到最近一个结束的回合）并打开它；出错或已关闭的会话先恢复。 */
export async function branchSession(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  session: Pick<Session, 'id' | 'state'>,
): Promise<void> {
  if (session.state === 'error' || session.state === 'closed') {
    await client.request('session.resume', { sessionId: session.id });
  }
  const { session: created } = await client.request('session.fork', { sessionId: session.id });
  store?.upsertSession(created);
  void router.navigate(paths.session(created.workspaceId, created.id));
}

// ── 移动 ─────────────────────────────────────────────────────────

/**
 * 会话能往哪儿移（0.81.0，`session.move`）：Host 声明了 `session_move`，是可写、没归档、不是环境会话的顶层会话，不在“对话”里。在项目
 * 目录里时移到工作树；在 Host 开的一个工作树里时移回本地。Host 还会查 git 的情况，不符时报错由调用方提示。
 */
export function moveTarget(
  session: Pick<
    Session,
    'parentSessionId' | 'side' | 'readOnly' | 'archivedAt' | 'environmentId' | 'worktrees'
  >,
  features: HostFeatures,
  chats: boolean,
): SessionMoveTarget | undefined {
  if (
    !hostSupports(features, 'session_move') ||
    chats ||
    session.parentSessionId !== undefined ||
    session.side === true ||
    session.readOnly !== undefined ||
    session.archivedAt !== undefined ||
    session.environmentId !== undefined
  ) {
    return undefined;
  }
  const worktrees = session.worktrees?.length ?? 0;
  if (worktrees === 0) return 'worktree';
  return worktrees === 1 ? 'local' : undefined;
}

/** 移到工作树或移回本地；结果的会话放进列表（事件也会更新它）。 */
export async function moveSession(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  sessionId: SessionId,
  to: SessionMoveTarget,
): Promise<void> {
  const { session } = await client.request('session.move', { sessionId, to });
  store?.upsertSession(session);
}

// ── 永久删除 ─────────────────────────────────────────────────────

export const deleteRequest = createStore<Session | undefined>(undefined);

/** 打开永久删除的确认框（delete-session-dialog.tsx）。 */
export function requestDelete(session: Session): void {
  deleteRequest.set(session);
}

export interface DeleteResult {
  keptBranches: string[];
  engineDataKept: boolean;
}

/**
 * 永久删除一个会话（`session.delete` 只收已归档的）：没归档的先归档，再删。`force`：量的时候工作树有没提交的改动，确认框已经
 * 提醒过。删掉的会话取消置顶；归档那一步已经让正在看的会话回到首页。
 */
export async function deleteSessionPermanently(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  session: Pick<Session, 'id' | 'archivedAt'>,
  force: boolean,
): Promise<DeleteResult> {
  const sessionId = session.id as SessionId;
  if (session.archivedAt === undefined) await archiveSession(client, store, sessionId, true);
  const result = await client.request('session.delete', {
    sessionId,
    ...(force && { force: true }),
  });
  unpin(sessionId);
  await store?.refresh();
  return {
    keptBranches: result.keptBranches ?? [],
    engineDataKept: result.engineDataKept === true,
  };
}

// ── 行上的动作（右键菜单与悬停的按钮共用） ──────────────────────────

type ActionFailure = 'session.archiveFailed' | 'message.branchFailed' | 'session.moveFailed';

export interface SessionActions {
  pinned: boolean;
  unread: boolean;
  togglePin(): void;
  /** Host 不支持（旧版本）或没连上时没有。 */
  rename?: () => void;
  archive?: () => void;
  branch?: () => void;
  /** 移到工作树或移回本地（0.81.0）。 */
  move?: { to: SessionMoveTarget; run: () => void };
  /** 新建发进这个会话的自动化（0.73.0，Host 功能 `automation_conditions`）。 */
  automate?: () => void;
  remove?: () => void;
  toggleUnread(): void;
  copyId(): void;
  copyCwd(): void;
  /** 在访达中显示工作目录；路径不在这台电脑上（platform/platform.ts 的 `localFiles`）时没有。 */
  reveal?: () => void;
}

/** 把动作绑到一个会话上；失败的动作报到窗口右下角的通知（action-notices.ts），不再只写控制台。 */
export function useSessionActions(session: Session): SessionActions {
  const { client, view } = useHostConnection();
  const store = useWorkbenchStore();
  // 左栏每行都调用：只订阅 Provider 列表与这个会话的未读，不随别的会话的事件重渲染。
  const providers = useWorkbenchProviders();
  const manage = useSessionManagement();
  const pinned = usePinnedSessions().includes(session.id);
  const unread = useUnread(session);

  const engine =
    view.status === 'connected' && providers !== undefined
      ? engineFeaturesOf(view.hello.engineFeatures, providers, session.providerId)
      : undefined;
  const branchable =
    view.status === 'connected' && canBranchSession(session, view.hello.features, engine);

  const workspace = (() => {
    const data = store?.get();
    return data?.status === 'ready'
      ? data.workspaces.find((entry) => entry.workspace.id === session.workspaceId)?.workspace
      : undefined;
  })();
  const moveTo =
    view.status === 'connected'
      ? moveTarget(session, view.hello.features, workspace !== undefined && isChats(workspace))
      : undefined;

  const automatable =
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'automation_conditions') &&
    session.parentSessionId === undefined &&
    session.readOnly === undefined &&
    session.automation === undefined &&
    session.state !== 'closed';

  const guard = (failure: ActionFailure, task: () => Promise<unknown>) => () => {
    task().catch((error: unknown) => reportActionFailure(t(failure, { error: describe(error) })));
  };
  const copy = (text: string) => () =>
    void platformApi()
      .copyText(text)
      .catch(() => undefined);

  return {
    pinned,
    unread,
    togglePin: () => togglePinned(session.id),
    toggleUnread: () => (unread ? markSeen(session) : markUnread(session)),
    ...(manage.rename && { rename: () => requestRename(session) }),
    ...(manage.archive &&
      client && {
        archive: guard('session.archiveFailed', () =>
          archiveSession(client, store, session.id as SessionId, true),
        ),
      }),
    ...(branchable &&
      client && {
        branch: guard('message.branchFailed', () => branchSession(client, store, session)),
      }),
    ...(moveTo !== undefined &&
      client && {
        move: {
          to: moveTo,
          run: guard('session.moveFailed', () =>
            moveSession(client, store, session.id as SessionId, moveTo),
          ),
        },
      }),
    ...(automatable && {
      automate: () => openAutomationDialog({ kind: 'create', sessionId: session.id }),
    }),
    ...(manage.remove && manage.archive && { remove: () => requestDelete(session) }),
    copyId: copy(session.id),
    copyCwd: copy(session.cwd),
    ...(capabilities().localFiles && {
      reveal: () =>
        void platformApi()
          .revealPath(session.cwd)
          .catch(() => undefined),
    }),
  };
}
