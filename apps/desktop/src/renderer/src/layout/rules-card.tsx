// 会话侧栏的“规则文件”卡片（0.68.0，Host 功能 `rule_files`）：这个会话当前的来源加载了哪些 AGENTS.md / CLAUDE.md / GEMINI.md /
// Cursor 规则，哪些是引擎自己读的、哪些由 Wevir 补给。最后一行是这些规则所在的档案版本（0.85.0），点它到调优页展开这一版。

import type { ProfileVersionRef, SessionRules } from '@wevir/protocol';
import { cn } from 'cn';
import { Link } from 'react-router';
import { isChats } from '@/data/workbench-model';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { versionLabel } from '@/tuning/tuning-model';
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

/** “档案 vN”：到调优页、选中这个会话的范围（“对话”工作区的会话用全局档案）并展开这一版。 */
function ProfileLine({ version, workspace }: { version: ProfileVersionRef; workspace: string }) {
  return (
    <Link
      to={paths.tuning('profile', { workspace, version: version.id })}
      className="mt-1 flex h-6 min-w-0 items-center gap-2 rounded-md text-xs outline-none transition-colors duration-150 hover:text-foreground focus-visible:focus-ring"
      data-testid="rules-profile"
    >
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {t('rail.rules.profile')}
      </span>
      <span className="shrink-0 tabular-nums">{versionLabel(version.seq)}</span>
    </Link>
  );
}

function useRulesCard({ session, entry }: RailContext) {
  const rules = session.rules;
  if (rules === undefined) return null;
  const version = rules.profileVersion;
  if (rules.files.length === 0 && version === undefined) return null;
  return {
    summary: (
      <span className="tabular-nums">
        {t('rail.rules.count', { count: loadedRuleCount(rules) })}
      </span>
    ),
    details: (
      <>
        {rules.files.length > 0 && <RuleFileList rules={rules} cwd={session.cwd} />}
        {version !== undefined && (
          <ProfileLine
            version={version}
            workspace={isChats(entry.workspace) ? 'global' : entry.workspace.id}
          />
        )}
      </>
    ),
  };
}

registerRailCard({
  id: 'rules',
  order: 22,
  title: () => t('rail.rules'),
  useCard: useRulesCard,
});
