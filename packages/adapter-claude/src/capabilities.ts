import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';

/**
 * Claude 适配器在契约测试（`runAdapterContract`）里声明的能力（claude-event-mapping.md §7）：逐字增量（`stream_event`）、
 * 工具调用、审批（`canUseTool`）、恢复（`resume`）、每个会话一个进程所以可以并发、子 agent（Agent 工具）与插话（排在当前
 * 这一步之后的用户消息）都有。
 */
export const claudeAdapterCapabilities: Readonly<AdapterCapabilities> = Object.freeze({
  incrementalStream: true,
  toolCalls: true,
  approvals: true,
  resume: true,
  concurrentSessions: true,
  subagents: true,
  steer: true,
});
