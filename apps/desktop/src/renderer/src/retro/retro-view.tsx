// 任务回顾的完整视图（0.76.0，“任务回顾”窗格）：目标、完成与未完成、验证（每个“通过”指向一条带代码版本的记录）、交付、改动、
// 批注、关键决定、下一步、关联的会话与笔记，可选的模型摘要单独一段。每一行点开它的出处。

import type {
  RetroCheck,
  RetroItem,
  RetroSourceState,
  RetroSummary,
  Session,
  SessionId,
  SessionRetro,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Download, FilePlus2, RefreshCw, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/icon-button';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { currentLocale, t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';
import { formatMessageTime } from '@/session/format';
import { useRetro, useRetroActions, useRetroOpen } from './retro-data';
import {
  checkStatusText,
  decisionLabel,
  deliveryLabel,
  diffLabel,
  evidenceLabel,
  goalStatusLabel,
  nextDetail,
  nextLabel,
  originLabel,
  type RetroTarget,
  relationLabel,
  retroEmpty,
  retroTarget,
  sourceLabel,
  testParams,
  workStatusLabel,
} from './retro-model';

const CHECK_TONES: Record<string, StatusTone> = {
  passed: 'success',
  failed: 'danger',
  timed_out: 'danger',
  running: 'accent',
  environment_unavailable: 'warning',
  stale: 'warning',
};

/** 交付里“本地检查”的颜色。 */
export const DELIVERY_TONES: Record<string, StatusTone> = {
  passed: 'success',
  outdated: 'warning',
  failed: 'danger',
  running: 'accent',
  environment_unavailable: 'warning',
};

export function checkTone(check: Pick<RetroCheck, 'status' | 'evidence'>): StatusTone {
  if (check.status === 'passed' && check.evidence === 'outdated') return 'warning';
  return CHECK_TONES[check.status] ?? 'neutral';
}

export function RetroView({ session }: { session: Session }) {
  const sessionId = session.id as SessionId;
  const { retro, error, loading, reload } = useRetro(sessionId, true);
  const actions = useRetroActions(session, reload);
  const { open, copied } = useRetroOpen(session);

  if (!retro) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{error ?? t('retro.loading')}</p>;
  }
  const time = formatMessageTime(retro.checkedAt, currentLocale());
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-4 pt-2 pb-4 text-sm" data-testid="retro-view">
        <header className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
            {t('retro.meta', { seq: retro.throughSeq, time })}
            {retro.running && ` · ${t('retro.running')}`}
          </span>
          <IconButton
            label={t('retro.refresh')}
            size="icon-xs"
            disabled={loading}
            onClick={reload}
            data-action="retro-refresh"
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  label={t('retro.export')}
                  size="icon-xs"
                  disabled={actions.pending !== undefined}
                  data-action="retro-export"
                >
                  <Download />
                </IconButton>
              }
            />
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => void actions.exportAs('md')}>
                {t('retro.export.markdown')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void actions.exportAs('json')}>
                {t('retro.export.json')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton
            label={t('retro.newSession')}
            size="icon-xs"
            disabled={actions.pending !== undefined}
            onClick={() => void actions.startFromRetro()}
            data-action="retro-new-session"
          >
            <FilePlus2 />
          </IconButton>
        </header>
        {(actions.error || error) && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
            {actions.error ?? error}
          </p>
        )}
        {actions.notice && (
          <p className="text-xs text-muted-foreground" data-testid="retro-notice">
            {actions.notice}
          </p>
        )}
        {retroEmpty(retro) ? (
          <p className="text-muted-foreground">{t('retro.empty')}</p>
        ) : (
          <RetroSections retro={retro} open={open} copied={copied} />
        )}
        <SummarySection
          summary={retro.summary}
          pending={actions.pending === 'summary'}
          disabled={actions.pending !== undefined || retro.turns.length === 0 || retro.running}
          onGenerate={() => void actions.summarize()}
        />
      </div>
    </ScrollArea>
  );
}

