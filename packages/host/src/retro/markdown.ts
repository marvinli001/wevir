// 给 Agent 看的回顾（`wevir_session_retro`，ADR-0012 决策 12）：英文 Markdown，结构同桌面的导出。每行末尾括号里是出处 ID。

import type { RetroItem, SessionRetro } from '@wevir/protocol';

const EVIDENCE: Record<string, string> = {
  current: 'matches the current code',
  outdated: 'result is for an older version of the code; rerun',
  unbound: 'not bound to a code version',
};

const DIFF: Record<string, string> = {
  available: 'diff available',
  live: 'turn in progress',
  deleted: 'source deleted',
  none: 'no snapshot',
  not_git: 'not a git repository',
};

function cite(item: { id: string; inherited?: true; source?: string }): string {
  const tags = [item.id];
  if (item.inherited) tags.push('before the branch');
  if (item.source === 'deleted') tags.push('source deleted');
  return ` (${tags.join('; ')})`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function retroMarkdown(retro: SessionRetro, title?: string): string {
  const out: string[] = [];
  const section = (name: string, lines: string[], empty = '- Not recorded.') => {
    out.push('', `## ${name}`, ...(lines.length === 0 ? [empty] : lines));
  };
  const item = (prefix: string, entry: RetroItem) =>
    `- ${prefix}${oneLine(entry.text)}${cite(entry)}`;

  out.push(`# Task retro${title ? `: ${oneLine(title)}` : ''}`);
  out.push(
    '',
    `Session ${retro.sessionId}, through event ${retro.throughSeq} (schema ${retro.schemaVersion}), checked ${retro.checkedAt}.${retro.running ? ' A turn is still running.' : ''}`,
    'Built from the session events, not written by a model. "Done" is the recorded status of a list item, not verification.',
  );

  const goal: string[] = [];
  if (retro.goal.goal) goal.push(item(`Goal (${retro.goal.goal.status}): `, retro.goal.goal));
  if (retro.goal.request) goal.push(item('First request: ', retro.goal.request));
  section('Goal', goal);

  if (retro.chapters && retro.chapters.length > 0) {
    section(
      'Chapters',
      retro.chapters.map((chapter) =>
        item('', {
          ...chapter,
          text: `${chapter.text}${chapter.summary ? `: ${chapter.summary}` : ''} (${chapter.turns} turn${chapter.turns === 1 ? '' : 's'})`,
        }),
      ),
    );
  }

  section(
    'Done (recorded)',
    retro.done.map((entry) => item(`[${entry.origin}] `, entry)),
    '- None recorded.',
  );
  section(
    'Open',
    retro.open.map((entry) => item(`[${entry.origin}, ${entry.status}] `, entry)),
    '- None recorded.',
  );
  if (!retro.boardRecorded) out.push('- Task list: not recorded in this session.');

  const verification: string[] = [];
  if (!retro.verification.recorded) verification.push('- Unverified: no verification records.');
  for (const check of retro.verification.checks) {
    const detail = [check.status, check.reason, check.evidence && EVIDENCE[check.evidence]]
      .filter(Boolean)
      .join(', ');
    const tests = check.tests
      ? ` tests ${check.tests.passed} passed, ${check.tests.failed} failed`
      : '';
    verification.push(
      `- ${check.name} (\`${oneLine(check.command)}\`): ${detail}${tests}${cite(check)}`,
    );
  }
  if (retro.verification.commands.length > 0) {
    verification.push('', 'Commands the agent ran (not verification):');
    for (const command of retro.verification.commands) {
      verification.push(
        `- \`${oneLine(command.text)}\` ${command.status ?? 'running'}${cite(command)}`,
      );
    }
  }
  section('Verification', verification);

  const d = retro.delivery;
  section('Delivery', [
    `- Local checks: ${d.checks}`,
    `- Commit: ${d.commit}${retro.changes.uncommitted ? ` (${retro.changes.uncommitted} uncommitted files)` : ''}`,
    `- Push: ${d.push}${d.ahead ? ` (${d.ahead} unpushed commits)` : ''}`,
    `- CI: ${d.ci}`,
    `- Deploy: ${d.deploy}`,
  ]);

  const changes: string[] = retro.changes.files.map(
    (file) =>
      `- ${file.path}: ${file.turnIds.length} turn(s), ${DIFF[file.diff] ?? file.diff}${cite(file)}`,
  );
  if (retro.changes.omittedFiles) changes.push(`- ${retro.changes.omittedFiles} more files`);
  for (const commit of retro.changes.commits) {
    changes.push(
      `- Commit during the session ${commit.sha.slice(0, 12)} ${oneLine(commit.subject)}${cite(commit)}`,
    );
  }
  section('Changes', changes);

  section(
    'Review comments',
    retro.review.comments.map(
      (comment) =>
        `- ${comment.path}:${comment.line} [${comment.status}${comment.outdated ? ', outdated' : ''}] ${oneLine(comment.text)}${cite(comment)}`,
    ),
    retro.review.recorded ? '- None.' : '- Not recorded.',
  );

  const decisions = retro.decisions.map((entry) => item(`[${entry.kind}] `, entry));
  if (retro.omittedDecisions)
    decisions.unshift(`- ${retro.omittedDecisions} earlier decisions omitted`);
  if (retro.hiddenTurns > 0)
    decisions.push(`- ${retro.hiddenTurns} undone turn(s) are not listed.`);
  section('Decisions', decisions, '- None recorded.');

  section(
    'Next steps',
    retro.next.map((entry) => `- [${entry.kind}] ${oneLine(entry.text)}${cite(entry)}`),
    '- None derived.',
  );

  const related = [
    ...retro.sessions.map((entry) => item(`[${entry.relation}] ${entry.sessionId} `, entry)),
    ...retro.memories.map((entry) => item(`[memory ${entry.operation}, ${entry.scope}] `, entry)),
  ];
  if (related.length > 0) section('Related', related);

  if (retro.summary) {
    const s = retro.summary;
    out.push(
      '',
      `## Model summary (model-generated by ${s.providerId}/${s.modelId}${s.outdated ? ', based on older records' : ''})`,
      ...s.points.map(
        (point) =>
          `- ${oneLine(point.text)} (${point.inferred ? 'inferred' : point.refs.join(', ')})`,
      ),
    );
  }
  return `${out.join('\n')}\n`;
}
