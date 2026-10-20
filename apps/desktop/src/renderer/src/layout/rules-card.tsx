// 会话侧栏的“规则文件”卡片（0.68.0，Host 功能 `rule_files`）：这个会话当前的来源加载了哪些 AGENTS.md / CLAUDE.md / GEMINI.md /
// Cursor 规则，哪些是引擎自己读的、哪些由 Wevir 补给。

import type { SessionRules } from '@wevir/protocol';
import { cn } from 'cn';
import { t } from '@/i18n';
import { loadedRuleCount, type RuleRow, ruleRows } from './rules-model';
import { type RailContext, registerRailCard } from './session-rail';

const SKIP_REASONS = ['duplicate', 'over_budget', 'disabled', 'empty', 'unreadable'] as const;
type SkipReason = (typeof SKIP_REASONS)[number];

/** 一行右边的状态：引擎读取、Wevir 补充（截断）或没加载的原因。 */
export function ruleStatusText(row: RuleRow): string {
  if (row.status === 'engine') return t('rules.engine');
  if (row.status === 'wevir') return row.truncated ? t('rules.truncated') : t('rules.wevir');
  const reason = row.skipReason;
  return reason !== undefined && (SKIP_REASONS as readonly string[]).includes(reason)
    ? t(`rules.skipped.${reason as SkipReason}`)
    : t('rules.skipped');
}

function RuleFileList({ rules, cwd }: { rules: SessionRules; cwd: string }) {
  return (
    <ul data-testid="rule-files">
      {ruleRows(rules, cwd).map((row) => (
        <li
          key={row.key}
          title={
            row.importedFrom === undefined
              ? row.path
              : `${row.path}\n${t('rules.importedFrom', { name: row.importedFrom })}`
          }
          className="flex h-6 min-w-0 items-center gap-2 text-xs"
          data-rule-status={row.status}
        >
          <span
            dir="rtl"
            className={cn(
              'min-w-0 flex-1 truncate text-left font-mono',
              row.status === 'skipped' && 'text-muted-foreground',
              row.importedFrom !== undefined && 'pl-3',
            )}
          >
            <bdi dir="ltr">{row.name}</bdi>
          </span>
          <span
            className={cn(
              'shrink-0',
              row.status === 'wevir' ? 'text-soft-foreground' : 'text-muted-foreground',
            )}
          >
            {ruleStatusText(row)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function useRulesCard({ session }: RailContext) {
  const rules = session.rules;
  if (rules === undefined || rules.files.length === 0) return null;
  return {
    summary: (
      <span className="tabular-nums">
        {t('rail.rules.count', { count: loadedRuleCount(rules) })}
      </span>
    ),
    details: <RuleFileList rules={rules} cwd={session.cwd} />,
  };
}

registerRailCard({
  id: 'rules',
  order: 22,
  title: () => t('rail.rules'),
  useCard: useRulesCard,
});
