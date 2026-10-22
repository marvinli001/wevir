// 任务回顾里的“生成建议”（0.87.0）：只对项目里的会话、Host 有 `tuning_proposals` 时有。生成了就跳到调优页这个项目（0.107.0 起
// 改动直接进入试用，试用卡里能看到）；没生成时把原因交给回顾视图显示。

import { hostSupports } from '@wevir/client-sdk';
import type { Session, SessionId } from '@wevir/protocol';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useWorkbenchData } from '@/data/workbench-data';
import { isChats } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { generatedText, reasonText } from './proposals-model';

export function useProposalGenerate(session: Session): {
  available: boolean;
  pending: boolean;
  /** 没生成的原因，或模型认为没有可改的（“暂无建议 · n tokens”）。 */
  message?: string;
  run: () => Promise<void>;
} {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const workbench = useWorkbenchData();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const workspace =
    workbench.status === 'ready'
      ? workbench.workspaces.find((entry) => entry.workspace.id === session.workspaceId)?.workspace
      : undefined;
  const available =
    client !== undefined &&
    hostSupports(client.hello.features, 'tuning_proposals') &&
    workspace !== undefined &&
    !isChats(workspace) &&
    session.parentSessionId === undefined;

  const run = useCallback(async () => {
    if (client === undefined) return;
    setPending(true);
    setMessage(undefined);
    try {
      const result = await client.request('tuning.proposal.generate', {
        sessionId: session.id as SessionId,
      });
      if (result.reason !== undefined) {
        setMessage(t('tuning.proposals.failed', { reason: reasonText(result.reason) }));
      } else if (result.proposals.length === 0) {
        setMessage(generatedText(result));
      } else {
        void navigate(paths.tuning({ workspace: session.workspaceId }));
      }
    } catch (reason) {
      setMessage(t('tuning.proposals.failed', { reason: describe(reason) }));
    } finally {
      setPending(false);
    }
  }, [client, navigate, session.id, session.workspaceId]);

  return { available, pending, ...(message !== undefined && { message }), run };
}
