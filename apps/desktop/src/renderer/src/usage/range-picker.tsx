// 使用统计页的自定义时间段：时间段分段旁边的“自定义”按钮，点开是起止两栏（日期与时分）、“结束跟随当前时刻”与月历，确定后才生效。
// 日期由月历选、按界面语言写，时分是 24 小时制的文本框：原生日期与时间框跟随系统区域，与界面语言对不上，12 小时制还放不下。
// 交互参照 cc-switch 的用量日期范围选择：先改开始、点完自动转到结束，结束早于开始时把点的那天当新的开始。选法见 usage-model.ts 的
// pickDay。

import { cn } from 'cn';
import { CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import {
  type CustomRange,
  calendarDays,
  customRangeLabel,
  firstDayOfWeek,
  localMidnight,
  parseTimeInput,
  pickDay,
  type RangeDraft,
  timeInputValue,
} from './usage-model';

const MINUTE_MS = 60_000;

/** 打开时的起止：上次的自定义时间段，没有时从当前时间段的开始到现在（跟随当前时刻）。 */
function initialDraft(value: CustomRange | undefined, start: number): RangeDraft {
  const now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  if (value === undefined) return { from: start, to: now, live: true, field: 'from' };
  return {
    from: value.from,
    to: value.to ?? now,
    live: value.to === undefined,
    field: 'from',
  };
}

const monthOf = (at: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

export function RangePicker({
  active,
  value,
  start,
  locale,
  onApply,
}: {
  /** 现在看的是自定义时间段。 */
  active: boolean;
  value: CustomRange | undefined;
  /** 当前时间段的开始，没有自定义过时拿来当初始的开始。 */
  start: number;
  locale: string;
  onApply: (range: CustomRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RangeDraft>(() => initialDraft(value, start));
  const [month, setMonth] = useState(() => monthOf(draft.from));
  const [invalid, setInvalid] = useState(false);

  const onOpenChange = (next: boolean) => {
    if (next) {
      const initial = initialDraft(value, start);
      setDraft(initial);
      setMonth(monthOf(initial.from));
      setInvalid(false);
    }
    setOpen(next);
  };

  const apply = () => {
    const to = draft.live ? Date.now() : draft.to;
    if (draft.from >= to) {
      setInvalid(true);
      return;
    }
    onApply(draft.live ? { from: draft.from } : { from: draft.from, to: draft.to });
    setOpen(false);
  };

  const edit = (next: RangeDraft) => {
    setDraft(next);
    setInvalid(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-pressed={active}
            data-range="custom"
            className={cn(
              'inline-flex h-8 max-w-64 items-center gap-1.5 rounded-lg px-2.5 text-xs whitespace-nowrap pressable outline-none transition-[color,background-color,box-shadow] duration-150 ease-smooth focus-visible:focus-ring [&_svg]:size-3.5 [&_svg]:shrink-0',
              active
                ? 'bg-selected font-medium text-foreground ring-1 ring-selected-border ring-inset'
                : 'bg-muted text-muted-foreground hover:text-foreground',
            )}
          />
        }
      >
        <CalendarRange aria-hidden />
        <span className="truncate tabular-nums">
          {active && value !== undefined
            ? customRangeLabel(value, locale)
            : t('usage.range.custom')}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-2rem)] p-3">
        <div className="flex flex-col gap-3 sm:flex-row" data-testid="usage-range-picker">
          <div className="flex w-56 flex-col gap-2">
            <Field
              label={t('usage.range.start')}
              at={draft.from}
              selected={draft.field === 'from'}
              onSelect={() => {
                if (draft.field !== 'from') setMonth(monthOf(draft.from));
                edit({ ...draft, field: 'from' });
              }}
              onChange={(from) => edit({ ...draft, from })}
              locale={locale}
              name="from"
            />
            <Field
              label={t('usage.range.end')}
              at={draft.to}
              selected={draft.field === 'to' && !draft.live}
              live={draft.live}
              onSelect={() => {
                if (draft.field !== 'to') setMonth(monthOf(draft.to));
                edit({ ...draft, field: 'to' });
              }}
              onChange={(to) => edit({ ...draft, to })}
              locale={locale}
              name="to"
            />
            <label className="flex cursor-pointer items-center gap-2 py-1 text-xs text-muted-foreground select-none">
              <Checkbox
                size="sm"
                checked={draft.live}
                onCheckedChange={(checked) =>
                  edit({
                    ...draft,
                    live: checked,
                    to: Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS,
                    field: 'from',
                  })
                }
              />
              {t('usage.range.followNow')}
            </label>
            {invalid && (
              <p className="text-xs text-destructive" role="alert">
                {t('usage.range.invalid')}
              </p>
            )}
            <div className="mt-auto flex gap-2 pt-1">
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" className="flex-1" onClick={apply} data-action="apply-range">
                {t('usage.range.apply')}
              </Button>
            </div>
          </div>
          <Calendar
            month={month}
            onMonth={setMonth}
            draft={draft}
            locale={locale}
            onPick={(day) => edit(pickDay(draft, day))}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Field({
  label,
  at,
  selected,
  live = false,
  onSelect,
  onChange,
  locale,
  name,
}: {
  label: string;
  at: number;
  selected: boolean;
  live?: boolean;
  onSelect: () => void;
  onChange: (at: number) => void;
  locale: string;
  name: string;
}) {
  // 正在输入的时分；不完整时先留着原样，失焦后回到当前值。
  const [typing, setTyping] = useState<string>();
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return (
    <fieldset
      className={cn(
        'rounded-lg border px-2.5 py-1.5 transition-[border-color,box-shadow] duration-150 ease-smooth',
        selected ? 'border-foreground/40 ring-1 ring-foreground/10' : 'border-input',
        live ? 'bg-muted' : 'cursor-pointer',
      )}
      onFocus={live ? undefined : onSelect}
      onPointerDown={live ? undefined : onSelect}
      data-field={name}
    >
      <legend className="sr-only">{label}</legend>
      <div aria-hidden className="text-xs text-muted-foreground">
        {label}
      </div>
      <div className="flex h-6 items-center justify-between gap-2 text-sm tabular-nums">
        {live ? (
          <span className="text-muted-foreground">{t('usage.range.now')}</span>
        ) : (
          <>
            <span>{date}</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label={label}
              maxLength={5}
              className="w-12 rounded-sm bg-transparent text-right tabular-nums outline-none focus-visible:bg-foreground/5"
              value={typing ?? timeInputValue(at)}
              onChange={(event) => {
                setTyping(event.target.value);
                const next = parseTimeInput(at, event.target.value);
                if (next !== undefined) onChange(next);
              }}
              onBlur={() => setTyping(undefined)}
            />
          </>
        )}
      </div>
    </fieldset>
  );
}

function Calendar({
  month,
  onMonth,
  draft,
  locale,
  onPick,
}: {
  month: Date;
  onMonth: (month: Date) => void;
  draft: RangeDraft;
  locale: string;
  onPick: (day: Date) => void;
}) {
  const firstDay = useMemo(() => firstDayOfWeek(locale), [locale]);
  const days = useMemo(() => calendarDays(month, firstDay), [month, firstDay]);
  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    // 2024-01-07 是星期日。
    return Array.from({ length: 7 }, (_, index) =>
      format.format(new Date(2024, 0, 7 + ((firstDay + index) % 7))),
    );
  }, [locale, firstDay]);
  const title = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(month);
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'long' });
  const today = localMidnight(new Date());
  const from = localMidnight(new Date(draft.from));
  const to = localMidnight(new Date(draft.live ? Date.now() : draft.to));
  const shift = (months: number) =>
    onMonth(new Date(month.getFullYear(), month.getMonth() + months, 1));

  return (
    <div className="w-64 rounded-lg bg-muted/60 p-2">
      <div className="mb-1 flex items-center justify-between">
        <IconButton label={t('usage.range.prevMonth')} size="icon-xs" onClick={() => shift(-1)}>
          <ChevronLeft />
        </IconButton>
        <button
          type="button"
          className="rounded-md px-2 py-0.5 text-sm font-medium outline-none hover:bg-muted focus-visible:focus-ring"
          onClick={() => onMonth(monthOf(Date.now()))}
        >
          {title}
        </button>
        <IconButton label={t('usage.range.nextMonth')} size="icon-xs" onClick={() => shift(1)}>
          <ChevronRight />
        </IconButton>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground" aria-hidden>
        {weekdays.map((label, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 星期按位置排，窄写法可能重名（英文的 T、S）。
          <div key={index} className="py-1">
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {days.map((day) => {
          const at = day.getTime();
          const inMonth = day.getMonth() === month.getMonth();
          const endpoint = at === from || at === to;
          const inRange = at > from && at < to;
          return (
            <button
              key={at}
              type="button"
              aria-label={dayFormat.format(day)}
              aria-pressed={endpoint}
              aria-current={at === today ? 'date' : undefined}
              onClick={() => onPick(day)}
              className={cn(
                'h-7 rounded-md text-xs tabular-nums outline-none transition-colors duration-150 ease-smooth focus-visible:focus-ring',
                endpoint
                  ? 'bg-primary font-medium text-primary-foreground'
                  : inRange
                    ? 'bg-selected text-foreground'
                    : 'hover:bg-foreground/5',
                !endpoint && !inRange && !inMonth && 'text-muted-foreground/60',
                at === today && !endpoint && 'ring-1 ring-border-strong ring-inset',
              )}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
