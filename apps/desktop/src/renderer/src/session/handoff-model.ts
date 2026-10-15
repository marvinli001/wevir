// 接力（0.25.0，domain-model §3.14）的纯逻辑：已有会话能换到哪些来源、当前的引擎能做什么、切换处那一行写什么。

import type { EngineFeatures, ProviderProfile, Session, SessionState } from '@wevir/protocol';
import { sourceOf } from '@/data/sources';
import { t } from '@/i18n';

const ACTIVE: readonly SessionState[] = ['running', 'awaiting_approval', 'cancelling'];

/** 一个 Provider 的会话由哪个引擎跑、能做什么（`host.hello` 的 `engineFeatures`，按种类）；旧 Host 没有。 */
export function engineFeaturesOf(
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
  providers: readonly ProviderProfile[],
  providerId: string,
): EngineFeatures | undefined {
  const kind = providers.find((provider) => provider.id === providerId)?.kind;
  return kind === undefined ? undefined : engineFeatures?.[kind];
}

/**
 * 已有会话能不能接力到这个 Provider：会话是顶层、不是支线、可写、没有在跑回合；有额外目录（多文件夹的环境）时对方的引擎
 * 要支持额外目录。同一个 Provider 不算接力。
 */
export function canHandoffTo(
  target: Pick<ProviderProfile, 'id' | 'kind'>,
  session: Pick<
    Session,
    'providerId' | 'extraRoots' | 'state' | 'side' | 'parentSessionId' | 'readOnly'
  >,
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
): boolean {
  if (target.id === session.providerId) return false;
  if (session.side || session.parentSessionId !== undefined || session.readOnly !== undefined) {
    return false;
  }
  if (ACTIVE.includes(session.state)) return false;
  if ((session.extraRoots?.length ?? 0) > 0) {
    return engineFeatures?.[target.kind]?.additionalRoots === true;
  }
  return true;
}

/** “来源 · 模型”：订阅写软件名，API 写服务的名字；认不出的照原样。 */
export function modelLabel(
  providers: readonly ProviderProfile[],
  providerId: string,
  modelId: string,
): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) return modelId;
  const source = sourceOf(provider);
  const model = provider.models.find((candidate) => candidate.id === modelId);
  return `${source ? t(source.name) : provider.displayName} · ${model?.displayName ?? modelId}`;
}
