import type { AcpEngine, AcpRouteCodec } from '@wevir/adapter-acp';
import { DeltaMerger } from './delta-merge.js';
import { STREAM_FD } from './env.js';
import { DSH_VERSION } from './paths.js';
import { classifyResumeError } from './resume-error.js';
import { STREAM_TAP_READY_GRACE_MS, StreamTapDecoder } from './stream-tap.js';
import { parseTodoItems, TODO_TOOL, toolDisplay } from './tool-display.js';
import { classifyTurnError } from './turn-error.js';

/**
 * dsh 的会话路由：模型选项 `model` 的值是 JSON 编码的 `["<provider>","<model>"]`（上游
 * `dsh-acp/src/model-control.ts`，T0.3 §3.2），推理强度是 `reasoning_effort`（T3.4，providers.md §2.2）。
 */
export const DSH_ROUTE: AcpRouteCodec = Object.freeze<AcpRouteCodec>({
  modelOption: 'model',
  reasoningEffortOption: 'reasoning_effort',
  encode: (providerId, modelId) => JSON.stringify([providerId, modelId]),
  decodeModel: (value) => {
    try {
      const route: unknown = JSON.parse(value);
      return Array.isArray(route) && typeof route[1] === 'string' ? route[1] : undefined;
    } catch {
      // 不是 dsh 的路由编码：不报模型，Host 用请求值。
      return undefined;
    }
  },
});

/**
 * dsh 的引擎描述（ADR-0005 决策 1.3）：通用 ACP 适配器（`@wevir/adapter-acp`）按它驱动 dsh。可执行入口、参数与
 * 环境随数据目录和 Provider 配置变化，在 `DshProcess` 的启动器里（dsh-process.ts）。对照表见
 * docs/architecture/acp-event-mapping.md 第二部分。
 */
export const DSH_ENGINE: AcpEngine = Object.freeze<AcpEngine>({
  name: 'dsh',
  version: DSH_VERSION,
  // ACP 路径本身的能力，与旁路无关（T0.3 实测）：工具调用（场景 A）、审批（B / C / D）、close 之后 resume
  // （§3.2、场景 H）、单进程多会话并发（§10）。
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  // dsh 的 `kind` 恒为 `other`、没有 `locations`：展示类型按工具名取（tool-display.ts）。
  tools: {
    display: (toolName, rawInput) => toolDisplay(toolName, rawInput),
    todos: (toolName, rawInput) => (toolName === TODO_TOOL ? parseTodoItems(rawInput) : undefined),
  },
  route: DSH_ROUTE,
  classifyTurnError,
  classifyResumeError,
  // ACP 只有已提交消息，逐字增量走 stream-tap 插件写的 fd 3（T3.2a，ADR-0001 §3）。
  incremental: {
    name: 'stream-tap 插件',
    fd: STREAM_FD,
    readyGraceMs: STREAM_TAP_READY_GRACE_MS,
    createDecoder: (handlers) => new StreamTapDecoder(handlers),
    createMerger: () => new DeltaMerger(),
  },
});
