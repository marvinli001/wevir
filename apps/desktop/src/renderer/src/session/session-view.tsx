import { hostSupports } from '@wevir/client-sdk';
import type { PendingDelivery, PermissionMode, Session, SubagentSummary } from '@wevir/protocol';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useHostSettings } from '@/data/host-settings';
import { markSeen } from '@/data/seen-sessions';
import { useTranscript, useWorkbenchData } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { draftScopeKey } from '@/layout/pane-state';
import { movePaneScope } from '@/layout/pane-store';
import { paths } from '@/routes/paths';
import { ApprovalDock } from './approval-card';
import { Composer, setDraft } from './composer';
import { EnvironmentBar } from './environment-bar';
import { historyDigest } from './history-digest';
import { type ModelChoice, ModelPicker } from './model-picker';
import { NewSessionHero, NewSessionLayout } from './new-session';
import { PendingArea } from './pending-area';
import { PermissionPicker, usePermissionChoice } from './permission-picker';
import { QuestionDock } from './question-card';
import { RecoveryPanel } from './recovery-panel';
import {
  sendError,
  sendText,
  useModelChoice,
  usePermissionModes,
  useStartSession,
} from './start-session';
import { TranscriptView, type TranscriptViewHandle } from './transcript-view';

/**
 * 一个会话：消息流、审批区、输入框与状态指示（T5.3）。消息流来自从 seq 0 开始的订阅（transcript-store.ts），
 * 状态与审批都以这条事件流为准。
 */
export function SessionView({ session }: { session: Session }) {
  const { client, identity, view } = useHostConnection();
  const hostSettings = useHostSettings();
  const { settings } = hostSettings;
  // 回合进行中也能发（R11）：Host 有待发消息时，回车按“回合进行中按回车”的设置。
  const pendingEnabled =
    view.status === 'connected' && hostSupports(view.hello.features, 'pending_messages');
  const state = useTranscript(session.id);
  const transcriptRef = useRef<TranscriptViewHandle>(undefined);
  const [notice, setNotice] = useState<string>();

  useEffect(() => markSeen(session), [session]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换会话时清掉上一个会话的提示。
  useEffect(() => setNotice(undefined), [session.id]);

  const transcript = state?.transcript;
  const sessionState = transcript?.state ?? session.state;
  const readOnly = transcript?.readOnly ?? session.readOnly;

  const send = useCallback(
    async (text: string, delivery?: PendingDelivery): Promise<boolean> => {
      if (!client) return false;
      setNotice(undefined);
      try {
        // 出错或已关闭的会话先恢复（领域模型 §4.2：send 在这两个状态下回 INVALID_STATE）。
        if (sessionState === 'error' || sessionState === 'closed') {
          await client.request('session.resume', { sessionId: session.id });
        }
        await sendText(client, session.id, text, delivery);
        transcriptRef.current?.jumpToLatest('auto');
        return true;
      } catch (error) {
        setNotice(sendError(error));
        return false;
      }
    },
    [client, session.id, sessionState],
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
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={<TriangleAlert />}
            title={t('transcript.failed', { error: state.error })}
          />
        </div>
      ) : transcript && (state.caughtUp || transcript.lastSeq > 0) ? (
        <TranscriptView
          sessionId={session.id}
          transcript={transcript}
          self={identity}
          cwd={session.cwd}
          onReady={onReady}
        />
      ) : (
        <p className="min-h-0 flex-1 py-16 text-center text-sm text-muted-foreground">
          {t('transcript.loading')}
        </p>
      )}
      <div className="mx-auto w-full max-w-content shrink-0 px-6 pb-5">
        {/* 输入框上方的提问、审批、恢复、提示与待发区（U14）：最多占窗口高的 55%，再多在这一块里滚动，消息流不被挤没。 */}
        <div className="-mx-1 max-h-[55vh] overflow-y-auto px-1 pt-1 empty:hidden">
          {transcript && <QuestionDock transcript={transcript} client={client} />}
          {transcript && (
            <ApprovalDock
              transcript={transcript}
              client={client}
              self={identity}
              subagentHref={subagentHref}
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
          model={<SessionModelPicker session={session} onError={setNotice} />}
          leading={<SessionPermissionPicker session={session} onError={setNotice} />}
          {...(pendingEnabled && { busyDelivery: settings.sendWhileBusy })}
          {...(pendingEnabled &&
            hostSettings.supported && { onBusyDeliveryChange: changeBusyDelivery })}
          onSend={send}
          onStop={stop}
          autoFocus
        />
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
  const value: ModelChoice = {
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
  };
  const configure = async (next: ModelChoice) => {
    if (!client) return;
    try {
      await client.request('session.configure', {
        sessionId: session.id,
        modelId: next.modelId,
        reasoningEffort: next.reasoningEffort ?? null,
      });
    } catch (error) {
      onError(t('model.configureFailed', { error: describe(error) }));
    }
  };
  return (
    <ModelPicker
      providers={providers}
      value={value}
      lockProvider
      readOnly={!supported || !client || session.readOnly !== undefined}
      onChange={(next) => void configure(next)}
    />
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
  const { client } = useHostConnection();
  const supported = usePermissionModes();
  if (!supported) return null;
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
      readOnly={!client || session.readOnly !== undefined || session.parentSessionId !== undefined}
      onChange={(next) => void configure(next)}
    />
  );
}

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
  const { start: send, error } = useStartSession(workspaceId, choice, movePanes, permission.mode);

  const noProvider = providers !== undefined && providers.length === 0;
  const workspaces = data.status === 'ready' ? data.workspaces : [entry];
  const selectProject = (id: string) => navigate(paths.draft(id));

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
            onSend={(text) => send(text)}
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
            tray={
              <EnvironmentBar current={entry} workspaces={workspaces} onSelect={selectProject} />
            }
          />
        </>
      }
    />
  );
}
