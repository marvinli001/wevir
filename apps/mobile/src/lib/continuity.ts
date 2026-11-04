import { type ContinuityNotice, type HandoffDetailRow, handoffDetailRows } from '@wevir/client-sdk';
import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { locale, t } from '../i18n';
import { providerTitle } from './new-session';

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
      from: providerLabel(from.providerId),
      to: providerLabel(to.providerId),
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
