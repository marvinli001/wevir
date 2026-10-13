import { cn } from 'cn';
import { ArrowLeft, Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { type Location, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useHostConnection } from '@/host/host-connection';
import { hostIndicator } from '@/host/host-status';
import { type PlainMessageKey, t } from '@/i18n';
import { ProviderSettings } from '@/settings/provider-settings';
import { WorkspaceSettings } from '@/settings/workspace-settings';
import { setThemeMode, useTheme } from '@/theme/theme';
import type { ThemeMode } from '../../../shared/theme.js';
import { NotFound } from './not-found';
import { isSettingsTab, paths, SETTINGS_TABS, type SettingsTab } from './paths';

const TAB_LABELS: Record<SettingsTab, PlainMessageKey> = {
  providers: 'settings.tab.providers',
  workspaces: 'settings.tab.workspaces',
  appearance: 'settings.tab.appearance',
  about: 'settings.tab.about',
};

/** 打开设置前所在的位置（左栏“设置”链接带上），关闭设置时回到那里。 */
interface SettingsState {
  from?: Location;
}

/** `/settings/:tab`：整窗的设置页，左侧标签列表，右侧内容；返回时回到打开设置前的页面。 */
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
        className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      >
        <div className="flex h-11 shrink-0 items-center gap-1.5 px-2">
          <IconButton label={t('settings.back')} onClick={back} tooltipSide="bottom">
            <ArrowLeft />
          </IconButton>
          <span className="text-sm font-semibold">{t('settings.title')}</span>
        </div>
        <ul className="space-y-0.5 p-2">
          {SETTINGS_TABS.map((id) => (
            <li key={id}>
              <NavLink
                to={paths.settings(id)}
                state={location.state}
                replace
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center rounded-md px-2.5 text-sm outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
                    isActive && 'bg-sidebar-accent font-medium',
                  )
                }
              >
                {t(TAB_LABELS[id])}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1">
        {isSettingsTab(tab) ? (
          <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-2xl px-8 py-8">
              <h1 className="mb-6 text-xl font-semibold">{t(TAB_LABELS[tab])}</h1>
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
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border py-5 first:pt-0 last:border-b-0">
      <h2 className="text-sm font-medium">{label}</h2>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </section>
  );
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
      <Field label={t('settings.appearance.theme')} hint={t('settings.appearance.themeHint')}>
        <fieldset className="flex gap-2">
          <legend className="sr-only">{t('settings.appearance.theme')}</legend>
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.mode}
              variant={option.mode === mode ? 'secondary' : 'outline'}
              aria-pressed={option.mode === mode}
              data-theme-option={option.mode}
              className={cn(option.mode === mode && 'border-primary/40')}
              onClick={() => setThemeMode(option.mode)}
            >
              {option.icon}
              {t(option.label)}
            </Button>
          ))}
        </fieldset>
      </Field>
      <Field label={t('settings.appearance.language')}>
        <p className="text-base">{t('settings.appearance.languageValue')}</p>
      </Field>
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
    <Field label={t('settings.about.host')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value, testId]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-mono" data-testid={testId}>
              {value ?? '—'}
            </dd>
          </div>
        ))}
      </dl>
    </Field>
  );
}
