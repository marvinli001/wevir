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
import { useCan } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';

/** 三种权限模式，按菜单里的先后（protocol 0.11.0 的 `PermissionMode`）。 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'on_request',
  'auto_review',
  'full_access',
];
const MODES = PERMISSION_MODES;

export const PERMISSION_META: Record<PermissionMode, { icon: LucideIcon; label: PlainMessageKey }> =
  {
    on_request: {
      icon: Hand,
      label: 'permission.on_request',
    },
    auto_review: {
      icon: ShieldCheck,
      label: 'permission.auto_review',
    },
    full_access: {
      icon: ShieldAlert,
      label: 'permission.full_access',
    },
  };

/** 新会话用的权限模式（U15）：本机记住上次选的，首页与草稿页共用；默认请求批准。 */
const lastMode = createPersistedStore<PermissionMode>(
  'wevir.permission-mode.v1',
  'on_request',
  (raw) => (MODES.includes(raw as PermissionMode) ? (raw as PermissionMode) : undefined),
);

/** 可以关掉的权限模式（请求批准一直在）。 */
export type OptionalPermissionMode = Exclude<PermissionMode, 'on_request'>;

/**
 * 设置 → 常规 → 权限（照 Codex 桌面端）：输入框的权限菜单里出现哪几种模式，只存在本机，默认都有。关掉的模式不再能选；
 * 已经在用它的会话照样显示。
 */
export const permissionModePrefs = createPersistedStore<Record<OptionalPermissionMode, boolean>>(
  'wevir.permission-modes.v1',
  { auto_review: true, full_access: true },
  (raw) =>
    typeof raw === 'object' && raw !== null
      ? {
          auto_review: (raw as Record<string, unknown>).auto_review !== false,
          full_access: (raw as Record<string, unknown>).full_access !== false,
        }
      : undefined,
);

/**
 * 现在能选的模式（按菜单里的先后）。完全访问要 `policy.write`（0.98.0）：远程设备没有时不能选。
 */
export function allowedPermissionModes(
  prefs = permissionModePrefs.get(),
  policyWrite = true,
): readonly PermissionMode[] {
  return MODES.filter(
    (mode) => mode === 'on_request' || (prefs[mode] && (mode !== 'full_access' || policyWrite)),
  );
}

function useAllowedPermissionModes(): readonly PermissionMode[] {
  return allowedPermissionModes(permissionModePrefs.use(), useCan('policy.write'));
}

export function usePermissionChoice() {
  const allowed = useAllowedPermissionModes();
  const last = lastMode.use();
  // 上次选的模式在设置里关掉了（或这台设备不能用）：新会话回到请求批准。
  const mode = allowed.includes(last) ? last : 'on_request';
  return { mode, choose: (next: PermissionMode) => lastMode.set(next) };
}

/**
 * 输入框左下角的权限模式（U15，照 Codex 桌面端的“完全访问”芯片）：芯片写着当前模式，完全访问用警示色；点开是三种模式，
 * 每种一行图标、名称与说明，当前的打勾。新会话（首页、草稿页）选的是建会话时用的；已有会话经 `session.configure`
 * （0.11.0）从下一个回合起生效。Host 不支持（没有 `permission_modes`）或会话只读时只显示。
 */
export function PermissionPicker({
  value,
  modes = MODES,
  readOnly = false,
  onChange,
}: {
  value: PermissionMode;
  /** 能选的模式（0.25.0：接力后跟着当前的引擎）；默认三种都有。 */
  modes?: readonly PermissionMode[];
  readOnly?: boolean;
  onChange: (next: PermissionMode) => void;
}) {
  const { icon: Icon, label } = PERMISSION_META[value];
  const allowed = useAllowedPermissionModes();
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
                'focus-visible:focus-ring',
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
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-52 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t('permission.title')}</p>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next: PermissionMode) => onChange(next)}
        >
          {MODES.filter(
            (mode) => mode === value || (modes.includes(mode) && allowed.includes(mode)),
          ).map((mode) => {
            const meta = PERMISSION_META[mode];
            const ModeIcon = meta.icon;
            return (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                closeOnClick
                data-mode={mode}
                className={cn(
                  'gap-2.5 pl-2',
                  mode === 'full_access' && 'text-warning focus:**:text-warning focus:text-warning',
                )}
              >
                <ModeIcon aria-hidden className="size-4" />
                {t(meta.label)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
