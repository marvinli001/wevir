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
        'flex items-start gap-2 rounded-lg px-3 py-2 text-sm break-words',
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

// U4 起设置页照方向稿「A 静器」：页面标题下面按节排，节与节之间是细分隔线；列表放在表面色的卡片里，行与行之间也是
// 细分隔线；表单控件只经设计变量取色（tokens.css）。

/** 设置页的一节：标题（可带说明与右侧的操作），下面是内容。没有标题时只有说明与操作（只有一节的页面）。 */
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
    <section
      className={cn(
        'border-t border-border py-6 first-of-type:border-t-0 first-of-type:pt-0 last:pb-0',
        className,
      )}
      {...rest}
    >
      {(title || description || action) && (
        <div className="mb-3.5 flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && (
              <div className={cn('text-sm text-muted-foreground', title && 'mt-0.5')}>
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

/** 卡片式的列表（方向稿的 .card）：表面色、分隔线、12px 圆角，行之间是细分隔线。 */
export const LIST_CARD = 'divide-y divide-border rounded-xl border border-border bg-card';

/** 列表为空时的说明：虚线框。 */
export function EmptyList({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-muted-foreground">
      {children}
    </p>
  );
}

/** 原生下拉框（与 components/ui/input.tsx 的输入框同一套：表面色、强分隔线的边框、运行色的焦点环）。 */
export const SELECT =
  'h-8 w-full rounded-lg border border-input bg-card px-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';
