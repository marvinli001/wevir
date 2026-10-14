// 发消息与新建会话（U4 从 session-view.tsx 抽出）：新会话草稿页与首页的大输入框共用同一套建会话的流程。

import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { PendingDelivery, ProviderProfile, Session, WorkspaceId } from '@wevir/protocol';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';
import { paths } from '@/routes/paths';
import { type ModelChoice, modelsOf } from './model-picker';

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

/** 上次新建会话用的模型（U8）：本机记住，下次首页与草稿页默认用它。 */
const lastChoice = createPersistedStore<ModelChoice | null>(
  'wevir.model-choice.v1',
  null,
  (raw) => {
    if (raw === null) return null;
    if (typeof raw !== 'object') return undefined;
    const { providerId, modelId, reasoningEffort } = raw as Record<string, unknown>;
    if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
    return {
      providerId,
      modelId,
      ...(typeof reasoningEffort === 'string' && { reasoningEffort }),
    };
  },
);

/**
 * 记下的选择还能用就用它（Provider 还在、模型还在它的列表里，档位不在模型的档位里时去掉），否则用第一个（或 `preferred`
 * 指定的）Provider 的默认模型。
 */
export function resolveChoice(
  providers: readonly ProviderProfile[],
  candidate: ModelChoice | null,
  preferred?: string,
): ModelChoice | undefined {
  const provider =
    providers.find((p) => p.id === (preferred ?? candidate?.providerId)) ?? providers[0];
  if (!provider) return undefined;
  const models = modelsOf(provider);
  const model =
    candidate?.providerId === provider.id
      ? models.find((m) => m.id === candidate.modelId)
      : undefined;
  if (!model || !candidate) {
    return { providerId: provider.id, modelId: provider.defaultModelId };
  }
  const effort = candidate.reasoningEffort;
  return {
    providerId: provider.id,
    modelId: model.id,
    ...(effort !== undefined &&
      model.reasoningEfforts?.includes(effort as never) && {
        reasoningEffort: effort,
      }),
  };
}

/**
 * 新会话用哪个模型（U8 起替代只选 Provider）：Provider 列表随工作区列表一起读（workbench-store.ts），设置页改了之后跟着变；
 * 还没读到时 `providers` 是 undefined。`preferred`：优先用这个 Provider（基于历史新建时沿用原会话的）。
 */
export function useModelChoice(preferred?: string) {
  const data = useWorkbenchData();
  const stored = lastChoice.use();
  const providers = data.status === 'ready' ? data.providers : undefined;
  const choice = providers && resolveChoice(providers, stored, preferred);
  return { providers, choice, choose: (next: ModelChoice) => lastChoice.set(next) };
}

/**
 * 新建会话：发出第一条消息时才建（`session.create` 再 `session.send`），建好后放进列表、跳到会话页。返回 true 表示已发出
 * （输入框清空）；失败时 `error` 是给界面的说明，输入框保留文字。`onCreated` 在跳转之前调用（草稿页把窗格搬到新会话）。
 */
export function useStartSession(
  workspaceId: WorkspaceId | undefined,
  choice: ModelChoice | undefined,
  onCreated?: (session: Session) => void,
) {
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();

  const start = useCallback(
    /** `target`：在别的工作区里建（首页没有项目时，先建项目再接着发）。 */
    async (text: string, target: WorkspaceId | undefined = workspaceId): Promise<boolean> => {
      const workspaceId = target;
      if (!client || !workspaceId || !choice) return false;
      setError(undefined);
      let session: Session;
      try {
        ({ session } = await client.request('session.create', {
          workspaceId,
          providerId: choice.providerId,
          modelId: choice.modelId,
          ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
        }));
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
    [client, workspaceId, choice, store, navigate, onCreated],
  );

  return { start, error, ready: client !== undefined && choice !== undefined };
}
