import { Check, ChevronDown, Pencil, Plus } from 'lucide-react';
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
 * 选了环境就换到它的主文件夹。Host 没有 `environments` 时不出现。
 */
export function EnvironmentPicker({
  current,
  onSelect,
}: {
  current: WorkspaceEntry | undefined;
  onSelect: (workspaceId: string) => void;
}) {
  const { supported, environments } = useEnvironments();
  const active = useActiveEnvironment(current?.workspace.id);
  if (!supported) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="environment-picker"
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:text-foreground"
      >
        {active ? active.name : t('env.choose')}
        <ChevronDown aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-80">
        {environments.map((environment) => (
          <DropdownMenuItem
            key={environment.id}
            closeOnClick
            onClick={() => {
              chooseEnvironment(environment.id);
              const primary = environment.folders[0]?.workspaceId;
              if (primary) onSelect(primary);
            }}
            className="group/env gap-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{environment.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {environmentSummary(environment)}
              </span>
            </span>
            {active?.id === environment.id && <Check aria-hidden className="size-4" />}
            <button
              type="button"
              aria-label={t('env.edit')}
              onClick={(event) => {
                event.stopPropagation();
                openEnvironmentDialog(environment);
              }}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/env:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
            >
              <Pencil aria-hidden className="size-3.5" />
            </button>
          </DropdownMenuItem>
        ))}
        {environments.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem closeOnClick onClick={() => chooseEnvironment(null)}>
          {t('env.none')}
          {!active && <Check aria-hidden className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem closeOnClick onClick={() => openEnvironmentDialog()}>
          <Plus aria-hidden className="size-4" />
          {t('env.create')}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
