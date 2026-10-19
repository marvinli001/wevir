// 会话侧栏的“Wevir 工具”卡片（0.61.0，Host 功能 `tool_presets`）：这个会话建的时候选的工具预设，带来哪些组、几个工具。建好后不能
// 改。没选过的（以前建的会话、旧客户端建的）就是“全部”。子会话沿用父会话的预设，不单独显示。

import { t } from '@/i18n';
import { presetGroups, presetToolCount, sessionToolPreset } from '@/session/tool-preset-model';
import { TOOL_GROUP_LABELS, toolPresetName, useToolPresets } from '@/session/tool-preset-picker';
import { type RailContext, registerRailCard } from './session-rail';

function useToolPresetCard({ session }: RailContext) {
  const info = useToolPresets();
  if (info === undefined || session.parentSessionId !== undefined) return null;
  const preset = sessionToolPreset(session.toolPreset);
  const groups = presetGroups(preset, info);
  const name = toolPresetName(preset);
  return {
    summary: <span className="truncate">{name}</span>,
    details: (
      <div className="space-y-2" data-testid="rail-tool-preset" data-preset={preset.id}>
        <div className="flex items-baseline justify-between gap-2">
          <span>{name}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('toolPreset.count', { count: presetToolCount(preset, info) })}
          </span>
        </div>
        <ul className="space-y-0.5 text-xs">
          {groups.map((group) => (
            <li key={group.id} className="flex justify-between gap-2" data-group={group.id}>
              <span className="truncate">{t(TOOL_GROUP_LABELS[group.id])}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {group.tools.length}
              </span>
            </li>
          ))}
        </ul>
        {session.openedBy?.role !== undefined && (
          <p className="text-xs text-muted-foreground">{t('toolPreset.roleNote')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('toolPreset.scope')}</p>
        <p className="text-xs text-muted-foreground">{t('toolPreset.fixed')}</p>
      </div>
    ),
  };
}

registerRailCard({
  id: 'tool-preset',
  order: 15,
  title: () => t('rail.tools'),
  useCard: useToolPresetCard,
});
