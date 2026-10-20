import { ClipboardList } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { useRetroSupported } from '@/retro/retro-data';
import { RetroView } from '@/retro/retro-view';
import type { PaneContext } from '../pane-registry';

/** “任务回顾”窗格（0.76.0）：当前会话的回顾，每行点开出处。旧 Host 没有 `session_retro` 时只写不支持。 */
export function RetroPane({ context }: { context: PaneContext }) {
  const supported = useRetroSupported();
  const { entry, sessionId } = context;
  const session = entry?.sessions.find((item) => item.id === sessionId);
  if (!supported) return <Note>{t('retro.unsupported')}</Note>;
  if (!session) return <Note>{t('retro.noSession')}</Note>;
  return <RetroView key={session.id} session={session} />;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <ClipboardList aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
