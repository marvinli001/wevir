// Local Agent Host（SKELETON_PLAN §4.1）。目前是事件库与会话快照（T2.2）、会话管理器（T2.3）、
// WebSocket JSON-RPC 服务与 Host API 方法（T2.4）；进程入口在 T2.5 加入。

export * from './errors.js';
export type { EventListener } from './event-bus.js';
export * from './event-store.js';
export * from './host-methods.js';
export * from './ids.js';
export { adaptEventForClient, InvalidResultError } from './rpc-connection.js';
export * from './rpc-server.js';
export * from './session-manager.js';
export * from './snapshot.js';
export * from './truncate.js';
