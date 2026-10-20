import { cn } from 'cn';
import { Check, ChevronDown, Layers, Pencil, Plus } from 'lucide-react';
import type { RefObject } from 'react';
import { COMPACT_DETAIL, COMPACT_ICON, COMPACT_ITEM } from '@/components/compact-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { t } from '@/i18n';
import { openEnvironmentDialog } from './environment-dialog';
import {
  chooseEnvironment,
  environmentSummary,
  useActiveEnvironment,
  useEnvironments,
} from './environments';

/**
 * 新会话页的“选择环境 ▾”（U22.1，desktop-layout.md §16；截图 01–02 的 Choose environment）：保存的环境、不用环境、新建环境。
 * 选了环境就换到它的主文件夹。Host 没有 `environments` 时不出现。给了 `anchor` 时菜单贴着它的下沿、与它同宽（新会话页的卡片）。
 */
export function EnvironmentPicker({
  current,
  onSelect,
  className,
  anchor,
}: {
  current: WorkspaceEntry | undefined;
  onSelect: (workspaceId: string) => void;
  /** 触发按钮的额外样式（新会话页的卡片里占满一行）。 */
  className?: string;
  /** 菜单对齐的元素；省略时对齐触发按钮。 */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const { supported, environments } = useEnvironments();
  const active = useActiveEnvironment(current?.workspace.id);
  if (!supported) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="environment-picker"
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:text-foreground',
          className,
        )}
      >
        {active ? active.name : t('env.choose')}
        <ChevronDown aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        anchor={anchor}
        className={anchor ? undefined : 'w-auto max-w-80 min-w-56'}
      >
        {environments.map((environment) => (
          <DropdownMenuItem
            key={environment.id}
            closeOnClick
            onClick={() => {
              chooseEnvironment(environment.id);
              const primary = environment.folders[0]?.workspaceId;
              if (primary) onSelect(primary);
            }}
            className={cn(COMPACT_ITEM, 'group/env pr-1')}
          >
            <Layers aria-hidden className={COMPACT_ICON} />
            <span className="max-w-36 shrink-0 truncate">{environment.name}</span>
            <span className={COMPACT_DETAIL}>{environmentSummary(environment)}</span>
            {active?.id === environment.id && <Check aria-hidden />}
            <button
              type="button"
              aria-label={t('env.edit')}
              onClick={(event) => {
                event.stopPropagation();
                openEnvironmentDialog(environment);
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/env:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
            >
              <Pencil aria-hidden className="size-3" />
            </button>
          </DropdownMenuItem>
        ))}
        {environments.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          closeOnClick
          onClick={() => chooseEnvironment(null)}
          className={COMPACT_ITEM}
        >
          <span className="size-3.5 shrink-0" />
          <span className="flex-1">{t('env.none')}</span>
          {!active && <Check aria-hidden />}
        </DropdownMenuItem>
        <DropdownMenuItem
          closeOnClick
          onClick={() => openEnvironmentDialog()}
          className={COMPACT_ITEM}
        >
          <Plus aria-hidden className={COMPACT_ICON} />
          {t('env.create')}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