function RetroSections({
  retro,
  open,
  copied,
}: {
  retro: SessionRetro;
  open: (target: RetroTarget) => void;
  copied: string | undefined;
}) {
  const row = (
    entry: RetroItem,
    children: ReactNode,
    extra?: { tone?: StatusTone; detail?: string | undefined; mono?: boolean },
  ) => (
    <RetroRow
      key={entry.id}
      id={entry.id}
      target={retroTarget(entry.ref, entry.source)}
      source={entry.source}
      inherited={entry.inherited}
      open={open}
      {...extra}
    >
      {children}
    </RetroRow>
  );
  const d = retro.delivery;
  return (
    <>
      <Section title={t('retro.section.goal')} testId="retro-goal">
        {retro.goal.goal &&
          row(retro.goal.goal, retro.goal.goal.text, {
            detail: goalStatusLabel(retro.goal.goal.status),
          })}
        {retro.goal.request &&
          row(retro.goal.request, retro.goal.request.text, { detail: t('retro.goal.request') })}
        {!retro.goal.recorded && <Empty>{t('retro.notRecorded')}</Empty>}
      </Section>

      <Section title={t('retro.section.next')} testId="retro-next">
        {retro.next.map((entry) =>
          row(entry, nextLabel(entry), { ...(nextDetail(entry) && { detail: nextDetail(entry) }) }),
        )}
        {retro.next.length === 0 && <Empty>{t('retro.next.none')}</Empty>}
      </Section>

      <Section title={t('retro.section.verification')} testId="retro-verification">
        {!retro.verification.recorded && (
          <li className="flex h-7 items-center gap-2.5" data-testid="retro-unverified">
            <StatusDot tone="neutral" />
            <span>{t('retro.unverified')}</span>
          </li>
        )}
        {retro.verification.checks.map((check) => (
          <RetroRow
            key={check.id}
            id={check.id}
            target={{ kind: 'seq', seq: check.seq }}
            open={open}
            tone={checkTone(check)}
            detail={[
              checkStatusText(check),
              check.evidence && evidenceLabel(check.evidence),
              check.tests && t('verification.tests', testParams(check.tests)),
            ]
              .filter(Boolean)
              .join(' · ')}
            data-evidence={check.evidence}
            data-check-status={check.status}
          >
            {check.name}
            {(check.earlier ?? []).length > 0 && (
              <span className="ml-1.5 inline-flex gap-1 align-middle" aria-hidden>
                {(check.earlier ?? []).map((run) => (
                  <StatusDot key={run.runId} tone={CHECK_TONES[run.status] ?? 'neutral'} />
                ))}
              </span>
            )}
          </RetroRow>
        ))}
      </Section>

      <Section title={t('retro.section.delivery')} testId="retro-delivery">
        <DeliveryRow name={t('retro.delivery.checks')} tone={DELIVERY_TONES[d.checks]}>
          {deliveryLabel(d.checks)}
        </DeliveryRow>
        <DeliveryRow name={t('retro.delivery.commit')}>
          {deliveryLabel(d.commit)}
          {retro.changes.uncommitted
            ? ` · ${t('retro.uncommitted', { count: retro.changes.uncommitted })}`
            : ''}
        </DeliveryRow>
        <DeliveryRow name={t('retro.delivery.push')}>
          {deliveryLabel(d.push)}
          {d.ahead ? ` · ${t('retro.ahead', { count: d.ahead })}` : ''}
        </DeliveryRow>
        <DeliveryRow name={t('retro.delivery.ci')}>{deliveryLabel(d.ci)}</DeliveryRow>
        <DeliveryRow name={t('retro.delivery.deploy')}>{deliveryLabel(d.deploy)}</DeliveryRow>
      </Section>

      <Section title={t('retro.section.open')} testId="retro-open">
        {retro.open.map((entry) =>
          row(entry, entry.text, {
            detail: `${originLabel(entry.origin)} · ${workStatusLabel(entry.status)}`,
          }),
        )}
        {retro.open.length === 0 && <Empty>{t('retro.none')}</Empty>}
      </Section>

      <Section title={t('retro.section.done')} testId="retro-done">
        {retro.done.map((entry) => row(entry, entry.text, { detail: originLabel(entry.origin) }))}
        {retro.done.length === 0 && <Empty>{t('retro.none')}</Empty>}
      </Section>

      <Section title={t('retro.section.changes')} testId="retro-changes">
        {retro.changes.files.map((file) => {
          const turnId = file.turnIds.at(-1);
          const available = file.diff === 'available' || file.diff === 'live';
          return (
            <RetroRow
              key={file.id}
              id={file.id}
              target={
                available && turnId
                  ? { kind: 'diff', scope: { kind: 'turn', turnId }, path: file.path }
                  : undefined
              }
              open={open}
              detail={diffLabel(file.diff)}
              mono
            >
              {file.path}
            </RetroRow>
          );
        })}
        {retro.changes.omittedFiles ? (
          <Empty>{t('retro.moreFiles', { count: retro.changes.omittedFiles })}</Empty>
        ) : null}
        {!retro.changes.recorded && <Empty>{t('retro.notRecorded')}</Empty>}
      </Section>

      {retro.changes.commits.length > 0 && (
        <Section title={t('retro.section.commits')} testId="retro-commits">
          {retro.changes.commits.map((commit) => (
            <RetroRow
              key={commit.id}
              id={commit.id}
              target={{ kind: 'commit', sha: commit.sha }}
              open={open}
              detail={copied === commit.sha ? t('retro.copied') : commit.sha.slice(0, 8)}
              title={t('retro.copySha')}
            >
              {commit.subject}
            </RetroRow>
          ))}
        </Section>
      )}

      {(retro.review.comments.length > 0 || !retro.review.recorded) && (
        <Section title={t('retro.section.review')} testId="retro-review">
          {retro.review.comments.map((comment) =>
            row(comment, comment.text, {
              detail: [
                `${comment.path}:${comment.line}`,
                t(comment.status === 'pending' ? 'retro.review.pending' : 'retro.review.sent'),
                comment.outdated && t('retro.review.outdated'),
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          )}
          {!retro.review.recorded && <Empty>{t('retro.notRecorded')}</Empty>}
        </Section>
      )}

      <Section title={t('retro.section.decisions')} testId="retro-decisions">
        {retro.omittedDecisions ? (
          <Empty>{t('retro.moreDecisions', { count: retro.omittedDecisions })}</Empty>
        ) : null}
        {retro.decisions.map((entry) =>
          row(entry, entry.text || decisionLabel(entry.kind), {
            ...(entry.text !== '' && { detail: decisionLabel(entry.kind) }),
          }),
        )}
        {retro.decisions.length === 0 && <Empty>{t('retro.none')}</Empty>}
        {retro.hiddenTurns > 0 && (
          <Empty>{t('retro.hiddenTurns', { count: retro.hiddenTurns })}</Empty>
        )}
      </Section>

      {retro.verification.commands.length > 0 && (
        <Section title={t('retro.section.commands')} testId="retro-commands">
          {retro.verification.commands.map((command) =>
            row(command, command.text, {
              ...(command.status !== undefined && { detail: workStatusLabel(command.status) }),
              mono: true,
            }),
          )}
        </Section>
      )}

      {(retro.sessions.length > 0 || retro.memories.length > 0) && (
        <Section title={t('retro.section.related')} testId="retro-related">
          {retro.sessions.map((entry) =>
            row(entry, entry.text, { detail: relationLabel(entry.relation) }),
          )}
          {retro.memories.map((entry) =>
            row(entry, entry.name, {
              detail: t(entry.operation === 'save' ? 'retro.memory.save' : 'retro.memory.delete'),
            }),
          )}
        </Section>
      )}
    </>
  );
}

function SummarySection({
  summary,
  pending,
  disabled,
  onGenerate,
}: {
  summary: RetroSummary | undefined;
  pending: boolean;
  disabled: boolean;
  onGenerate: () => void;
}) {
  return (
    <section data-testid="retro-summary">
      <h3 className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles aria-hidden className="size-3.5" />
        <span className="flex-1">{t('retro.section.summary')}</span>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || pending}
          onClick={onGenerate}
          data-action="retro-summarize"
        >
          {pending
            ? t('retro.summary.generating')
            : summary
              ? t('retro.summary.regenerate')
              : t('retro.summary.generate')}
        </Button>
      </h3>
      {summary && (
        <div className="mt-1 rounded-lg border border-border px-3 py-2">
          <ul className="space-y-1.5">
            {summary.points.map((point) => (
              <li key={point.text} className="leading-snug" data-inferred={point.inferred}>
                {point.text}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {point.inferred ? t('retro.summary.inferred') : point.refs.join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground tabular-nums">
            {[
              `${summary.providerId} / ${summary.modelId}`,
              summary.usage
                ? t('retro.summary.usage', {
                    input: formatTokens(summary.usage.inputTokens),
                    output: formatTokens(summary.usage.outputTokens),
                  })
                : t('retro.summary.usageMissing'),
              summary.outdated && t('retro.summary.outdated'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId}>
      <h3 className="pb-1 text-xs text-muted-foreground">{title}</h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <li className="flex h-7 items-center text-muted-foreground">{children}</li>;
}

function DeliveryRow({
  name,
  tone,
  children,
}: {
  name: string;
  tone?: StatusTone | undefined;
  children: ReactNode;
}) {
  return (
    <li className="flex h-7 min-w-0 items-center gap-2.5">
      <span className="w-16 shrink-0 text-muted-foreground">{name}</span>
      {tone && <StatusDot tone={tone} />}
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

/** 一行：有出处时是按钮（来源已删除、来源未知时写在右边），没有时是纯文字。 */
export function RetroRow({
  id,
  target,
  source,
  inherited,
  open,
  tone,
  detail,
  mono = false,
  title,
  children,
  ...data
}: {
  id: string;
  target: RetroTarget | undefined;
  source?: RetroSourceState | undefined;
  inherited?: true | undefined;
  open: (target: RetroTarget) => void;
  tone?: StatusTone | undefined;
  detail?: string | undefined;
  mono?: boolean;
  title?: string;
  children: ReactNode;
  [key: `data-${string}`]: string | undefined;
}) {
  const tags = [detail, inherited && t('retro.inherited'), sourceLabel(source)].filter(Boolean);
  const body = (
    <>
      {tone && <StatusDot tone={tone} />}
      <span className={cn('min-w-0 flex-1 truncate', mono && 'font-mono text-xs')}>{children}</span>
      {tags.length > 0 && (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
          {tags.join(' · ')}
        </span>
      )}
    </>
  );
  const className =
    '-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left';
  return (
    <li data-retro-id={id} {...data}>
      {target ? (
        <button
          type="button"
          title={title}
          onClick={() => open(target)}
          className={cn(
            className,
            'outline-none transition-colors hover:bg-muted focus-visible:focus-ring',
          )}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}
