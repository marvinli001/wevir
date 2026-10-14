// 发消息与新建会话（U4 从 session-view.tsx 抽出）：新会话草稿页与首页的大输入框共用同一套建会话的流程。

import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { PendingDelivery, Session, WorkspaceId } from '@wevir/protocol';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';

export async function sendText(
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

export function sendError(error: unknown): string {
  if (isRpcError(error, 'SESSION_BUSY')) return t('session.busy');
  if (isRpcError(error, 'INVALID_STATE') && error.data?.readOnly) {
    return t('session.readOnlyComposer');
  }
  return t('session.sendFailed', { error: describe(error) });
}

/**
 * 新会话用哪个 Provider：选过的还在列表里就用它，否则用第一个。Provider 列表随工作区列表一起读（workbench-store.ts），
 * 设置页改了之后跟着变；还没读到时 `providers` 是 undefined。
 */
export function useProviderChoice(initial?: string) {
  const data = useWorkbenchData();
  const [chosen, choose] = useState<string | undefined>(initial);
  const providers = data.status === 'ready' ? data.providers : undefined;
  const providerId = providers?.some((p) => p.id === chosen) ? chosen : providers?.[0]?.id;
  return { providers, providerId, choose };
}

/**
 * 新建会话：发出第一条消息时才建（`session.create` 再 `session.send`），建好后放进列表、跳到会话页。返回 true 表示已发出
 * （输入框清空）；失败时 `error` 是给界面的说明，输入框保留文字。`onCreated` 在跳转之前调用（草稿页把窗格搬到新会话）。
 */
export function useStartSession(
  workspaceId: WorkspaceId | undefined,
  providerId: string | undefined,
  onCreated?: (session: Session) => void,
) {
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();

  const start = useCallback(
    async (text: string): Promise<boolean> => {
      if (!client || !workspaceId || !providerId) return false;
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
      onCreated?.(session);
      navigate(paths.session(workspaceId, session.id));
      return true;
    },
    [client, workspaceId, providerId, store, navigate, onCreated],
  );

  return { start, error, ready: client !== undefined && providerId !== undefined };
}
