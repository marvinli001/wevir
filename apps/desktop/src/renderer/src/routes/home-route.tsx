import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, FolderPlus, Plus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { BrandMark } from '@/components/brand-mark';
import { StatusDot, type StatusTone } from '@/components/status-dot';
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
import { onboardingDone } from '@/onboarding/onboarding-state';
import { openCreateProject } from '@/projects/create-project';
import { Composer, setDraft } from '@/session/composer';
import { ModelPicker } from '@/session/model-picker';
import { useModelChoice, useStartSession } from '@/session/start-session';
import { formatRelativeTime } from '@/session/subagent-model';
import { useNow } from '@/session/subagent-view';
import { homeWorkspace, rememberWorkspace, useLastLocation } from './last-location';
import { paths } from './paths';
import { PendingPage } from './route-states';

/** 首页大输入框的草稿归属：换工作区时输入的字不丢（建会话时才用到所选的工作区）。 */
const HOME_DRAFT = 'home';

/** 首页各块依次淡入上移（U10）：品牌行、标题、输入框、最近会话，相隔 60 ms。 */
const ENTER = 'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 ease-smooth';

function stagger(index: number): CSSProperties {
  return { animationDelay: `${index * 60}ms` };
}

/** “接着做”列几个会话。 */
const RECENT_COUNT = 3;

/**
 * `/`：首页（U4，方向稿 A 静器的 HomeA）。一列居中、内容左对齐：品牌行、宋体标题“今天在 [项目 ▾] 里做什么？”、大输入框、
 * “接着做”（所选项目最近的会话）。发送后在所选项目新建会话并跳过去，和新会话草稿页是同一套流程
 * （session/start-session.ts）。新开窗口停在这里，不跳回上次的会话（维护者 2026-10-14 定）；默认的项目是上次所在的那个
 * （last-location.ts）。U6 起：没有 Provider 又没走过引导时转到整窗的分步引导（onboarding/welcome-route.tsx）；跳过引导
 * 后没有 Provider 时输入框不能发、左下角是“添加模型服务”；没有项目时照常能输入，发送时先打开“创建项目”，建好后接着发。
 */
export function HomeRoute() {
  const data = useWorkbenchData();
  const last = useLastLocation();
  const welcomed = onboardingDone.use();
  if (data.status === 'loading') return <PendingPage />;
  if (data.status === 'error') return <PendingPage error={data.error} />;
  // 还没有 Provider、也没走过引导：先去分步引导（U6）。
  if (data.providers.length === 0 && !welcomed) return <Navigate to={paths.welcome()} replace />;
  return (
    <HomeColumn>
      <Home entry={homeWorkspace(data, last)} workspaces={data.workspaces} />
    </HomeColumn>
  );
}

/** 首页的一列：最宽 700px、水平居中，上方留白约 14vh（方向稿 .home-col）。 */
function HomeColumn({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex w-full max-w-175 flex-col gap-5.5 px-4 pt-[clamp(2.5rem,14vh,8.75rem)] pb-12 sm:px-7">
        <div className={cn('flex items-center gap-2.5', ENTER)} data-testid="home-brand">
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
  entry: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
}) {
  const workspace = entry?.workspace;
  const { providers, choice, choose } = useModelChoice();
  const { start, error, ready } = useStartSession(workspace?.id, choice);
  const noProvider = providers !== undefined && providers.length === 0;

  // 还没有项目：先建项目（维护者 2026-10-14 定），建好后在它里面接着发。
  const send = async (text: string): Promise<boolean> => {
    if (workspace) return start(text);
    openCreateProject({
      onCreated: async (created) => {
        if (await start(text, created.id)) setDraft(HOME_DRAFT, '');
      },
    });
    return false;
  };

  return (
    <>
      <h1
        className={cn(
          'flex flex-wrap items-baseline gap-x-[0.25em] font-display text-[clamp(1.75rem,4vw,2.5rem)] leading-tight font-medium tracking-[0.01em] text-balance',
          ENTER,
        )}
        style={stagger(1)}
      >
        {t('home.title.before')}
        <WorkspacePicker current={entry} workspaces={workspaces} />
        {t('home.title.after')}
      </h1>
      <div className={ENTER} style={stagger(2)}>
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
          disabled={!ready && !noProvider}
          {...(noProvider && { disabledReason: t('home.noProvider') })}
          status={noProvider && <AddProviderChip />}
          model={
            providers &&
            choice && <ModelPicker providers={providers} value={choice} onChange={choose} />
          }
          onSend={send}
          onStop={() => {}}
          autoFocus
        />
      </div>
      {entry && <RecentSessions entry={entry} />}
    </>
  );
}

/** 没有 Provider 时输入框左下角的入口：去设置里添加。 */
function AddProviderChip() {
  const location = useLocation();
  return (
    <Link
      to={paths.settings('providers')}
      state={{ from: location }}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-2.5 text-xs text-soft-foreground outline-none transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Plus aria-hidden className="size-3.5" />
      {t('home.addProvider')}
    </Link>
  );
}

/** 标题里的工作区名：内联的下拉（方向稿 .ws-inline），换工作区，最下面可以去添加工作区。 */
function WorkspacePicker({
  current,
  workspaces,
}: {
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="home-workspace"
        title={current?.workspace.rootPath}
        className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-xs border-b-[1.5px] border-dashed border-border-strong px-0.5 font-sans text-[0.86em] font-semibold text-foreground outline-none hover:border-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:border-foreground"
      >
        <span className={cn('truncate', !current && 'text-muted-foreground')}>
          {current?.workspace.displayName ?? t('home.chooseProject')}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-auto max-w-80 min-w-56">
        <DropdownMenuRadioGroup
          value={current?.workspace.id ?? ''}
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
        {workspaces.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={() => openCreateProject()}>
          <FolderPlus className="text-muted-foreground" />
          {t('home.createProject')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
    <section
      aria-labelledby="home-recent"
      className={cn('mt-4.5', ENTER)}
      style={stagger(3)}
      data-testid="home-recent"
    >
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
