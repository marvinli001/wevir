import type { ReactNode } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';

/** 中栏页面：内容区可滚动、限宽居中（max-w-content），可选的底部区域（输入框）同样限宽。 */
export function CenterPage({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-content px-6 py-8">{children}</div>
      </ScrollArea>
      {footer && <div className="mx-auto w-full max-w-content shrink-0 px-6 pb-5">{footer}</div>}
    </div>
  );
}
