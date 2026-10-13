import { cn } from 'cn';
import { PanelRightClose } from 'lucide-react';
import { IconButton } from '@/components/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import {
  type RightPanelKey,
  type RightPanelTab,
  selectRightPanelTab,
  useRightPanelTabs,
} from './right-panel-tabs';

const TAB_LABELS: Record<RightPanelTab['type'], string> = {
  overview: t('rightPanel.tab.overview'),
};

/** 右栏：当前会话的一组标签。骨架只有“概览”占位。 */
export function RightPanel({
  panelKey,
  entry,
  onClose,
}: {
  panelKey: RightPanelKey;
  /** 当前路由所在的工作区；首页、未找到等页面没有。 */
  entry: WorkspaceEntry | undefined;
  /** 浮层时给出自己的关闭按钮（顶栏的开关被遮罩挡住）；停靠时由顶栏的开关收起。 */
  onClose?: () => void;
}) {
  const { tabs, activeIndex } = useRightPanelTabs(panelKey);
  const active = tabs[activeIndex];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="app-drag flex h-11 shrink-0 items-center gap-1 border-b border-sidebar-border px-2">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1">
          {tabs.map((tab, index) => (
            <button
              key={tab.type}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              onClick={() => selectRightPanelTab(panelKey, index)}
              className={cn(
                'h-7 rounded-md px-2.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                index === activeIndex && 'bg-sidebar-accent text-foreground',
              )}
            >
              {TAB_LABELS[tab.type]}
            </button>
          ))}
        </div>
        {onClose && (
          <IconButton label={t('layout.closeRightPanel')} onClick={onClose} tooltipSide="bottom">
            <PanelRightClose />
          </IconButton>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div role="tabpanel" className="space-y-6 p-4">
          {active?.type === 'overview' && <Overview entry={entry} />}
        </div>
      </ScrollArea>
    </div>
  );
}

function Overview({ entry }: { entry: WorkspaceEntry | undefined }) {
  if (!entry) {
    return <p className="text-sm text-muted-foreground">{t('rightPanel.noSession')}</p>;
  }
  return (
    <>
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('rightPanel.workspacePath')}
        </h3>
        <p className="font-mono text-sm break-all">{entry.workspace.rootPath}</p>
      </section>
      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">{t('rightPanel.files')}</h3>
        <p className="text-sm text-faint-foreground">{t('rightPanel.filesEmpty')}</p>
      </section>
    </>
  );
}
