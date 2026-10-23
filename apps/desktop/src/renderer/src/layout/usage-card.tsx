// 会话侧栏的“用量”卡片（desktop-layout.md §12）：会话的模型来自订阅时，显示那个订阅账号的用量窗口（5 小时、每周、每月）。
// 数据是账号表（accounts-store.ts）里的 `rateLimits`：Host 定时重读已登录账号的用量（回合里与回合结束后每 30 秒、重置时间到了、每 2 分钟），
// 经 account.updated 推过来，别处（其他设备、终端里的 CLI）用掉的额度也跟得上；这里不读、也没有刷新按钮。

import { Settings } from 'lucide-react';
import { useNavigate } from 'react-router';
import { AccountBadge } from '@/components/account-badge';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { SOURCES } from '@/data/sources';
import { useAccounts } from '@/data/workbench-data';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { useNow } from '@/session/subagent-view';
import { windowName } from '@/settings/chatgpt-account-model';
import { ContextBar } from './context-bar';
import { type RailContext, registerRailCard } from './session-rail';
import { resetText, subscriptionUsage, usageBar } from './usage-model';

/** 重置时间是“还有多久”，每分钟重画。 */
const TICK_MS = 60_000;

function useUsageCard({ session, providers, visible }: RailContext) {
  const accounts = useAccounts();
  const navigate = useNavigate();
  const usage = subscriptionUsage(session, providers, accounts);
  const now = useNow(visible && usage !== undefined ? TICK_MS : undefined);

  if (usage === undefined) return null;
  const source = SOURCES[usage.kind];
  const peak = usageBar(usage.peak);
  return {
    summary: (
      <>
        <span className="tabular-nums">{peak.percent}%</span>
        <ContextBar usage={peak} className="w-8" />
      </>
    ),
    details: (
      <div data-testid="rail-usage">
        <ul className="space-y-3">
          {usage.windows.map((window, index) => {
            const bar = usageBar(window);
            const resets = resetText(window.resetsAt, new Date(now));
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 窗口没有 ID，名字可能相同（长度不明的窗口）
              <li key={index}>
                <div className="flex items-baseline justify-between gap-2">
                  <span>{windowName(window)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('account.chatgpt.usage.used', { percent: bar.percent })}
                  </span>
                </div>
                <ContextBar usage={bar} className="mt-2" />
                {resets !== undefined && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{resets}</p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex h-6 items-center gap-2 text-xs text-muted-foreground">
          <ProviderLogo logo={source.logo} className="size-3.5" />
          <AccountBadge label={usage.label} size="sm" />
          <span className="min-w-0 truncate">
            {t(source.name)}
            {usage.plan !== undefined && ` · ${usage.plan}`}
          </span>
          <span className="flex-1" />
          <IconButton
            label={t('settings.tab.providers')}
            size="icon-xs"
            className="-mr-1"
            onClick={() => void navigate(paths.settings('providers'))}
            data-testid="rail-usage-settings"
          >
            <Settings />
          </IconButton>
        </div>
      </div>
    ),
  };
}

registerRailCard({
  id: 'usage',
  order: 25,
  title: () => t('rail.usage'),
  useCard: useUsageCard,
});
