import type { ProviderProfile, Session } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, ChevronDown, Cpu, FolderPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand-mark';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useWorkbenchData } from '@/data/workbench-data';
import { sessionMarker, type WorkspaceEntry } from '@/data/workbench-model';
import { MetalWordmark } from '@/fx/metal';
import { type PlainMessageKey, t } from '@/i18n';
import { Composer } from '@/session/composer';
import { useProviderChoice, useStartSession } from '@/session/start-session';
import { formatRelativeTime } from '@/session/subagent-model';
import { useNow } from '@/session/subagent-view';
import { homeWorkspace, rememberWorkspace, useLastLocation } from './last-location';
import { paths } from './paths';
import { PendingPage } from './route-states';

/** 首页大输入框的草稿归属：换工作区时输入的字不丢（建会话时才用到所选的工作区）。 */
const HOME_DRAFT = 'home';

/** “接着做”列几个会话。 */
const RECENT_COUNT = 3;

/**
 * `/`：首页（U4，方向稿 A 静器的 HomeA）。一列居中、内容左对齐：品牌行、宋体标题“今天在 [工作区 ▾] 里做什么？”、大输入框、
 * “接着做”（所选工作区最近的会话）。发送后在所选工作区新建会话并跳过去，和新会话草稿页是同一套流程
 * （session/start-session.ts）。新开窗口停在这里，不跳回上次的会话（维护者 2026-10-14 定）；默认的工作区是上次所在的那个
 * （last-location.ts）。还没有 Provider 或工作区时显示首次使用的三步引导（T5.4）。
 */
export function HomeRoute() {
  const data = useWorkbenchData();
  const last = useLastLocation();
  if (data.status === 'loading') return <PendingPage />;
  if (data.status === 'error') return <PendingPage error={data.error} />;
  const entry = homeWorkspace(data, last);
  const hasProvider = data.providers.length > 0;
  return (
    <HomeColumn>
      {hasProvider && entry ? (
        <Home entry={entry} workspaces={data.workspaces} />
      ) : (
        <Onboarding hasProvider={hasProvider} hasWorkspace={entry !== undefined} />
      )}
    </HomeColumn>
  );
}

/** 首页的一列：最宽 700px、水平居中，上方留白约 14vh（方向稿 .home-col）。 */
function HomeColumn({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-175 flex-col gap-5.5 px-4 pt-[clamp(2.5rem,14vh,8.75rem)] pb-12 sm:px-7">
        <div className="flex items-center gap-2.5" data-testid="home-brand">
          <BrandMark className="size-5.5 text-brand" />
          <MetalWordmark>{t('app.name')}</MetalWordmark>
        </div>
        {children}
      </div>
    </ScrollArea>
  );
}

