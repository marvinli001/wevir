// 会话侧栏的“任务回顾”卡片（0.76.0，Host 功能 `session_retro`）：目标、本地检查、前几步下一步；“完整回顾”开窗格，“基于回顾新建”
// 把回顾放进新会话的输入框。只在顶层会话里有，设置里打开后才显示（默认不显示），侧栏看得见时才读（`retro.get` 按需生成，不在后台跑）。

import type { SessionId } from '@wevir/protocol';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { useRetro, useRetroActions, useRetroOpen, useRetroSupported } from '@/retro/retro-data';
import { deliveryLabel, nextDetail, nextLabel, retroTarget } from '@/retro/retro-model';
import { DELIVERY_TONES, RetroRow } from '@/retro/retro-view';
import { usePanes } from './pane-controller';
import { type RailContext, registerRailCard } from './session-rail';

/** 卡片里列几步下一步。 */
const NEXT_SHOWN = 3;

function useRetroCard({ sessionId, session, visible }: RailContext) {
  const supported = useRetroSupported();
  const topLevel = session.parentSessionId === undefined;
  const { retro, reload } = useRetro(sessionId as SessionId, supported && topLevel && visible);
  const actions = useRetroActions(session, reload);
  const { open } = useRetroOpen(session);
  const panes = usePanes();
  if (!supported || !topLevel) return null;
  const next = retro?.next ?? [];
  const goal = retro?.goal.goal ?? retro?.goal.request;
  const checks = retro?.delivery.checks;
  return {
    summary: retro && (
      <span className="truncate">{next[0] ? nextLabel(next[0]) : t('retro.next.none')}</span>
    ),
    details: (
      <div data-testid="rail-retro">
        {retro ? (
          <ul className="space-y-0.5">
            {goal ? (
              <RetroRow id={goal.id} target={retroTarget(goal.ref, goal.source)} open={open}>
                {goal.text}
              </RetroRow>
            ) : (
              <li className="flex h-7 items-center text-muted-foreground">
                {t('retro.notRecorded')}
              </li>
            )}
            {checks && (
              <li className="flex h-7 min-w-0 items-center gap-2.5" data-testid="rail-retro-checks">
                <StatusDot tone={DELIVERY_TONES[checks] ?? 'neutral'} />
                <span className="min-w-0 truncate">{deliveryLabel(checks)}</span>
              </li>
            )}
            {next.slice(0, NEXT_SHOWN).map((entry) => (
              <RetroRow
                key={entry.id}
                id={entry.id}
                target={retroTarget(entry.ref, entry.source)}
                open={open}
                detail={nextDetail(entry)}
              >
                {nextLabel(entry)}
              </RetroRow>
            ))}
          </ul>
        ) : (
          <p className="h-7 text-xs leading-7 text-muted-foreground">{t('retro.loading')}</p>
        )}
        {actions.error && <p className="mt-2 text-xs text-destructive">{actions.error}</p>}
        <div className="mt-3 flex h-6 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => panes?.open({ kind: 'retro' })}
            disabled={!panes}
            data-action="open-retro"
          >
            {t('retro.open')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void actions.startFromRetro()}
            disabled={actions.pending !== undefined || !retro}
            data-action="retro-new-session"
          >
            {t('retro.newSession')}
          </Button>
        </div>
      </div>
    ),
  };
}

registerRailCard({
  id: 'retro',
  order: 38,
  title: () => t('rail.retro'),
  useCard: useRetroCard,
});
