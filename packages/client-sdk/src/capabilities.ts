import type { ClientCapability, HostFeature, HostFeatures } from '@wevir/protocol';

/**
 * 本版 client-sdk 能理解的全部客户端能力位（ADR-0002 §2、host-api.md §10），在 `host.hello` 里声明。
 * CLI 与桌面直接继承这张表，不各自维护。
 *
 * 穷举：protocol 的 `CLIENT_CAPABILITIES` 每加一个能力位，`satisfies` 就要求这里写上它，否则类型检查
 * 失败。新能力位意味着客户端要能处理它放开的新形状，所以加进来之前先把处理写好。
 * - `title_source_generated`（0.5.0）：`TitleSource` 的 `generated` 只是一个新的来源值，会话列表与消息投影
 *   不按来源分支，照常显示标题。
 * - `provider_kind_chatgpt`（0.7.0）：`ProviderKind` 的 `chatgpt`。CLI 的 `provider list` 与桌面端的 Provider 列表
 *   按 kind 分支的地方都处理了它（没有 Key、没有地址，桌面端在“ChatGPT 账号”一节里显示）。
 * - `subscription_kinds`（0.19.0）：`ProviderKind` 与 `AccountKind` 的订阅来源。CLI 的 `provider list` 写“订阅登录”，桌面端的
 *   表单只管 DeepSeek 官方与 OpenAI 兼容，订阅来源在设置的订阅一节与模型选择里按种类显示。
 */
export const DEFAULT_CLIENT_CAPABILITIES = {
  title_source_generated: true,
  provider_kind_chatgpt: true,
  subscription_kinds: true,
} as const satisfies Record<ClientCapability, true>;

/** Host 是否声明了这项功能（host-api.md §10：客户端只在一处判断，功能内部不写降级路径）。 */
export function hostSupports(features: HostFeatures, feature: HostFeature): boolean {
  return features[feature] === true;
}
