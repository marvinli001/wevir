import { hostSupports, isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { PendingDelivery, Session, SubagentSummary } from '@wevir/protocol';
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { useHostSettings } from '@/data/host-settings';
import { markSeen } from '@/data/seen-sessions';
import { useTranscript, useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { draftScopeKey } from '@/layout/pane-state';
import { movePaneScope } from '@/layout/pane-store';
import { paths } from '@/routes/paths';
import { ApprovalDock } from './approval-card';
import { Composer, setDraft } from './composer';
import { historyDigest } from './history-digest';
import { PendingArea } from './pending-area';
import { RecoveryPanel } from './recovery-panel';
import { SessionStatus } from './session-status';
import { TranscriptView, type TranscriptViewHandle } from './transcript-view';

/**
 * 一个会话：消息流、审批区、输入框与状态指示（T5.3）。消息流来自从 seq 0 开始的订阅（transcript-store.ts），
 * 状态与审批都以这条事件流为准。
 */
export function SessionView({ session }: { session: Session }) {
  const { client, identity, view } = useHostConnection();
  const { settings } = useHostSettings();
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
    <div className="flex h-full min-h-0 flex-col">
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
          onReady={onReady}
        />
      ) : (
        <p className="min-h-0 flex-1 py-16 text-center text-sm text-faint-foreground">
          {t('transcript.loading')}
        </p>
      )}
      <div className="mx-auto w-full max-w-content shrink-0 px-6 pb-5">
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
        <Composer
          key={session.id}
          draftKey={session.id}
          state={sessionState}
          disabled={!client || readOnly !== undefined}
          disabledReason={readOnly ? t('session.readOnlyComposer') : undefined}
          status={transcript && <SessionStatus transcript={transcript} />}
          {...(pendingEnabled && { busyDelivery: settings.sendWhileBusy })}
          onSend={send}
          onStop={stop}
          autoFocus
        />
      </div>
    </div>
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
 * 新会话草稿（`/workspace/:wid/session`）：选工作区与模型，发出第一条消息时才建会话，建好后跳到会话页。
 */
export function DraftView({ entry }: { entry: WorkspaceEntry }) {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const location = useLocation();
  const origin = draftOrigin(location.state);
  const [chosen, setProviderId] = useState<string | undefined>(origin?.providerId);
  const [error, setError] = useState<string>();

  // Provider 列表随工作区列表一起读（workbench-store.ts），设置页改了之后这里跟着变。
  const providers = data.status === 'ready' ? data.providers : undefined;
  const providerId = providers?.some((p) => p.id === chosen) ? chosen : providers?.[0]?.id;

  const workspaceId = entry.workspace.id;
  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!client || !providerId) return false;
      setError(undefined);
      let session: Session;
      try {
        ({ session } = await client.request('session.create', { workspaceId, providerId }));
      } catch (reason) {
        setError(t('session.createFailed', { error: describe(reason) }));
        return false;
      }
      store?.upsertSession(session);
      try {
        await sendText(client, session.id, text);
      } catch (reason) {
        setError(sendError(reason));
        return false;
      }
      // 草稿页打开的窗格跟着搬到新会话（desktop-layout.md §2.2）。
      movePaneScope(draftScopeKey(workspaceId), session.id);
      navigate(paths.session(workspaceId, session.id));
      return true;
    },
    [client, providerId, workspaceId, store, navigate],
  );

  const noProvider = providers !== undefined && providers.length === 0;
  const workspaces = data.status === 'ready' ? data.workspaces : [entry];
  const selectClass =
    'h-7 max-w-56 truncate rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-content px-6 py-16 text-center">
          <h2 className="text-lg font-medium">{t('session.draftTitle')}</h2>
          <p className="mt-2 text-muted-foreground">
            {t('session.draftBody', { workspace: entry.workspace.displayName })}
          </p>
          <p className="mt-1 font-mono text-sm break-all text-faint-foreground">
            {entry.workspace.rootPath}
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-content shrink-0 px-6 pb-5">
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
          draftKey={newSessionDraftKey(workspaceId)}
          state="idle"
          disabled={!client || !providerId}
          onSend={send}
          onStop={() => {}}
          autoFocus
          toolbar={
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t('session.workspace')}
                <select
                  className={selectClass}
                  value={workspaceId}
                  onChange={(event) => navigate(paths.draft(event.target.value))}
                >
                  {workspaces.map(({ workspace }) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.displayName}
                    </option>
                  ))}
                </select>
              </label>
              {providers && providers.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t('session.provider')}
                  <select
                    className={selectClass}
                    value={providerId}
                    onChange={(event) => setProviderId(event.target.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName} · {provider.defaultModelId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          }
        />
      </div>
    </div>
  );
}

async function sendText(
  client: WevirClient,
  sessionId: Session['id'],
  text: string,
  delivery?: PendingDelivery,
) {
  await client.request('session.send', {
    sessionId,
    content: [{ type: 'text', text }],
    clientMessageId: crypto.randomUUID(),
    ...(delivery !== undefined && { delivery }),
  });
}

function sendError(error: unknown): string {
  if (isRpcError(error, 'SESSION_BUSY')) return t('session.busy');
  if (isRpcError(error, 'INVALID_STATE') && error.data?.readOnly) {
    return t('session.readOnlyComposer');
  }
  return t('session.sendFailed', { error: describe(error) });
}
