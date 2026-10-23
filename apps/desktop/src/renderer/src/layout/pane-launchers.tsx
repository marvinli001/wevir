// 顶栏右侧的“终端”“浏览器”“文件”按钮（照 Claude Code 桌面端）：这几种窗格都在窗格区里，常用到值得一键打开。

import { cn } from 'cn';
import { IconButton } from '@/components/icon-button';
import { useHostConnection } from '@/host/host-connection';
import { formatShortcut, SHORTCUTS, type Shortcut } from '@/lib/shortcuts';
import { usePaneAccess } from './pane-access';
import type { PaneController } from './pane-controller';
import { type PaneKind, paneKindUsable } from './pane-kinds';
import { paneIcon, paneKindName } from './pane-registry';
import { findKindTab } from './pane-state';

type LauncherKind = Extract<PaneKind, 'terminal' | 'browser' | 'files'>;

export const PANE_LAUNCHERS: readonly { kind: LauncherKind; shortcut: Shortcut }[] = [
  { kind: 'terminal', shortcut: SHORTCUTS.terminal },
  { kind: 'browser', shortcut: SHORTCUTS.browser },
  { kind: 'files', shortcut: SHORTCUTS.files },
];

/** 显示这种窗格：已经开着就切过去（终端有几个时取正显示着的、否则第一个），没有就新开一个。 */
export function showPaneKind(panes: PaneController, kind: LauncherKind): void {
  const found = findKindTab(panes.scope, kind);
  if (found) panes.activate(found.tab.id);
  else panes.open({ kind });
}

export function PaneLaunchers({ panes }: { panes: PaneController }) {
  const { client } = useHostConnection();
  const access = usePaneAccess();
  return PANE_LAUNCHERS.filter(
    ({ kind }) =>
      paneKindUsable(kind, access) && (kind !== 'terminal' || client?.supports('user_terminal')),
  ).map(({ kind, shortcut }) => {
    const Icon = paneIcon(kind);
    // 按下的样子：这种窗格正显示着（窗格区看得见、是某个窗格当前的标签）。
    const shown = panes.auxShown && findKindTab(panes.scope, kind)?.shown === true;
    return (
      <IconButton
        key={kind}
        label={paneKindName(kind)}
        shortcut={formatShortcut(shortcut)}
        aria-pressed={shown}
        className={cn(shown && 'bg-accent')}
        onClick={() => showPaneKind(panes, kind)}
        tooltipSide="bottom"
        data-testid={`launch-${kind}`}
      >
        <Icon />
      </IconButton>
    );
  });
}
