// 调优页“建议”分段（0.87.0，desktop-layout.md §35）的纯逻辑：种类名、生成失败的原因、证据的标签、采纳之后的统计、护栏规则的
// 一行写法与改动的两段文本。

import type {
  GuardrailRule,
  TuningProposal,
  TuningProposalEvidence,
  TuningProposalKind,
} from '@wevir/protocol';
import { GuardrailRuleSchema } from '@wevir/protocol';
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

/** 一条建议这次操作的用量；没报告时 undefined。 */
export function proposalTokens(proposal: Pick<TuningProposal, 'usage'>): string | undefined {
  return proposal.usage === undefined
    ? undefined
    : tokensText(proposal.usage.inputTokens + proposal.usage.outputTokens);
}

/** 证据的标签：回合写“回合 n”，别的用那一行的文字。 */
export function evidenceLabel(evidence: TuningProposalEvidence): string {
  if (evidence.turn !== undefined) return t('tuning.proposal.turn', { n: evidence.turn });
  if (evidence.text === '') return evidence.id;
  // 命令与长文本只取第一行、压掉空白，过长截断；全文在悬停提示里。
  const line = (evidence.text.split('\n', 1)[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length > EVIDENCE_LABEL_MAX ? `${line.slice(0, EVIDENCE_LABEL_MAX - 1)}…` : line;
}

const EVIDENCE_LABEL_MAX = 28;

/** 采纳之后的统计：“2 个会话 · 验证通过 3/4”。 */
export function statsText(proposal: Pick<TuningProposal, 'stats'>): string | undefined {
  const stats = proposal.stats;
  if (stats === undefined) return undefined;
  return [
    t('tuning.sessionCount', { count: stats.sessions }),
    stats.checks &&
      t('tuning.proposal.checks', { passed: stats.checks.passed, total: stats.checks.total }),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 护栏规则写成一行（与 Host 给模型看的一样）。 */
export function ruleLine(rule: GuardrailRule): string {
  switch (rule.kind) {
    case 'forbidden_command':
      return `forbidden_command (${rule.match}): ${rule.pattern}`;
    case 'protected_path':
      return `protected_path: ${rule.glob}`;
    case 'stop_check':
      return `stop_check: ${rule.command}`;
    case 'commit_check':
      return `commit_check: ${rule.command}`;
  }
}

/** 改动的文件名与前后文本（文本类的原样；护栏是规则的 JSON，前面是空的）。 */
export function changeTexts(change: TuningProposal['change']): {
  name: string;
  before: string;
  after: string;
} {
  switch (change.kind) {
    case 'rule':
      return { name: 'AGENTS.md', before: change.before, after: change.after };
    case 'skill':
      return { name: 'SKILL.md', before: change.before, after: change.after };
    case 'memory':
      return { name: `${change.name}.md`, before: change.before, after: change.after };
    case 'guardrail':
      return { name: 'guardrail.json', before: '', after: ruleJson(change.rule) };
  }
}

export function ruleJson(rule: GuardrailRule): string {
  return `${JSON.stringify(rule, null, 2)}\n`;
}

/** 编辑框里的护栏 JSON：认得出就是规则，否则 undefined。 */
export function parseRuleJson(text: string): GuardrailRule | undefined {
  try {
    const parsed = GuardrailRuleSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 编辑之后要发的 `tuning.proposal.update` 参数；没有改动时 undefined，护栏 JSON 不对时 `invalid`。 */
export function editParams(
  change: TuningProposal['change'],
  text: string,
): { after: string } | { rule: GuardrailRule } | 'invalid' | undefined {
  if (change.kind === 'guardrail') {
    const rule = parseRuleJson(text);
    if (rule === undefined) return 'invalid';
    return JSON.stringify(rule) === JSON.stringify(change.rule) ? undefined : { rule };
  }
  return text === change.after ? undefined : { after: text };
}

/** 末尾补一个换行再比，免得 diff 多出“文件末尾没有换行”一行（记忆正文通常不带）。 */
export function withNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

/** diff 大约显示几行（定框高用）：改后的行，加上改前有、改后没有的行；给了每行能放几个字宽时按折行算；至少 1 行。 */
export function diffLineCount(before: string, after: string, columns = Infinity): number {
  const lines = (text: string) => (text === '' ? [] : withNewline(text).slice(0, -1).split('\n'));
  const rows = (line: string) => Math.max(1, Math.ceil(displayWidth(line) / columns));
  const left = new Map<string, number>();
  for (const line of lines(after)) left.set(line, (left.get(line) ?? 0) + 1);
  let total = 0;
  for (const line of lines(before)) {
    const count = left.get(line) ?? 0;
    if (count === 0) total += rows(line);
    else left.set(line, count - 1);
  }
  for (const line of lines(after)) total += rows(line);
  return Math.max(1, total);
}

/** 等宽字体下的显示宽度：全角字符算两个字宽。 */
function displayWidth(line: string): number {
  let width = 0;
  for (const char of line)
    width +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(
        char,
      )
        ? 2
        : 1;
  return width;
}

/** 待审数（侧栏与分段上的数字）：待审与已过时都算。 */
export function openCount(proposals: readonly Pick<TuningProposal, 'status'>[]): number {
  return proposals.filter((p) => p.status === 'pending' || p.status === 'stale').length;
}
