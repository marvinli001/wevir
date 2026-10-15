import { hostSupports } from '@wevir/client-sdk';
import type { PendingDelivery, UserImagePart } from '@wevir/protocol';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { useWorkbenchData } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { useActiveEnvironment, useWorktreeChoice } from '@/environments/environments';
import type { FileScope } from '@/files/files-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { onboardingDone } from '@/onboarding/onboarding-state';
import { openCreateProject } from '@/projects/create-project';
import { Composer, setDraft } from '@/session/composer';
import { EnvironmentBar } from '@/session/environment-bar';
import { useAcceptsImages } from '@/session/image-attachments';
import { ModelPicker } from '@/session/model-picker';
import { NewSessionHero, NewSessionLayout } from '@/session/new-session';
import { PermissionPicker, usePermissionChoice } from '@/session/permission-picker';
import { useModelChoice, usePermissionModes, useStartSession } from '@/session/start-session';
import { useDraftCommands } from '@/session/use-composer-commands';
import { homeWorkspace, rememberWorkspace, useLastLocation } from './last-location';
import { paths } from './paths';
import { PendingPage } from './route-states';

/** 首页大输入框的草稿归属：换工作区时输入的字不丢（建会话时才用到所选的工作区）。 */
const HOME_DRAFT = 'home';

/**
 * `/`：首页（U4，方向稿 A 静器的 HomeA；U14 起照 Codex 桌面端排：品牌与随机句式的标题（如“今天在 [项目 ▾] 里做什么？”）、最近会话在内容区
 * 正中，输入框贴底，session/new-session.tsx）。发送后在所选项目新建会话并跳过去，和新会话草稿页是同一套流程
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
  return <Home entry={homeWorkspace(data, last)} workspaces={data.workspaces} />;
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
  const permission = usePermissionChoice();
  const permissions = usePermissionModes();
  const environment = useActiveEnvironment(workspace?.id);
  const worktree = useWorktreeChoice(workspace?.id);
  const { start, error, ready } = useStartSession(
    workspace?.id,
    choice,
    undefined,
    permission.mode,
    environment?.id,
    worktree.active,
  );
  const noProvider = providers !== undefined && providers.length === 0;

  // 还没有项目：先建项目（维护者 2026-10-14 定），建好后在它里面接着发。
  const send = async (
    text: string,
    _delivery?: PendingDelivery,
    images?: readonly UserImagePart[],
  ): Promise<boolean> => {
    if (workspace) return start(text, undefined, images);
    openCreateProject({
      onCreated: async (created) => {
        if (await start(text, created.id, images)) setDraft(HOME_DRAFT, '');
      },
    });
    return false;
  };
  const acceptImages = useAcceptsImages(choice);

  // 斜杠命令与 @ 提及（U33）：首页没有窗格区，命令只有模型、思考力度、权限与初始化。
  const { view } = useHostConnection();
  const filesEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_files');
  const sendCommandText = (text: string) => void send(text);
  const permissionCommand = useMemo(
    () => (permissions ? { mode: permission.mode, onChange: permission.choose } : undefined),
    [permissions, permission.mode, permission.choose],
  );
  const commands = useDraftCommands({
    providers,
    model: choice,
    onModelChange: choose,
    ...(permissionCommand && { permission: permissionCommand }),
    filesEnabled: false,
    panes: undefined,
    ...(workspace && { send: sendCommandText }),
  });
  const fileScope = useMemo<FileScope | undefined>(
    () =>
      filesEnabled && workspace
        ? { workspaceId: workspace.id as FileScope['workspaceId'], root: workspace.rootPath }
        : undefined,
    [filesEnabled, workspace],
  );

  return (
    <NewSessionLayout
      hero={<NewSessionHero current={entry} workspaces={workspaces} onSelect={rememberWorkspace} />}
      footer={
        <>
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
            acceptImages={acceptImages}
            disabled={!ready && !noProvider}
            {...(noProvider && { disabledReason: t('home.noProvider') })}
            leading={
              <>
                {permissions && (
                  <PermissionPicker value={permission.mode} onChange={permission.choose} />
                )}
                {noProvider && <AddProviderChip />}
              </>
            }
            tray={
              <EnvironmentBar
                current={entry}
                workspaces={workspaces}
                onSelect={rememberWorkspace}
                worktree={worktree}
              />
            }
            model={
              providers &&
              choice && <ModelPicker providers={providers} value={choice} onChange={choose} />
            }
            onSend={send}
            onStop={() => {}}
            autoFocus
            commands={commands}
            {...(fileScope && { fileScope })}
          />
        </>
      }
    />
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
