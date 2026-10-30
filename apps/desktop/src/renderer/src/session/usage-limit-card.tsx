// 用量上限的卡片（0.119.0）：回合因订阅账号的用量上限失败时代替错误部件，照 Claude Code 桌面版的会话上限卡片——哪个窗口用完了、
// 什么时候重置，勾上“额度恢复后自动继续”后 Host 在重置之后替用户发一条继续消息（消息流里不显示），卡片写出发出的时刻。每周额度等
// 一天之后才重置的没有勾选。0.143.0 起还有“换模型继续”：点开是输入框模型菜单的列表，额度也用完的来源排在后面、标出来；选好后
// Host 换模型（别的来源时接力），替用户发一条继续消息。重连进度（`retry` 部件）也在这里：一行“正在重新连接 2/5”，点开是断开的原因。

import type { ChatPartOf } from '@wevir/client-sdk';
import { AUTO_CONTINUE_MAX_WAIT_MS, type TurnId } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, Gauge, RotateCw, Shuffle } from 'lucide-react';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAccounts } from '@/data/workbench-data';
import { currentLocale, t } from '@/i18n';
import { resetLabel, windowName } from '@/settings/chatgpt-account-model';
import { type MessageActions, useMessageActions } from './message-actions';
import { ModelList } from './model-picker';
import { switchTargets } from './usage-limit-model';

/** 回合因用量上限失败的错误部件（有 `usageLimit`）。 */
export function UsageLimitCard({ part }: { part: ChatPartOf<'error'> }) {
  const { autoContinue, switchModel } = useMessageActions();
  const [busy, setBusy] = useState(false);
  const limit = part.usageLimit;
  if (limit === undefined) return null;
  const title =
    limit.windowMinutes === undefined
      ? t('usageLimit.title')
      : t('usageLimit.titleWindow', {
          window: windowName({ usedPercent: 100, windowMinutes: limit.windowMinutes }),
        });
  const resets = resetLabel(limit.resetsAt);
  const pending = autoContinue?.armed;
  const armed = pending?.turnId === part.turnId ? pending : undefined;
  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt);
  const toggleable =
    autoContinue !== undefined &&
    part.turnId !== undefined &&
    autoContinue.lastTurnId === part.turnId &&
    part.resumedAt === undefined &&
    resetsAt - Date.now() <= AUTO_CONTINUE_MAX_WAIT_MS;
  const toggle = (enabled: boolean) => {
    if (autoContinue === undefined || part.turnId === undefined) return;
    setBusy(true);
    void autoContinue.set(part.turnId, enabled).finally(() => setBusy(false));
  };
  return (
    <div
      role="note"
      className="my-2 flex gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
      data-usage-limit={part.turnId}
      data-auto-continue={armed !== undefined || undefined}
    >
      <Gauge aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {title}
          {resets !== undefined && (
            <span className="font-normal text-muted-foreground"> · {resets}</span>
          )}
        </p>
        {(toggleable || armed !== undefined) && (
          <label className="mt-2 flex w-fit items-center gap-2 text-sm">
            <Checkbox
              size="sm"
              checked={armed !== undefined}
              disabled={busy || !toggleable}
              onCheckedChange={(checked) => toggle(checked)}
              data-testid="usage-limit-auto-continue"
            />
            {t('usageLimit.autoContinue')}
          </label>
        )}
        {switchModel !== undefined &&
          part.turnId !== undefined &&
          switchModel.lastTurnId === part.turnId &&
          part.resumedAt === undefined && (
            <SwitchModelButton switchModel={switchModel} turnId={part.turnId} />
          )}
        {armed !== undefined && (
          <p className="mt-1 text-xs text-muted-foreground" data-resume-at={armed.resumeAt}>
            {t('usageLimit.resumeAt', { time: clockLabel(armed.resumeAt) })}
          </p>
        )}
        {part.resumedAt !== undefined && (
          <p className="mt-1 text-xs text-muted-foreground" data-resumed-at={part.resumedAt}>
            {t('usageLimit.resumed', { time: clockLabel(part.resumedAt) })}
          </p>
        )}
        <p className="mt-1.5 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
          {part.message}
        </p>
      </div>
    </div>
  );
}

/** “换模型继续”：点开是模型列表，选了与当前不同的模型就换过去并继续。 */
function SwitchModelButton({
  switchModel,
  turnId,
}: {
  switchModel: NonNullable<MessageActions['switchModel']>;
  turnId: TurnId;
}) {
  const accounts = useAccounts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { value } = switchModel;
  const targets = switchTargets(switchModel.providers, accounts, value.providerId);
  const choose = (providerId: string, modelId: string) => {
    setOpen(false);
    if (providerId === value.providerId && modelId === value.modelId) return;
    setBusy(true);
    void switchModel.run(turnId, { providerId, modelId }).finally(() => setBusy(false));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={busy}
        data-testid="usage-limit-switch-model"
        className={cn(buttonVariants({ size: 'xs', variant: 'outline' }), 'mt-2')}
      >
        <Shuffle aria-hidden />
        {t('usageLimit.switchModel')}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} className="w-72 gap-0 p-0">
        <ModelList
          providers={targets.providers}
          exhausted={targets.exhausted}
          locked={(provider) => !switchModel.switchable(provider)}
          value={value}
          onChoose={(providerId, model) => choose(providerId, model.id)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * 引擎在重连（`retry` 部件）：`active` 时是进行中的回合的最后一项，写“正在重新连接 2/5”并闪动，之后写“重新连接 2/5”。有原因时
 * 右边一个箭头，点开显示原文，同 Codex 桌面端。
 */
export function RetryRow({ part, active }: { part: ChatPartOf<'retry'>; active: boolean }) {
  const [open, setOpen] = useState(false);
  const counted = part.attempt !== undefined && part.maxAttempts !== undefined;
  const label = counted
    ? t(active ? 'retry.active' : 'retry.done', {
        attempt: part.attempt ?? 0,
        max: part.maxAttempts ?? 0,
      })
    : t(active ? 'retry.activePlain' : 'retry.donePlain');
  return (
    <div className="my-1.5 text-sm text-muted-foreground" data-retry={active ? 'active' : 'done'}>
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md py-0.5 transition-colors hover:text-foreground disabled:pointer-events-none"
        disabled={part.reason === undefined}
        aria-expanded={part.reason === undefined ? undefined : open}
        onClick={() => setOpen((value) => !value)}
      >
        <RotateCw aria-hidden className={cn('size-3.5', active && 'animate-spin')} />
        <span className={cn(active && 'shimmer')}>{label}</span>
        {part.reason !== undefined && (
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-150 ease-smooth',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      {open && part.reason !== undefined && (
        <p className="mt-1 ml-5 font-mono text-xs break-words whitespace-pre-wrap">{part.reason}</p>
      )}
    </div>
  );
}

/** 一个时刻：今天的只写时分，别的天带上月日。 */
function clockLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  const date = at.toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' });
  return `${date} ${time}`;
}
