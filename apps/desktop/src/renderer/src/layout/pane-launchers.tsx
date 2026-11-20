// 工作台顶栏和窄窗浮层共用终端、浏览器与文件开关。首页、插件页沿用所选项目的草稿窗格集。

import { cn } from 'cn';
import { IconButton } from '@/components/icon-button';
import { useHostConnection } from '@/host/host-connection';
import { formatShortcut, useKeybindings } from '@/lib/shortcuts';
import { displayPanes } from './arrange';
import { usePaneAccess } from './pane-access';
import type { PaneController } from './pane-controller';
import { type PaneKind, paneKindUsable } from './pane-kinds';
import { paneIcon, paneKindName } from './pane-registry';
import { findKindTab } from './pane-state';

type LauncherKind = Extract<PaneKind, 'terminal' | 'browser' | 'files'>;

export const PANE_LAUNCHERS: readonly LauncherKind[] = ['terminal', 'browser', 'files'];

function launcherTab(panes: PaneController, kind: LauncherKind) {
  const shown = displayPanes(panes.auxShown ? panes.plan.tree : undefined);
  return findKindTab(
    panes.scope,
    kind,
    shown.map((pane) => pane.activeTabId),
  );
}

/** 打开快捷键始终显示对应窗格。 */
export function showPaneKind(panes: PaneController, kind: LauncherKind): void {
  const found = launcherTab(panes, kind);
  if (found) panes.activate(found.tab.id);
  else panes.open({ kind });
}

export function PaneLaunchers({ panes }: { panes: PaneController | undefined }) {
  const { client } = useHostConnection();
  const access = usePaneAccess();
  const bindings = useKeybindings();
  return PANE_LAUNCHERS.filter(
    (kind) =>
      paneKindUsable(kind, access) && (kind !== 'terminal' || client?.supports('user_terminal')),
  ).map((kind) => {
    const Icon = paneIcon(kind);
    const shown = panes !== undefined && launcherTab(panes, kind)?.shown === true;
    return (
      <IconButton
        key={kind}
        label={paneKindName(kind)}
        shortcut={formatShortcut(bindings[kind])}
        aria-pressed={shown}
        className={cn(shown && 'bg-accent')}
        disabled={panes === undefined}
        onClick={() => panes && (shown ? panes.collapseKind(kind) : showPaneKind(panes, kind))}
        tooltipSide="bottom"
        data-testid={`launch-${kind}`}
      >
        <Icon />
      </IconButton>
    );
  });
}
