// 发消息与新建会话（U4 从 session-view.tsx 抽出）：新会话草稿页与首页的大输入框共用同一套建会话的流程。

import { goalsSupported, hostSupports, isRpcError, type WevirClient } from '@wevir/client-sdk';
import type {
  CollaborationMode,
  EnvironmentId,
  PendingDelivery,
  PermissionMode,
  ProviderProfile,
  Session,
  UserImagePart,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { isPickable, pickerOrder } from '@/data/sources';
import { useAccounts, useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createPersistedStore } from '@/lib/store';
import { paths } from '@/routes/paths';
import { messageContent } from './composer-images';
import { expandPastes } from './composer-pastes';
import { parseGoalCommand } from './goal-command';
import { engineFeaturesOf } from './handoff-model';
import { type ModelChoice, modelsOf } from './model-picker';
import { setPlanMode } from './plan-mode';
import { alongside } from './start-session-model';

export async function sendText(
  client: WevirClient,
  sessionId: Session['id'],
  text: string,
  delivery?: PendingDelivery,
  images?: readonly UserImagePart[],
  /** 协作模式（0.36.0）；只在 Host 与引擎有计划模式时给。 */
  collaborationMode?: CollaborationMode,
) {
  await client.request('session.send', {
    sessionId,
    content: messageContent(text, images),
    clientMessageId: crypto.randomUUID(),
    ...(delivery !== undefined && { delivery }),
    ...(collaborationMode !== undefined && { collaborationMode }),
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
  const accounts = useAccounts();
  const stored = lastChoice.use();
  // 0.19.0：只在能选的里挑（停用的、订阅没登录的不算），订阅来源排在 API 前面（data/sources.ts）。
  const providers =
    data.status === 'ready'
      ? pickerOrder(data.providers.filter((provider) => isPickable(provider, accounts)))
      : undefined;
  const choice = providers && resolveChoice(providers, stored, preferred);
  return { providers, choice, choose: (next: ModelChoice) => lastChoice.set(next) };
}

/** Host 支持权限模式（0.11.0 的 `permission_modes`）：新会话与已有会话的输入框才显示可选的权限芯片。 */
export function usePermissionModes(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'permission_modes');
}

/**
 * 新建会话：发出第一条消息时才建（`session.create` 再 `session.send`），建好后放进列表、跳到会话页。返回 true 表示已发出
 * （输入框清空）；失败时 `error` 是给界面的说明，输入框保留文字。`onCreated` 在跳转之前调用（草稿页把窗格搬到新会话）。
 * `permissionMode`（U15）只在 Host 支持权限模式时带上。
 */
export function useStartSession(
  /** 不给（0.39.0，Host 功能 `chat_sessions`）：建不在项目里的会话（对话）。 */
  workspaceId: WorkspaceId | undefined,
  choice: ModelChoice | undefined,
  onCreated?: (session: Session) => void,
  permissionMode?: PermissionMode,
  /** 新会话页选中的环境（U22.1，0.15.0）；它的主文件夹就是 `workspaceId`。 */
  environmentId?: EnvironmentId,
  /** 选了“新工作树”（0.18.0）：在 `workspaceId` 的仓库里新开一个 worktree。 */
  newWorktree?: boolean,
) {
  const { client, view } = useHostConnection();
  const permissions = usePermissionModes();
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const primary = workspaceId;
  const chats = view.status === 'connected' && hostSupports(view.hello.features, 'chat_sessions');
  // 选的模型能用目标（0.35.0）：`/goal 〈目标〉` 建会话后设目标，第一个回合以目标为消息。
  const data = useWorkbenchData();
  const goals =
    view.status === 'connected' &&
    choice !== undefined &&
    data.status === 'ready' &&
    goalsSupported(
      view.hello.features,
      engineFeaturesOf(view.hello.engineFeatures, data.providers, choice.providerId),
    );

  // 0.129.0：选中的来源有冷启动的引擎（Antigravity 等 ACP 运行体）时先让 Host 拉起来，第一条消息只等建会话。
  const prewarm =
    view.status === 'connected' && hostSupports(view.hello.features, 'engine_prewarm');
  const providerId = choice?.providerId;
  useEffect(() => {
    if (!client || !prewarm || providerId === undefined) return;
    client.request('provider.prewarm', { providerId }).catch(() => {});
  }, [client, prewarm, providerId]);

  const start = useCallback(
    /**
     * `target`：在别的工作区里建（首页没有项目时，先建项目再接着发）；`images`：带的图片（0.28.0）；`collaborationMode`：第一条
     * 消息的模式（0.36.0，草稿页选了计划模式）。
     */
    async (
      text: string,
      target: WorkspaceId | undefined = workspaceId,
      images?: readonly UserImagePart[],
      collaborationMode?: CollaborationMode,
    ): Promise<boolean> => {
      const workspaceId = target;
      if (!client || !choice) return false;
      if (!workspaceId && !chats) return false;
      const goal = goals && !images?.length ? parseGoalCommand(expandPastes(text)) : undefined;
      // 新会话还没有目标可管：只有 `/goal 〈目标〉` 建会话，其余写法留在输入框里。
      if (goal !== undefined && goal.type !== 'set') return false;
      setError(undefined);
      let session: Session;
      try {
        ({ session } = await client.request('session.create', {
          ...(workspaceId !== undefined && { workspaceId }),
          providerId: choice.providerId,
          modelId: choice.modelId,
          ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
          ...(permissions && permissionMode !== undefined && { permissionMode }),
          // 环境与新工作树只对选的那个项目生效（首页先建项目再接着发时 target 是新项目）。
          ...(environmentId !== undefined &&
            workspaceId &&
            target === primary && { environmentId }),
          ...(newWorktree && workspaceId && target === primary && { worktree: 'new' as const }),
        }));
      } catch (reason) {
        setError(t('session.createFailed', { error: describe(reason) }));
        return false;
      }
      store?.upsertSession(session);
      try {
        // 第一个对话：“对话”工作区刚建，列表里还没有它，跳过去之前先重读；和第一条消息同时进行，不让消息等它。
        await alongside(
          async () => {
            if (goal?.type === 'set') {
              await client.request('session.setGoal', {
                sessionId: session.id,
                objective: goal.objective,
              });
            } else {
              await sendText(client, session.id, text, undefined, images, collaborationMode);
            }
          },
          workspaceId || !store ? undefined : () => store.refresh(),
        );
      } catch (reason) {
        setError(sendError(reason));
        return false;
      }
      // 会话页的开关接着草稿的（它最近一条消息就是这个模式，这里只是不等事件到）。
      if (collaborationMode !== undefined) setPlanMode(session.id, collaborationMode === 'plan');
      onCreated?.(session);
      navigate(paths.session(session.workspaceId, session.id));
      return true;
    },
    [
      client,
      workspaceId,
      choice,
      store,
      navigate,
      onCreated,
      permissions,
      permissionMode,
      environmentId,
      newWorktree,
      primary,
      goals,
      chats,
    ],
  );

  return { start, error, goals, ready: client !== undefined && choice !== undefined };
}
