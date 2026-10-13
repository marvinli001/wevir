import type { ClientCapability, HostFeature, HostFeatures } from '@wevir/protocol';

/**
 * 本版 client-sdk 能理解的全部客户端能力位（ADR-0002 §2、host-api.md §10），在 `host.hello` 里声明。
 * CLI 与桌面直接继承这张表，不各自维护。
 *
 * 穷举：protocol 的 `CLIENT_CAPABILITIES` 每加一个能力位，`satisfies` 就要求这里写上它，否则类型检查
 * 失败。新能力位意味着客户端要能处理它放开的新形状，所以加进来之前先把处理写好。v0 是基线，表为空。
 */
export const DEFAULT_CLIENT_CAPABILITIES = {} as const satisfies Record<ClientCapability, true>;

/** Host 是否声明了这项功能（host-api.md §10：客户端只在一处判断，功能内部不写降级路径）。 */
export function hostSupports(features: HostFeatures, feature: HostFeature): boolean {
  return features[feature] === true;
}
