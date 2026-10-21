import { cn } from 'cn';
import {
  Archive,
  Bell,
  Brain,
  Cpu,
  Folder,
  Globe,
  HardDrive,
  Import,
  Info,
  Keyboard,
  type LucideIcon,
  Palette,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { type Location, NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useHostConnection } from '@/host/host-connection';
import { hostIndicator } from '@/host/host-status';
import { type PlainMessageKey, t } from '@/i18n';
import { clampSidebarWidth, LAYOUT, settingsNavWidth } from '@/layout/layout-rules';
import { layoutPrefs, useViewportWidth } from '@/layout/layout-state';
import { Splitter } from '@/layout/splitter';
import { WindowControls } from '@/layout/window-controls';
import { AppearanceSettings } from '@/settings/appearance-settings';
import { ApprovalRuleSettings } from '@/settings/approval-rule-settings';
import { ArchivedSettings } from '@/settings/archived-settings';
import { GeneralSettings } from '@/settings/general-settings';
import { ImportSettings } from '@/settings/import-settings';
import { MemorySettings } from '@/settings/memory-settings';
import { NotificationSettingsPage } from '@/settings/notification-settings-page';
import { PersonalizationSettings } from '@/settings/personalization-settings';
import { ProviderSettings } from '@/settings/provider-settings';
import { LIST_CARD, SettingsSection } from '@/settings/settings-ui';
import { ShortcutsSettings } from '@/settings/shortcuts-settings';
import { StorageSettings } from '@/settings/storage-settings';
import { WebSettingsPage } from '@/settings/web-settings';
import { WorkspaceSettings } from '@/settings/workspace-settings';
import { AppUpdateSettings } from '@/updates/update-settings';
import { NotFound } from './not-found';
import { isSettingsTab, paths, type SettingsTab } from './paths';

interface TabInfo {
  label: PlainMessageKey;
  icon: LucideIcon;
  /** 搜索时除了名字还认这些词（这一页里各项设置的名字）。 */
  keywords: PlainMessageKey[];
}

const TABS: Record<SettingsTab, TabInfo> = {
  general: {
    label: 'settings.tab.general',
    icon: Settings2,
    keywords: [
      'settings.appearance.language',
      'settings.section.permissions',
      'permission.full_access',
      'settings.preventSleep',
      'settings.chat.sendWhileBusy',
      'settings.composer.send',
      'settings.editor',
    ],
  },
  appearance: {
    label: 'settings.tab.appearance',
    icon: Palette,
    keywords: [
      'settings.appearance.mode',
      'settings.appearance.theme',
      'settings.appearance.accent',
      'settings.appearance.background',
      'settings.appearance.font',
      'settings.appearance.uiFontSize',
      'settings.appearance.codeFontSize',
      'settings.appearance.contrast',
    ],
  },
  notifications: {
    label: 'settings.tab.notifications',
    icon: Bell,
    keywords: [
      'settings.notify.system',
      'settings.notify.inApp',
      'settings.notify.sound',
      'settings.notify.completed',
      'settings.notify.approval',
    ],
  },
  shortcuts: {
    label: 'settings.tab.shortcuts',
    icon: Keyboard,
    keywords: ['shortcuts.newSession', 'shortcuts.send', 'shortcuts.toggleSidebar'],
  },
  storage: {
    label: 'settings.tab.storage',
    icon: HardDrive,
    keywords: [
      'settings.storage.clean',
      'settings.storage.category.cache',
      'settings.storage.category.logs',
      'settings.storage.category.browser',
    ],
  },
  providers: {
    label: 'settings.tab.providers',
    icon: Cpu,
    keywords: ['provider.section.accounts', 'provider.section.keyed', 'account.chatgpt.title'],
  },
  personalization: {
    label: 'settings.tab.personalization',
    icon: Sparkles,
    keywords: ['settings.personalization.outputStyle', 'settings.personalization.instructions'],
  },
  web: {
    label: 'settings.tab.web',
    icon: Globe,
    keywords: ['settings.web.enabled', 'settings.web.service'],
  },
  memory: {
    label: 'settings.tab.memory',
    icon: Brain,
    keywords: ['settings.memory.auto', 'settings.memory.global'],
  },
  approvalRules: {
    label: 'settings.tab.approvalRules',
    icon: ShieldCheck,
    keywords: ['settings.approvalRules.rules', 'settings.approvalRules.suggested'],
  },
  import: {
    label: 'settings.tab.import',
    icon: Import,
    keywords: [
      'import.app.claude',
      'import.app.codex',
      'import.app.grok',
      'import.app.antigravity',
      'settings.import.group.connector',
      'settings.import.group.skill',
    ],
  },
  workspaces: {
    label: 'settings.tab.workspaces',
    icon: Folder,
    keywords: ['project.create.title'],
  },
  archived: {
    label: 'settings.tab.archived',
    icon: Archive,
    keywords: ['settings.archived.search', 'session.unarchive'],
  },
  about: {
    label: 'settings.tab.about',
    icon: Info,
    keywords: [
      'settings.about.host',
      'settings.about.hostVersion',
      'settings.about.version',
      'settings.about.channel',
      'settings.about.update',
    ],
  },
};

const GROUPS: { label: PlainMessageKey; tabs: SettingsTab[] }[] = [
  {
    label: 'settings.group.app',
    tabs: ['general', 'appearance', 'notifications', 'shortcuts', 'storage', 'about'],
  },
  {
    label: 'settings.group.work',
    tabs: [
      'providers',
      'personalization',
      'web',
      'memory',
      'approvalRules',
      'import',
      'workspaces',
      'archived',
    ],
  },
];

/** 打开设置前所在的位置（左栏“设置”链接带上），历史里退无可退时后退回到那里。 */
interface SettingsState {
  from?: Location;
}

/**
 * `/settings/:tab`：整窗的设置页（U7 照 Codex 桌面端）。左边是设置自己的侧栏：后退 / 前进、“设置”标题、搜索框、分组的
 * 页面列表；右边一列最宽 720px，页面标题下面是一组组卡片（settings/settings-ui.tsx）。
 *
 * 左栏与工作台的侧栏共用宽度偏好（layout-rules.ts 的 settingsNavWidth）：从对话进设置左栏不变宽窄，在这里拖也改那边。
 */
export function SettingsRoute() {
  const { tab } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as SettingsState | null)?.from;
  const [query, setQuery] = useState('');
  const viewportWidth = useViewportWidth();
  const preferredWidth = layoutPrefs.use().sidebarWidth;
  // 拖动分隔条时的草稿宽度，松开才写进偏好。
  const [dragWidth, setDragWidth] = useState<number>();
  const dragStart = useRef(0);
  const navWidth = settingsNavWidth(viewportWidth, dragWidth ?? preferredWidth);
  const commitWidth = (width: number) => {
    setDragWidth(undefined);
    layoutPrefs.set((current) => ({ ...current, sidebarWidth: clampSidebarWidth(width) }));
  };

  return (
    <div className="relative flex h-full" data-translucent-root>
      <nav
        aria-label={t('settings.title')}
        className="translucent-sidebar flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        style={{ width: navWidth }}
      >
        <div className="app-drag flex h-11 shrink-0 items-center pl-[max(0.5rem,var(--traffic-lights-inset))]">
          <WindowControls onBack={() => navigate(from ?? paths.home())} />
        </div>
        <h1 className="px-4 pt-1 pb-3 text-xl font-semibold tracking-tight">
          {t('settings.title')}
        </h1>
        <div className="px-2.5 pb-2">
          <label className="flex h-8 items-center gap-2 rounded-full bg-sidebar-accent/70 px-3 text-muted-foreground transition-colors focus-within:bg-sidebar-accent focus-within:focus-ring">
            <Search aria-hidden className="size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                aria-label={t('settings.searchClear')}
                onClick={() => setQuery('')}
                className="-mr-1 flex size-5 items-center justify-center rounded-full outline-none hover:text-foreground focus-visible:focus-ring"
              >
                <X className="size-3" />
              </button>
            )}
          </label>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <TabList query={query} state={location.state} />
        </ScrollArea>
      </nav>
      <Splitter
        orientation="vertical"
        label={t('layout.resizeSidebar')}
        valueNow={navWidth}
        valueMin={LAYOUT.sidebarMin}
        valueMax={LAYOUT.sidebarMax}
        onResizeStart={() => {
          dragStart.current = navWidth;
        }}
        onResize={(delta) => setDragWidth(clampSidebarWidth(dragStart.current + delta))}
        onResizeEnd={(delta) => commitWidth(dragStart.current + delta)}
        onResizeCancel={() => setDragWidth(undefined)}
        onReset={() => commitWidth(LAYOUT.sidebarDefault)}
        className="absolute inset-y-0 z-20 -ml-1"
        style={{ left: navWidth }}
      />
      <main className="translucent-content flex min-w-0 flex-1 flex-col">
        {/* 内容区没有顶栏，留一条与左侧顶栏同高的空白作标题栏，窗口从这里也能拖动。 */}
        <div className="app-drag h-11 shrink-0" />
        {isSettingsTab(tab) ? (
          <ScrollArea className="min-h-0 flex-1">
            <div
              key={tab}
              className="mx-auto w-full max-w-180 px-5 pt-6 pb-16 animate-in duration-300 fade-in slide-in-from-bottom-1 sm:px-10"
            >
              <h2 className="mb-7 text-2xl font-semibold tracking-tight">{t(TABS[tab].label)}</h2>
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

function matches(tab: SettingsTab, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const info = TABS[tab];
  return [info.label, ...info.keywords].some((key) => t(key).toLowerCase().includes(needle));
}

function TabList({ query, state }: { query: string; state: unknown }) {
  const groups = GROUPS.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => matches(tab, query)),
  })).filter((group) => group.tabs.length > 0);
  if (groups.length === 0) {
    return <p className="px-4 py-2 text-sm text-muted-foreground">{t('settings.searchEmpty')}</p>;
  }
  return (
    <div className="px-2.5 pb-4">
      {groups.map((group) => (
        <section key={group.label} className="pt-3 first:pt-1">
          <h3 className="px-2 pb-1 text-xs text-muted-foreground">{t(group.label)}</h3>
          <ul className="space-y-px">
            {group.tabs.map((id) => {
              const { label, icon: Icon } = TABS[id];
              return (
                <li key={id}>
                  <NavLink
                    to={paths.settings(id)}
                    state={state}
                    replace
                    data-settings-tab={id}
                    className={({ isActive }) =>
                      cn(
                        'flex h-8 items-center gap-2.5 rounded-lg px-2 text-base text-soft-foreground outline-none transition-[color,background-color,box-shadow] duration-150 ease-smooth hover:bg-sidebar-accent/70 focus-visible:focus-ring',
                        isActive &&
                          'bg-sidebar-accent/70 text-sidebar-accent-foreground ring-1 ring-selected-border ring-inset hover:bg-sidebar-accent/70',
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
        </section>
      ))}
    </div>
  );
}

function SettingsTabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'general':
      return <GeneralSettings />;
    case 'appearance':
      return <AppearanceSettings />;
    case 'notifications':
      return <NotificationSettingsPage />;
    case 'shortcuts':
      return <ShortcutsSettings />;
    case 'about':
      return <AboutSettings />;
    case 'providers':
      return <ProviderSettings />;
    case 'personalization':
      return <PersonalizationSettings />;
    case 'web':
      return <WebSettingsPage />;
    case 'memory':
      return <MemorySettings />;
    case 'approvalRules':
      return <ApprovalRuleSettings />;
    case 'import':
      return <ImportSettings />;
    case 'workspaces':
      return <WorkspaceSettings />;
    case 'archived':
      return <ArchivedSettings />;
    case 'storage':
      return <StorageSettings />;
  }
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
    <>
      <AppUpdateSettings />
      <SettingsSection title={t('settings.about.host')}>
        <dl className={LIST_CARD}>
          {rows.map(([label, value, testId]) => (
            <div key={label} className="flex min-h-11 items-center gap-6 px-4 py-2.5 text-sm">
              <dt className="shrink-0 font-medium">{label}</dt>
              <dd
                className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground"
                data-testid={testId}
              >
                {value ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </>
  );
}
