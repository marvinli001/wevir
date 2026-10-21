// 任务回顾（0.76.0，Host 功能 `session_retro`）在界面上的写法：各种状态的名称、每行的出处打开什么、导出的 Markdown。回顾本身由
// Host 从事件生成（`retro.get`），这里只翻译与排版，不推断：没有验证记录就是“未验证”，清单的“已完成”只是登记。

import type {
  RetroCheck,
  RetroItem,
  RetroRef,
  RetroSourceState,
  SessionId,
  SessionRetro,
} from '@wevir/protocol';
import type { ChangesScope } from '@/changes/changes-model';
import { type PlainMessageKey, t } from '@/i18n';
import { GOAL_STATUS_LABELS } from '@/session/goal-model';
import { RUN_LABELS, reasonLabel } from '@/session/verification-model';

const label = (labels: Record<string, PlainMessageKey>, value: string): string => {
  const key = labels[value];
  return key === undefined ? value : t(key);
};

const WORK_STATUS: Record<string, PlainMessageKey> = {
  completed: 'retro.status.completed',
  pending: 'retro.status.pending',
  in_progress: 'retro.status.in_progress',
  cancelled: 'retro.status.cancelled',
  failed: 'retro.status.failed',
  interrupted: 'retro.status.interrupted',
};
export const workStatusLabel = (status: string) => label(WORK_STATUS, status);

const ORIGINS: Record<string, PlainMessageKey> = {
  todo: 'retro.origin.todo',
  board: 'retro.origin.board',
  turn: 'retro.origin.turn',
  approval: 'retro.origin.approval',
  question: 'retro.origin.question',
};
export const originLabel = (origin: string) => label(ORIGINS, origin);

const DECISIONS: Record<string, PlainMessageKey> = {
  instruction: 'retro.decision.instruction',
  steer: 'retro.decision.steer',
  answer: 'retro.decision.answer',
  declined: 'retro.decision.declined',
  cancelled: 'retro.decision.cancelled',
  undone: 'retro.decision.undone',
  redone: 'retro.decision.redone',
  rewound: 'retro.decision.rewound',
  handoff: 'retro.decision.handoff',
};
export const decisionLabel = (kind: string) => label(DECISIONS, kind);

const NEXT: Record<string, PlainMessageKey> = {
  decide: 'retro.next.decide',
  fix_check: 'retro.next.fix_check',
  rerun_check: 'retro.next.rerun_check',
  run_checks: 'retro.next.run_checks',
  environment: 'retro.next.environment',
  send_review: 'retro.next.send_review',
  open_item: 'retro.next.open_item',
  retry_turn: 'retro.next.retry_turn',
};

/** 下一步的名称；提交与推送的 `text` 是个数。 */
export function nextLabel(entry: { kind: string; text: string }): string {
  const count = Number.parseInt(entry.text, 10) || 0;
  if (entry.kind === 'commit') return t('retro.next.commit', { count });
  if (entry.kind === 'push') return t('retro.next.push', { count });
  return label(NEXT, entry.kind);
}

/** 下一步除了名称以外的那段文字（检查名、清单项）；提交与推送没有。 */
export function nextDetail(entry: { kind: string; text: string }): string | undefined {
  if (entry.kind === 'commit' || entry.kind === 'push') return undefined;
  return entry.text === '' ? undefined : entry.text;
}

const STATES: Record<string, PlainMessageKey> = {
  passed: 'retro.state.passed',
  outdated: 'retro.state.outdated',
  failed: 'retro.state.failed',
  running: 'retro.state.running',
  environment_unavailable: 'retro.state.environment_unavailable',
  unverified: 'retro.state.unverified',
  uncommitted: 'retro.state.uncommitted',
  committed: 'retro.state.committed',
  clean: 'retro.state.clean',
  unknown: 'retro.state.unknown',
  not_pushed: 'retro.state.not_pushed',
  pushed: 'retro.state.pushed',
  no_upstream: 'retro.state.no_upstream',
};
/** 交付各项的状态（本地检查、提交、推送、CI、部署）。 */
export const deliveryLabel = (state: string) => label(STATES, state);

