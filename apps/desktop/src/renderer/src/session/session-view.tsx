import {
  branchSupported,
  commandSupported,
  goalsSupported,
  hostSupports,
  isRpcError,
  rewindSupported,
  type UserChatMessage,
  undoSupported,
} from '@wevir/client-sdk';
import type {
  CollaborationMode,
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
import { ListChecks, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useBrowserReveal } from '@/browser/browser-store';
import { openChanges } from '@/changes/changes-store';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { reportActionFailure } from '@/data/action-notices';
import { useHostSettings } from '@/data/host-settings';
import { markSeen } from '@/data/seen-sessions';
import { archiveSession, requestRename, useSessionManagement } from '@/data/session-actions';
import { useTranscript, useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { isChats, type WorkspaceEntry } from '@/data/workbench-model';
import { useActiveEnvironment, useWorktreeChoice } from '@/environments/environments';
import { OpenFileLink, OpenSessionFile, openFileLink } from '@/files/file-links';
import type { FileScope } from '@/files/files-data';
import { openFile } from '@/files/files-store';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from '@/layout/pane-controller';
import { draftScopeKey } from '@/layout/pane-state';
import { movePaneScope } from '@/layout/pane-store';
import { rememberWorkspace } from '@/routes/last-location';
import { paths, seqParam } from '@/routes/paths';
import { ApprovalDock } from './approval-card';
import { useRegisterCompact } from './compact-action';
import {
  Composer,
  type ComposerPlan,
  insertQuote,
  isBusy,
  restoreDraft,
  setDraft,
} from './composer';
import { ContextMeter } from './context-meter';
import { type DraftOrigin, draftOrigin, newSessionDraftKey } from './draft-origin';
import { EnvironmentBar } from './environment-bar';
import { GoalBanner } from './goal-banner';
import { parseGoalCommand } from './goal-command';
import { canHandoffTo, engineFeaturesOf } from './handoff-model';
import { historyDigest } from './history-digest';
import { useAcceptsImages } from './image-attachments';
import { InsightCard } from './insight-card';
import { currentInsight, insightsEnabled } from './insight-model';
import { type MessageActions, MessageActionsContext } from './message-actions';
import { type ModelChoice, ModelPicker } from './model-picker';
import { NewSessionHero, NewSessionLayout } from './new-session';
import { OllamaContextNotice } from './ollama-context-notice';
import { PendingArea } from './pending-area';
import { steersInline } from './pending-model';
import { PermissionPicker, usePermissionChoice } from './permission-picker';
import { usePlanControl } from './plan-mode';
import { suggestionsEnabled, visibleSuggestion } from './prompt-suggestion';
import { planImplementationPrompt, proposedPlanTitle } from './proposed-plan';
import { QuestionDock } from './question-card';
import { RecapCard } from './recap-card';
import { recapEnabled } from './recap-model';
import { useSessionRecap } from './recap-store';
import { RecoveryPanel } from './recovery-panel';
import type { QuoteActions } from './selection-toolbar';
import { btwQuestion, hasFinishedTurn, openSide, startSide } from './side-session';
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
import { lastTurnId } from './turn-model';
import { useUiShow } from './ui-show';
import { UndoBanner } from './undo-banner';
import { filesNotice, promptOfTurn } from './undo-model';
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
  // 交给用户的文件（0.40.0）：点文件名在文件窗格里预览。
  const openSessionFile = useMemo(
    () => (filesEnabled && panes ? (path: string) => openFile(panes, path) : undefined),
    [filesEnabled, panes],
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
  // agent 请显示网页（0.33.0，`wevir_show` 的 browser）：同样只在主会话里打开浏览器窗格。
  useBrowserReveal(session.id, variant === 'main' ? panes : undefined);
  const sessionState = transcript?.state ?? session.state;
  const readOnly = transcript?.readOnly ?? session.readOnly;
  // 离开一阵再回到会话时的“回顾”（0.54.0）：只在主窗格的顶层会话里，Host 有功能、设置里没关。
  const sessionRecap = useSessionRecap({
    sessionId: session.id,
    client,
    enabled: recapEnabled({
      featureSupported:
        view.status === 'connected' && hostSupports(view.hello.features, 'session_recap'),
      settingOn: settings.sessionRecap,
      variant,
      side: session.side,
      parentSessionId: session.parentSessionId,
    }),
    state: sessionState,
    seq: transcript?.lastSeq ?? session.lastSeq,
  });
  // 旁观提示（0.78.0）：同回顾，只在主窗格的顶层会话里，Host 有功能、设置里开着（默认关）。
  const insight = insightsEnabled({
    featureSupported:
      view.status === 'connected' && hostSupports(view.hello.features, 'session_insights'),
    settings,
    variant,
    side: session.side,
    parentSessionId: session.parentSessionId,
  })
    ? currentInsight(transcript?.insights)
    : undefined;
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

  // 会话目标（0.35.0）：Host 声明 `session_goals`、会话当前的引擎有目标、会话是顶层且可写时，`/goal` 与目标横幅可用。
  const goalsEnabled =
    view.status === 'connected' &&
    client !== undefined &&
    readOnly === undefined &&
    session.parentSessionId === undefined &&
    !session.side &&
    goalsSupported(view.hello.features, engine);
  const goal = transcript?.goal ?? (transcript === undefined ? session.goal : undefined);
  const runGoal = useCallback(
    async (request: () => Promise<unknown>): Promise<boolean> => {
      setNotice(undefined);
      try {
        if (sessionState === 'error' || sessionState === 'closed') {
          await client?.request('session.resume', { sessionId: session.id });
        }
        await request();
        return true;
      } catch (error) {
        setNotice(
          isRpcError(error, 'SESSION_BUSY')
            ? t('session.busy')
            : t('goal.failed', { error: describe(error) }),
        );
        return false;
      }
    },
    [client, session.id, sessionState],
  );
  const pauseGoal = useCallback(
    () =>
      void runGoal(
        async () =>
          await client?.request('session.updateGoal', { sessionId: session.id, status: 'paused' }),
      ),
    [runGoal, client, session.id],
  );
  const resumeGoal = useCallback(
    () =>
      void runGoal(
        async () =>
          await client?.request('session.updateGoal', { sessionId: session.id, status: 'active' }),
      ),
    [runGoal, client, session.id],
  );
  const clearGoal = useCallback(
    () =>
      void runGoal(
        async () => await client?.request('session.clearGoal', { sessionId: session.id }),
      ),
    [runGoal, client, session.id],
  );

  // 计划模式（0.36.0）：会话当前的引擎有它、会话可写时才有开关；没动过开关时按最近一条消息的模式。
  const plan = usePlanControl(
    session.id,
    providers,
    session.providerId,
    (transcript?.collaborationMode ?? session.collaborationMode) === 'plan',
  );
  const planEnabled =
    plan.supported && readOnly === undefined && session.parentSessionId === undefined;

  /** 发一条消息；`mode` 是这条消息的协作模式（0.36.0，省略即默认模式）。 */
  const deliver = useCallback(
    async (
      text: string,
      delivery: PendingDelivery | undefined,
      images: readonly UserImagePart[] | undefined,
      mode: CollaborationMode | undefined,
    ): Promise<boolean> => {
      if (!client) return false;
      setNotice(undefined);
      // `/goal`（0.35.0）：设、暂停、继续、清除目标；不带参数时目标已在横幅里，没有目标时留在输入框里接着写。
      const goalCommand = goalsEnabled && !images?.length ? parseGoalCommand(text) : undefined;
      if (goalCommand !== undefined) {
        switch (goalCommand.type) {
          case 'show':
            return goal !== undefined;
          case 'set': {
            const done = await runGoal(() =>
              client.request('session.setGoal', {
                sessionId: session.id,
                objective: goalCommand.objective,
              }),
            );
            if (done) transcriptRef.current?.jumpToLatest('auto');
            return done;
          }
          case 'pause':
          case 'resume':
            return runGoal(() =>
              client.request('session.updateGoal', {
                sessionId: session.id,
                status: goalCommand.type === 'pause' ? 'paused' : 'active',
              }),
            );
          case 'clear':
            return runGoal(() => client.request('session.clearGoal', { sessionId: session.id }));
        }
      }
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
        await sendText(client, session.id, text, delivery, images, mode);
        transcriptRef.current?.jumpToLatest('auto');
        return true;
      } catch (error) {
        setNotice(sendError(error));
        return false;
      }
    },
    [client, session.id, sessionState, sideEnabled, panes, goalsEnabled, goal, runGoal],
  );
  const send = useCallback(
    (text: string, delivery?: PendingDelivery, images?: readonly UserImagePart[]) =>
      deliver(text, delivery, images, planEnabled ? plan.mode : undefined),
    [deliver, planEnabled, plan.mode],
  );

  // 计划给出之后（0.36.0，照 T3 Code）：会话空闲、没有待答的问题、开关还开着时，空输入框按发送是“实施”——回到默认模式发出
  // 实施消息；下拉里是“在新会话中实施”。
  const latestPlan = transcript?.latestPlan;
  const planReady =
    planEnabled &&
    plan.active &&
    latestPlan !== undefined &&
    sessionState === 'idle' &&
    (transcript?.pendingQuestions.length ?? 0) === 0;
  // 输入建议（0.53.0）：Host 在回合结束后给的“下一句”，空输入框里灰着显示，Tab 或 → 接受。
  const suggestion = visibleSuggestion(transcript?.promptSuggestion, {
    supported:
      view.status === 'connected' && hostSupports(view.hello.features, 'prompt_suggestions'),
    enabled: suggestionsEnabled(settings),
    state: sessionState,
    disabled: !client || readOnly !== undefined,
    planBusy: planEnabled && plan.active,
    awaitingInput: (transcript?.pendingQuestions.length ?? 0) > 0,
  });
  const navigate = useNavigate();
  const store = useWorkbenchStore();
  const permissionModes = usePermissionModes();
  const implementPlan = useCallback(async () => {
    if (!latestPlan) return;
    const prompt = planImplementationPrompt(t('plan.implementPrefix'), latestPlan.text);
    if (await deliver(prompt, undefined, undefined, 'default')) plan.set(false);
  }, [latestPlan, deliver, plan.set]);
  const implementInNew = useCallback(async () => {
    if (!client || !latestPlan) return;
    setNotice(undefined);
    const prompt = planImplementationPrompt(t('plan.implementPrefix'), latestPlan.text);
    try {
      const { session: created } = await client.request('session.create', {
        workspaceId: session.workspaceId,
        providerId: session.providerId,
        modelId: session.modelId,
        ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
        ...(permissionModes &&
          session.permissionMode !== undefined && { permissionMode: session.permissionMode }),
      });
      store?.upsertSession(created);
      await sendText(client, created.id, prompt, undefined, undefined, 'default');
      navigate(paths.session(created.workspaceId, created.id));
    } catch (error) {
      setNotice(sendError(error));
    }
  }, [client, latestPlan, session, permissionModes, store, navigate]);
  // 消息下方的操作（0.38.0）：主窗格里的顶层会话、可写时，回答能分支到新会话，最后一条用户消息能编辑（会话空闲时）。
  const messageActionsEnabled =
    view.status === 'connected' &&
    client !== undefined &&
    variant === 'main' &&
    readOnly === undefined &&
    session.parentSessionId === undefined &&
    !session.side;
  const branchEnabled = messageActionsEnabled && branchSupported(view.hello.features, engine);
  const rewindEnabled = messageActionsEnabled && rewindSupported(view.hello.features, engine);
  const branchFrom = useCallback(
    async (turnId: TurnId) => {
      if (!client) return;
      setNotice(undefined);
      try {
        if (sessionState === 'error' || sessionState === 'closed') {
          await client.request('session.resume', { sessionId: session.id });
        }
        const { session: created } = await client.request('session.fork', {
          sessionId: session.id,
          turnId,
        });
        store?.upsertSession(created);
        navigate(paths.session(created.workspaceId, created.id));
      } catch (error) {
        setNotice(t('message.branchFailed', { error: describe(error) }));
      }
    },
    [client, session.id, sessionState, store, navigate],
  );
  const submitEdit = useCallback(
    async (message: UserChatMessage, text: string): Promise<boolean> => {
      if (!client) return false;
      setNotice(undefined);
      try {
        await client.request('session.rewind', { sessionId: session.id, turnId: message.turnId });
      } catch (error) {
        setNotice(
          isRpcError(error, 'SESSION_BUSY')
            ? t('session.busy')
            : t('message.editFailed', { error: describe(error) }),
        );
        return false;
      }
      const images = message.parts.flatMap((part) => (part.type === 'image' ? [part.image] : []));
      try {
        await sendText(
          client,
          session.id,
          text,
          undefined,
          images,
          planEnabled && message.collaborationMode === 'plan' ? 'plan' : undefined,
        );
        transcriptRef.current?.jumpToLatest('auto');
      } catch (error) {
        // 回合已经撤回了：改过的文字放回输入框，用户再发一次。
        restoreDraft(session.id, text);
        setNotice(sendError(error));
      }
      return true;
    },
    [client, session.id, planEnabled],
  );
  const editTurnId =
    rewindEnabled && sessionState === 'idle' && transcript !== undefined
      ? lastTurnId(transcript)
      : undefined;
  const messageActions = useMemo<MessageActions>(
    () => ({
      ...(branchEnabled && { branch: (turnId: TurnId) => void branchFrom(turnId) }),
      ...(editTurnId !== undefined && { editTurnId, submitEdit }),
    }),
    [branchEnabled, branchFrom, editTurnId, submitEdit],
  );

  const composerPlan = useMemo<ComposerPlan | undefined>(
    () =>
      planEnabled
        ? {
            active: plan.active,
            onToggle: plan.toggle,
            ...(planReady && {
              followUp: {
                onImplement: () => void implementPlan(),
                ...(variant === 'main' && { onImplementInNew: () => void implementInNew() }),
              },
            }),
          }
        : undefined,
    [planEnabled, plan.active, plan.toggle, planReady, implementPlan, implementInNew, variant],
  );
  const planCommand = useMemo(
    () => (planEnabled ? { active: plan.active, onToggle: plan.toggle } : undefined),
    [planEnabled, plan.active, plan.toggle],
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
  // 会话侧栏的“上下文”卡片也有“压缩上下文”（compact-action.ts）。
  useRegisterCompact(session.id, onCompact);
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
  // 第二意见（0.75.0，desktop-tokens §65）：`/second-opinion` 选来源与模型，Host 开意见会话；意见的卡片随事件出现在消息流里。
  const canOpinion =
    commandsEnabled &&
    !session.side &&
    session.opinionOf === undefined &&
    hostSupports(view.hello.features, 'second_opinion');
  const onSecondOpinion = useMemo(
    () =>
      client && canOpinion
        ? (choice: ModelChoice) =>
            void (async () => {
              setNotice(undefined);
              try {
                const { session: reviewer } = await client.request('session.secondOpinion', {
                  sessionId: session.id,
                  providerId: choice.providerId,
                  modelId: choice.modelId,
                });
                store?.upsertSession(reviewer);
                transcriptRef.current?.jumpToLatest('auto');
              } catch (error) {
                setNotice(t('opinion.startFailed', { error: describe(error) }));
              }
            })()
        : undefined,
    [canOpinion, client, session.id, store],
  );
  // 撤销与重做（0.51.0，desktop-tokens §58）：撤销最后一个回合——文件回到回合开始前、回合从消息记录里隐藏；用户写的文字放回输入框。
  // 之后会话没开始新回合时可以重做（横幅与 `/redo`）。文件没动时用提示说明原因。
  const undoAvailable =
    commandsEnabled &&
    !session.side &&
    view.status === 'connected' &&
    undoSupported(view.hello.features, engine);
  const redoCount = transcript?.redoTurnIds.length ?? 0;
  const hasTurns = transcript !== undefined && lastTurnId(transcript) !== undefined;
  const undoTurn = useCallback(async () => {
    if (!client) return;
    const messages = transcript?.messages ?? [];
    setNotice(undefined);
    try {
      if (sessionState === 'error' || sessionState === 'closed') {
        await client.request('session.resume', { sessionId: session.id });
      }
      const result = await client.request('session.undo', { sessionId: session.id });
      const prompt = promptOfTurn(messages, result.turnId);
      if (prompt !== undefined) restoreDraft(session.id, prompt);
      const skipped = filesNotice(result.files);
      if (skipped !== undefined) reportActionFailure(skipped);
    } catch (error) {
      setNotice(
        isRpcError(error, 'SESSION_BUSY')
          ? t('session.busy')
          : t('undo.failed', { error: describe(error) }),
      );
    }
  }, [client, session.id, sessionState, transcript]);
  const redoTurn = useCallback(async () => {
    if (!client) return;
    setNotice(undefined);
    try {
      const result = await client.request('session.redo', { sessionId: session.id });
      const skipped = filesNotice(result.files);
      if (skipped !== undefined) reportActionFailure(skipped);
    } catch (error) {
      setNotice(
        isRpcError(error, 'SESSION_BUSY')
          ? t('session.busy')
          : t('redo.failed', { error: describe(error) }),
      );
    }
  }, [client, session.id]);
  const onUndo = undoAvailable && hasTurns ? () => void undoTurn() : undefined;
  const onRedo = undoAvailable && redoCount > 0 ? () => void redoTurn() : undefined;
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
    ...(onSecondOpinion && { onSecondOpinion }),
    ...(onUndo && { onUndo }),
    ...(onRedo && { onRedo }),
    goalEnabled: goalsEnabled,
    ...(planCommand && { plan: planCommand }),
  });
  // 选中消息里的文字（desktop-tokens §57）：“添加到对话”把引用放进这个会话的输入框，“支线提问”分出支线、引用放进支线窗格的
  // 输入框；只读的会话没有输入框，也就没有工具条。
  const quote = useMemo<QuoteActions | undefined>(() => {
    if (!writable) return undefined;
    return {
      onAdd: (text) => insertQuote(session.id, text),
      ...(sideEnabled &&
        client && {
          onSide: (text: string) => {
            setNotice(undefined);
            openSide(client, session.id as SessionId, text, panes, (sideId) =>
              insertQuote(sideId, text),
            ).catch((error: unknown) => setNotice(t('side.failed', { error: describe(error) })));
          },
        }),
    };
  }, [writable, sideEnabled, client, session.id, panes]);
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

  // 跳到某个事件（任务回顾的出处，0.76.0）：主窗格地址里的 `?seq=N`，消息流追上之后滚过去，再从地址里去掉。
  const location = useLocation();
  const revealTarget = variant === 'main' ? seqParam(location.search) : undefined;
  const caughtUp = state?.caughtUp === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在目标出现或消息流追上时跳一次，location.state 原样带回。
  useEffect(() => {
    if (revealTarget === undefined || !caughtUp) return;
    transcriptRef.current?.revealSeq(revealTarget);
    void navigate({ search: '' }, { replace: true, state: location.state });
  }, [revealTarget, caughtUp, navigate]);

  const resume = useCallback(async () => {
    if (!client) return;
    await client.request('session.resume', { sessionId: session.id });
  }, [client, session.id]);

  const subagentHref = useCallback(
    (subagent: SubagentSummary) => paths.agent(session.workspaceId, session.id, subagent.sessionId),
    [session.workspaceId, session.id],
  );

  // 基于历史新建（T5.5）：对话记录放进同一工作区新会话的输入框，沿用原会话的 Provider，用户确认后发送。
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
            <OpenSessionFile value={openSessionFile}>
              <MessageActionsContext value={messageActions}>
                <TranscriptView
                  sessionId={session.id}
                  transcript={transcript}
                  cwd={session.cwd}
                  onReady={onReady}
                  compact={variant === 'pane'}
                  {...(quote && { quote })}
                />
              </MessageActionsContext>
            </OpenSessionFile>
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
            {sessionRecap && (
              <RecapCard text={sessionRecap.text} onDismiss={sessionRecap.dismiss} />
            )}
            {insight && <InsightCard key={insight.id} sessionId={session.id} insight={insight} />}
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
            {planReady && <PlanReadyBanner title={proposedPlanTitle(latestPlan.text)} />}
            {transcript && (
              <PendingArea
                sessionId={session.id}
                pending={transcript.pendingMessages}
                steerInline={steersInline(transcript)}
                state={sessionState}
                client={client}
                onError={setNotice}
              />
            )}
            {goal && goalsEnabled && (
              <GoalBanner
                goal={goal}
                working={
                  sessionState !== 'idle' && sessionState !== 'closed' && sessionState !== 'error'
                }
                disabled={!client}
                onPause={pauseGoal}
                onResume={resumeGoal}
                onClear={clearGoal}
              />
            )}
            {undoAvailable && redoCount > 0 && (
              <UndoBanner count={redoCount} disabled={!client} onRedo={() => void redoTurn()} />
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
            {...(composerPlan && { plan: composerPlan })}
            {...(suggestion !== undefined && { suggestion })}
          />
        </div>
      </div>
    </div>
  );
}

/** 输入框上方的“计划已就绪”（0.36.0，照 T3 Code 的 ComposerPlanFollowUpBanner）：计划的标题。 */
function PlanReadyBanner({ title }: { title: string | null }) {
  return (
    <p
      data-testid="plan-ready"
      className="mb-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm"
    >
      <ListChecks aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-muted-foreground">{t('plan.ready')}</span>
      {title && <span className="min-w-0 flex-1 truncate">{title}</span>}
    </p>
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
  const {
    start: send,
    error,
    goals,
  } = useStartSession(
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
  // “不在目录中工作”（0.39.0）回到首页去建对话。
  const selectProject = (id: string | null) => {
    if (id !== null) return navigate(paths.draft(id));
    rememberWorkspace(null);
    return navigate(paths.home());
  };
  // 斜杠命令与 @ 提及（U33）：草稿页的目录是工作区的根目录。
  const panes = usePanes();
  const { view } = useHostConnection();
  const filesEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_files');
  // 计划模式（0.36.0）：草稿也能选，按选的模型所在的引擎；第一条消息带上它。
  const draftKey = newSessionDraftKey(workspaceId);
  const plan = usePlanControl(draftKey, providers ?? NO_PROVIDERS, choice?.providerId);
  const startWithPlan = useCallback(
    async (text: string, images?: readonly UserImagePart[]) => {
      const started = await send(text, undefined, images, plan.mode);
      if (started && plan.active) plan.set(false);
      return started;
    },
    [send, plan],
  );
  const sendCommandText = useCallback((text: string) => void startWithPlan(text), [startWithPlan]);
  const permissionCommand = useMemo(
    () => (permissions ? { mode: permission.mode, onChange: permission.choose } : undefined),
    [permissions, permission.mode, permission.choose],
  );
  const planCommand = useMemo(
    () => (plan.supported ? { active: plan.active, onToggle: plan.toggle } : undefined),
    [plan.supported, plan.active, plan.toggle],
  );
  const commands = useDraftCommands({
    providers,
    model: choice,
    onModelChange: choose,
    ...(permissionCommand && { permission: permissionCommand }),
    filesEnabled,
    panes,
    send: sendCommandText,
    goalEnabled: goals,
    ...(planCommand && { plan: planCommand }),
  });
  // “对话”工作区（0.39.0）只能按会话读文件，草稿还没有会话。
  const chatDraft = isChats(entry.workspace);
  const fileScope = useMemo<FileScope | undefined>(
    () =>
      filesEnabled && !chatDraft
        ? {
            workspaceId: entry.workspace.id as FileScope['workspaceId'],
            root: entry.workspace.rootPath,
          }
        : undefined,
    [filesEnabled, chatDraft, entry.workspace.id, entry.workspace.rootPath],
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
              {t(origin.material === 'retro' ? 'retro.draftNotice' : 'history.draftNotice', {
                title: origin.fromTitle,
              })}
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
            draftKey={draftKey}
            state="idle"
            disabled={!client || !choice}
            onSend={(text, _delivery, images) => startWithPlan(text, images)}
            {...(planCommand && { plan: planCommand })}
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
