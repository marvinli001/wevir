// 回合末的下一步卡片（0.128.0，`turn.wrap_up`，照 Claude Code 桌面端）：agent 在回合结束前调 `wevir_wrap_up`，需要用户决定时，
// 回答下面一块细边框圆角卡片：灰色的回顾、一行问题、一个主按钮（agent 的推荐）与至多一个次按钮。悬停按钮显示点了会发出的完整
// 消息；点了以用户身份发出它。用户之后发了消息（自己输入或点了按钮）、有了新回合，卡片就不再画（turn-view.tsx 的 laterTurn）；
// 会话不在空闲（回合在跑或在等审批）时按钮置灰。右上角可以关掉卡片（照 Claude Code）：按回合 ID 记在本机，切走再回来也不再画。

import type { TranscriptWrapUp } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { X } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';
import { useMessageActions } from './message-actions';
import { dismissWrapUp, parseDismissedWrapUps, wrapUpCardOf } from './wrap-up-model';

const dismissedWrapUps = createPersistedStore<readonly string[]>(
  'wevir.wrap-up-dismissed.v1',
  [],
  parseDismissedWrapUps,
);

export function WrapUpCard({ turnId, wrapUp }: { turnId: TurnId; wrapUp: TranscriptWrapUp }) {
  const { wrapUp: actions } = useMessageActions();
  // 点过的按钮：新回合开始之前不能再点（发送失败时清掉）。
  const [sent, setSent] = useState<number>();
  const dismissed = dismissedWrapUps.use().includes(turnId);
  const card = wrapUpCardOf(wrapUp);
  if (card === undefined || dismissed) return null;
  const enabled = actions?.lastTurnId === turnId && sent === undefined;
  return (
    <section
      aria-label={t('wrapUp.title')}
      data-testid="wrap-up-card"
      className="relative mt-3 rounded-xl border border-border bg-background p-3 text-sm"
    >
      <IconButton
        label={t('common.close')}
        size="icon-xs"
        className="absolute top-1.5 right-1.5"
        data-wrap-up-dismiss
        onClick={() => dismissedWrapUps.set((current) => dismissWrapUp(current, turnId))}
      >
        <X />
      </IconButton>
      <p className="break-words pr-6 text-muted-foreground">{card.recap}</p>
      <p className="mt-2 break-words font-medium text-foreground">{card.ask}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {card.actions.map((action, index) => (
          <Tooltip key={action.label}>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant={index === 0 ? 'default' : 'secondary'}
                  disabled={!enabled}
                  data-wrap-up-action={index}
                  onClick={async () => {
                    if (!enabled || actions === undefined) return;
                    setSent(index);
                    if (!(await actions.send(action.message))) setSent(undefined);
                  }}
                />
              }
            >
              {action.label}
            </TooltipTrigger>
            <TooltipContent className="line-clamp-6 block whitespace-pre-wrap break-words">
              {action.message}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </section>
  );
}
