// 调优的改动（0.87.0，desktop-layout.md §35）的纯逻辑：种类名、生成没成的原因与生成结果的一行。

import type { TuningProposalKind } from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import { formatTokens } from '@/layout/rail-model';

const KIND_KEYS: Record<TuningProposalKind, PlainMessageKey> = {
  rule: 'tuning.proposal.kind.rule',
  skill: 'tuning.proposal.kind.skill',
  memory: 'tuning.proposal.kind.memory',
  guardrail: 'tuning.proposal.kind.guardrail',
};

export function kindName(kind: string): string {
  const key = KIND_KEYS[kind as TuningProposalKind];
  return key === undefined ? kind : t(key);
}

const REASON_KEYS: Record<string, PlainMessageKey> = {
  no_project: 'tuning.proposals.reason.noProject',
  sub_session: 'tuning.proposals.reason.subSession',
  unsupported: 'retro.summary.reason.unsupported',
  running: 'retro.summary.reason.running',
  unavailable: 'retro.summary.reason.unavailable',
  failed: 'retro.summary.reason.failed',
  unparsable: 'retro.summary.reason.unparsable',
  empty: 'retro.summary.reason.empty',
};

/** 生成没成时给人看的原因；认不出的原样显示。 */
export function reasonText(reason: string): string {
  const key = REASON_KEYS[reason];
  return key === undefined ? reason : t(key);
}

/** 生成之后的一行：几条、用了多少 token；没有建议时“暂无建议”。 */
export function generatedText(result: {
  proposals: readonly unknown[];
  usage?: { inputTokens: number; outputTokens: number };
}): string {
  const tokens =
    result.usage === undefined
      ? undefined
      : tokensText(result.usage.inputTokens + result.usage.outputTokens);
  const head =
    result.proposals.length === 0
      ? t('tuning.proposals.none')
      : t('tuning.proposals.generated', { count: result.proposals.length });
  return tokens === undefined ? head : `${head} · ${tokens}`;
}

export function tokensText(count: number): string {
  return t('tuning.proposal.tokens', { count: formatTokens(count) });
}
