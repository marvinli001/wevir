import { commandSupported, hostSupports, isRpcError } from '@wevir/client-sdk';
import type {
  PendingDelivery,
  PermissionMode,
  ProviderProfile,
  ReviewTarget,
  Session,
  SessionId,
  SubagentSummary,
  TurnId,
  UserImagePart,
} from '@wevir/protocol';
import { cn } from 'cn';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { openChanges } from '@/changes/changes-store';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useHostSettings } from '@/data/host-settings';
import { markSeen } from '@/data/seen-sessions';
import { archiveSession, requestRename, useSessionManagement } from '@/data/session-actions';
import { useTranscript, useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { useActiveEnvironment, useWorktreeChoice } from '@/environments/environments';
import { OpenFileLink, openFileLink } from '@/files/file-links';
import type { FileScope } from '@/files/files-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from '@/layout/pane-controller';
import { draftScopeKey } from '@/layout/pane-state';
import { movePaneScope } from '@/layout/pane-store';
import { paths } from '@/routes/paths';
import { ApprovalDock } from './approval-card';
import { Composer, isBusy, setDraft } from './composer';
import { ContextMeter } from './context-meter';
import { EnvironmentBar } from './environment-bar';
import { canHandoffTo, engineFeaturesOf } from './handoff-model';
import { historyDigest } from './history-digest';
import { useAcceptsImages } from './image-attachments';
import { type ModelChoice, ModelPicker } from './model-picker';
import { NewSessionHero, NewSessionLayout } from './new-session';
import { OllamaContextNotice } from './ollama-context-notice';
import { PendingArea } from './pending-area';
import { PermissionPicker, usePermissionChoice } from './permission-picker';
import { QuestionDock } from './question-card';
import { RecoveryPanel } from './recovery-panel';
import { btwQuestion, hasFinishedTurn, startSide } from './side-session';
import {
  sendError,
  sendText,
  useModelChoice,
  usePermissionModes,
  useStartSession,
} from './start-session';
import { useSessions } from './suggested-tasks';
import { TodoDock, TurnRecap } from './todo-card';
import { TranscriptView, type TranscriptViewHandle } from './transcript-view';
import { OpenTurnChanges } from './turn-changes';
import { useUiShow } from './ui-show';
import { useDraftCommands, useSessionCommands } from './use-composer-commands';

/**
 * 一个会话：消息流、审批区、输入框与状态指示（T5.3）。消息流来自从 seq 0 开始的订阅（transcript-store.ts），
 * 状态与审批都以这条事件流为准。
 */
export function SessionView({
  session,
  variant = 'main',
}: {
  session: Session;
  /** `pane`：在窗格里（U23.1 的支线，desktop-tokens.md §30）：内边距收窄，输入框不自动获得焦点。 */
  variant?: 'main' | 'pane';
}) {
  const panes = usePanes();
  const { client, identity, view } = useHostConnection();
  const hostSettings = useHostSettings();
  const { settings } = hostSettings;
  // 回合进行中也能发（R11）：Host 有待发消息时，回车按“回合进行中按回车”的设置。
  const pendingEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'pending_messages');
  const state = useTranscript(session.id);
  // 回合的“N 个文件已更改”打开“变更”窗格（0.20.0）：只在主会话里，支线没有回合快照。
  const diffEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_diff');
  const openTurnChanges = useMemo(
    () =>
      variant === 'main' && diffEnabled && panes && !session.side
        ? (turnId: TurnId) => openChanges(panes, session.id, { kind: 'turn', turnId })
        : undefined,
    [variant, diffEnabled, panes, session.side, session.id],
  );
  // 助手消息里的文件链接（U32）：Host 有 `workspace_files` 时在文件窗格里打开（主会话与支线都用会话目录）。
  const filesEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_files');
  const openLink = useMemo(
    () =>
      filesEnabled && panes ? (href: string) => openFileLink(panes, session.cwd, href) : undefined,
    [filesEnabled, panes, session.cwd],
  );
  const transcriptRef = useRef<TranscriptViewHandle>(undefined);
  const [notice, setNotice] = useState<string>();

  useEffect(() => markSeen(session), [session]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换会话时清掉上一个会话的提示。
  useEffect(() => setNotice(undefined), [session.id]);

  const transcript = state?.transcript;
  // 会话里的 agent 请界面显示的东西（0.30.0，`wevir_show`）：只在主会话里打开窗格。
  const sessionsById = useSessions();
  const titleOf = useCallback((id: SessionId) => sessionsById.get(id)?.title, [sessionsById]);
  useUiShow(session, variant === 'main' ? transcript?.uiShow : undefined, panes, titleOf);
  const sessionState = transcript?.state ?? session.state;
  const readOnly = transcript?.readOnly ?? session.readOnly;
  const acceptImages = useAcceptsImages(session);

  // 当前的引擎能做什么（0.25.0）：接力到别的来源后跟着变；旧 Host 没有时只看 Host 的功能。
  const workbench = useWorkbenchData();
  const providers = workbench.status === 'ready' ? workbench.providers : NO_PROVIDERS;
  const engine =
    view.status === 'connected'
      ? engineFeaturesOf(view.hello.engineFeatures, providers, session.providerId)
      : undefined;

  // `/btw 〈问题〉`（U23.1）：Host 能分支、会话是顶层会话、不只读、已有结束的回合时，分出支线在窗格里问。
  const sideEnabled =
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'side_sessions') &&
    (engine === undefined || engine.fork === true) &&
    !session.side &&
    session.subagent === undefined &&
    readOnly === undefined &&
    transcript !== undefined &&
    hasFinishedTurn(transcript);

  const send = useCallback(
    async (
      text: string,
      delivery?: PendingDelivery,
      images?: readonly UserImagePart[],
    ): Promise<boolean> => {
      if (!client) return false;
      setNotice(undefined);
      // 带图片的消息不当作支线提问（支线只问文字）。
      const question = sideEnabled && !images?.length ? btwQuestion(text) : undefined;
      if (question !== undefined) {
        try {
          await startSide(client, session.id, question, panes);
          return true;
        } catch (error) {
          setNotice(t('side.failed', { error: describe(error) }));
          return false;
        }
      }
      try {
        // 出错或已关闭的会话先恢复（领域模型 §4.2：send 在这两个状态下回 INVALID_STATE）。
        if (sessionState === 'error' || sessionState === 'closed') {
          await client.request('session.resume', { sessionId: session.id });
        }
        await sendText(client, session.id, text, delivery, images);
        transcriptRef.current?.jumpToLatest('auto');
        return true;
      } catch (error) {
        setNotice(sendError(error));
        return false;
      }
    },
    [client, session.id, sessionState, sideEnabled, panes],
  );

  const stop = useCallback(() => {
    if (!client) return;
    client.request('session.cancel', { sessionId: session.id }).catch((error: unknown) => {
      setNotice(t('session.cancelFailed', { error: describe(error) }));
    });
  }, [client, session.id]);

  // 输入框里的“插话 | 排队”切换改的是 Host 设置（U3），和设置页是同一个值。
  const changeBusyDelivery = useCallback(
    (delivery: PendingDelivery) => {
      hostSettings.update({ sendWhileBusy: delivery }).catch((error: unknown) => {
        setNotice(t('settings.chat.saveFailed', { error: describe(error) }));
      });
    },
    [hostSettings.update],
  );

  // 输入框的斜杠命令与 @ 提及（U33）。
  const writable = client !== undefined && readOnly === undefined;
  const configureModel = useCallback(
    (next: ModelChoice) => {
      client
        ?.request('session.configure', configureParams(session, next))
        .catch((error: unknown) =>
          setNotice(t('model.configureFailed', { error: describe(error) })),
        );
    },
    [client, session],
  );
  const switchable = useHandoffTargets(session);
  const permissionModes = usePermissionModes();
  const permission = useMemo(
    () =>
      permissionModes && writable && session.parentSessionId === undefined
        ? {
            mode: session.permissionMode ?? ('on_request' as const),
            onChange: (permissionMode: PermissionMode) => {
              client
                ?.request('session.configure', { sessionId: session.id, permissionMode })
                .catch((error: unknown) =>
                  setNotice(t('permission.configureFailed', { error: describe(error) })),
                );
            },
          }
        : undefined,
    [
      permissionModes,
      writable,
      session.parentSessionId,
      session.permissionMode,
      client,
      session.id,
    ],
  );
  const sendCommandText = useCallback((text: string) => void send(text), [send]);
  // 改名与归档（U34，0.23.0）：只给顶层、不是支线的会话。
  const manage = useSessionManagement();
  const store = useWorkbenchStore();
  const topLevel = session.parentSessionId === undefined && !session.side;
  const onRename = useMemo(
    () => (manage.rename && topLevel ? () => requestRename(session) : undefined),
    [manage.rename, topLevel, session],
  );
  const onArchive = useMemo(
    () =>
      manage.archive && topLevel && client
        ? () => {
            archiveSession(client, store, session.id as SessionId, true).catch((error: unknown) =>
              setNotice(t('session.archiveFailed', { error: describe(error) })),
            );
          }
        : undefined,
    [manage.archive, topLevel, client, store, session.id],
  );
  // 压缩上下文与代码审查（0.24.0）：由命令开始的回合，前提同发送（出错或已关闭的会话先恢复）。0.27.0 起只列当前引擎会的
  // （`engineFeatures` 的 `commands`，接力后跟着变）；失败的提示写在输入框上方。
  const commandsEnabled =
    writable && session.parentSessionId === undefined && view.status === 'connected';
  const canCompact = commandsEnabled && commandSupported(view.hello.features, engine, 'compact');
  const canReview = commandsEnabled && commandSupported(view.hello.features, engine, 'review');
  const runCommand = useCallback(
    async (start: () => Promise<unknown>) => {
      if (!client) return;
      setNotice(undefined);
      try {
        if (sessionState === 'error' || sessionState === 'closed') {
          await client.request('session.resume', { sessionId: session.id });
        }
        await start();
        transcriptRef.current?.jumpToLatest('auto');
      } catch (error) {
        setNotice(
          isRpcError(error, 'SESSION_BUSY')
            ? t('session.busy')
            : t('session.commandFailed', { error: describe(error) }),
        );
      }
    },
    [client, session.id, sessionState],
  );
  const onCompact = useMemo(
    () =>
      client && canCompact
        ? () => void runCommand(() => client.request('session.compact', { sessionId: session.id }))
        : undefined,
    [canCompact, runCommand, client, session.id],
  );
  const onReview = useMemo(
    () =>
      client && canReview
        ? (target: ReviewTarget) =>
            void runCommand(() =>
              client.request('session.review', { sessionId: session.id, target }),
            )
        : undefined,
    [canReview, runCommand, client, session.id],
  );
  const commands = useSessionCommands({
    workspaceId: session.workspaceId,
    sessionId: session.id as SessionId,
    providers,
    model: {
      providerId: session.providerId,
      modelId: session.modelId,
      ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
    },
    canConfigure:
      writable &&
      session.parentSessionId === undefined &&
      view.status === 'connected' &&
      hostSupports(view.hello.features, 'session_configure'),
    onModelChange: configureModel,
    ...(switchable && { switchable }),
    ...(permission && { permission }),
    sideEnabled,
    filesEnabled,
    diffEnabled: diffEnabled && !session.side,
    panes,
    send: sendCommandText,
    ...(onRename && { onRename }),
    ...(onArchive && { onArchive }),
    ...(onCompact && { onCompact }),
    ...(onReview && { onReview }),
  });
  const fileScope = useMemo<FileScope | undefined>(
    () =>
      filesEnabled
        ? {
            workspaceId: session.workspaceId as FileScope['workspaceId'],
            sessionId: session.id as SessionId,
            root: session.cwd,
          }
        : undefined,
    [filesEnabled, session.workspaceId, session.id, session.cwd],
  );

  const onReady = useCallback((handle: TranscriptViewHandle) => {
    transcriptRef.current = handle;
  }, []);

  const resume = useCallback(async () => {
    if (!client) return;
    await client.request('session.resume', { sessionId: session.id });
  }, [client, session.id]);

  const subagentHref = useCallback(
    (subagent: SubagentSummary) => paths.agent(session.workspaceId, session.id, subagent.sessionId),
    [session.workspaceId, session.id],
  );

  // 基于历史新建（T5.5）：对话记录放进同一工作区新会话的输入框，沿用原会话的 Provider，用户确认后发送。
  const navigate = useNavigate();
  const startFromHistory = useCallback(() => {
    if (!transcript) return;
    setDraft(newSessionDraftKey(session.workspaceId), historyDigest(transcript));
    const origin: DraftOrigin = {
      providerId: session.providerId,
      fromTitle: transcript.title || session.title,
    };
    navigate(paths.draft(session.workspaceId), { state: origin });
  }, [transcript, session.workspaceId, session.providerId, session.title, navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-200 ease-smooth">
      {state?.error ? (
        <div className="rail-clear min-h-0 flex-1">
          <EmptyState
            icon={<TriangleAlert />}
            title={t('transcript.failed', { error: state.error })}
          />
        </div>
      ) : transcript && (state.caughtUp || transcript.lastSeq > 0) ? (
        <OpenTurnChanges value={openTurnChanges}>
          <OpenFileLink value={openLink}>
            <TranscriptView
              sessionId={session.id}
              transcript={transcript}
              cwd={session.cwd}
              onReady={onReady}
              compact={variant === 'pane'}
            />
          </OpenFileLink>
        </OpenTurnChanges>
      ) : (
        <p className="rail-clear min-h-0 flex-1 py-16 text-center text-sm text-muted-foreground">
          {t('transcript.loading')}
        </p>
      )}
      {/* 会话侧栏盖在主窗格上时，输入框与消息同样让位（index.css 的 rail-clear）。 */}
      <div className="rail-clear shrink-0">
        <div
          className={cn(
            'mx-auto w-full max-w-content',
            variant === 'pane' ? 'px-4 pb-4' : 'px-6 pb-5',
          )}
        >
          {/* 输入框上方的清单（U20）、提问、审批、恢复、提示与待发区（U14）：最多占窗口高的 55%，再多在这一块里滚动，消息流不被挤没。 */}
          <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1 pt-1 empty:hidden">
            {transcript && <TodoDock transcript={transcript} />}
            <OllamaContextNotice
              client={client}
              providerId={session.providerId}
              modelId={session.modelId}
              running={sessionState === 'running'}
            />
            {transcript && (
              <QuestionDock
                transcript={transcript}
                client={client}
                recap={<TurnRecap transcript={transcript} />}
              />
            )}
            {transcript && (
              <ApprovalDock
                transcript={transcript}
                session={session}
                client={client}
                self={identity}
                subagentHref={subagentHref}
                recap={<TurnRecap transcript={transcript} />}
              />
            )}
            <RecoveryPanel
              // 换会话、或从出错变为只读（恢复失败的原因已经写在只读说明里）时重建，清掉上一次的失败提示。
              key={`${session.id}:${readOnly ? 'read-only' : 'error'}`}
              state={sessionState}
              readOnly={readOnly}
              lastError={transcript?.lastError ?? session.lastError}
              disabled={!client || !transcript}
              onResume={resume}
              onFromHistory={startFromHistory}
            />
            {notice && (
              <p
                role="alert"
                className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {notice}
              </p>
            )}
            {transcript && (
              <PendingArea
                sessionId={session.id}
                pending={transcript.pendingMessages}
                state={sessionState}
                client={client}
                onError={setNotice}
              />
            )}
          </div>
          <Composer
            key={session.id}
            draftKey={session.id}
            state={sessionState}
            disabled={!client || readOnly !== undefined}
            disabledReason={readOnly ? t('session.readOnlyComposer') : undefined}
            model={
              <>
                <ContextMeter
                  session={session}
                  providers={providers}
                  busy={isBusy(sessionState)}
                  {...(onCompact && { onCompact })}
                />
                <SessionModelPicker session={session} onError={setNotice} />
              </>
            }
            leading={<SessionPermissionPicker session={session} onError={setNotice} />}
            {...(pendingEnabled && { busyDelivery: settings.sendWhileBusy })}
            {...(pendingEnabled &&
              hostSettings.supported && { onBusyDeliveryChange: changeBusyDelivery })}
            onSend={send}
            onStop={stop}
            acceptImages={acceptImages && readOnly === undefined}
            autoFocus={variant === 'main'}
            commands={readOnly === undefined ? commands : undefined}
            {...(fileScope && { fileScope })}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 已有会话的模型与思考力度（U8）：只在会话的 Provider 里换，经 `session.configure`（0.9.0）从下一个回合起生效；Host 不支持
 * （没有 `session_configure`）或会话只读、是子会话时只显示。会话的新值经 `session.configured` 回到列表（workbench-store）。
 */
function SessionModelPicker({
  session,
  onError,
}: {
  session: Session;
  onError: (message: string) => void;
}) {
  const { client, view } = useHostConnection();
  const data = useWorkbenchData();
  const providers = data.status === 'ready' ? data.providers : [];
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_configure');
  const switchable = useHandoffTargets(session);
  const value: ModelChoice = {
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
  };
  const configure = async (next: ModelChoice) => {
    if (!client) return;
    try {
      await client.request('session.configure', configureParams(session, next));
    } catch (error) {
      onError(t('model.configureFailed', { error: describe(error) }));
    }
  };
  return (
    <ModelPicker
      providers={providers}
      value={value}
      lockProvider
      {...(switchable && { switchable })}
      readOnly={!supported || !client || session.readOnly !== undefined}
      onChange={(next) => void configure(next)}
    />
  );
}

/**
 * 换模型的请求：别的 Provider 的模型带 `providerId`（0.25.0 的接力），同一个 Provider 里照常只换模型与档位。
 */
function configureParams(session: Session, next: ModelChoice) {
  return {
    sessionId: session.id,
    ...(next.providerId !== session.providerId && { providerId: next.providerId }),
    modelId: next.modelId,
    reasoningEffort: next.reasoningEffort ?? null,
  };
}

/**
 * 已有会话能接力过去的别的来源（0.25.0）：Host 有 `session_handoff` 时按 `canHandoffTo` 判断；旧 Host 返回 undefined（只在
 * 当前 Provider 里换）。
 */
function useHandoffTargets(session: Session): ((provider: ProviderProfile) => boolean) | undefined {
  const { view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_handoff');
  const engineFeatures = view.status === 'connected' ? view.hello.engineFeatures : undefined;
  return useMemo(
    () =>
      supported
        ? (provider: ProviderProfile) => canHandoffTo(provider, session, engineFeatures)
        : undefined,
    [supported, session, engineFeatures],
  );
}

/**
 * 已有会话的权限模式（U15）：经 `session.configure` 的 `permissionMode`（0.11.0）从下一个回合起生效，新值经
 * `session.configured` 回到列表。Host 不支持（没有 `permission_modes`）时不显示；会话只读、是子会话时只显示。
 */
function SessionPermissionPicker({
  session,
  onError,
}: {
  session: Session;
  onError: (message: string) => void;
}) {
  const { client, view } = useHostConnection();
  const data = useWorkbenchData();
  const supported = usePermissionModes();
  if (!supported) return null;
  // 当前的引擎支持的模式（0.25.0）：接力到别的来源后跟着变。
  const engine =
    view.status === 'connected'
      ? engineFeaturesOf(
          view.hello.engineFeatures,
          data.status === 'ready' ? data.providers : NO_PROVIDERS,
          session.providerId,
        )
      : undefined;
  const configure = async (permissionMode: PermissionMode) => {
    if (!client) return;
    try {
      await client.request('session.configure', { sessionId: session.id, permissionMode });
    } catch (error) {
      onError(t('permission.configureFailed', { error: describe(error) }));
    }
  };
  return (
    <PermissionPicker
      value={session.permissionMode ?? 'on_request'}
      {...(engine?.permissionModes && { modes: engine.permissionModes })}
      readOnly={!client || session.readOnly !== undefined || session.parentSessionId !== undefined}
      onChange={(next) => void configure(next)}
    />
  );
}

const NO_PROVIDERS: readonly ProviderProfile[] = [];

/** 新会话草稿页输入框的草稿归属。 */
function newSessionDraftKey(workspaceId: string): string {
  return `draft:${workspaceId}`;
}

/** 从只读会话“基于历史新建”时带给草稿页的路由 state。 */
interface DraftOrigin {
  providerId: string;
  fromTitle: string;
}

function draftOrigin(state: unknown): DraftOrigin | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const { providerId, fromTitle } = state as Record<string, unknown>;
  return typeof providerId === 'string' && typeof fromTitle === 'string'
    ? { providerId, fromTitle }
    : undefined;
}

/**
 * 新会话草稿（`/workspace/:wid/session`）：选工作区与模型，发出第一条消息时才建会话，建好后跳到会话页。U14 起与首页同一个
 * 版式（session/new-session.tsx：标题居中、输入框贴底），换项目即换到那个项目的草稿页。
 */
export function DraftView({ entry }: { entry: WorkspaceEntry }) {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const navigate = useNavigate();
  const location = useLocation();
  const origin = draftOrigin(location.state);
  const { providers, choice, choose } = useModelChoice(origin?.providerId);

  const workspaceId = entry.workspace.id;
  // 草稿页打开的窗格跟着搬到新会话（desktop-layout.md §2.2）。
  const movePanes = useCallback(
    (session: Session) => movePaneScope(draftScopeKey(workspaceId), session.id),
    [workspaceId],
  );
  const permission = usePermissionChoice();
  const permissions = usePermissionModes();
  const environment = useActiveEnvironment(workspaceId);
  const worktree = useWorktreeChoice(workspaceId);
  const { start: send, error } = useStartSession(
    workspaceId,
    choice,
    movePanes,
    permission.mode,
    environment?.id,
    worktree.active,
  );
  const acceptImages = useAcceptsImages(choice);

  const noProvider = providers !== undefined && providers.length === 0;
  const workspaces = data.status === 'ready' ? data.workspaces : [entry];
  const selectProject = (id: string) => navigate(paths.draft(id));
  // 斜杠命令与 @ 提及（U33）：草稿页的目录是工作区的根目录。
  const panes = usePanes();
  const { view } = useHostConnection();
  const filesEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_files');
  const sendCommandText = useCallback((text: string) => void send(text), [send]);
  const permissionCommand = useMemo(
    () => (permissions ? { mode: permission.mode, onChange: permission.choose } : undefined),
    [permissions, permission.mode, permission.choose],
  );
  const commands = useDraftCommands({
    providers,
    model: choice,
    onModelChange: choose,
    ...(permissionCommand && { permission: permissionCommand }),
    filesEnabled,
    panes,
    send: sendCommandText,
  });
  const fileScope = useMemo<FileScope | undefined>(
    () =>
      filesEnabled
        ? {
            workspaceId: entry.workspace.id as FileScope['workspaceId'],
            root: entry.workspace.rootPath,
          }
        : undefined,
    [filesEnabled, entry.workspace.id, entry.workspace.rootPath],
  );

  return (
    <NewSessionLayout
      hero={<NewSessionHero current={entry} workspaces={workspaces} onSelect={selectProject} />}
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
          {origin && (
            <p
              data-testid="draft-from-history"
              className="mb-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
            >
              {t('history.draftNotice', { title: origin.fromTitle })}
            </p>
          )}
          {noProvider && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"
            >
              <span className="min-w-0 flex-1">{t('session.noProvider')}</span>
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<Link to={paths.settings('providers')} state={{ from: location }} />}
              >
                {t('session.goProviders')}
              </Button>
            </div>
          )}
          <Composer
            key={workspaceId}
            variant="home"
            draftKey={newSessionDraftKey(workspaceId)}
            state="idle"
            disabled={!client || !choice}
            onSend={(text, _delivery, images) => send(text, undefined, images)}
            acceptImages={acceptImages}
            leading={
              permissions && (
                <PermissionPicker value={permission.mode} onChange={permission.choose} />
              )
            }
            model={
              providers &&
              choice && <ModelPicker providers={providers} value={choice} onChange={choose} />
            }
            onStop={() => {}}
            autoFocus
            commands={commands}
            {...(fileScope && { fileScope })}
            tray={
              <EnvironmentBar
                current={entry}
                workspaces={workspaces}
                onSelect={selectProject}
                worktree={worktree}
              />
            }
          />
        </>
      }
    />
  );
}
