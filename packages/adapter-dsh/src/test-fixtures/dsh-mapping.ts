// dsh 配置下的通用 ACP 映射与会话队列：DshAdapter 经 AcpAdapter 按 DSH_ENGINE 映射、排队，这里把同样的东西绑上
// DSH_ENGINE，给直接回放 dsh 样本的测试用（映射与快照、增量对齐、acp-event-mapping.md 的对照）。

import {
  SessionEventQueue as AcpSessionEventQueue,
  type AcpSessionNotification,
  mapAcpUpdate as mapAcpUpdateWith,
  type OnRawUpdate,
  sessionConfigInfo as sessionConfigInfoWith,
  type WarnOnce,
} from '@wevir/adapter-acp';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { DSH_ENGINE } from '../engine.js';
import type { StreamTapEvent } from '../stream-tap.js';

export function mapAcpUpdate(
  notification: AcpSessionNotification,
  onRaw?: OnRawUpdate,
): AgentEvent[] {
  return mapAcpUpdateWith(notification, DSH_ENGINE.tools, onRaw);
}

export function sessionConfigInfo(configOptions: unknown): {
  modelId?: string;
  reasoningEffort?: string;
} {
  return sessionConfigInfoWith(configOptions, DSH_ENGINE.route);
}

export class SessionEventQueue extends AcpSessionEventQueue {
  constructor(engineSessionId: string, warnOnce: WarnOnce) {
    super(engineSessionId, warnOnce, DSH_ENGINE);
  }

  /** stream-tap 的增量（通用队列的 `incremental`）。 */
  streamTap(event: StreamTapEvent): void {
    this.incremental(event);
  }
}
