// 额度用完的卡片上“换模型继续”（0.143.0）的模型列表：同输入框的模型菜单（停用的、订阅没登录的不列，订阅来源在前），额度也用完了
// 的来源排到最后并标出来。会话当前的来源刚碰到上限，总是算用完。

import { type AccountState, isExhausted, type ProviderProfile } from '@wevir/protocol';

export { exhaustionReset, isExhausted } from '@wevir/protocol';

import { accountOfProvider, isPickable, pickerOrder } from '@/data/sources';

/** 换模型继续能选的来源与其中额度用完的：可用的在前，用完的在后，各自保持模型菜单的顺序。 */
export function switchTargets(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
  currentProviderId: string,
  now: number = Date.now(),
): { providers: ProviderProfile[]; exhausted: ReadonlySet<string> } {
  const listed = pickerOrder(
    providers.filter(
      (provider) => provider.id === currentProviderId || isPickable(provider, accounts),
    ),
  );
  const exhausted = new Set(
    listed
      .filter(
        (provider) =>
          provider.id === currentProviderId ||
          isExhausted(accountOfProvider(provider, accounts), now),
      )
      .map((provider) => provider.id),
  );
  return {
    providers: [
      ...listed.filter((provider) => !exhausted.has(provider.id)),
      ...listed.filter((provider) => exhausted.has(provider.id)),
    ],
    exhausted,
  };
}

/** 新会话换源：优先选同类的另一个账号，再按模型菜单的顺序。 */
export function quotaAlternative(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
  currentProviderId: string,
  now = Date.now(),
): ProviderProfile | undefined {
  const current = providers.find((provider) => provider.id === currentProviderId);
  const available = pickerOrder(
    providers.filter(
      (provider) =>
        provider.id !== currentProviderId &&
        isPickable(provider, accounts) &&
        !isExhausted(accountOfProvider(provider, accounts), now),
    ),
  );
  return available.find((provider) => provider.kind === current?.kind) ?? available[0];
}
