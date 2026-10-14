// `@wevir/adapter-acp/sdk`：ACP SDK（`@agentclientprotocol/sdk`）原样转出。SDK 只由本包声明、锁定版本
// （ADR-0001 §1，ADR-0005 决策 1.3）；引擎适配器与它们的测试要直接说 ACP 时（例如用 SDK 搭一个假的 Host）从这里取，
// 不再各自声明 SDK。

export * from '@agentclientprotocol/sdk';
