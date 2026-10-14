import { ScrollArea } from '@/components/ui/scroll-area';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';

/** “概览”窗格（由 T5.2 的右栏迁来）：工作区目录与本会话涉及的文件（占位）。 */
export function OverviewPane({ entry }: { entry: WorkspaceEntry | undefined }) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 px-4 pt-1 pb-4">
        {entry && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t('pane.overview.workspacePath')}
            </h3>
            <p className="font-mono text-sm break-all">{entry.workspace.rootPath}</p>
          </section>
        )}
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t('pane.overview.files')}</h3>
          <p className="text-sm text-faint-foreground">{t('pane.overview.filesEmpty')}</p>
        </section>
      </div>
    </ScrollArea>
  );
}
