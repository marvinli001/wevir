import { cn } from 'cn';
import { t } from '@/i18n';

/**
 * agent 开会话时用的预设角色名（0.52.0，`Session.openedBy.role`）：会话行与顶栏标题后面的小标签。角色名是角色文件里的名字
 * （内置的 explorer、reviewer、worker，或用户自己的），不翻译；读屏器读“角色 〈名〉”。
 */
export function RoleLabel({
  role,
  className,
  ...props
}: { role: string; className?: string } & Omit<React.ComponentProps<'span'>, 'children'>) {
  return (
    <span
      title={t('session.role', { role })}
      data-role={role}
      className={cn(
        'max-w-24 shrink-0 truncate rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground',
        className,
      )}
      {...props}
    >
      <span aria-hidden>{role}</span>
      <span className="sr-only">{t('session.role', { role })}</span>
    </span>
  );
}
