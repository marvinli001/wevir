import { routingReason as sharedRoutingReason } from '@wevir/client-sdk';
import {
  type AccountState,
  isExhausted,
  type ProviderProfile,
  type RoutingDecision,
  type RoutingSettings,
  type RoutingTarget,
  rateLimitWindows,
  type WevirEvent,
} from '@wevir/protocol';
import { accountOfProvider, isPickable, sourceOf } from '@/data/sources';
import { t } from '@/i18n';

/**
 * 路由页模型菜单列哪些 Provider：与对话的模型选择一样只列能选的（停用的、订阅没登录或没装的不列）；`keep` 是当前用的，照列。
 */
export function routingMenuProviders<T extends ProviderProfile>(
  providers: readonly T[],
  accounts: readonly AccountState[] | undefined,
  keep?: string,
): T[] {
  return providers.filter((provider) => provider.id === keep || isPickable(provider, accounts));
}

export interface RoutingNode extends RoutingTarget {
  key: string;
  section: 'current' | 'account' | 'backup';
  chainIndex?: number;
  enabled: boolean;
  provider?: ProviderProfile;
  account?: AccountState;
  reason?: string;
}

export function routingNodes(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
  current: RoutingTarget | undefined,
  settings: RoutingSettings,
  now: number,
): RoutingNode[] {
  const provider = providers.find((item) => item.id === current?.providerId);
  const siblings =
    provider && sourceOf(provider)
      ? providers.filter((item) => item.kind === provider.kind && item.id !== provider.id)
      : [];
  const reset = (item: ProviderProfile) => {
    const times = rateLimitWindows(accountOfProvider(item, accounts))
      .map((window) => Date.parse(window.resetsAt ?? ''))
      .filter((time) => time > now);
    return times.length ? Math.min(...times) : Number.POSITIVE_INFINITY;
  };
  if (settings.preferSoonestReset) siblings.sort((a, b) => reset(a) - reset(b));
  const consumed = new Set<number>();
  const node = (
    target: RoutingSettings['chain'][number],
    section: RoutingNode['section'],
    chainIndex?: number,
  ): RoutingNode => {
    const provider = providers.find((item) => item.id === target.providerId);
    const account = provider && accountOfProvider(provider, accounts);
    const modelId = target.modelId ?? provider?.defaultModelId ?? '';
    let reason: string | undefined;
    if (target.enabled === false) reason = 'node_disabled';
    else if (!provider) reason = 'provider_missing';
    else if (provider.enabled === false) reason = 'provider_disabled';
    else if (
      section !== 'current' &&
      current?.providerId === provider.id &&
      current.modelId === modelId
    )
      reason = 'same_model';
    else if (sourceOf(provider) && account?.status !== 'signed_in') reason = 'signed_out';
    else if (isExhausted(account, now)) reason = 'exhausted';
    else if (
      !modelId ||
      (provider.models.length > 0 && !provider.models.some((model) => model.id === modelId))
    )
      reason = 'model_missing';
    return {
      providerId: target.providerId,
      modelId,
      key: section === 'current' ? 'current' : `${section}:${chainIndex ?? target.providerId}`,
      section,
      enabled: target.enabled !== false,
      ...(chainIndex !== undefined && { chainIndex }),
      ...(provider && { provider }),
      ...(account && { account }),
      ...(reason && { reason }),
    };
  };
  return [
    ...(current ? [node(current, 'current')] : []),
    ...siblings.map((provider) => {
      const index = settings.chain.findIndex((item) => item.providerId === provider.id);
      if (index >= 0) consumed.add(index);
      return node(
        settings.chain[index] ?? { providerId: provider.id },
        'account',
        index < 0 ? undefined : index,
      );
    }),
    ...settings.chain.flatMap((target, index) =>
      consumed.has(index) ? [] : [node(target, 'backup', index)],
    ),
  ];
}

export function moveRoutingNode(
  chain: RoutingSettings['chain'],
  from: number,
  to: number,
): RoutingSettings['chain'] {
  if (from === to || to < 0 || to >= chain.length) return chain;
  const next = [...chain];
  const [node] = next.splice(from, 1);
  if (node === undefined) return chain;
  next.splice(to, 0, node);
  return next;
}

export function routingReason(reason: string): string {
  return sharedRoutingReason(reason, t);
}

export function isRoutingSwitch(event: WevirEvent, decision: RoutingDecision): boolean {
  if (event.type !== 'session.handoff' && event.type !== 'session.configured') return false;
  const target =
    event.type === 'session.handoff'
      ? event.payload.to
      : { providerId: decision.from.providerId, modelId: event.payload.modelId };
  return (
    target.providerId === decision.to?.providerId &&
    target.modelId === decision.to.modelId &&
    event.payload.reason === 'usage_limit' &&
    event.payload.failover?.originTurnId === decision.originTurnId &&
    event.payload.failover.attempt === decision.attempt
  );
}
