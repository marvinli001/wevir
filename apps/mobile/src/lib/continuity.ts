import {
  type ContinuityNotice,
  canHandoffTo,
  type HandoffDetailRow,
  handoffDetailRows,
} from '@wevir/client-sdk';
import type { AccountState, ProviderProfile, Session } from '@wevir/protocol';
import { locale, t } from '../i18n';
import {
  modelName,
  modelsOf,
  type NewSessionClient,
  pickableProviders,
  providerTitle,
} from './new-session';

export function quotaModels(
  session: Session,
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
  client: NewSessionClient,
) {
  return pickableProviders(providers, accounts).flatMap((provider) => {
    const same = provider.id === session.providerId;
    if (
      same
        ? !client.supports('session_configure')
        : !client.supports('session_handoff') ||
          !canHandoffTo(provider, session, client.engineFeatures)
    )
      return [];
    return modelsOf(provider)
      .filter((model) => !same || model.id !== session.modelId)
      .map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        label: `${providerTitle(provider, accounts)} · ${modelName(model)}`,
      }));
  });
}

export function continuityView(
  notice: ContinuityNotice,
  providers: readonly ProviderProfile[],
  accounts?: readonly AccountState[],
) {
  const from =
    notice.kind === 'handoff'
      ? { providerId: notice.fromProviderId, modelId: notice.fromModelId }
      : notice.from;
  const to =
    notice.kind === 'handoff'
      ? { providerId: notice.providerId, modelId: notice.modelId }
      : notice.to;
  const providerLabel = (id: string) => {
    const provider = providers.find((provider) => provider.id === id);
    return provider ? providerTitle(provider, accounts) : id;
  };
  // 同一个来源里换模型：两端写模型名（写来源名就成了“Codex → Codex”）；只换了速度时快速的一端加“快速”。
  const speedChanged =
    notice.kind === 'configured' && (notice.from.fast === true) !== (notice.to.fast === true);
  const modelOnly = (target: { providerId: string; modelId: string; fast?: boolean }) => {
    const name =
      providers
        .find((provider) => provider.id === target.providerId)
        ?.models.find((model) => model.id === target.modelId)?.displayName ?? target.modelId;
    return speedChanged && target.fast === true ? `${name} · ${t('model.speed.fast')}` : name;
  };
  const sameSource = from.providerId === to.providerId;
  const rows: HandoffDetailRow[] = [
    {
      key: 'target',
      label: t('handoff.detail.target'),
      value: modelLabel(providers, to, accounts),
    },
    { key: 'from', label: t('handoff.detail.from'), value: modelLabel(providers, from, accounts) },
    ...handoffDetailRows(notice, { text: t, providerLabel }),
  ];
  return {
    label: t('handoff.transition', {
      from: sameSource ? modelOnly(from) : providerLabel(from.providerId),
      to: sameSource ? modelOnly(to) : providerLabel(to.providerId),
    }),
    from: providers.find((provider) => provider.id === from.providerId),
    to: providers.find((provider) => provider.id === to.providerId),
    rows,
  };
}

export function modelLabel(
  providers: readonly ProviderProfile[],
  target: { providerId: string; modelId: string },
  accounts?: readonly AccountState[],
): string {
  const provider = providers.find((provider) => provider.id === target.providerId);
  if (!provider) return `${target.providerId} · ${target.modelId}`;
  const model = provider.models.find((model) => model.id === target.modelId);
  return `${providerTitle(provider, accounts)} · ${model?.displayName ?? target.modelId}`;
}

export function clockLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })} ${time}`;
}
