// 会话侧栏的“个性化”卡片（0.78.0，Host 功能 `agent_instructions`）：这个会话当前的来源有没有收到“给 Agent 的说明”、用的哪种输出
// 风格（`session.rules` 的 `custom`）。设置改了之后，要等会话新建、恢复或接力时才变。

import { t } from '@/i18n';
import { customRows } from '@/settings/personalization-model';
import { type RailContext, registerRailCard } from './session-rail';

function useInstructionsCard({ session }: RailContext) {
  const custom = session.rules?.custom;
  if (custom === undefined) return null;
  const rows = customRows(custom);
  if (rows.length === 0) return null;
  return {
    summary: (
      <span className="tabular-nums">{t('rail.instructions.count', { count: rows.length })}</span>
    ),
    details: (
      <ul data-testid="custom-instructions">
        {rows.map((row) => (
          <li key={row.key} className="flex h-6 min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{t(row.label)}</span>
            <span className="shrink-0 text-soft-foreground">{t(row.value)}</span>
          </li>
        ))}
      </ul>
    ),
  };
}

registerRailCard({
  id: 'instructions',
  order: 21,
  title: () => t('rail.instructions'),
  useCard: useInstructionsCard,
});
