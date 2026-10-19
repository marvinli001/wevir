import type { Transcript, WevirClient } from '@wevir/client-sdk';
import type { QuestionRequest, UserQuestion } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, ChevronDown, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';

/** 输入框上方的提问（U11，照 Claude Code 的提问卡片）：一次一组，一题一页。 */
export function QuestionDock({
  transcript,
  client,
  recap,
}: {
  transcript: Transcript;
  client: WevirClient | undefined;
  /** 卡片最上面的“这一轮”回顾（U20，todo-card.tsx 的 TurnRecap）。 */
  recap?: ReactNode;
}) {
  const request = transcript.pendingQuestions[0];
  if (!request) return null;
  return <QuestionCard key={request.id} request={request} client={client} recap={recap} />;
}

/** “其他”在回答里的占位：选中了“其他”时这一题的回答是输入框里的文字。 */
const OTHER = '\u0000other';

/**
 * 一组问题（protocol 0.10.0 的 `QuestionRequest`）：顶上是“第几题 / 共几题”与题目，下面是选项（单选点一下即选中，多选是
 * 勾选框），允许时最后一项是“其他”加输入框；数字键选选项，⌘↵ 下一题，最后一题是提交。跳过的题回答为空。
 */
function QuestionCard({
  request,
  client,
  recap,
}: {
  request: QuestionRequest;
  client: WevirClient | undefined;
  recap: ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cardRef = useRef<HTMLElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const total = request.questions.length;
  const question = request.questions[Math.min(index, total - 1)] as UserQuestion;
  const selected = chosen[question.id] ?? [];
  const last = index >= total - 1;

  // 换题时把焦点放回卡片，数字键与 ⌘↵ 照常可用。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换题时。
  useEffect(() => {
    if (!collapsed) cardRef.current?.focus({ preventScroll: true });
  }, [index]);

  const toggle = (value: string) => {
    setChosen((current) => {
      const list = current[question.id] ?? [];
      const next = question.multiSelect
        ? list.includes(value)
          ? list.filter((item) => item !== value)
          : [...list, value]
        : [value];
      return { ...current, [question.id]: next };
    });
    if (value === OTHER) requestAnimationFrame(() => otherRef.current?.focus());
  };

  const answersFor = (item: UserQuestion, picks: Record<string, string[]>): string[] =>
    (picks[item.id] ?? []).flatMap((value) => {
      if (value !== OTHER) return [value];
      const text = (other[item.id] ?? '').trim();
      return text === '' ? [] : [text];
    });

  const submit = async (picks: Record<string, string[]>) => {
    if (!client || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('question.respond', {
        questionId: request.id,
        answers: Object.fromEntries(
          request.questions.map((item) => [item.id, { answers: answersFor(item, picks) }]),
        ),
      });
    } catch (reason) {
      setError(t('question.failed', { error: describe(reason) }));
      setBusy(false);
    }
  };

  const next = (picks = chosen) => {
    if (last) void submit(picks);
    else setIndex((value) => value + 1);
  };
  const skip = () => {
    const picks = { ...chosen, [question.id]: [] };
    setChosen(picks);
    next(picks);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      next();
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    const digit = Number.parseInt(event.key, 10);
    const values = [
      ...question.options.map((option) => option.label),
      ...(question.allowOther ? [OTHER] : []),
    ];
    if (digit >= 1 && digit <= values.length && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      toggle(values[digit - 1] as string);
    }
  };

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={t('question.label')}
      data-testid="question-card"
      data-keyboard-scope
      className="mb-2 rounded-2xl border border-border bg-card shadow-sm outline-none animate-in fade-in slide-in-from-bottom-2 duration-300 ease-smooth"
    >
      {recap}
      <header className="flex items-start gap-2.5 px-3.5 pt-3">
        <span className="mt-px shrink-0 rounded-md bg-brand/15 px-1.5 text-xs leading-5 font-medium text-brand tabular-nums">
          {index + 1}/{total}
        </span>
        <div className="min-w-0 flex-1">
          {question.header && <p className="text-xs text-muted-foreground">{question.header}</p>}
          <h3 className="text-base leading-snug font-medium">{question.question}</h3>
        </div>
        <IconButton
          label={t(collapsed ? 'question.expand' : 'question.collapse')}
          size="icon-xs"
          className="text-muted-foreground"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown
            className={cn('transition-transform duration-200', collapsed && 'rotate-180')}
          />
        </IconButton>
        <IconButton
          label={t('question.skipAll')}
          size="icon-xs"
          className="text-muted-foreground"
          disabled={busy}
          onClick={() => void submit({})}
        >
          <X />
        </IconButton>
      </header>

      {!collapsed && (
        <div key={question.id} className="animate-in fade-in duration-200 ease-smooth">
          {question.multiSelect && (
            <p className="px-3.5 pt-1 pl-14 text-xs text-muted-foreground">{t('question.multi')}</p>
          )}
          <ul className="flex flex-col gap-1.5 px-3.5 pt-3" aria-label={question.question}>
            {question.options.map((option, optionIndex) => (
              <li key={option.label}>
                <OptionRow
                  label={option.label}
                  description={option.description}
                  number={optionIndex + 1}
                  multi={question.multiSelect === true}
                  checked={selected.includes(option.label)}
                  onToggle={() => toggle(option.label)}
                />
              </li>
            ))}
            {question.allowOther && (
              <li>
                <OptionRow
                  label={t('question.other')}
                  number={question.options.length + 1}
                  multi={question.multiSelect === true}
                  checked={selected.includes(OTHER)}
                  onToggle={() => toggle(OTHER)}
                >
                  <input
                    ref={otherRef}
                    value={other[question.id] ?? ''}
                    onChange={(event) => {
                      const text = event.target.value;
                      setOther((current) => ({ ...current, [question.id]: text }));
                      if (text !== '' && !selected.includes(OTHER)) toggle(OTHER);
                    }}
                    type={question.secret ? 'password' : 'text'}
                    placeholder={t('question.otherPlaceholder')}
                    aria-label={t('question.other')}
                    className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring-soft focus-visible:ring-2 focus-visible:ring-ring/12"
                  />
                </OptionRow>
              </li>
            )}
          </ul>
          {error && (
            <p role="alert" className="px-3.5 pt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <footer className="flex items-center justify-end gap-2 px-3.5 pt-3 pb-3">
            <Button size="sm" variant="secondary" disabled={busy} onClick={skip}>
              {t('question.skip')}
            </Button>
            <Button
              size="sm"
              disabled={busy || !client}
              onClick={() => next()}
              data-action={last ? 'question-submit' : 'question-next'}
            >
              {t(last ? 'question.submit' : 'question.next')}
              <kbd className="ml-0.5 rounded-sm bg-primary-foreground/15 px-1 font-sans text-[0.6875rem] leading-4">
                {IS_MAC ? '⌘↵' : 'Ctrl+↵'}
              </kbd>
            </Button>
          </footer>
        </div>
      )}
    </section>
  );
}

function OptionRow({
  label,
  description,
  number,
  multi,
  checked,
  onToggle,
  children,
}: {
  label: string;
  description?: string | undefined;
  number: number;
  multi: boolean;
  checked: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      data-option={label}
      className={cn(
        'rounded-lg transition-[background-color,box-shadow] duration-150 ease-smooth',
        checked
          ? 'bg-selected ring-1 ring-selected-border ring-inset'
          : 'bg-muted/50 hover:bg-muted',
      )}
    >
      <button
        type="button"
        aria-pressed={checked}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {multi && (
          <span
            aria-hidden
            className={cn(
              'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
              checked ? 'border-foreground bg-foreground text-background' : 'border-border-strong',
            )}
          >
            {checked && <Check className="size-3" strokeWidth={3} />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          {description && (
            <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
          )}
        </span>
        <kbd
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border font-sans text-[0.6875rem] text-muted-foreground"
        >
          {number}
        </kbd>
      </button>
      {children && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );
}
