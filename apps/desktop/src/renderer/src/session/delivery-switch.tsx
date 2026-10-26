import type { PendingDelivery } from '@wevir/protocol';
import { cn } from 'cn';
import { Liquid } from 'liquid-gooey';
import { ArrowLeftRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';

const OPTIONS: readonly PendingDelivery[] = ['steer', 'queue'];

/**
 * 回合进行中输入框里的“插话 | 排队”切换（U3，方向稿 A 静器）：选的是回车与发送键用哪种，另一种用 Tab；和设置 → 对话的
 * “回合进行中按回车”是同一个 Host 设置（维护者 2026-10-14 定），改了 CLI 也跟着变。滑块是 liquid-gooey 的 move 效果：
 * 滑块本身用 CSS 过渡平移，液面跟着它拖出尾巴；库自己处理减弱动效。库在根节点与 Item 上写死了内联的 position /
 * display，这里用 style 覆盖（Item 的 style 排在它的默认值后面）。
 */
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
      <DeliveryOptions value={value} index={index} disabled={disabled} onChange={onChange} />
    </>
  );
}

const LABELS = { steer: 'session.sendSteer', queue: 'session.sendQueue' } as const;

function DeliveryOptions({
  value,
  index,
  disabled,
  onChange,
}: {
  value: PendingDelivery;
  index: number;
  disabled: boolean;
  onChange: (delivery: PendingDelivery) => void;
}) {
  return (
    <fieldset
      data-delivery-switch={value}
      className="relative grid h-7 w-fit min-w-0 shrink-0 grid-cols-2 rounded-full bg-muted p-0.5 text-xs @max-[30rem]/composer:hidden"
    >
      <legend className="sr-only">{t('settings.chat.sendWhileBusy')}</legend>
      <div aria-hidden className="pointer-events-none absolute inset-0.5">
        <Liquid
          fill="var(--switch-thumb)"
          blur={5}
          contrast={16}
          shadow="0 1px 2px rgba(0,0,0,.12)"
          style={{ height: '100%' }}
        >
          <Liquid.Item effect="move" style={{ display: 'block', height: '100%' }}>
            <div
              className="h-full w-1/2 rounded-full transition-transform duration-(--spring-press-duration) ease-spring-press motion-reduce:transition-none"
              style={{ transform: `translateX(${index * 100}%)` }}
            />
          </Liquid.Item>
        </Liquid>
      </div>
      {OPTIONS.map((delivery) => {
        const checked = delivery === value;
        return (
          <Tooltip key={delivery} disabled={checked}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={checked}
                  disabled={disabled}
                  data-delivery-option={delivery}
                  onClick={() => !checked && onChange(delivery)}
                  className={cn(
                    'relative min-w-11 rounded-full px-2 outline-none focus-visible:focus-ring disabled:opacity-60',
                    checked
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                />
              }
            >
              {t(LABELS[delivery])}
            </TooltipTrigger>
            <TooltipContent>
              <kbd className="font-sans">Tab</kbd>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
