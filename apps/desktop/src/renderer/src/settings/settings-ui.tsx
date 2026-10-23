import { cn } from 'cn';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import type { WorkbenchData } from '@/data/workbench-model';
import { t } from '@/i18n';

export interface Notice {
  tone: 'success' | 'error' | 'warning' | 'info';
  text: string;
}

const NOTICE_STYLE: Record<Notice['tone'], string> = {
  success: 'bg-success/10 text-success',
  error: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-muted text-muted-foreground',
};

/** 设置页里一次操作的结果（添加了、保存了、失败了），显示在列表上方。 */
export function NoticeBanner({ notice }: { notice: Notice }) {
  const Icon =
    notice.tone === 'success' ? CircleCheck : notice.tone === 'info' ? Info : CircleAlert;
  return (
    <p
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-sm break-words animate-in fade-in slide-in-from-top-1 duration-200 ease-smooth',
        NOTICE_STYLE[notice.tone],
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{notice.text}</span>
    </p>
  );
}

/** 列表还没读到（或读失败）时的设置页内容。 */
export function SettingsLoading({ data }: { data: Exclude<WorkbenchData, { status: 'ready' }> }) {
  return data.status === 'error' ? (
    <NoticeBanner notice={{ tone: 'error', text: data.error }} />
  ) : (
    <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  );
}

// U4 起设置页照方向稿「A 静器」，U7 起照 Codex 桌面端的设置：页面标题下面是一组组卡片，每组上面一行小标题；卡片是表面色、
// 12px 圆角，行与行之间是细分隔线，每行左边是名称与一行说明、右边是控件（SettingsRow）。

/** 设置页的一组：小标题（可带一行说明与右侧的操作），下面是内容（通常是卡片）。 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  ...rest
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<ComponentProps<'section'>, 'title' | 'children'>) {
  return (
    <section className={cn('mb-9 last:mb-0', className)} {...rest}>
      {(title || description || action) && (
        <div className="mb-2.5 flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <div className={cn('text-xs text-muted-foreground', title && 'mt-0.5')}>
                {description}
              </div>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 卡片里的一行：左边名称与说明，右边控件（Codex 设置的行）。行太窄放不下控件时，控件折到名称下面。 */
export function SettingsRow({
  title,
  description,
  control,
  className,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  className?: string;
} & Omit<ComponentProps<'div'>, 'title'>) {
  return (
    <div
      className={cn('flex min-h-14 flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3', className)}
      {...rest}
    >
      <div className="min-w-0 flex-1 basis-36">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {control !== undefined && (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{control}</div>
      )}
    </div>
  );
}

/**
 * 分段切换（主题、回合进行中按回车）：轨道是次表面色，选中的一段是滑块色，滑块在两段之间滑动（宽度按选项均分），
 * 走 press 弹簧（同输入框里的“插话 | 排队”，desktop-tokens.md §62）。
 * 与输入框里的“插话 | 排队”同一套颜色。
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <fieldset
      className="relative inline-grid rounded-lg bg-muted p-0.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      disabled={disabled}
    >
      <legend className="sr-only">{label}</legend>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-switch-thumb shadow-xs ring-1 ring-border transition-transform duration-(--spring-press-duration) ease-spring-press"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={checked}
            data-segment={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative z-10 inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-3 text-xs whitespace-nowrap outline-none transition-colors duration-150 focus-visible:focus-ring disabled:opacity-60 [&_svg]:size-3.5',
              checked
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** 卡片：表面色、分隔线、12px 圆角，行之间是细分隔线。 */
export const LIST_CARD = 'divide-y divide-border rounded-xl border border-border bg-card';

/** 列表为空时的说明：虚线框。 */
export function EmptyList({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
