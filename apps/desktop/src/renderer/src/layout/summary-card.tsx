import { cn } from 'cn';
import { Ellipsis, Pin } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { PANE_LAYOUT } from './arrange';
import { layoutPrefs } from './layout-state';

/**
 * 置顶摘要的一节（desktop-layout.md §3.8）：变更、子智能体、后台任务、计划由各自的任务登记。`useContent` 是
 * React hook，返回这一节的内容（点它通常经 usePanes() 打开对应的窗格），没有东西可显示时返回 null。
 */
export interface SummarySection {
  id: string;
  /** 卡片里从上到下的顺序：变更 10、子智能体 20、后台任务 30、计划 40。 */
  order: number;
  useContent: (sessionId: string) => ReactNode | null;
}

const sections: SummarySection[] = [];

/** 在模块加载时调用；渲染开始后再登记会打乱 hook 的调用顺序。 */
export function registerSummarySection(section: SummarySection): void {
  sections.push(section);
  sections.sort((a, b) => a.order - b.order);
}

/** 当前会话有内容的各节。R12 只做框架，还没有任何一节，所以总是空的。 */
export function useSummarySections(
  sessionId: string | undefined,
): { id: string; content: ReactNode }[] {
  const result: { id: string; content: ReactNode }[] = [];
  for (const section of sections) {
    // biome-ignore lint/correctness/useHookAtTopLevel: 登记表在模块加载时就定了，每次渲染调用的 hook 个数与顺序都一样。
    const content = section.useContent(sessionId ?? '');
    if (sessionId !== undefined && content !== null) result.push({ id: section.id, content });
  }
  return result;
}

function CardBody({ workspaceName, content }: { workspaceName: string; content: ReactNode[] }) {
  return (
    <>
      <div className="flex h-7 items-center justify-between pl-1">
        <span className="truncate text-sm text-muted-foreground">{workspaceName}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label={t('summary.more')} size="icon-xs">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              onClick={() => layoutPrefs.set((prefs) => ({ ...prefs, summaryPinned: false }))}
            >
              {t('summary.hide')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="space-y-3 pt-1">{content}</div>
    </>
  );
}

/** 浮在主窗格右上角的卡片：开着、有内容、主窗格够宽（≥ 560）时显示（截图 02）。 */
export function SummaryCard({
  sessionId,
  workspaceName,
  primaryWidth,
}: {
  sessionId: string | undefined;
  workspaceName: string;
  primaryWidth: number;
}) {
  const { summaryPinned } = layoutPrefs.use();
  const items = useSummarySections(sessionId);
  if (!summaryPinned || items.length === 0 || primaryWidth < PANE_LAYOUT.summaryMinPrimaryWidth) {
    return null;
  }
  return (
    <aside
      aria-label={t('summary.toggle')}
      className="absolute top-3 right-4 z-10 w-[300px] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-md"
    >
      <CardBody workspaceName={workspaceName} content={items.map((item) => item.content)} />
    </aside>
  );
}

/**
 * 顶栏的“置顶摘要”按钮（截图 08）：主窗格够宽时切换卡片（全局偏好）；不够宽时以弹出框显示同样的内容；没有内容时
 * 不可用。
 */
export function SummaryToggle({
  sessionId,
  workspaceName,
  primaryWidth,
}: {
  sessionId: string | undefined;
  workspaceName: string;
  primaryWidth: number;
}) {
  const { summaryPinned } = layoutPrefs.use();
  const items = useSummarySections(sessionId);
  const empty = items.length === 0;
  const button = (
    <IconButton
      label={empty ? t('summary.empty') : t('summary.toggle')}
      aria-pressed={!empty && summaryPinned}
      // 不可用时仍能悬停与聚焦，提示里说明为什么。
      disabled={empty}
      focusableWhenDisabled
      tooltipSide="bottom"
      className={cn('aria-disabled:opacity-50', !empty && summaryPinned && 'bg-accent')}
      onClick={
        primaryWidth >= PANE_LAYOUT.summaryMinPrimaryWidth
          ? () => layoutPrefs.set((prefs) => ({ ...prefs, summaryPinned: !prefs.summaryPinned }))
          : undefined
      }
    >
      <Pin />
    </IconButton>
  );
  if (empty || primaryWidth >= PANE_LAYOUT.summaryMinPrimaryWidth) return button;
  return (
    <Popover>
      <PopoverTrigger render={button} />
      <PopoverContent align="end" className="w-[300px] gap-0 rounded-xl p-3">
        <CardBody workspaceName={workspaceName} content={items.map((item) => item.content)} />
      </PopoverContent>
    </Popover>
  );
}
