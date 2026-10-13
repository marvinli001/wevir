// 上次打开的工作区与会话（T5.5）：记在本机的 localStorage（只有 ID，不放会话内容），应用重启后恢复。只在
// 新打开的窗口停在首页时恢复一次：刷新页面时 URL 本身就保留着当前位置（URL 是唯一事实），之后用户自己回到首页
// 也不再跳走。记下的工作区或会话已经不在了，就留在首页或进那个工作区的新会话草稿，不显示“未找到”。

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { WorkbenchData } from '@/data/workbench-model';
import { createPersistedStore } from '@/lib/store';
import { paths, ROUTE_PATTERNS } from './paths';

export interface LastLocation {
  workspaceId: string;
  /** 新会话草稿页没有。 */
  sessionId?: string;
}

export function parseLastLocation(raw: unknown): LastLocation | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { workspaceId, sessionId } = raw as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined;
  return sessionId === undefined ? { workspaceId } : { workspaceId, sessionId };
}

const lastLocation = createPersistedStore<LastLocation | null>(
  'wevir.last-location.v1',
  null,
  parseLastLocation,
);

/**
 * 恢复到哪里：会话还在就回到它；会话不在了（或上次在草稿页）而工作区还在，进这个工作区的新会话草稿；工作区也
 * 不在了就不恢复。数据还没读到时返回 `pending`。
 */
export function restorePath(
  data: WorkbenchData,
  last: LastLocation | null,
): string | 'pending' | undefined {
  if (!last) return undefined;
  if (data.status === 'loading') return 'pending';
  if (data.status === 'error') return undefined;
  const entry = data.workspaces.find((candidate) => candidate.workspace.id === last.workspaceId);
  if (!entry) return undefined;
  if (last.sessionId !== undefined && entry.sessions.some((s) => s.id === last.sessionId)) {
    return paths.session(last.workspaceId, last.sessionId);
  }
  return paths.draft(last.workspaceId);
}

/** 窗口打开时的 URL 是首页才恢复（electron 加载的入口没有 hash）。测试在 Node 上加载本模块，没有 window。 */
let pendingRestore =
  typeof window !== 'undefined' &&
  ['', '#', `#${ROUTE_PATTERNS.home}`].includes(window.location.hash);

/** 在工作台布局里调用：记下当前所在的工作区与会话；离开首页即放弃启动时的恢复。 */
export function useRememberLocation(
  workspaceId: string | undefined,
  sessionId: string | undefined,
) {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== ROUTE_PATTERNS.home) pendingRestore = false;
    if (workspaceId === undefined) return;
    const current = lastLocation.get();
    if (current?.workspaceId === workspaceId && current.sessionId === sessionId) return;
    lastLocation.set(sessionId === undefined ? { workspaceId } : { workspaceId, sessionId });
  }, [location.pathname, workspaceId, sessionId]);
}

/** 在首页调用：启动后第一次读到列表时，回到上次打开的会话（或工作区）。 */
export function useRestoreLastLocation(data: WorkbenchData) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!pendingRestore) return;
    const target = restorePath(data, lastLocation.get());
    if (target === 'pending') return;
    pendingRestore = false;
    if (target !== undefined) navigate(target, { replace: true });
  }, [data, navigate]);
}
