import { cn } from 'cn';
import { Check, ChevronDown, Folder, Plus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { recentWorkspaces, type WorkspaceEntry } from '@/data/workbench-model';
import { MetalWordmark } from '@/fx/metal';
import { t } from '@/i18n';
import { abbreviateHome, parentDirectory } from '@/layout/rail-model';
import { openCreateProject } from '@/projects/create-project';
import { ProjectMenuContent } from '@/projects/project-menu';

/** 各块依次淡入上移（U10）：品牌行、标题、输入框，相隔 60 ms。 */
export const ENTER =
  'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 ease-smooth';

export function stagger(index: number): CSSProperties {
  return { animationDelay: `${index * 60}ms` };
}

/**
 * 还没有发起会话时的版式（U14，照 Codex 桌面端）：`hero`（品牌与标题）在内容区里上下左右居中，`footer`（输入框）贴在
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
        style={stagger(2)}
      >
        {footer}
      </div>
    </div>
  );
}

/**
 * 居中的那一块（方向稿 A 静器的 HomeA，U14 起居中排）：品牌主标与金属字标、宋体标题“今天在 [项目 ▾] 里做什么？”（项目是
 * 内联的下拉，与环境栏是同一个菜单）。U4 的“最近会话”已去掉（维护者 2026-10-15 定），会话都在左栏。
 */
export function NewSessionHero({
  current,
  workspaces,
  onSelect,
}: {
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <div className="flex w-full max-w-content flex-col items-center gap-5 text-center">
      <div className={cn('flex items-center gap-2.5', ENTER)} data-testid="home-brand">
        <BrandMark className="size-5.5 text-brand" />
        <MetalWordmark>{t('app.name')}</MetalWordmark>
      </div>
      <h1
        className={cn(
          'flex max-w-full flex-wrap items-baseline justify-center gap-x-[0.25em] font-display text-[clamp(1.625rem,3.4vw,2.5rem)] leading-tight font-medium tracking-[0.01em] text-balance',
          ENTER,
        )}
        style={stagger(1)}
      >
        {t('home.title.before')}
        <ProjectPicker current={current} workspaces={workspaces} onSelect={onSelect} />
        {t('home.title.after')}
      </h1>
      {workspaces.length > 0 && (
        <RecentFolders current={current} workspaces={workspaces} onSelect={onSelect} />
      )}
    </div>
  );
}

/**
 * 最近的文件夹（U22，desktop-layout.md §16；截图 01–02）：一键换到最近用过的项目，当前的打勾，最下面“添加文件夹…”。
 */
function RecentFolders({
  current,
  workspaces,
  onSelect,
}: {
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
}) {
  const row =
    'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-base outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50';
  return (
    <nav
      aria-label={t('home.recentFolders')}
      data-testid="recent-folders"
      className={cn('mt-1 w-80 max-w-full rounded-xl border border-border bg-card p-1', ENTER)}
      style={stagger(2)}
    >
      <ul>
        {recentWorkspaces(workspaces).map(({ workspace }) => {
          const selected = workspace.id === current?.workspace.id;
          return (
            <li key={workspace.id}>
              <button
                type="button"
                aria-current={selected || undefined}
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
                {selected && <Check aria-hidden className="size-4 shrink-0" />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mx-2 my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => openCreateProject()}
        className={cn(row, 'text-muted-foreground hover:text-foreground')}
      >
        <Plus aria-hidden className="size-4 shrink-0" />
        {t('home.addFolder')}
      </button>
    </nav>
  );
}

/** 标题里的项目名：内联的下拉（方向稿 .ws-inline），换项目，最下面可以去创建项目。 */
function ProjectPicker({
  current,
  workspaces,
  onSelect,
}: {
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="home-workspace"
        title={current?.workspace.rootPath}
        className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-xs border-b-[1.5px] border-dashed border-border-strong px-0.5 font-sans text-[0.86em] font-semibold text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:border-foreground"
      >
        <span className={cn('truncate', !current && 'text-muted-foreground')}>
          {current?.workspace.displayName ?? t('home.chooseProject')}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <ProjectMenuContent
        currentId={current?.workspace.id}
        workspaces={workspaces}
        onSelect={onSelect}
        align="center"
      />
    </DropdownMenu>
  );
}