function Home({
  entry,
  workspaces,
}: {
  entry: WorkspaceEntry;
  workspaces: readonly WorkspaceEntry[];
}) {
  const { workspace } = entry;
  const { providers, providerId, choose } = useProviderChoice();
  const { start, error, ready } = useStartSession(workspace.id, providerId);

  return (
    <>
      <h1 className="flex flex-wrap items-baseline gap-x-[0.25em] font-display text-[clamp(1.75rem,4vw,2.5rem)] leading-tight font-medium tracking-[0.01em] text-balance">
        {t('home.title.before')}
        <WorkspacePicker current={entry} workspaces={workspaces} />
        {t('home.title.after')}
      </h1>
      <div>
        {error && (
          <p
            role="alert"
            className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <Composer
          variant="home"
          draftKey={HOME_DRAFT}
          state="idle"
          disabled={!ready}
          placeholder={t('home.placeholder', { workspace: workspace.displayName })}
          status={
            providers && <ProviderChip providers={providers} value={providerId} onChange={choose} />
          }
          onSend={start}
          onStop={() => {}}
          autoFocus
        />
      </div>
      <RecentSessions entry={entry} />
    </>
  );
}

/** 标题里的工作区名：内联的下拉（方向稿 .ws-inline），换工作区，最下面可以去添加工作区。 */
function WorkspacePicker({
  current,
  workspaces,
}: {
  current: WorkspaceEntry;
  workspaces: readonly WorkspaceEntry[];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="home-workspace"
        title={current.workspace.rootPath}
        className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-xs border-b-[1.5px] border-dashed border-border-strong px-0.5 font-sans text-[0.86em] font-semibold text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:border-foreground"
      >
        <span className="truncate">{current.workspace.displayName}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto max-w-80 min-w-56">
        <DropdownMenuRadioGroup
          value={current.workspace.id}
          onValueChange={(id: string) => rememberWorkspace(id)}
        >
          {workspaces.map(({ workspace }) => (
            <DropdownMenuRadioItem
              key={workspace.id}
              value={workspace.id}
              title={workspace.rootPath}
              closeOnClick
            >
              <span className="min-w-0">
                <span className="block truncate">{workspace.displayName}</span>
                {/* 长路径截掉开头、留住最后的目录名：容器从右往左排，省略号就落在左边；路径本身用 bdi 保持从左往右。 */}
                <span
                  dir="rtl"
                  className="block truncate text-left font-mono text-xs text-muted-foreground"
                >
                  <bdi dir="ltr">{workspace.rootPath}</bdi>
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => navigate(paths.settings('workspaces'), { state: { from: location } })}
        >
          <FolderPlus className="text-muted-foreground" />
          {t('home.addWorkspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 输入框左下角的模型芯片（方向稿 .chip）：新会话用哪个 Provider；只有一个时只显示、不能点。 */
function ProviderChip({
  providers,
  value,
  onChange,
}: {
  providers: readonly ProviderProfile[];
  value: string | undefined;
  onChange: (providerId: string) => void;
}) {
  const current = providers.find((provider) => provider.id === value);
  if (!current) return null;
  const chip =
    'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-soft-foreground';
  const label = (
    <>
      <Cpu aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{providerLabel(current)}</span>
    </>
  );
  if (providers.length < 2) {
    return (
      <span className={chip} data-testid="home-provider" title={t('session.provider')}>
        {label}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="home-provider"
        aria-label={t('home.provider', { provider: providerLabel(current) })}
        className={cn(
          chip,
          'outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted',
        )}
      >
        {label}
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-auto max-w-80 min-w-56">
        <DropdownMenuRadioGroup value={current.id} onValueChange={(id: string) => onChange(id)}>
          {providers.map((provider) => (
            <DropdownMenuRadioItem key={provider.id} value={provider.id} closeOnClick>
              <span className="min-w-0">
                <span className="block truncate">{provider.displayName}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {provider.defaultModelId}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function providerLabel(provider: ProviderProfile): string {
  return `${provider.displayName} · ${provider.defaultModelId}`;
}

/** “接着做”的状态点：出错与左栏一致，其余是运行中 / 待审批 / 空闲。 */
const RECENT_TONES: Record<
  NonNullable<ReturnType<typeof sessionMarker>> | 'idle',
  { tone: StatusTone; label: PlainMessageKey }
> = {
  running: { tone: 'accent', label: 'session.marker.running' },
  awaiting_approval: { tone: 'warning', label: 'session.marker.awaitingApproval' },
  error: { tone: 'danger', label: 'session.marker.error' },
  idle: { tone: 'neutral', label: 'home.recent.idle' },
};

/** “接着做”：所选工作区最近有活动的几个会话（方向稿 .recent），点击进入。没有会话时整节不显示。 */
function RecentSessions({ entry }: { entry: WorkspaceEntry }) {
  const now = useNow(30_000);
  const sessions = entry.sessions.slice(0, RECENT_COUNT);
  if (sessions.length === 0) return null;
  return (
    <section aria-labelledby="home-recent" className="mt-4.5" data-testid="home-recent">
      <h2 id="home-recent" className="mb-1 text-xs text-muted-foreground">
        {t('home.recent')}
      </h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <RecentRow workspaceId={entry.workspace.id} session={session} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentRow({
  workspaceId,
  session,
  now,
}: {
  workspaceId: string;
  session: Session;
  now: number;
}) {
  const { tone, label } = RECENT_TONES[sessionMarker(session) ?? 'idle'];
  return (
    <Link
      to={paths.session(workspaceId, session.id)}
      data-session-id={session.id}
      className="group flex items-center gap-3 border-b border-border px-0.5 py-2.5 text-foreground outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <StatusDot tone={tone} label={t(label)} className="size-1.75" />
      <span className="min-w-0 flex-1 truncate underline-offset-3 group-hover:underline">
        {session.title || t('session.untitled')}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTime(session.updatedAt, now)}
      </span>
    </Link>
  );
}

/**
 * 首次使用的三步：配置 Provider → 添加工作区 → 开始第一个会话。前两步指向设置页，做完的打勾；两步都做完首页就换成输入框，
 * 第三步只是说明。
 */
function Onboarding({
  hasProvider,
  hasWorkspace,
}: {
  hasProvider: boolean;
  hasWorkspace: boolean;
}) {
  const location = useLocation();
  const steps = [
    {
      id: 'provider',
      title: t('onboarding.provider'),
      body: t('onboarding.providerBody'),
      done: hasProvider,
      action: t('onboarding.providerAction'),
      to: paths.settings('providers'),
    },
    {
      id: 'workspace',
      title: t('onboarding.workspace'),
      body: t('onboarding.workspaceBody'),
      done: hasWorkspace,
      action: t('onboarding.workspaceAction'),
      to: paths.settings('workspaces'),
    },
    {
      id: 'session',
      title: t('onboarding.session'),
      body: t('onboarding.sessionBody'),
      done: false,
    },
  ];
  // 当前该做的一步：第一个没做完的。
  const current = steps.findIndex((step) => !step.done);

  return (
    <section aria-labelledby="onboarding-title" className="flex flex-col gap-5.5">
      <div>
        <h1 id="onboarding-title" className="text-2xl font-semibold tracking-tight">
          {t('onboarding.title')}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{t('onboarding.body')}</p>
      </div>
      <ol className="divide-y divide-border rounded-xl border border-border bg-card">
        {steps.map((step, index) => {
          const active = index === current;
          return (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done || undefined}
              data-active={active || undefined}
              className="flex items-center gap-3.5 px-4 py-3.5"
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
                  step.done
                    ? 'border-success/40 bg-success/10 text-success'
                    : active
                      ? 'border-foreground text-foreground'
                      : 'border-border-strong text-muted-foreground',
                )}
              >
                {step.done ? (
                  <Check className="size-3.5" aria-label={t('onboarding.done')} />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'font-medium',
                    step.done || !active ? 'text-soft-foreground' : 'text-foreground',
                  )}
                >
                  {step.title}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.body}</p>
              </div>
              {step.done ? (
                <span className="shrink-0 text-sm text-success">{t('onboarding.done')}</span>
              ) : (
                step.to && (
                  <Button
                    className="shrink-0"
                    variant={active ? 'default' : 'outline'}
                    nativeButton={false}
                    render={<Link to={step.to} state={{ from: location }} />}
                  >
                    {step.action}
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
