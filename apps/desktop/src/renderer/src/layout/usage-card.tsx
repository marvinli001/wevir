// 会话侧栏的“用量”卡片（desktop-layout.md §12）：会话的模型来自订阅时，显示那个订阅账号的用量窗口（5 小时、每周、每月）。
// 数据是账号表（accounts-store.ts）里的 `rateLimits`，引擎在回合里推送更新；侧栏看得见时另外每 5 分钟读一次账号，
// 别处（其他设备、终端里的 CLI）用掉的额度也跟得上。

import { Settings } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo } from '@/components/provider-logo';
import { SOURCES } from '@/data/sources';
import { useAccounts, useAccountsStore } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { useNow } from '@/session/subagent-view';
import { windowName } from '@/settings/chatgpt-account-model';
import { ContextBar } from './context-bar';
import { type RailContext, registerRailCard } from './session-rail';
import { resetText, subscriptionUsage, usageBar } from './usage-model';

/** 侧栏看得见时多久重读一次账号。 */
const REFRESH_MS = 5 * 60_000;
/** 刚读过（别的会话的侧栏、换会话）就不再读。 */
const FRESH_MS = 60_000;
/** 重置时间是“还有多久”，每分钟重画。 */
const TICK_MS = 60_000;

/** 每种账号上次读的时间：几个窗格的侧栏同时开着时只读一次。 */
const lastRead = new Map<string, number>();

function useUsageCard({ session, providers, visible }: RailContext) {
  const accounts = useAccounts();
  const store = useAccountsStore();
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const usage = subscriptionUsage(session, providers, accounts);
  const kind = usage?.kind;
  const now = useNow(visible && usage !== undefined ? TICK_MS : undefined);

  useEffect(() => {
    if (!visible || kind === undefined || client === undefined) return;
    const read = () => {
      const last = lastRead.get(kind);
      if (last !== undefined && Date.now() - last < FRESH_MS) return;
      lastRead.set(kind, Date.now());
      client
        .request('account.get', { kind })
        .then(({ account }) => store?.merge(account))
        // 用量只是附带的，读不到就留着上次的。
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, kind, client, store]);

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
