import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';

/**
 * Codex 适配器在契约测试（`runAdapterContract`）里声明的能力。逐字增量、工具调用、单进程多会话并发是 app-server 原生
 * 就有的（codex-notes §2.2、§7）；审批与恢复在 R3 实现，之前为 false，对应条款跳过。
 */
export const codexAdapterCapabilities: Readonly<AdapterCapabilities> = Object.freeze({
  incrementalStream: true,
  toolCalls: true,
  approvals: false,
  resume: false,
  concurrentSessions: true,
});
