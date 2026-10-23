// 任务回顾的数据（0.76.0）：看得见时读 `retro.get`（Host 按需生成或增量更新），会话有新事件时稍后重读；不在后台生成。还有每行
// 出处的打开方式、导出、模型摘要与“基于回顾新建”。

import { hostSupports } from '@wevir/client-sdk';
import type { RetroSummary, Session, SessionId, SessionRetro } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { openChanges } from '@/changes/changes-store';
import { useTranscript } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from '@/layout/pane-controller';
import { platformApi } from '@/platform/platform';
import { paths } from '@/routes/paths';
import { setDraft } from '@/session/composer';
import { type DraftOrigin, newSessionDraftKey } from '@/session/draft-origin';
import { useSessions } from '@/session/suggested-tasks';
import {
  type RetroTarget,
  retroFileName,
  retroJson,
  retroMarkdownText,
  summaryReasonLabel,
} from './retro-model';

/** 会话有新事件后隔多久重读（连续的事件合成一次）。 */
const RETRO_REFRESH_MS = 800;

export function useRetroSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'session_retro');
}

export interface RetroData {
  retro: SessionRetro | undefined;
  error: string | undefined;
  loading: boolean;
  reload(): void;
}

/** `active` 时读，会话的事件变了就稍后重读。 */
export function useRetro(sessionId: SessionId, active: boolean): RetroData {
  const { client } = useHostConnection();
  const supported = useRetroSupported();
  const lastSeq = useTranscript(sessionId)?.transcript.lastSeq ?? 0;
  const [state, setState] = useState<{
    sessionId: SessionId;
    retro?: SessionRetro;
    error?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loaded = useRef<SessionId | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lastSeq 与 nonce 只用来触发重读。
  useEffect(() => {
    if (!client || !supported || !active) return;
    let stopped = false;
    const fresh = loaded.current !== sessionId;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        client
          .request('retro.get', { sessionId })
          .then(
            (result) => {
              if (stopped) return;
              loaded.current = sessionId;
              setState({ sessionId, retro: result.retro });
            },
            (reason) => {
              if (stopped) return;
              setState((current) => ({
                sessionId,
                ...(current?.sessionId === sessionId && current.retro && { retro: current.retro }),
                error: describe(reason),
              }));
            },
          )
          .finally(() => {
            if (!stopped) setLoading(false);
          });
      },
      fresh ? 0 : RETRO_REFRESH_MS,
    );
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [client, supported, active, sessionId, lastSeq, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const current = state?.sessionId === sessionId ? state : undefined;
  return { retro: current?.retro, error: current?.error, loading, reload };
}

/** 打开一行的出处：事件跳到消息流里的位置，改动开“变更”窗格，提交复制提交号，会话跳过去，笔记开记忆设置。 */
export function useRetroOpen(session: Session): {
  open(target: RetroTarget): void;
  copied: string | undefined;
} {
  const navigate = useNavigate();
  const panes = usePanes();
  const sessions = useSessions();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    if (copied === undefined) return;
    const timer = window.setTimeout(() => setCopied(undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const open = useCallback(
    (target: RetroTarget) => {
      switch (target.kind) {
        case 'seq':
          void navigate(paths.sessionAt(session.workspaceId, session.id, target.seq));
          return;
        case 'diff':
          openChanges(panes, session.id as SessionId, target.scope, target.path);
          return;
        case 'commit':
          void platformApi()
            .copyText(target.sha)
            .then(() => setCopied(target.sha));
          return;
        case 'session': {
          const other = sessions.get(target.sessionId);
          if (other) void navigate(paths.session(other.workspaceId, other.id));
          return;
        }
        case 'memory':
          void navigate(paths.settings('memory'));
          return;
      }
    },
    [navigate, panes, sessions, session.workspaceId, session.id],
  );
  return { open, copied };
}

/** 导出、摘要与“基于回顾新建”。导出与新建都先向 Host 要脱敏后的回顾（正则检查）。 */
export function useRetroActions(session: Session, onChanged: () => void) {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const [pending, setPending] = useState<'export' | 'summary' | 'new'>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const sessionId = session.id as SessionId;

  const redacted = useCallback(async () => {
    if (!client) throw new Error(t('retro.offline'));
    return client.request('retro.get', { sessionId, redact: true });
  }, [client, sessionId]);

  const run = useCallback(async (kind: 'export' | 'summary' | 'new', task: () => Promise<void>) => {
    setPending(kind);
    setError(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (reason) {
      setError(t('retro.failed', { error: describe(reason) }));
    } finally {
      setPending(undefined);
    }
  }, []);

  const exportAs = useCallback(
    (format: 'md' | 'json') =>
      run('export', async () => {
        const { retro, redactions } = await redacted();
        const text =
          format === 'md'
            ? retroMarkdownText(retro, {
                ...(retro.title && { title: retro.title }),
                redactions: redactions ?? 0,
              })
            : retroJson(retro, redactions);
        const saved = await platformApi().saveTextAs(retroFileName(session.id, format), text);
        if (saved === 'saved') setNotice(t('retro.export.redacted', { count: redactions ?? 0 }));
      }),
    [run, redacted, session.id],
  );

  const summarize = useCallback(
    () =>
      run('summary', async () => {
        if (!client) return;
        const result: { summary?: RetroSummary; reason?: string } = await client.request(
          'retro.summarize',
          { sessionId },
        );
        if (result.reason !== undefined) {
          setError(t('retro.summary.failed', { reason: summaryReasonLabel(result.reason) }));
        }
        onChanged();
      }),
    [run, client, sessionId, onChanged],
  );

  /** 回顾作为起始材料放进同一工作区新会话的输入框（不写进记忆），沿用原会话的 Provider，用户确认后才发送。 */
  const startFromRetro = useCallback(
    () =>
      run('new', async () => {
        const { retro, redactions } = await redacted();
        const material = retroMarkdownText(retro, {
          ...(retro.title && { title: retro.title }),
          redactions: redactions ?? 0,
        });
        setDraft(
          newSessionDraftKey(session.workspaceId),
          `${t('retro.handoffPrefix')}\n\n${material}`,
        );
        const origin: DraftOrigin = {
          providerId: session.providerId,
          fromTitle: session.title,
          material: 'retro',
        };
        void navigate(paths.draft(session.workspaceId), { state: origin });
      }),
    [run, redacted, navigate, session.title, session.workspaceId, session.providerId],
  );

  return { pending, error, notice, exportAs, summarize, startFromRetro };
}