const EVIDENCE: Record<string, PlainMessageKey> = {
  current: 'retro.evidence.current',
  outdated: 'retro.evidence.outdated',
  unbound: 'retro.evidence.unbound',
};
export const evidenceLabel = (evidence: string) => label(EVIDENCE, evidence);

const DIFF: Record<string, PlainMessageKey> = {
  available: 'retro.diff.available',
  live: 'retro.diff.live',
  deleted: 'retro.source.deleted',
  none: 'retro.diff.none',
  not_git: 'retro.diff.not_git',
};
export const diffLabel = (state: string) => label(DIFF, state);

const RELATIONS: Record<string, PlainMessageKey> = {
  forked_from: 'retro.relation.forked_from',
  subagent: 'retro.relation.subagent',
  opened: 'retro.relation.opened',
};
export const relationLabel = (relation: string) => label(RELATIONS, relation);

const SUMMARY_REASONS: Record<string, PlainMessageKey> = {
  unsupported: 'retro.summary.reason.unsupported',
  sub_session: 'retro.summary.reason.unsupported',
  running: 'retro.summary.reason.running',
  unavailable: 'retro.summary.reason.unavailable',
  failed: 'retro.summary.reason.failed',
  unparsable: 'retro.summary.reason.unparsable',
  empty: 'retro.summary.reason.empty',
};
export const summaryReasonLabel = (reason: string) => label(SUMMARY_REASONS, reason);

export const goalStatusLabel = (status: keyof typeof GOAL_STATUS_LABELS) =>
  t(GOAL_STATUS_LABELS[status]);

/** 一条检查记录的状态与原因：“失败 · 退出码非零”。 */
export function checkStatusText(check: Pick<RetroCheck, 'status' | 'reason'>): string {
  const status = t(RUN_LABELS[check.status]);
  const reason = check.status === 'passed' ? undefined : reasonLabel(check.reason);
  return reason ? `${status} · ${t(reason)}` : status;
}

/** 出处现在打不开时的说明（来源已删除、来源未知）。 */
export function sourceLabel(source: RetroSourceState | undefined): string | undefined {
  if (source === 'deleted') return t('retro.source.deleted');
  if (source === 'unknown') return t('retro.source.unknown');
  return undefined;
}

/** 一行的出处在界面上打开什么。来源已删除时没有。 */
export type RetroTarget =
  | { kind: 'seq'; seq: number }
  | { kind: 'diff'; scope: ChangesScope; path?: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'memory' };

export function retroTarget(
  ref: RetroRef | undefined,
  source?: RetroSourceState,
): RetroTarget | undefined {
  if (ref === undefined || source === 'deleted') return undefined;
  switch (ref.kind) {
    case 'event':
    case 'verification':
      return { kind: 'seq', seq: ref.seq };
    case 'turn_diff':
      return {
        kind: 'diff',
        scope: { kind: 'turn', turnId: ref.turnId },
        ...(ref.path !== undefined && { path: ref.path }),
      };
    case 'review':
      return { kind: 'diff', scope: ref.source, path: ref.path };
    case 'commit':
      return { kind: 'commit', sha: ref.sha };
    case 'session':
      return { kind: 'session', sessionId: ref.sessionId };
    case 'memory':
      return { kind: 'memory' };
  }
}

/** 回顾里有没有任何内容（新会话、还没有回合时显示“暂无记录”）。 */
export function retroEmpty(retro: SessionRetro): boolean {
  return retro.turns.length === 0 && !retro.goal.recorded && retro.decisions.length === 0;
}

// ── 导出 ───────────────────────────────────────────────────────

export function retroFileName(sessionId: string, format: 'md' | 'json'): string {
  return `retro-${sessionId}.${format}`;
}

