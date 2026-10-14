import { X } from 'lucide-react';
import { Fragment, type KeyboardEvent } from 'react';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { formatShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { usePanes } from './pane-controller';
import { openableKinds } from './pane-kinds';
import { paneIcon, paneKindName, paneTitle } from './pane-registry';
import { tabCount } from './pane-state';

/**
 * 顶栏右侧的计数按钮与“已打开的标签页”列表（desktop-layout.md §3.7，截图 07）：数字是当前会话打开的标签数，
 * 没有标签时不显示；点一行显示那个标签，Delete 或行尾的“×”关掉它；底部是“打开窗格”。
 */
export function OpenTabsMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panes = usePanes();
  if (!panes) return null;
  const count = tabCount(panes.scope);
  if (count === 0) return null;
  const closeOnDelete = (event: KeyboardEvent, tabId: string) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    panes.closeTab(tabId);
  };
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <IconButton
            label={t('layout.openTabsCount', { count })}
            shortcut={formatShortcut(SHORTCUTS.openTabs)}
            tooltipSide="bottom"
          >
            <span
              aria-hidden
              className="flex h-4 min-w-4 items-center justify-center rounded-sm border-[1.5px] border-current px-0.5 text-[10px] leading-none font-semibold tabular-nums"
            >
              {count}
            </span>
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('layout.openTabs')}</DropdownMenuLabel>
          {panes.scope.groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.tabs.map((tab) => {
                const Icon = paneIcon(tab.kind);
                const title = paneTitle(tab);
                return (
                  <DropdownMenuItem
                    key={tab.id}
                    className="group/item"
                    onClick={() => panes.activate(tab.id)}
                    onKeyDown={(event) => closeOnDelete(event, tab.id)}
                  >
                    <Icon aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {/* 只给鼠标用的关闭按钮（菜单项里不能再嵌一个可聚焦的按钮）；键盘在这一行上按 Delete。 */}
                    <span
                      aria-hidden
                      title={t('pane.closeTab', { title })}
                      onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        panes.closeTab(tab.id);
                      }}
                      className="flex size-4 items-center justify-center rounded-sm opacity-0 group-hover/item:opacity-100 hover:bg-accent"
                    >
                      <X className="size-3" />
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </Fragment>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <OpenPaneSubmenu />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** “打开窗格 ▸”：能打开的种类，新开的自成一个窗格（§3.1）。 */
export function OpenPaneSubmenu() {
  const panes = usePanes();
  if (!panes) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{t('layout.openPane')}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {openableKinds(import.meta.env.DEV).map((kind) => {
          const Icon = paneIcon(kind);
          return (
            <DropdownMenuItem key={kind} onClick={() => panes.open({ kind })}>
              <Icon aria-hidden />
              {paneKindName(kind)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
