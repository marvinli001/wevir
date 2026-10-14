// 上次所在的工作区（T5.5 起记在本机的 localStorage，只有 ID，不放会话内容）。U4 起新开窗口停在首页（维护者 2026-10-14
// 定），不再自动跳回上次的会话或草稿；记下的工作区只给首页标题里的工作区下拉当默认值。进某个工作区的会话或草稿、在首页
// 下拉里换工作区时更新。T5.5 存的 {workspaceId, sessionId} 照样能读，sessionId 不再用。

import { useEffect } from 'react';
import type { WorkbenchData, WorkspaceEntry } from '@/data/workbench-model';
import { createPersistedStore } from '@/lib/store';

export interface LastLocation {
  workspaceId: string;
}

export function parseLastLocation(raw: unknown): LastLocation | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { workspaceId } = raw as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
  return { workspaceId };
}

const lastLocation = createPersistedStore<LastLocation | null>(
  'wevir.last-location.v1',
  null,
  parseLastLocation,
);

export const useLastLocation = lastLocation.use;

/** 记下所在的工作区（首页的下拉换工作区时也调）。 */
export function rememberWorkspace(workspaceId: string): void {
  if (lastLocation.get()?.workspaceId === workspaceId) return;
  lastLocation.set({ workspaceId });
}

/** 在工作台布局里调用：进了某个工作区的会话或草稿就记下它。 */
export function useRememberLocation(workspaceId: string | undefined) {
  useEffect(() => {
    if (workspaceId !== undefined) rememberWorkspace(workspaceId);
  }, [workspaceId]);
}

/**
 * 首页默认的工作区：上次所在的那个还在就用它；否则用最近有活动的会话所在的工作区；都没有就用第一个。没有工作区时
 * 是 undefined。
 */
export function homeWorkspace(
  data: Extract<WorkbenchData, { status: 'ready' }>,
  last: LastLocation | null,
): WorkspaceEntry | undefined {
  const remembered =
    last && data.workspaces.find((entry) => entry.workspace.id === last.workspaceId);
  if (remembered) return remembered;
  let latest: { entry: WorkspaceEntry; updatedAt: string } | undefined;
  for (const entry of data.workspaces) {
    const newest = entry.sessions[0];
    if (newest && (!latest || newest.updatedAt > latest.updatedAt)) {
      latest = { entry, updatedAt: newest.updatedAt };
    }
  }
  return latest?.entry ?? data.workspaces[0];
}
