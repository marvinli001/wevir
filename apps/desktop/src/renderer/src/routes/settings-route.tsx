import { cn } from 'cn';
import {
  ArrowLeft,
  Cpu,
  Folder,
  Info,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { type Location, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useHostConnection } from '@/host/host-connection';
import { hostIndicator } from '@/host/host-status';
import { type PlainMessageKey, t } from '@/i18n';
import { ChatSettings } from '@/settings/chat-settings';
import { ProviderSettings } from '@/settings/provider-settings';
import { LIST_CARD, SettingsSection } from '@/settings/settings-ui';
import { WorkspaceSettings } from '@/settings/workspace-settings';
import { setThemeMode, useTheme } from '@/theme/theme';
import type { ThemeMode } from '../../../shared/theme.js';
import { NotFound } from './not-found';
import { isSettingsTab, paths, SETTINGS_TABS, type SettingsTab } from './paths';

const TABS: Record<SettingsTab, { label: PlainMessageKey; icon: LucideIcon }> = {
  providers: { label: 'settings.tab.providers', icon: Cpu },
  workspaces: { label: 'settings.tab.workspaces', icon: Folder },
  chat: { label: 'settings.tab.chat', icon: MessageSquare },
  appearance: { label: 'settings.tab.appearance', icon: Palette },
  about: { label: 'settings.tab.about', icon: Info },
};

/** 打开设置前所在的位置（左栏“设置”链接带上），关闭设置时回到那里。 */
interface SettingsState {
  from?: Location;
}

/**
 * `/settings/:tab`：整窗的设置页，左侧标签列表，右侧内容；返回时回到打开设置前的页面。U4 起照方向稿「A 静器」：标签列表
 * 是侧栏色、选中的一行和左栏的当前会话一样（表面色加一圈分隔线），内容一列最宽 720px，按节排、节之间是细分隔线
 * （settings/settings-ui.tsx）。
 */
export function SettingsRoute() {
  const { tab } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as SettingsState | null)?.from;
  const back = () => navigate(from ?? paths.home());

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('settings.title')}
        className="flex w-52 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-md:w-44"
      >
        <div className="app-drag flex h-11 shrink-0 items-center gap-1.5 pr-2 pl-[max(0.5rem,var(--traffic-lights-inset))]">
          <IconButton label={t('settings.back')} onClick={back} tooltipSide="bottom">
            <ArrowLeft />
          </IconButton>
          <span className="text-sm font-semibold">{t('settings.title')}</span>
        </div>
        <ul className="space-y-0.5 px-2 pt-1">
          {SETTINGS_TABS.map((id) => {
            const { label, icon: Icon } = TABS[id];
            return (
              <li key={id}>
                <NavLink
                  to={paths.settings(id)}
                  state={location.state}
                  replace
                  data-settings-tab={id}
                  className={({ isActive }) =>
                    cn(
                      'flex h-8 items-center gap-2 rounded-lg px-2.5 text-base text-soft-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
                      isActive &&
                        'bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-border ring-inset hover:bg-sidebar-accent',
                    )
                  }
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t(label)}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 内容区没有顶栏，留一条与左侧顶栏同高的空白作标题栏，窗口从这里也能拖动。 */}
        <div className="app-drag h-11 shrink-0" />
        {isSettingsTab(tab) ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-180 px-5 pt-3 pb-12 sm:px-8">
              <h1 className="mb-6 text-2xl font-semibold tracking-tight">{t(TABS[tab].label)}</h1>
              <SettingsTabContent tab={tab} />
            </div>
          </ScrollArea>
        ) : (
          <NotFound message={t('notFound.settingsTab', { tab: tab ?? '' })} />
        )}
      </main>
    </div>
  );
}

function SettingsTabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'appearance':
      return <AppearanceSettings />;
    case 'about':
      return <AboutSettings />;
    case 'providers':
      return <ProviderSettings />;
    case 'workspaces':
      return <WorkspaceSettings />;
    case 'chat':
      return <ChatSettings />;
  }
}

const THEME_OPTIONS: { mode: ThemeMode; label: PlainMessageKey; icon: ReactNode }[] = [
  { mode: 'system', label: 'settings.appearance.theme.system', icon: <Monitor /> },
  { mode: 'light', label: 'settings.appearance.theme.light', icon: <Sun /> },
  { mode: 'dark', label: 'settings.appearance.theme.dark', icon: <Moon /> },
];

function AppearanceSettings() {
  const { mode } = useTheme();
  return (
    <>
      <SettingsSection
        title={t('settings.appearance.theme')}
        description={t('settings.appearance.themeHint')}
      >
        {/* 分段切换（与输入框里的“插话 | 排队”同一套：轨道是次表面色，选中的一段是滑块色）。 */}
        <fieldset className="inline-flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
          <legend className="sr-only">{t('settings.appearance.theme')}</legend>
          {THEME_OPTIONS.map((option) => {
            const checked = option.mode === mode;
            return (
              <button
                key={option.mode}
                type="button"
                aria-pressed={checked}
                data-theme-option={option.mode}
                onClick={() => setThemeMode(option.mode)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5',
                  checked
                    ? 'bg-switch-thumb font-medium text-foreground ring-1 ring-border'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.icon}
                {t(option.label)}
              </button>
            );
          })}
        </fieldset>
      </SettingsSection>
      <SettingsSection title={t('settings.appearance.language')}>
        <p className="text-base">{t('settings.appearance.languageValue')}</p>
      </SettingsSection>
    </>
  );
}

function AboutSettings() {
  const { view, hostStatus } = useHostConnection();
  const hello = view.status === 'connected' ? view.hello : undefined;
  const ownership = hostStatus?.phase === 'running' ? hostStatus.ownership : undefined;
  const rows: [string, string | undefined, string?][] = [
    [t('settings.about.status'), hostIndicator(view, hostStatus).text],
    [
      t('settings.about.process'),
      ownership &&
        t(ownership.kind === 'owned' ? 'settings.about.owned' : 'settings.about.attached', {
          pid: ownership.pid,
        }),
      'host-process',
    ],
    [t('settings.about.protocolVersion'), hello?.protocolVersion, 'protocol-version'],
    [t('settings.about.hostVersion'), hello?.hostVersion, 'host-version'],
    [t('settings.about.hostId'), hello?.hostId],
  ];
  return (
    <SettingsSection title={t('settings.about.host')}>
      <dl className={cn(LIST_CARD, 'text-sm')}>
        {rows.map(([label, value, testId]) => (
          <div key={label} className="flex items-baseline gap-6 px-4 py-2.5">
            <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 flex-1 truncate font-mono" data-testid={testId}>
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  );
}
