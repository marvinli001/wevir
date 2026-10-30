// 会话里的 agent 请界面显示的东西（0.30.0，应用级工具的 `wevir_show`，desktop-layout.md §20）：会话视图看到新的 `ui.show` 时
// 打开对应的窗格。只对打开会话之后新到的打开：订阅从头回放的历史里也有，按时刻跳过旧的。0.140.0 的会话侧栏卡片例外：历史里请求过的
// 卡片在这个会话里一直显示（投影的 railCards），只有展开与露出侧栏按这里的规则。

import type { Session, SessionId, UiShowTarget } from '@wevir/protocol';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { openChanges } from '@/changes/changes-store';
import { openFile, openFiles } from '@/files/files-store';
import { revealRailCard } from '@/layout/layout-state';
import type { PaneController } from '@/layout/pane-controller';
import { isSettingsTab, paths } from '@/routes/paths';

/** 比这早的 `ui.show` 当作历史，不再打开。 */
export const UI_SHOW_FRESH_MS = 15_000;

/** 是否该打开：还没处理过的（`seq` 更大），而且是刚发生的。 */
export function shouldShow(
  show: { seq: number; ts: string },
  handledSeq: number | undefined,
  now: number,
): boolean {
  if (handledSeq !== undefined && show.seq <= handledSeq) return false;
  return now - Date.parse(show.ts) <= UI_SHOW_FRESH_MS;
}

/**
 * 设置页（0.136.0）的路径：设置的分页或插件页；这个版本没有的页是 `undefined`，不打开。
 */
export function settingsPath(page: string): string | undefined {
  if (page === 'plugins') return paths.plugins();
  return isSettingsTab(page) ? paths.settings(page) : undefined;
}

/**
 * 打开 `target` 对应的窗格；`sessionTitle` 是要显示的会话的标题（窗格标签用），`navigate` 换到设置页用。
 */
export function showTarget(
  panes: PaneController,
  sessionId: SessionId,
  target: UiShowTarget,
  sessionTitle?: string,
  navigate?: (path: string) => void,
): void {
  switch (target.kind) {
    case 'file':
      openFile(panes, target.path, target.line);
      return;
    case 'files':
      openFiles(panes);
      return;
    case 'changes':
      openChanges(panes, sessionId, { kind: 'uncommitted' });
      return;
    case 'session':
      panes.open({
        kind: 'session',
        params: {
          sessionId: target.sessionId,
          ...(sessionTitle !== undefined && sessionTitle !== '' && { label: sessionTitle }),
        },
      });
      return;
    case 'settings': {
      const path = settingsPath(target.page);
      if (path !== undefined) navigate?.(path);
      return;
    }
    case 'card':
      // 卡片本身由投影的 railCards 显示出来（session-rail.tsx）；这里展开它、露出侧栏。
      revealRailCard(target.card);
      return;
  }
}

/**
 * 会话视图用：`uiShow` 是投影里最近一次的 `ui.show`。换会话时重新开始计；`titleOf` 取要显示的会话的标题。
 */
export function useUiShow(
  session: Session,
  uiShow: { seq: number; ts: string; target: UiShowTarget } | undefined,
  panes: PaneController | undefined,
  titleOf: (sessionId: SessionId) => string | undefined,
): void {
  const navigate = useNavigate();
  const handled = useRef<{ sessionId: SessionId; seq: number | undefined }>({
    sessionId: session.id,
    seq: undefined,
  });
  useEffect(() => {
    if (handled.current.sessionId !== session.id) {
      handled.current = { sessionId: session.id, seq: undefined };
    }
    if (!panes || uiShow === undefined) return;
    if (!shouldShow(uiShow, handled.current.seq, Date.now())) {
      handled.current.seq = Math.max(handled.current.seq ?? 0, uiShow.seq);
      return;
    }
    handled.current.seq = uiShow.seq;
    const { target } = uiShow;
    showTarget(
      panes,
      session.id,
      target,
      target.kind === 'session' ? titleOf(target.sessionId) : undefined,
      (path) => void navigate(path),
    );
  }, [session.id, uiShow, panes, titleOf, navigate]);
}
