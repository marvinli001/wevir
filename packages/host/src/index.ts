// Local Agent Host（SKELETON_PLAN §4.1）：事件库与会话快照（T2.2）、会话管理器（T2.3）、
// WebSocket JSON-RPC 服务与 Host API 方法（T2.4）、进程组装与运行时文件（T2.5）。可执行入口
// `wevir-host` 是 src/main.ts，不从这里导出。

export * from './approval-rules/service.js';
export * from './errors.js';
export type { EventListener } from './event-bus.js';
export * from './event-store.js';
export * from './home.js';
export * from './host-methods.js';
export * from './host-process.js';
export * from './ids.js';
export * from './logger.js';
export { adaptEventForClient, InvalidResultError } from './rpc-connection.js';
export * from './rpc-server.js';
export * from './runtime-file.js';
export * from './session-manager.js';
export * from './session-search.js';
export * from './snapshot.js';
export * from './truncate.js';
export { WebService, type WebServiceOptions } from './web/service.js';
