// 插件页三个分段共用的列表行与详情里的小块（0.42.0，desktop-layout.md §23、desktop-tokens.md §52）。

import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Collapse } from '@/components/collapse';

/**
 * 可展开的列表行：整行是一个撑满的按钮（图标、名称与说明、摘要、展开箭头），开关等控件在按钮之外的右端，点它们不触发展开；
 * 展开的详情在行下面，上面一道分隔线、画布色 40% 的底。同一张列表里一次只展开一行（由调用方管）。
 */
export function ExpandableRow({
  id,
  expanded,
  onToggle,
  leading,
  title,
  meta,
  summary,
  control,
  children,
}: {
  /** 列表项的 ID，只用作 data 属性，给测试与脚本找行。 */
  id: string;
  expanded: boolean;
  onToggle: () => void;
  leading?: ReactNode;
  title: ReactNode;
  /** 名称下面一行的说明文字。 */
  meta?: ReactNode;
  /** 名称右边的摘要（数量、状态），窄屏时隐藏。 */
  summary?: ReactNode;
  control?: ReactNode;
  children: ReactNode;
}) {
  const detailId = useId();
  return (
    <li data-plugin-row={id} data-expanded={expanded || undefined}>
      <div className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/50">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
          data-action="toggle-row"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {leading}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{title}</span>
            {meta && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>
            )}
          </span>
          {summary && (
            <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:block">
              {summary}
            </span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-smooth',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      <Collapse open={expanded} id={detailId}>
        <div className="space-y-4 border-t border-border bg-background/40 px-4 py-4">
          {children}
        </div>
      </Collapse>
    </li>
  );
}

/** 详情里的一块：小标题加内容。 */
export function DetailSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** 配置、路径这类等宽字内容：内凹的次表面色底，一项一行。 */
export function MonoBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 一行“名称  值”，值是密钥时写“已设置”。 */
export function ConfigLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** 详情最下面靠左的一排操作（卸载、删除、编辑）。 */
export function DetailActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>;
}
