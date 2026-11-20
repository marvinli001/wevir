import type { PendingDelivery } from '@wevir/protocol';
import { ArrowLeftRight } from 'lucide-react';
import { Segment, SegmentGroup } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';

const OPTIONS: readonly PendingDelivery[] = ['steer', 'queue'];

export function DeliverySwitch({
  value,
  disabled = false,
  onChange,
}: {
  value: PendingDelivery;
  disabled?: boolean;
  onChange: (delivery: PendingDelivery) => void;
}) {
  const index = OPTIONS.indexOf(value);
  const other = OPTIONS[1 - index] ?? 'queue';
  // 同设置页（settings/chat-settings.tsx）：一组 aria-pressed 的按钮，按下的那个是当前的方式。输入框窄于 30rem
  // （子会话窗格、窄窗口）时换成一颗写着当前方式的按钮，点一下换成另一种，和 Tab 一样。
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              data-delivery-toggle={value}
              onClick={() => onChange(other)}
              className="hidden h-7 shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-foreground outline-none transition-colors duration-150 hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] focus-visible:focus-ring disabled:opacity-60 @max-[30rem]/composer:inline-flex"
            />
          }
        >
          {t(LABELS[value])}
          <ArrowLeftRight aria-hidden className="size-3 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          {t(LABELS[other])}
          <kbd className="ml-1.5 font-sans opacity-70">Tab</kbd>
        </TooltipContent>
      </Tooltip>
      <SegmentGroup
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={t('settings.chat.sendWhileBusy')}
        data-delivery-switch={value}
        className="h-7 w-fit shrink-0 @max-[30rem]/composer:hidden"
      >
        {OPTIONS.map((delivery) => (
          <Tooltip key={delivery} disabled={delivery === value}>
            <TooltipTrigger
              render={
                <Segment
                  value={delivery}
                  data-delivery-option={delivery}
                  className="h-6 min-w-11 px-2"
                />
              }
            >
              {t(LABELS[delivery])}
            </TooltipTrigger>
            <TooltipContent>
              <kbd className="font-sans">Tab</kbd>
            </TooltipContent>
          </Tooltip>
        ))}
      </SegmentGroup>
    </>
  );
}

const LABELS = { steer: 'session.sendSteer', queue: 'session.sendQueue' } as const;
