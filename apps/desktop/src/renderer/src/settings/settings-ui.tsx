import { cn } from 'cn';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { t } from '@/i18n';

export interface Notice {
  tone: 'success' | 'error' | 'warning' | 'info';
  text: string;
}

const NOTICE_ICON_COLOR: Record<Notice['tone'], string> = {
  success: 'text-icon-success',
  error: 'text-icon-danger',
  warning: 'text-icon-warning',
  info: 'text-muted-foreground',
};

/** 设置页里一次操作的结果（添加了、保存了、失败了），显示在列表上方。 */
export function NoticeBanner({
  notice,
  className,
}: {
  notice: Notice | undefined;
  className?: string;
}) {
  const [shown, setShown] = useState(notice);
  if (notice && notice !== shown) setShown(notice);
  const Icon =
    shown?.tone === 'success'
      ? CircleCheck
      : shown?.tone === 'info'
        ? Info
        : shown?.tone === 'warning'
          ? TriangleAlert
          : CircleAlert;
  return (
    <Collapse open={notice !== undefined} motion="height">
      {shown && (
        <p
          role={shown.tone === 'error' ? 'alert' : 'status'}
          className={cn('flex items-start gap-2 text-sm text-soft-foreground', className)}
        >
          <Icon
            className={cn('mt-0.5 size-4 shrink-0', NOTICE_ICON_COLOR[shown.tone])}
            aria-hidden
          />
          <span className="min-w-0 break-words">{shown.text}</span>
        </p>
      )}
    </Collapse>
  );
}

export function SettingsPlaceholder({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label={t('common.loading')}
      className={cn('flex min-h-14 items-center rounded-xl border border-border px-4', className)}
    >
      <div className="h-3 w-32 rounded-sm bg-muted" />
    </div>
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

export { Segmented } from '@/components/ui/tabs';

/** 卡片：表面色、分隔线、16px 圆角，行之间是细分隔线。 */
export const SETTINGS_CARD = 'rounded-xl border border-border bg-card';
export const LIST_CARD = `divide-y divide-border ${SETTINGS_CARD}`;

/** 列表为空时的说明：虚线框。 */
export function EmptyList({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
