// 输入框上方的菜单（U33，照 T3 Code 的 ComposerCommandMenu，MIT，ec1313c；外形照 Codex 桌面端的斜杠菜单）：斜杠命令、命令
// 的二级菜单与 @ 提及共用。焦点一直在输入框里（上下键、回车、Tab、Esc 由输入框处理），菜单只画列表；指针悬停换高亮，按下
// 时不抢焦点。

import { cn } from 'cn';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

export interface MenuEntry {
  key: string;
  icon?: ReactNode;
  label: string;
  /** 名称后面说明文字色的补充（文件所在的目录、模型所属的服务、当前值）。 */
  detail?: string;
  /** 最右边等宽的提示（`/model`）。 */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  /** 有二级菜单，右边一个箭头。 */
  nested?: boolean;
}

export function menuOptionId(listId: string, key: string): string {
  return `${listId}-${encodeURIComponent(key)}`;
}

export function ComposerMenu({
  listId,
  label,
  entries,
  active,
  title,
  empty,
  onBack,
  onActive,
  onSelect,
}: {
  listId: string;
  /** 读屏用的列表名称。 */
  label: string;
  entries: readonly MenuEntry[];
  active: number;
  /** 二级菜单的标题（命令名），左边带返回。 */
  title?: string;
  /** 没有项时显示的短语。 */
  empty: string;
  onBack?: () => void;
  onActive: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeKey = entries[active]?.key;

  useLayoutEffect(() => {
    if (activeKey === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${CSS.escape(menuOptionId(listId, activeKey))}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, listId]);

  return (
    <div
      data-testid="composer-menu"
      className="absolute inset-x-0 bottom-full z-30 mb-2 flex max-h-80 flex-col overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in duration-150 ease-smooth fade-in slide-in-from-bottom-1"
    >
      {title !== undefined && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <button
            type="button"
            aria-label={title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-lg px-1.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
            {title}
          </button>
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        className="min-h-0 overflow-y-auto p-1.5"
      >
        {entries.length === 0 ? (
          <p className="px-2 py-2.5 text-xs text-muted-foreground">{empty}</p>
        ) : (
          entries.map((entry, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive: 焦点留在输入框里，选项经 aria-activedescendant 指向，键盘由输入框处理。
            // biome-ignore lint/a11y/useKeyWithClickEvents: 同上。
            <div
              key={entry.key}
              id={menuOptionId(listId, entry.key)}
              role="option"
              aria-selected={index === active}
              aria-disabled={entry.disabled || undefined}
              data-menu-entry={entry.key}
              onMouseMove={() => index !== active && onActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => !entry.disabled && onSelect(index)}
              className={cn(
                'flex h-8 cursor-default items-center gap-2 rounded-lg px-2 text-sm select-none',
                index === active && 'bg-muted',
                entry.disabled && 'text-muted-foreground/70',
              )}
            >
              <span
                aria-hidden
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4"
              >
                {entry.icon}
              </span>
              <span className="max-w-[60%] shrink-0 truncate">{entry.label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {entry.detail}
              </span>
              {entry.hint && (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {entry.hint}
                </span>
              )}
              {entry.checked && <Check aria-hidden className="size-4 shrink-0" />}
              {entry.nested && (
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
