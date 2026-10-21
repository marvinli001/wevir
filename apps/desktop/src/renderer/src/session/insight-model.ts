// 你应该知道（0.79.0，domain-model §3.33、desktop-tokens §66）的显示规则：Host 在回合结束后的后台检查里提出一条（`Transcript.insights`），
// 输入框上方至多显示一张卡片。纯逻辑，不碰 DOM 与 React。

import type { HostSettings, SessionInsight } from '@wevir/protocol';

/** 要不要显示：Host 有功能、设置里开着（默认关），是主窗格里的顶层会话（子智能体与支线不检查）。 */
export function insightsEnabled(options: {
  featureSupported: boolean;
  settings: Pick<HostSettings, 'sessionInsights'>;
  variant: 'main' | 'pane';
  side: boolean | undefined;
  parentSessionId: string | undefined;
}): boolean {
  return (
    options.featureSupported &&
    options.settings.sessionInsights === true &&
    options.variant === 'main' &&
    options.side !== true &&
    options.parentSessionId === undefined
  );
}

/** 现在该显示的一条：最近提出的、还没处理的。 */
export function currentInsight(
  insights: readonly SessionInsight[] | undefined,
): SessionInsight | undefined {
  if (insights === undefined) return undefined;
  for (let index = insights.length - 1; index >= 0; index -= 1) {
    const insight = insights[index] as SessionInsight;
    if (insight.status === 'open') return insight;
  }
  return undefined;
}
