import { cn } from 'cn';
import { Check, Folder, Plus } from 'lucide-react';
import { type CSSProperties, type ReactNode, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isChats, projectsOf, recentWorkspaces, type WorkspaceEntry } from '@/data/workbench-model';
import { useWorkspaceManagement } from '@/data/workspace-actions';
import { EnvironmentPicker } from '@/environments/environment-picker';
import { useEnvironments } from '@/environments/environments';
import { t } from '@/i18n';
import { abbreviateHome, parentDirectory } from '@/layout/rail-model';
import { openCreateProject } from '@/projects/create-project';

/** 各块依次淡入上移（U10）：居中的卡片、输入框，相隔 60 ms。 */
export const ENTER =
  'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 ease-smooth';

export function stagger(index: number): CSSProperties {
  return { animationDelay: `${index * 60}ms` };
}

/**
 * 还没有发起会话时的版式（U14，照 Codex 桌面端）：`hero`（最近的文件夹与环境）在内容区里上下左右居中，`footer`（输入框）贴在
 * 底部，宽度与位置同会话页的输入框，发出第一条消息、跳到会话页时输入框不挪地方。窗口矮到放不下时 `hero` 那一块可以滚动，
 * 输入框始终在底部。首页（routes/home-route.tsx）与新会话草稿页（session-view.tsx 的 DraftView）共用。
 */
export function NewSessionLayout({ hero, footer }: { hero: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex min-h-full flex-col items-center justify-center px-6 pt-10 pb-6">
          {hero}
        </div>
      </ScrollArea>
      <div
        className={cn('mx-auto w-full max-w-content shrink-0 px-6 pb-5', ENTER)}
        style={stagger(1)}
      >
        {footer}
      </div>
    </div>
  );
}

/**
 * 居中的那一块（照 Claude Code 桌面端的新会话页，维护者 2026-10-20 定）：只有一张卡片，上面是最近的文件夹，下面是“添加文件夹…”
 * 与“选择环境 ▾”。不放品牌与标题；不在目录中工作、创建项目从输入框上方环境栏的项目菜单选。
 */
export function NewSessionHero({
  current: selected,
  workspaces: all,
  onSelect,
}: {
  /** 选的项目；不在项目里（0.39.0）时省略，“对话”工作区也算不在项目里。 */
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
}) {
  const current = selected && !isChats(selected.workspace) ? selected : undefined;
  const workspaces = projectsOf(all);
  const environments = useEnvironments().supported;
  // 远程设备没有 `workspace.write`、或外壳选不了这台电脑上的文件夹时，没有“添加文件夹”。
  const canCreate = useWorkspaceManagement().create;
  const card = useRef<HTMLElement>(null);
  const row =
    'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-base outline-none transition-colors duration-150 hover:bg-muted focus-visible:focus-ring';
  const divider = <div className="mx-2 my-1 h-px bg-border" />;
  return (
    <nav
      ref={card}
      aria-label={t('home.recentFolders')}
      data-testid="recent-folders"
      className={cn('w-80 max-w-full rounded-xl border border-border bg-card p-1', ENTER)}
    >
      {workspaces.length > 0 && (
        <>
          <ul>
            {recentWorkspaces(workspaces).map(({ workspace }) => {
              const isCurrent = workspace.id === current?.workspace.id;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    aria-current={isCurrent || undefined}
                    title={workspace.rootPath}
                    onClick={() => onSelect(workspace.id)}
                    className={row}
                  >
                    <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="shrink-0">{workspace.displayName}</span>
                    <span
                      dir="rtl"
                      className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
                    >
                      <bdi dir="ltr">{abbreviateHome(parentDirectory(workspace.rootPath))}</bdi>
                    </span>
                    {isCurrent && <Check aria-hidden className="size-4 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {(canCreate || environments) && divider}
        </>
      )}
      {canCreate && (
        <button
          type="button"
          onClick={() => openCreateProject()}
          className={cn(row, 'text-muted-foreground hover:text-foreground')}
        >
          <Plus aria-hidden className="size-4 shrink-0" />
          {t('home.addFolder')}
        </button>
      )}
      {environments && (
        <>
          {canCreate && divider}
          <EnvironmentPicker
            current={current}
            onSelect={onSelect}
            anchor={card}
            className="h-9 w-full justify-center px-2"
          />
        </>
      )}
    </nav>
  );
}
