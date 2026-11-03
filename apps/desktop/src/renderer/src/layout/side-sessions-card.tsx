import type { Session } from '@wevir/protocol';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StatusDot } from '@/components/status-dot';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from './pane-controller';
import { type RailContext, registerRailCard } from './session-rail';

function useSideSessionsCard({ sessionId, visible }: RailContext) {
  const { client } = useHostConnection();
  const panes = usePanes();
  const [sides, setSides] = useState<Session[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setSides([]);
    setError(undefined);
    if (!client?.supports('side_session_list') || !visible) return;
    let stopped = false;
    let revision = 0;
    const reload = async () => {
      const current = ++revision;
      try {
        const { sessions } = await client.request('session.list', { sideOf: sessionId });
        if (stopped || current !== revision) return;
        setSides(sessions);
        setError(undefined);
      } catch (reason) {
        if (!stopped && current === revision) setError(describe(reason));
      }
    };
    void reload();
    const stop = client.onSessionsChanged((change) => {
      if (
        !change ||
        change.removed.length > 0 ||
        change.upserted.some(
          (session) => session.side && session.forkedFrom?.sessionId === sessionId,
        )
      )
        void reload();
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [client, sessionId, visible]);
  if (!sides.length && !error) return null;
  return {
    summary: sides.length,
    details: (
      <div data-testid="rail-side-sessions">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {sides.map((side) => (
          <button
            key={side.id}
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted focus-visible:focus-ring"
            onClick={() =>
              panes?.open({
                kind: 'session',
                params: { sessionId: side.id, title: side.title || t('command.btw') },
              })
            }
          >
            <MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{side.title || t('command.btw')}</span>
            <StatusDot
              tone={
                side.state === 'running'
                  ? 'accent'
                  : side.state === 'awaiting_approval' || (side.pendingQuestionCount ?? 0) > 0
                    ? 'warning'
                    : side.state === 'error'
                      ? 'danger'
                      : 'neutral'
              }
            />
          </button>
        ))}
      </div>
    ),
  };
}

registerRailCard({
  id: 'side-sessions',
  order: 39,
  title: () => t('side.list'),
  useCard: useSideSessionsCard,
});
