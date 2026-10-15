import type { ProviderProfile, Session, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, SquareMenu } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { Collapse } from '@/components/collapse';
import { IconButton } from '@/components/icon-button';
import { useWorkbenchData } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { useWorkspaceGit, type WorkspaceGitState } from '@/data/workspace-git';
import { t } from '@/i18n';
import { layoutPrefs, toggleRailCard } from './layout-state';

/** 卡片拿到的上下文：当前会话、它的项目、Provider 列表与项目的 git 状态。 */
export interface RailContext {
  sessionId: SessionId;
  session: Session;
  entry: WorkspaceEntry;
  providers: readonly ProviderProfile[];
  git: WorkspaceGitState;
}

export interface RailCardContent {
  /** 收起时标题行右边的一句摘要。 */
  summary?: ReactNode;
  /** 展开的明细。 */
  details: ReactNode;
}

/**
 * 会话侧栏的一张卡片（desktop-layout.md §12，取代 R12 置顶摘要的 `registerSummarySection`）。`useCard` 是 React hook，
 * 返回 null 时这张卡片现在不显示。
 */
export interface RailCard {
  id: string;
  /** 从上到下：环境 10、上下文 20、变更 30、后台任务 40。 */
  order: number;
  title: () => string;
  useCard: (context: RailContext) => RailCardContent | null;
}

const cards: RailCard[] = [];

/**
 * 在模块加载时调用；渲染开始后再登记会打乱 hook 的调用顺序。同一个 `id` 再登记是替换（开发模式的热更新会重新执行
 * 登记它的模块），卡片数不变。
 */
export function registerRailCard(card: RailCard): void {
  const index = cards.findIndex((existing) => existing.id === card.id);
  if (index >= 0) cards[index] = card;
  else cards.push(card);
  cards.sort((a, b) => a.order - b.order);
}

/**
 * 侧栏的内容：竖排的卡片，多了在这一列里滚动。`visible` 为 false（收起着、浮层关着）时仍渲染（开合有宽度过渡），但不读
 * git 状态。
 */
export function SessionRail({
  sessionId,
  session,
  entry,
  visible,
}: {
  sessionId: SessionId;
  session: Session;
  entry: WorkspaceEntry;
  visible: boolean;
}) {
  const data = useWorkbenchData();
  const { railOpen } = layoutPrefs.use();
  // 回合结束（离开 running）时重读一次，改动多半刚发生。
  // 环境会话新开了 worktree 时读它（0.15.0），否则读工作区目录。
  const git = useWorkspaceGit(entry.workspace.id, {
    active: visible,
    refreshKey: session.state,
    ...(session.worktrees !== undefined && { sessionId }),
  });
  const context: RailContext = {
    sessionId,
    session,
    entry,
    providers: data.status === 'ready' ? data.providers : [],
    git,
  };
  const items: { card: RailCard; content: RailCardContent }[] = [];
  for (const card of cards) {
    // biome-ignore lint/correctness/useHookAtTopLevel: 登记表在模块加载时就定了，每次渲染调用的 hook 个数与顺序都一样。
    const content = card.useCard(context);
    if (content) items.push({ card, content });
  }
  return (
    <aside
      aria-label={t('rail.label')}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-2 pr-2 [scrollbar-width:thin]"
      data-testid="session-rail"
    >
      {items.map(({ card, content }) => (
        <RailCardView
          key={card.id}
          id={card.id}
          title={card.title()}
          content={content}
          open={railOpen.includes(card.id)}
        />
      ))}
    </aside>
  );
}

function RailCardView({
  id,
  title,
  content,
  open,
}: {
  id: string;
  title: string;
  content: RailCardContent;
  open: boolean;
}) {
  return (
    <section
      aria-label={title}
      className="shrink-0 rounded-xl border border-border bg-background"
      data-testid={`rail-card-${id}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggleRailCard(id)}
        className="flex h-10 w-full items-center gap-1 rounded-xl px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="shrink-0 font-medium">{title}</span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-smooth',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-2 flex-1" />
        {!open && content.summary && (
          <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
            {content.summary}
          </span>
        )}
      </button>
      <Collapse open={open}>
        <div className="px-3 pb-3 text-sm">{content.details}</div>
      </Collapse>
    </section>
  );
}

/** 顶栏的开关（截图 10、11 的“Hide session rail”）。 */
export function RailToggle({
  shown,
  onToggle,
  ref,
}: {
  shown: boolean;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <IconButton
      ref={ref}
      label={t(shown ? 'rail.hide' : 'rail.show')}
      aria-pressed={shown}
      className={cn(shown && 'bg-accent')}
      onClick={onToggle}
      tooltipSide="bottom"
      data-testid="rail-toggle"
    >
      <SquareMenu />
    </IconButton>
  );
}
