// 会话的改名、归档与置顶（U34，0.23.0）：改名与归档经 Host（`session.rename`、`session.archive`），置顶只记在本机。左栏的行、
// 斜杠命令与设置 → 已归档共用这里。改名的对话框由 `requestRename` 打开（rename-dialog.tsx 挂在根上）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { Session, SessionId } from '@wevir/protocol';
import { useHostConnection } from '@/host/host-connection';
import { createPersistedStore, createStore } from '@/lib/store';
import { paths } from '@/routes/paths';
import { router } from '@/routes/router';
import type { WorkbenchStore } from './workbench-store';

/** Host 能改名、能归档（0.23.0）。 */
export function useSessionManagement(): { rename: boolean; archive: boolean } {
  const { view } = useHostConnection();
  if (view.status !== 'connected') return { rename: false, archive: false };
  return {
    rename: hostSupports(view.hello.features, 'session_rename'),
    archive: hostSupports(view.hello.features, 'session_archive'),
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

/** 归档或取消归档；归档掉正在看的会话时回到首页，并取消置顶。 */
export async function archiveSession(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  sessionId: SessionId,
  archived: boolean,
): Promise<void> {
  await client.request('session.archive', { sessionId, archived });
  if (archived) {
    unpin(sessionId);
    const viewing = router.state.matches.some((match) => match.params.sessionId === sessionId);
    if (viewing) void router.navigate(paths.home());
  }
  await store?.refresh();
}
