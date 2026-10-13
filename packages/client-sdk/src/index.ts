// Wevir Host 的 TypeScript 客户端（T4.1）：浏览器与 Node 共用的入口，只依赖 @wevir/protocol，不 import
// Node 内置模块（ADR-0002 §7）。读取 run/host.json 的功能在 `@wevir/client-sdk/node`。

export * from './capabilities.js';
export * from './client.js';
export * from './errors.js';
export { type BackoffOptions, DEFAULT_BACKOFF, type ReconnectReason } from './lifecycle.js';
export type { EventSubscription, SubscribeOptions, SubscriptionItem } from './subscription.js';
export * from './transport.js';
