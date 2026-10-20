// 项目的动作（0.49.0 起右键菜单）：改名与改源文件夹（0.63.0）经 Host 的 `workspace.update`，移除经 `workspace.remove`（只注销、不删磁盘文件），归档会话
// 是对项目里每个会话的 `session.archive`，置顶只记在本机。侧栏的项目菜单与设置 → 项目共用这里；改名、移除与归档的确认框由
// `requestEditProject`、`requestRemoveProject`、`requestArchiveProject` 打开（projects/ 下的对话框挂在根上）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { useHostConnection } from '@/host/host-connection';
import { createPersistedStore, createStore } from '@/lib/store';
import { paths } from '@/routes/paths';
import { router } from '@/routes/router';
import { openSessions, removeClosingSessions } from '@/settings/remove';
import type { WorkspaceEntry } from './workbench-model';
import type { WorkbenchStore } from './workbench-store';

/** Host 能给项目改名（0.49.0）。 */
export function useWorkspaceManagement(): { update: boolean } {
  const { view } = useHostConnection();
  return {
    update: view.status === 'connected' && hostSupports(view.hello.features, 'workspace_update'),
  };
}

// ── 置顶（本机） ───────────────────────────────────────────────────

export const pinnedWorkspaces = createPersistedStore<readonly string[]>(
  'wevir.pinned-workspaces.v1',
  [],
  (raw) =>
    Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : undefined,
);

export const usePinnedWorkspaces = pinnedWorkspaces.use;

/** 置顶或取消置顶；后置顶的排在前面。 */
export function togglePinnedWorkspace(workspaceId: string): void {
  pinnedWorkspaces.set((current) =>
    current.includes(workspaceId)
      ? current.filter((id) => id !== workspaceId)
      : [workspaceId, ...current],
  );
}

function unpinWorkspace(workspaceId: string): void {
  pinnedWorkspaces.set((current) =>
    current.includes(workspaceId) ? current.filter((id) => id !== workspaceId) : current,
  );
}

// ── 改名 ─────────────────────────────────────────────────────────

export const editRequest = createStore<Workspace | undefined>(undefined);

/** 打开“编辑项目”的对话框。 */
export function requestEditProject(workspace: Workspace): void {
  editRequest.set(workspace);
}

/** 改名与（0.63.0）整组换掉其他源文件夹；省略的不改。 */
export async function updateWorkspace(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  workspaceId: Workspace['id'],
  changes: { displayName?: string; extraFolders?: readonly string[] },
): Promise<void> {
  await client.request('workspace.update', {
    workspaceId,
    ...(changes.displayName !== undefined && { displayName: changes.displayName }),
    ...(changes.extraFolders !== undefined && { extraFolders: [...changes.extraFolders] }),
  });
  await store?.refresh();
}

// ── 移除 ─────────────────────────────────────────────────────────

export const removeRequest = createStore<WorkspaceEntry | undefined>(undefined);

/** 打开“移除项目”的确认框；设置 → 项目与侧栏的菜单共用同一个。 */
export function requestRemoveProject(entry: WorkspaceEntry): void {
  removeRequest.set(entry);
}

/**
 * 移除项目：只让 Wevir 不再列出它，磁盘上的文件不动。有未关闭的会话挡着时先关闭它们再试一次（`removeClosingSessions`，确认框
 * 已经写明）。正在看这个项目里的会话时回到首页。
 */
export async function removeWorkspace(
  client: WevirClient,
  store: WorkbenchStore | undefined,
  workspace: Pick<Workspace, 'id'>,
): Promise<void> {
  await removeClosingSessions(client, () =>
    client.request('workspace.remove', { workspaceId: workspace.id }),
  );
  unpinWorkspace(workspace.id);
  const viewing = router.state.matches.some((match) => match.params.workspaceId === workspace.id);
  if (viewing) void router.navigate(paths.home());
  await store?.refresh();
}

/** 确认框里要写的：项目里的会话数与其中未关闭的个数。 */
export function removalImpact(entry: WorkspaceEntry): { sessions: number; open: number } {
  return { sessions: entry.sessions.length, open: openSessions(entry.sessions).length };
}

// ── 归档会话 ─────────────────────────────────────────────────────

export const archiveProjectRequest = createStore<WorkspaceEntry | undefined>(undefined);

/** 打开“归档会话”的确认框（归档会关闭会话，运行中的回合会被取消）。 */
export function requestArchiveProject(entry: WorkspaceEntry): void {
  archiveProjectRequest.set(entry);
}
