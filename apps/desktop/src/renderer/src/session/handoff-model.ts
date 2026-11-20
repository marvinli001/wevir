// 接力（0.25.0，domain-model §3.14）的纯逻辑：已有会话能换到哪些来源、当前的引擎能做什么、切换处那一行写什么。

import {
  type ConfigurationNoticeOf,
  type HandoffNoticeOf,
  type HandoffText,
  handoffDetailRows as sharedHandoffDetailRows,
} from '@wevir/client-sdk';
import type { AccountState, EngineFeatures, ProviderProfile } from '@wevir/protocol';
import { accountSuffix, sourceOf, sourceTitle } from '@/data/sources';
import { t } from '@/i18n';

/** 一个 Provider 的会话由哪个引擎跑、能做什么（`host.hello` 的 `engineFeatures`，按种类）；旧 Host 没有。 */
export function engineFeaturesOf(
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
  providers: readonly ProviderProfile[],
  providerId: string,
): EngineFeatures | undefined {
  const kind = providers.find((provider) => provider.id === providerId)?.kind;
  return kind === undefined ? undefined : engineFeatures?.[kind];
}

export { canHandoffTo } from '@wevir/client-sdk';

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
