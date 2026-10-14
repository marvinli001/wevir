import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';

/**
 * Codex 适配器在契约测试（`runAdapterContract`）里声明的能力：逐字增量、工具调用、单进程多会话并发是 app-server 原生
 * 就有的（codex-notes §2.2、§7），审批与恢复是 R3 实现的（codex-event-mapping.md §4、§6.6），子会话是 R4 实现的
 * （§6.5），插话（`turn/steer`）是 R11 实现的（§4.5）。全部打开。
 */
export const codexAdapterCapabilities: Readonly<AdapterCapabilities> = Object.freeze({
  incrementalStream: true,
  toolCalls: true,
  approvals: true,
  resume: true,
  concurrentSessions: true,
  subagents: true,
  steer: true,
});
