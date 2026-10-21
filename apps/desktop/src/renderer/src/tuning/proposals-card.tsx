// 调优的一条建议（0.87.0）：种类、标题、来自哪个会话、改动的 diff（AGENTS.md 是改前改后，技能与记忆是新增的文本，护栏是规则）、证据
// （点开跳到会话里对应的位置，同任务回顾）与操作。待审的可以采纳、编辑（文本框，diff 跟着变）、拒绝；已过时的只能拒绝或重新生成；
// 已处理的显示结果、产生的版本与之后的统计。

import { parseDiffFromFile } from '@pierre/diffs';
import type { CodeViewDiffItem } from '@pierre/diffs/react';
import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { Session, TuningProposal, TuningProposalEvidence } from '@wevir/protocol';
import { cn } from 'cn';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { resolveDiffThemeName } from '@/changes/diff-rendering';
import { PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { StyledDiffCodeView } from '@/changes/styled-code-view';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { useRetroOpen } from '@/retro/retro-data';
import { retroTarget } from '@/retro/retro-model';
import { useSessions } from '@/session/suggested-tasks';
import { useTheme } from '@/theme/theme';
import {
  changeTexts,
  diffLineCount,
  editParams,
  evidenceLabel,
  kindName,
  proposalTokens,
  ruleLine,
  statsText,
  withNewline,
} from './proposals-model';
import { versionLabel } from './tuning-model';

type Busy = 'accept' | 'reject' | 'save' | 'regenerate';

export function ProposalCard({
  client,
  proposal,
  onRegenerate,
}: {
  client: WevirClient;
  proposal: TuningProposal;
  /** 重新生成（已过时的那条）：由页面发 `generate`，结果显示在页面上。 */
  onRegenerate: (proposal: TuningProposal) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const texts = changeTexts(proposal.change);
  const stale = proposal.status === 'stale';
  const decided = proposal.status === 'accepted' || proposal.status === 'rejected';
  const edit = editing === undefined ? undefined : editParams(proposal.change, editing);

  const run = async (kind: Busy, task: () => Promise<unknown>) => {
    setBusy(kind);
    setError(undefined);
    try {
      await task();
    } catch (reason) {
      // 目标已改动：卡片随通知变成“已过时”，那一行已经说明了。
      if (!isRpcError(reason, 'PROPOSAL_STALE')) {
        setError(t('tuning.proposal.actionFailed', { error: describe(reason) }));
      }
    } finally {
      setBusy(undefined);
    }
  };
  const decide = (decision: 'accept' | 'reject') =>
    run(decision, () =>
      client.request('tuning.proposal.decide', { proposalId: proposal.id, decision }),
    );
  const save = () =>
    run('save', async () => {
      if (edit !== undefined && edit !== 'invalid') {
        await client.request('tuning.proposal.update', { proposalId: proposal.id, ...edit });
      }
      setEditing(undefined);
    });

  return (
    <li
      className="space-y-2.5 px-4 py-3"
      data-proposal={proposal.id}
      data-kind={proposal.kind}
      data-status={proposal.status}
    >
      <ProposalHeader proposal={proposal} />
      {proposal.change.kind === 'guardrail' && editing === undefined ? (
        <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs">
          {ruleLine(proposal.change.rule)}
        </p>
      ) : (
        <ProposalDiff
          id={proposal.id}
          name={texts.name}
          before={texts.before}
          after={editing ?? texts.after}
        />
      )}
      {editing !== undefined && (
        <Textarea
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          aria-label={t('tuning.proposal.edit')}
          aria-invalid={edit === 'invalid' || undefined}
          className="max-h-80 font-mono text-xs"
          data-field="proposal-text"
        />
      )}
      <EvidenceList proposal={proposal} />
      {error !== undefined && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {decided ? (
          <DecidedSummary proposal={proposal} />
        ) : editing !== undefined ? (
          <>
            <Button
              size="sm"
              disabled={busy !== undefined || edit === 'invalid'}
              onClick={() => void save()}
              data-action="proposal-save"
            >
              {t('tuning.proposal.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
              {t('common.cancel')}
            </Button>
            {edit === 'invalid' && (
              <span className="text-xs text-destructive">{t('tuning.proposal.ruleInvalid')}</span>
            )}
          </>
        ) : stale ? (
          <>
            <span className="text-xs text-warning">
              {t('tuning.proposal.status.stale')} · {t('tuning.proposal.stale')}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={busy !== undefined}
              onClick={() => void run('regenerate', () => onRegenerate(proposal))}
              data-action="proposal-regenerate"
            >
              {busy === 'regenerate'
                ? t('tuning.proposals.generating')
                : t('tuning.proposal.regenerate')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== undefined}
              onClick={() => void decide('reject')}
              data-action="proposal-reject"
            >
              {t('tuning.proposal.reject')}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy !== undefined}
              onClick={() => void decide('accept')}
              data-action="proposal-accept"
            >
              {t('tuning.proposal.accept')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== undefined}
              onClick={() => setEditing(texts.after)}
              data-action="proposal-edit"
            >
              {t('tuning.proposal.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== undefined}
              onClick={() => void decide('reject')}
              data-action="proposal-reject"
            >
              {t('tuning.proposal.reject')}
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {[proposal.edited && t('tuning.proposal.edited'), proposalTokens(proposal)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

function ProposalHeader({ proposal }: { proposal: TuningProposal }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground">
        {kindName(proposal.kind)}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium" title={proposal.title}>
        {proposal.title}
      </span>
      <span className="max-w-60 shrink-0 truncate text-xs text-muted-foreground">
        {t('tuning.proposal.from', {
          title: proposal.sessionTitle ?? t('tuning.proposal.untitled'),
        })}
      </span>
    </div>
  );
}

/** 已处理：结果、时刻、产生的版本与统计、用量。 */
function DecidedSummary({ proposal }: { proposal: TuningProposal }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span
        className={cn(
          'shrink-0 font-medium',
          proposal.status === 'accepted' ? 'text-success' : 'text-muted-foreground',
        )}
      >
        {proposal.status === 'accepted'
          ? t('tuning.proposal.status.accepted')
          : t('tuning.proposal.status.rejected')}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {[
          proposal.version && versionLabel(proposal.version.seq),
          statsText(proposal),
          proposal.edited && t('tuning.proposal.edited'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="shrink-0">{proposalTokens(proposal)}</span>
    </span>
  );
}

/** diff 框的最大高度、行高与文件名一栏加上下边距（px，与 StyledDiffCodeView 的排版一致）：短的按行数定高，不留空白。 */
const DIFF_MAX_HEIGHT = 224;
const DIFF_LINE_HEIGHT = 20;
const DIFF_HEADER_HEIGHT = 50;
/** 代码视图的字宽与行号栏宽（折行估算用，宁大勿小）。 */
const DIFF_CHAR_WIDTH = 7.4;
const DIFF_GUTTER_WIDTH = 88;

/** 两段文本的 diff（改前为空时整段是新增）。 */
function ProposalDiff({
  id,
  name,
  before,
  after,
}: {
  id: string;
  name: string;
  before: string;
  after: string;
}) {
  const { resolved: theme } = useTheme();
  const items = useMemo<CodeViewDiffItem<undefined>[]>(() => {
    // 代码视图按条目 ID 缓存渲染：编辑时文本变了就换 ID，diff 才跟着变。
    const key = `proposal:${id}:${after.length}:${hash(after)}`;
    return [
      {
        id: key,
        type: 'diff',
        fileDiff: parseDiffFromFile(
          { name, contents: withNewline(before), cacheKey: `proposal:${id}:before` },
          { name, contents: withNewline(after), cacheKey: key },
        ),
        collapsed: false,
      },
    ];
  }, [id, name, before, after]);
  // 长行会折行：按框宽估每行能放几个字，框高才不会因少算而出滚动条。
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const columns =
    width > DIFF_GUTTER_WIDTH
      ? Math.max(1, Math.floor((width - DIFF_GUTTER_WIDTH) / DIFF_CHAR_WIDTH))
      : Infinity;
  const height = Math.min(
    DIFF_MAX_HEIGHT,
    DIFF_HEADER_HEIGHT + DIFF_LINE_HEIGHT * diffLineCount(before, after, columns),
  );
  return (
    <div
      ref={box}
      className="overflow-hidden rounded-md border border-border"
      style={{ height }}
      data-testid="proposal-diff"
    >
      <StyledDiffCodeView
        className="h-full min-h-0 overflow-auto"
        items={items}
        options={{
          diffStyle: 'unified',
          lineDiffType: 'none',
          overflow: 'wrap',
          theme: resolveDiffThemeName(theme),
          themeType: theme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          hunkSeparators: 'line-info',
        }}
      />
    </div>
  );
}

/** 编辑时 diff 的缓存键：文本变了就换。 */
function hash(text: string): string {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) | 0;
  return (value >>> 0).toString(36);
}

/** 证据：会话还在时可以点开（跳到会话里对应的位置）。 */
function EvidenceList({ proposal }: { proposal: TuningProposal }) {
  const session = useSessions().get(proposal.sessionId);
  if (proposal.evidence.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
      data-testid="proposal-evidence"
    >
      <span className="text-muted-foreground">{t('tuning.proposal.evidence')}</span>
      {session === undefined ? (
        proposal.evidence.map((item) => (
          <span key={item.id} title={item.text} className="max-w-48 truncate text-muted-foreground">
            {evidenceLabel(item)}
          </span>
        ))
      ) : (
        <EvidenceLinks session={session} evidence={proposal.evidence} />
      )}
    </div>
  );
}

function EvidenceLinks({
  session,
  evidence,
}: {
  session: Session;
  evidence: readonly TuningProposalEvidence[];
}) {
  const { open } = useRetroOpen(session);
  return evidence.map((item) => {
    const target = retroTarget(item.ref);
    return target === undefined ? (
      <span key={item.id} title={item.text} className="max-w-48 truncate text-muted-foreground">
        {evidenceLabel(item)}
      </span>
    ) : (
      <button
        key={item.id}
        type="button"
        onClick={() => open(target)}
        title={item.text}
        className="max-w-48 truncate rounded-sm text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:focus-ring"
        data-action="proposal-evidence"
      >
        {evidenceLabel(item)}
      </button>
    );
  });
}
