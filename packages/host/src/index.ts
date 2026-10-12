// Local Agent Host（SKELETON_PLAN §4.1）。目前是事件库与会话快照（T2.2）；会话管理器、RPC 服务、
// 进程入口依次在 T2.3–T2.5 加入。

export type { EventListener } from './event-bus.js';
export * from './event-store.js';
export * from './snapshot.js';
export * from './truncate.js';
