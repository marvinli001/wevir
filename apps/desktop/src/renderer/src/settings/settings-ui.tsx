import { cn } from 'cn';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
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