export function retroJson(retro: SessionRetro, redactions: number | undefined): string {
  return `${JSON.stringify({ retro, ...(redactions !== undefined && { redactions }) }, null, 2)}\n`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function cite(item: { id: string; inherited?: true; source?: RetroSourceState }): string {
  const tags = [item.id];
  if (item.inherited) tags.push(t('retro.inherited'));
  const source = sourceLabel(item.source);
  if (source) tags.push(source);
  return ` (${tags.join(' · ')})`;
}

/**
 * 导出与“基于回顾新建”的 Markdown，界面语言。每行末尾括号里是出处 ID（与 `wevir_session_retro` 给 Agent 的英文版同一套 ID）。
 * `redactions` 有值时（导出前 Host 已脱敏）开头注明替换了几处、只做了正则检查。
 */
export function retroMarkdownText(
  retro: SessionRetro,
  options: { title?: string; redactions?: number; checkedAt?: string } = {},
): string {
  const out: string[] = [];
  const notRecorded = `- ${t('retro.notRecorded')}`;
  const section = (name: string, lines: string[], empty = notRecorded) => {
    out.push('', `## ${name}`, ...(lines.length === 0 ? [empty] : lines));
  };
  const item = (prefix: string, entry: RetroItem) =>
    `- ${prefix}${oneLine(entry.text)}${cite(entry)}`;

  out.push(`# ${t('rail.retro')}${options.title ? ` · ${oneLine(options.title)}` : ''}`);
  out.push('', t('retro.meta', { seq: retro.throughSeq, time: retro.checkedAt }));
  if (retro.running) out.push('', t('retro.running'));
  if (options.redactions !== undefined) {
    out.push('', t('retro.export.redacted', { count: options.redactions }));
  }

  const goal: string[] = [];
  if (retro.goal.goal) {
    goal.push(item(`${goalStatusLabel(retro.goal.goal.status)}：`, retro.goal.goal));
  }
  if (retro.goal.request) goal.push(item(`${t('retro.goal.request')}：`, retro.goal.request));
  section(t('retro.section.goal'), goal);
  if (retro.chapters && retro.chapters.length > 0) {
    section(
      t('retro.section.chapters'),
      retro.chapters.map((chapter) =>
        item('', {
          ...chapter,
          text: `${chapter.text}${chapter.summary ? `：${chapter.summary}` : ''}（${t('retro.chapterTurns', { count: chapter.turns })}）`,
        }),
      ),
    );
  }

  section(
    t('retro.section.done'),
    retro.done.map((entry) => item(`[${originLabel(entry.origin)}] `, entry)),
    `- ${t('retro.none')}`,
  );
  const open = retro.open.map((entry) =>
    item(`[${originLabel(entry.origin)} · ${workStatusLabel(entry.status)}] `, entry),
  );
  if (!retro.boardRecorded) open.push(`- ${t('retro.board.notRecorded')}`);
  section(t('retro.section.open'), open, `- ${t('retro.none')}`);

  const verification: string[] = [];
  if (!retro.verification.recorded) verification.push(`- ${t('retro.unverified')}`);
  for (const check of retro.verification.checks) {
    const detail = [checkStatusText(check), check.evidence && evidenceLabel(check.evidence)]
      .filter(Boolean)
      .join(' · ');
    const tests = check.tests ? ` · ${t('verification.tests', testParams(check.tests))}` : '';
    verification.push(
      `- ${check.name} \`${oneLine(check.command)}\`：${detail}${tests}${cite(check)}`,
    );
    for (const run of check.earlier ?? []) {
      verification.push(`  - ${checkStatusText(run)} (v:${run.runId})`);
    }
  }
  if (retro.verification.commands.length > 0) {
    verification.push('', `${t('retro.section.commands')}：`);
    for (const command of retro.verification.commands) {
      const status = command.status === undefined ? '' : ` ${workStatusLabel(command.status)}`;
      verification.push(`- \`${oneLine(command.text)}\`${status}${cite(command)}`);
    }
  }
  section(t('retro.section.verification'), verification);

  const d = retro.delivery;
  section(t('retro.section.delivery'), [
    `- ${t('retro.delivery.checks')}：${deliveryLabel(d.checks)}`,
    `- ${t('retro.delivery.commit')}：${deliveryLabel(d.commit)}${
      retro.changes.uncommitted
        ? ` · ${t('retro.uncommitted', { count: retro.changes.uncommitted })}`
        : ''
    }`,
    `- ${t('retro.delivery.push')}：${deliveryLabel(d.push)}${
      d.ahead ? ` · ${t('retro.ahead', { count: d.ahead })}` : ''
    }`,
    `- ${t('retro.delivery.ci')}：${deliveryLabel(d.ci)}`,
    `- ${t('retro.delivery.deploy')}：${deliveryLabel(d.deploy)}`,
  ]);

  const changes = retro.changes.files.map(
    (file) => `- ${file.path} · ${diffLabel(file.diff)}${cite(file)}`,
  );
  if (retro.changes.omittedFiles) {
    changes.push(`- ${t('retro.moreFiles', { count: retro.changes.omittedFiles })}`);
  }
  section(t('retro.section.changes'), changes);
  if (retro.changes.commits.length > 0) {
    section(
      t('retro.section.commits'),
      retro.changes.commits.map(
        (commit) => `- ${commit.sha.slice(0, 12)} ${oneLine(commit.subject)}${cite(commit)}`,
      ),
    );
  }

  section(
    t('retro.section.review'),
    retro.review.comments.map(
      (comment) =>
        `- ${comment.path}:${comment.line} [${t(
          comment.status === 'pending' ? 'retro.review.pending' : 'retro.review.sent',
        )}${comment.outdated ? ` · ${t('retro.review.outdated')}` : ''}] ${oneLine(comment.text)}${cite(comment)}`,
    ),
    retro.review.recorded ? `- ${t('retro.none')}` : notRecorded,
  );

  const decisions = retro.decisions.map((entry) => item(`[${decisionLabel(entry.kind)}] `, entry));
  if (retro.omittedDecisions) {
    decisions.unshift(`- ${t('retro.moreDecisions', { count: retro.omittedDecisions })}`);
  }
  if (retro.hiddenTurns > 0) {
    decisions.push(`- ${t('retro.hiddenTurns', { count: retro.hiddenTurns })}`);
  }
  section(t('retro.section.decisions'), decisions, `- ${t('retro.none')}`);

  section(
    t('retro.section.next'),
    retro.next.map((entry) => {
      const detail = nextDetail(entry);
      return `- ${nextLabel(entry)}${detail ? `：${oneLine(detail)}` : ''}${cite(entry)}`;
    }),
    `- ${t('retro.next.none')}`,
  );

  const related = [
    ...retro.sessions.map((entry) => item(`[${relationLabel(entry.relation)}] `, entry)),
    ...retro.memories.map((entry) =>
      item(
        `[${t(entry.operation === 'save' ? 'retro.memory.save' : 'retro.memory.delete')}] `,
        entry,
      ),
    ),
  ];
  if (related.length > 0) section(t('retro.section.related'), related);

  if (retro.summary) {
    const s = retro.summary;
    out.push(
      '',
      `## ${t('retro.section.summary')} · ${s.providerId}/${s.modelId}${
        s.outdated ? ` · ${t('retro.summary.outdated')}` : ''
      }`,
      ...s.points.map(
        (point) =>
          `- ${oneLine(point.text)} (${point.inferred ? t('retro.summary.inferred') : point.refs.join(', ')})`,
      ),
    );
  }
  return `${out.join('\n')}\n`;
}

/** 同 verification-model 的 testCount：跳过的不算进总数。 */
export function testParams(tests: { passed: number; failed: number }) {
  return { passed: tests.passed, total: tests.passed + tests.failed };
}
