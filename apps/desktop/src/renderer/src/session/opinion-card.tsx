import type { ChatPartOf, UserChatMessage } from '@wevir/client-sdk';
import type { SecondOpinion, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ProviderLogo } from '@/components/provider-logo';
import { Button } from '@/components/ui/button';
import { sourceOf } from '@/data/sources';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { providerLogo } from '@/settings/provider-catalog';
import { useTranscriptSessionId } from './fold-state';
import { modelLabel } from './handoff-model';
import { MarkdownView } from './markdown/markdown-view';
import { useSessions } from './suggested-tasks';

/** 意见正文收起的高度：超过时收起，底部渐隐，同长的用户消息（§55）。 */
const OPINION_FOLD_PX = 240;
const OPINION_FOLD_SLACK_PX = 96;

/** 意见的来源：标志与“来源 · 模型”。 */
function useOpinionSource(opinion: Pick<SecondOpinion, 'providerId' | 'modelId'>) {
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const providers = data.status === 'ready' ? data.providers : [];
  const provider = providers.find((candidate) => candidate.id === opinion.providerId);
  const label = modelLabel(providers, opinion.providerId, opinion.modelId, accounts);
  const logo = provider ? (sourceOf(provider)?.logo ?? providerLogo(provider)) : undefined;
  return { label, logo };
}

/**
 * 第二意见（0.75.0，desktop-tokens §65）：发起时所在的位置一张卡片。标题行是来源与状态；好了之后是意见全文（很长时收起），下面“引用”
 * 把意见作为一条消息发给这个会话（会话忙时排在后面），引用过的写“已引用”；“打开会话”去给意见的那个会话。
 */
export function OpinionCard({ part }: { part: ChatPartOf<'opinion'> }) {
  const { opinion } = part;
  const { client } = useHostConnection();
  const sessions = useSessions();
  const originId = useTranscriptSessionId() as SessionId;
  const origin = sessions.get(originId);
  const reviewer = sessions.get(opinion.sessionId);
  const { label, logo } = useOpinionSource(opinion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const failed = opinion.status === 'failed';
  const onQuote = async () => {
    if (!client) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('session.quoteOpinion', {
        sessionId: originId,
        opinionId: opinion.id,
        delivery: 'queue',
      });
    } catch (reason) {
      setError(t('opinion.quoteFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const status =
    opinion.status === 'running' ? (
      <span className="inline-flex items-center gap-1.5">
        {reviewer?.activeTurn && (
          <Orb state={turnOrb(reviewer.id, reviewer.activeTurn.turnId)} className="shrink-0" />
        )}
        {t('opinion.running')}
      </span>
    ) : failed ? (
      <span className="text-destructive">
        {t(opinion.outcome === 'cancelled' ? 'opinion.cancelled' : 'opinion.failed')}
      </span>
    ) : opinion.quoted ? (
      <span>{t('opinion.quoted')}</span>
    ) : undefined;
  return (
    <section
      aria-label={t('opinion.title')}
      data-testid="second-opinion"
      data-opinion={opinion.status}
      className="my-3 rounded-xl border border-border bg-background"
    >
      <header className="flex h-9 items-center gap-1.5 px-3 text-xs text-muted-foreground">
        <MessagesSquare aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">{t('opinion.title')}</span>
        <span aria-hidden>·</span>
        {logo !== undefined && <ProviderLogo logo={logo} fallback={label} className="size-3.5" />}
        <span className="min-w-0 truncate">{label}</span>
        {status !== undefined && <span className="ml-auto shrink-0 pl-2">{status}</span>}
      </header>
      {opinion.text !== undefined && (
        <div className="border-t border-border px-3 py-2">
          <OpinionText text={opinion.text} />
        </div>
      )}
      {(opinion.status === 'ready' || reviewer !== undefined || error !== undefined) && (
        <footer className="flex min-h-10 items-center gap-2 border-t border-border px-3 py-1.5">
          {error !== undefined && (
            <p className="min-w-0 flex-1 truncate text-xs text-destructive" title={error}>
              {error}
            </p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {origin && reviewer && (
              <Link
                to={paths.session(origin.workspaceId, reviewer.id)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
              >
                {t('opinion.open')}
                <ChevronRight aria-hidden className="size-3.5" />
              </Link>
            )}
            {opinion.status === 'ready' && opinion.quoted === undefined && (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || !client}
                onClick={() => void onQuote()}
              >
                {t('opinion.quote')}
              </Button>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}

/** 意见正文：Markdown，很长时收起到 240 px，底部渐隐，下面是“展开 / 收起”。 */
function OpinionText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const foldable = height !== undefined && height > OPINION_FOLD_PX + OPINION_FOLD_SLACK_PX;
  const folded = foldable && !expanded;
  return (
    <>
      <div
        ref={ref}
        className={cn(
          'min-w-0',
          foldable && 'overflow-hidden transition-[max-height] duration-300 ease-expand',
          folded && '[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]',
        )}
        style={foldable ? { maxHeight: folded ? OPINION_FOLD_PX : height } : undefined}
      >
        <MarkdownView text={text} streaming={false} quotable />
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
        >
          {t(folded ? 'message.expand' : 'message.collapse')}
        </button>
      )}
    </>
  );
}

/**
 * 引用了第二意见的消息（`from.opinion`）：Host 拼给模型的正文不显示成用户气泡，一行“第二意见 · 来源”标记，悬停看全文；用户附的话
 * 在下面照用户气泡显示。
 */
export function OpinionQuote({ message }: { message: UserChatMessage }) {
  const quoted = message.from?.opinion;
  const sessions = useSessions();
  const reviewer = message.from === undefined ? undefined : sessions.get(message.from.sessionId);
  const { label } = useOpinionSource({
    providerId: reviewer?.providerId ?? '',
    modelId: reviewer?.modelId ?? '',
  });
  if (quoted === undefined) return null;
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  return (
    <div
      className="my-2 flex flex-col items-end gap-1"
      data-message-role="user"
      data-opinion-quote={quoted.opinionId}
    >
      {quoted.note !== undefined && (
        <div className="max-w-[85%] min-w-0 rounded-xl bg-muted px-3.5 py-2 text-base whitespace-pre-wrap break-words">
          {quoted.note}
        </div>
      )}
      <span
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm text-soft-foreground"
        title={text}
      >
        <MessagesSquare aria-hidden className="size-4 shrink-0" />
        <span className="truncate">
          {reviewer ? t('transcript.opinionQuote', { model: label }) : t('opinion.title')}
        </span>
      </span>
    </div>
  );
}
