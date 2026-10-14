import type { ReactNode } from 'react';

/** 空状态、未找到、连接失败等整页提示：图标、标题、说明、可选的操作。 */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <div className="text-muted-foreground [&_svg]:size-8 [&_svg]:stroke-[1.5]" aria-hidden>
        {icon}
      </div>
      <h2 className="text-lg font-medium">{title}</h2>
      {children && (
        <div className="max-w-md text-base break-words text-muted-foreground">{children}</div>
      )}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
