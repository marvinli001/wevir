import type { PermissionMode } from '@wevir/protocol';
import { cn } from 'cn';
import { Hand, type LucideIcon, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type PlainMessageKey, t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';

/** 三种权限模式，按菜单里的先后（protocol 0.11.0 的 `PermissionMode`）。 */
const MODES: readonly PermissionMode[] = ['on_request', 'auto_review', 'full_access'];

const META: Record<
  PermissionMode,
  { icon: LucideIcon; label: PlainMessageKey; description: PlainMessageKey }
> = {
  on_request: {
    icon: Hand,
    label: 'permission.on_request',
    description: 'permission.on_request.description',
  },
  auto_review: {
    icon: ShieldCheck,
    label: 'permission.auto_review',
    description: 'permission.auto_review.description',
  },
  full_access: {
    icon: ShieldAlert,
    label: 'permission.full_access',
    description: 'permission.full_access.description',
  },
};

/** 新会话用的权限模式（U15）：本机记住上次选的，首页与草稿页共用；默认请求批准。 */
const lastMode = createPersistedStore<PermissionMode>(
  'wevir.permission-mode.v1',
  'on_request',
  (raw) => (MODES.includes(raw as PermissionMode) ? (raw as PermissionMode) : undefined),
);

export function usePermissionChoice() {
  return { mode: lastMode.use(), choose: (next: PermissionMode) => lastMode.set(next) };
}

/**
 * 输入框左下角的权限模式（U15，照 Codex 桌面端的“完全访问”芯片）：芯片写着当前模式，完全访问用警示色；点开是三种模式，
 * 每种一行图标、名称与说明，当前的打勾。新会话（首页、草稿页）选的是建会话时用的；已有会话经 `session.configure`
 * （0.11.0）从下一个回合起生效。Host 不支持（没有 `permission_modes`）或会话只读时只显示。
 */
export function PermissionPicker({
  value,
  readOnly = false,
  onChange,
}: {
  value: PermissionMode;
  readOnly?: boolean;
  onChange: (next: PermissionMode) => void;
}) {
  const { icon: Icon, label } = META[value];
  const warning = value === 'full_access';
  const chipClass = cn(
    'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs outline-none transition-colors duration-150',
    warning ? 'text-warning' : 'text-soft-foreground',
  );
  const chip = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{t(label)}</span>
    </>
  );
  if (readOnly) {
    return (
      <span className={chipClass} data-testid="permission-picker" data-mode={value}>
        {chip}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              data-testid="permission-picker"
              data-mode={value}
              aria-label={t('permission.label', { mode: t(label) })}
              className={cn(
                chipClass,
                'focus-visible:ring-2 focus-visible:ring-ring/50',
                warning
                  ? 'hover:bg-warning/10 aria-expanded:bg-warning/10'
                  : 'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
              )}
            />
          }
        >
          {chip}
        </TooltipTrigger>
        <TooltipContent>{t('permission.change')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-80 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t('permission.title')}</p>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next: PermissionMode) => onChange(next)}
        >
          {MODES.map((mode) => {
            const meta = META[mode];
            const ModeIcon = meta.icon;
            return (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                closeOnClick
                data-mode={mode}
                className={cn(
                  'items-start gap-2.5 py-2 pl-2',
                  mode === 'full_access' && 'text-warning focus:**:text-warning focus:text-warning',
                )}
              >
                <ModeIcon aria-hidden className="mt-0.5 size-4" />
                <span className="min-w-0">
                  <span className="block font-medium">{t(meta.label)}</span>
                  <span
                    className={cn(
                      'block text-xs',
                      mode === 'full_access' ? 'text-warning/85' : 'text-muted-foreground',
                    )}
                  >
                    {t(meta.description)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
