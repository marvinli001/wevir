import { cn } from 'cn';
import { Columns2, Ellipsis, Maximize2, Minimize2, Plus, Rows2, X } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { formatShortcut, SHORTCUTS } from '@/lib/shortcuts';
import type { DisplayPane } from './arrange';
import { usePaneAccess } from './pane-access';
import { usePanes } from './pane-controller';
import { openableKinds, PANE_KIND_SPECS } from './pane-kinds';
import { PaneContent, type PaneContext, paneIcon, paneKindName, paneTitle } from './pane-registry';
import type { PaneTab } from './pane-state';

/**
 * 窗格（desktop-layout.md §3.6）：圆角卡片，窗格头左边是标题或标签条，右边是更多、最大化、关闭；双击窗格头的
 * 空白处最大化或还原。被折叠在一起的几个窗格显示成一个，标签条按原来的窗格分段。
 */
export function Pane({ pane, context }: { pane: DisplayPane; context: PaneContext }) {
  const panes = usePanes();
  if (!panes) return null;
  const active = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
  if (!active) return null;
  const maximized = panes.maximized === pane.id;
  const focused =
    panes.scope.focus[0] !== undefined && pane.groupIds.includes(panes.scope.focus[0]);
  const showTabs = pane.tabs.length > 1 || PANE_KIND_SPECS[active.kind].multiple;
  const title = paneTitle(active);
  const ActiveIcon = paneIcon(active.kind);

  const onHeaderDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    panes.toggleMaximize(pane.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !maximized) return;
    event.preventDefault();
    panes.toggleMaximize(pane.id);
  };

  return (
    <section
      aria-label={title}
      data-pane-id={pane.id}
      tabIndex={-1}
      onPointerDownCapture={() => panes.focus(pane.id)}
      onKeyDown={onKeyDown}
      className="surface-card flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden outline-none focus-visible:focus-field"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 双击窗格头最大化只是鼠标的便捷操作，键盘有最大化按钮与快捷键。 */}
      <header
        onDoubleClick={onHeaderDoubleClick}
        className={cn(
          'flex h-9 shrink-0 items-center gap-0.5 pr-1 pl-1.5 text-sm',
          focused ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {showTabs ? (
          <TabStrip pane={pane} />
        ) : (
          <h2 className="flex min-w-0 items-center gap-1.5 px-1.5 font-medium">
            <ActiveIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{title}</span>
          </h2>
        )}
        {showTabs && <NewTabMenu groupId={pane.id} />}
        <div className="min-w-2 flex-1 self-stretch" />
        <MoreMenu pane={pane} active={active} />
        <IconButton
          label={t(maximized ? 'pane.restore' : 'pane.maximize')}
          shortcut={formatShortcut(SHORTCUTS.maximize)}
          size="icon-xs"
          onClick={() => panes.toggleMaximize(pane.id)}
          tooltipSide="bottom"
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton
          label={t('pane.close')}
          size="icon-xs"
          onClick={() => panes.closeGroups(pane.groupIds)}
          tooltipSide="bottom"
        >
          <X />
        </IconButton>
      </header>
      <div role="tabpanel" aria-label={title} className="min-h-0 flex-1 overflow-hidden">
        <PaneContent key={active.id} tab={active} context={context} />
      </div>
    </section>
  );
}

/** 标签条：每个标签有图标、名称和关闭按钮；被并在一起的窗格之间画一条竖线。 */
function TabStrip({ pane }: { pane: DisplayPane }) {
  const panes = usePanes();
  if (!panes) return null;
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: PaneTab) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    panes.closeTab(tab.id);
  };
  return (
    <div
      role="tablist"
      className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
    >
      {pane.tabs.map((tab, index) => {
        const Icon = paneIcon(tab.kind);
        const selected = tab.id === pane.activeTabId;
        const title = paneTitle(tab);
        return (
          <div key={tab.id} className="flex shrink-0 items-center">
            {index > 0 && pane.segmentStarts.includes(index) && (
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            )}
            <div
              className={cn(
                'group/tab flex h-7 items-center rounded-lg transition-[background-color,box-shadow] duration-150 ease-smooth',
                selected
                  ? 'bg-selected ring-1 ring-selected-border ring-inset text-foreground'
                  : 'hover:bg-accent/60',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => panes.activate(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, tab)}
                className="flex h-full max-w-48 items-center gap-1.5 rounded-lg pr-1 pl-2 outline-none focus-visible:focus-ring"
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t('pane.closeTab', { title })}
                onClick={() => panes.closeTab(tab.id)}
                className={cn(
                  'mr-1 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                  !selected && 'opacity-0 group-hover/tab:opacity-100',
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** “＋”：选一个种类，加进这个窗格（截图 03）。 */
function NewTabMenu({ groupId }: { groupId: string }) {
  const panes = usePanes();
  const access = usePaneAccess();
  if (!panes) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label={t('pane.newTab')} size="icon-xs" tooltipSide="bottom">
            <Plus />
          </IconButton>
        }
      />
      <DropdownMenuContent className="w-44">
        {openableKinds(import.meta.env.DEV, access).map((kind) => {
          const Icon = paneIcon(kind);
          return (
            <DropdownMenuItem key={kind} onClick={() => panes.open({ kind, into: groupId })}>
              <Icon aria-hidden />
              {paneKindName(kind)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** “⋯”：拆分、移到别的窗格、关闭；折叠时说明合并了几个窗格。 */
function MoreMenu({ pane, active }: { pane: DisplayPane; active: PaneTab }) {
  const panes = usePanes();
  if (!panes) return null;
  const group = panes.scope.groups.find((candidate) =>
    candidate.tabs.some((tab) => tab.id === active.id),
  );
  const canSplit = (group?.tabs.length ?? 0) > 1;
  const others = panes.scope.groups.filter((candidate) => candidate.id !== group?.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label={t('pane.more')} size="icon-xs" tooltipSide="bottom">
            <Ellipsis />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-48">
        {pane.groupIds.length > 1 && (
          <>
            <DropdownMenuItem disabled>
              {t('pane.merged', { count: pane.groupIds.length })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem disabled={!canSplit} onClick={() => panes.split(active.id, 'right')}>
          <Columns2 aria-hidden />
          {t('pane.splitRight')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canSplit} onClick={() => panes.split(active.id, 'down')}>
          <Rows2 aria-hidden />
          {t('pane.splitDown')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={others.length === 0}>
            {t('pane.moveTo')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            {others.map((other) => {
              const shown = other.tabs.find((tab) => tab.id === other.activeTabId) ?? other.tabs[0];
              if (!shown) return null;
              const Icon = paneIcon(shown.kind);
              return (
                <DropdownMenuItem key={other.id} onClick={() => panes.move(active.id, other.id)}>
                  <Icon aria-hidden />
                  <span className="truncate">{paneTitle(shown)}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => panes.closeGroups(pane.groupIds)}>
          <X aria-hidden />
          {t('pane.close')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
