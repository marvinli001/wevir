// 输入框的计划模式开关（0.36.0，desktop-tokens §49）：按草稿归属（会话 ID，或新会话草稿的工作区）留在内存里，切走再切回来
// 还在，不持久化。没动过开关的会话按它最近一条消息的模式（`Session.collaborationMode`）。模式随每条消息发出
// （`session.send` 的 `collaborationMode`），不是会话的设置。

import { planModeSupported } from '@wevir/client-sdk';
import type { ProviderProfile } from '@wevir/protocol';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { engineFeaturesOf } from './handoff-model';

const choices = new Map<string, boolean>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 记下一个草稿的开关（发出消息时也记，之后以发出的为准）。 */
export function setPlanMode(draftKey: string, active: boolean): void {
  if (choices.get(draftKey) === active) return;
  choices.set(draftKey, active);
  for (const listener of listeners) listener();
}

/** 草稿的开关；没动过时是 `fallback`。 */
export function planModeOf(draftKey: string, fallback: boolean): boolean {
  return choices.get(draftKey) ?? fallback;
}

/** 输入框用的开关：`[开着, 改]`。 */
export function usePlanMode(
  draftKey: string,
  fallback: boolean,
): [boolean, (active: boolean) => void] {
  const active = useSyncExternalStore(subscribe, () => planModeOf(draftKey, fallback));
  const set = useCallback((next: boolean) => setPlanMode(draftKey, next), [draftKey]);
  return [active, set];
}

/** 一个输入框的计划模式：能不能用、开没开、开关；发消息时带的模式（只在开着时是 `plan`）。 */
export interface PlanControl {
  supported: boolean;
  active: boolean;
  toggle: () => void;
  set: (active: boolean) => void;
  /** `session.send` 的 `collaborationMode`：能用且开着时是 `plan`。 */
  mode: 'plan' | undefined;
}

/**
 * 按 Provider 所在的引擎判断能不能用计划模式（Host 有 `plan_mode`，`engineFeatures` 的 `planMode`，client-sdk 的
 * `planModeSupported`）：已有会话看它当前的 Provider（接力后跟着变），新会话看选的模型。不能用时开关不起作用，也不显示。
 */
export function usePlanControl(
  draftKey: string,
  providers: readonly ProviderProfile[],
  providerId: string | undefined,
  fallback = false,
): PlanControl {
  const { view } = useHostConnection();
  const supported =
    view.status === 'connected' &&
    providerId !== undefined &&
    planModeSupported(
      view.hello.features,
      engineFeaturesOf(view.hello.engineFeatures, providers, providerId),
    );
  const [stored, set] = usePlanMode(draftKey, fallback);
  const active = supported && stored;
  return useMemo(
    () => ({
      supported,
      active,
      toggle: () => set(!active),
      set,
      mode: active ? ('plan' as const) : undefined,
    }),
    [supported, active, set],
  );
}
