import {
  type AccountState,
  isExhausted,
  ROUTING_MAX_ATTEMPTS,
  type RoutingDecision,
  type RoutingSettings,
  type RoutingTarget,
  rateLimitWindows,
  SUBSCRIPTION_KINDS,
  type TurnId,
} from '@wevir/protocol';
import type { ProviderProfileRecord } from '@wevir/storage';
import type { RoutingState } from './snapshot.js';

export function decideRouting(input: {
  settings: RoutingSettings;
  providers: readonly ProviderProfileRecord[];
  account: (providerId: string) => AccountState | undefined;
  from: RoutingTarget;
  turnId: TurnId;
  previous: RoutingState | undefined;
  now: number;
}): RoutingDecision {
  const { settings, providers, account, from, turnId, previous, now } = input;
  const current = providers.find((provider) => provider.id === from.providerId);
  const subscription = (kind: string) =>
    kind === 'chatgpt' || (SUBSCRIPTION_KINDS as readonly string[]).includes(kind);
  const siblings = subscription(current?.kind ?? '')
    ? providers.filter(
        (provider) => provider.kind === current?.kind && provider.id !== from.providerId,
      )
    : [];
  const reset = (id: string) => {
    const times = rateLimitWindows(account(id))
      .map((window) => Date.parse(window.resetsAt ?? ''))
      .filter((time) => time > now);
    return times.length ? Math.min(...times) : Number.POSITIVE_INFINITY;
  };
  if (settings.preferSoonestReset) siblings.sort((a, b) => reset(a.id) - reset(b.id));
  const priority = siblings.map(
    (provider) =>
      settings.chain.find((node) => node.providerId === provider.id) ?? { providerId: provider.id },
  );
  const candidates = [...priority, ...settings.chain.filter((node) => !priority.includes(node))];
  const decision: RoutingDecision = {
    turnId,
    originTurnId: previous?.originTurnId ?? turnId,
    attempt: previous?.attempt ?? 0,
    from,
    to: null,
    skipped: [],
    at: new Date(now).toISOString(),
  };
  for (const node of candidates) {
    const provider = providers.find((candidate) => candidate.id === node.providerId);
    const modelId = node.modelId ?? provider?.defaultModelId;
    const state = account(node.providerId);
    let reason: string | undefined;
    if (decision.attempt >= ROUTING_MAX_ATTEMPTS) reason = 'attempt_limit';
    else if (node.enabled === false) reason = 'node_disabled';
    else if (provider === undefined) reason = 'provider_missing';
    else if (provider.enabled === false) reason = 'provider_disabled';
    else if (previous?.visited.includes(node.providerId)) reason = 'visited';
    else if (node.providerId === from.providerId && modelId === from.modelId) reason = 'same_model';
    else if (subscription(provider.kind) && state?.status !== 'signed_in') reason = 'signed_out';
    else if (isExhausted(state, now)) reason = 'exhausted';
    else if (
      !modelId ||
      ((provider.models as { id: string }[]).length > 0 &&
        !(provider.models as { id: string }[]).some((model) => model.id === modelId))
    )
      reason = 'model_missing';
    if (reason !== undefined) {
      decision.skipped.push({ providerId: node.providerId, reason });
      continue;
    }
    decision.to = { providerId: node.providerId, modelId: modelId as string };
    decision.attempt += 1;
    break;
  }
  return decision;
}
