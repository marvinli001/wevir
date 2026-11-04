// 接力（0.25.0，domain-model §3.14）的纯逻辑：已有会话能换到哪些来源、当前的引擎能做什么、切换处那一行写什么。

import {
  type ConfigurationNoticeOf,
  type HandoffNoticeOf,
  type HandoffText,
  handoffDetailRows as sharedHandoffDetailRows,
} from '@wevir/client-sdk';
import type {
  AccountState,
  EngineFeatures,
  ProviderProfile,
  Session,
  SessionState,
} from '@wevir/protocol';
import { accountSuffix, sourceOf, sourceTitle } from '@/data/sources';
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

export function handoffTransition(
  providers: readonly ProviderProfile[],
  fromProviderId: string,
  toProviderId: string,
  accounts?: readonly AccountState[],
): string {
  const from = providers.find((provider) => provider.id === fromProviderId);
  const to = providers.find((provider) => provider.id === toProviderId);
  const fromSource = from && sourceOf(from);
  const toSource = to && sourceOf(to);
  const accountsChanged =
    fromProviderId !== toProviderId && fromSource && fromSource.kind === toSource?.kind;
  const label = (provider: ProviderProfile | undefined, id: string) => {
    if (!provider) return id;
    const source = sourceOf(provider);
    if (accountsChanged && source) return accountSuffix(provider, accounts) ?? t(source.name);
    return source ? t(source.name) : provider.displayName;
  };
  return t('handoff.transition', {
    from: label(from, fromProviderId),
    to: label(to, toProviderId),
  });
}

export type { ConfigurationNoticeOf, HandoffDetailRow, HandoffNoticeOf } from '@wevir/client-sdk';

export function handoffDetailRows(
  notice: HandoffNoticeOf | ConfigurationNoticeOf,
  providers: readonly ProviderProfile[] = [],
  accounts?: readonly AccountState[],
) {
  return sharedHandoffDetailRows(notice, {
    text: t as HandoffText,
    providerLabel: (id) => {
      const provider = providers.find((provider) => provider.id === id);
      const source = provider && sourceOf(provider);
      return provider
        ? source
          ? sourceTitle(provider, accounts, t(source.name))
          : provider.displayName
        : id;
    },
  });
}

/**
 * “来源 · 模型”：订阅写软件名，API 写服务的名字；认不出的照原样。同一来源有多个账号时软件名带账号的标签或序号（0.63.0）。
 */
export function modelLabel(
  providers: readonly ProviderProfile[],
  providerId: string,
  modelId: string,
  accounts?: readonly AccountState[],
): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) return modelId;
  const source = sourceOf(provider);
  const model = provider.models.find((candidate) => candidate.id === modelId);
  const name = source ? sourceTitle(provider, accounts, t(source.name)) : provider.displayName;
  return `${name} · ${model?.displayName ?? modelId}`;
}
