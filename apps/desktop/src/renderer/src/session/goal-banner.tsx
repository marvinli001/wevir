// 输入框上方的目标横幅（0.35.0，desktop-tokens §48）：会话有目标时显示状态、用量与目标本身，右边是暂停 / 继续 / 清除。照 T3 Code
// 的目标横幅（apps/web/src/components/ChatView.tsx，MIT，ec1313c8）；按钮经 `session.updateGoal` / `session.clearGoal`。

import type { SessionGoal } from '@wevir/protocol';
import { GoalIcon } from '@/components/command-icons';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { presentGoal } from './goal-model';

export function GoalBanner({
  goal,
  working,
  disabled,
  onPause,
  onResume,
  onClear,
}: {
  goal: SessionGoal;
  /** 会话有进行中的回合。 */
  working: boolean;
  disabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const { title, usage, canPause, canResume } = presentGoal(goal, working);
  return (
    <section
      aria-label={t('command.goal')}
      data-testid="goal-banner"
      data-status={goal.status}
      className="mb-2 rounded-xl border border-border bg-background px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <div className="flex min-h-6 items-center gap-1.5 text-xs text-muted-foreground">
        <GoalIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{title}</span>
        {usage && <span className="min-w-0 truncate tabular-nums">· {usage}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {canPause && (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={onPause}>
              {t('goal.pause')}
            </Button>
          )}
          {canResume && (
            <Button size="xs" variant="ghost" disabled={disabled} onClick={onResume}>
              {t('goal.resume')}
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={disabled} onClick={onClear}>
            {t('goal.clear')}
          </Button>
        </span>
      </div>
      <p
        className="mt-0.5 line-clamp-2 text-sm break-words whitespace-pre-wrap"
        title={goal.objective}
      >
        {goal.objective}
      </p>
    </section>
  );
}
