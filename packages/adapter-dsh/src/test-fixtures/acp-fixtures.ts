// 测试读 ACP 样本的工具（样本来源见同目录 README.md）。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { isAcpSessionNotification } from '../acp-mapping.js';
import { SessionEventQueue, type WarnOnce } from '../session-events.js';
import { classifyTurnError } from '../turn-error.js';

export const ACP_FIXTURES = fileURLToPath(new URL('./acp/', import.meta.url));

/** `acp/` 下全部样本的相对路径（`/` 分隔），排好序。 */
export function fixtureFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ACP_FIXTURES, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

export function readFixture<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(ACP_FIXTURES, rel), 'utf8')) as T;
}

export interface TranscriptLine {
  /** 相对录制开始的毫秒数。 */
  t: number;
  /** c2a：客户端 → dsh；a2c：dsh → 客户端。 */
  dir: 'c2a' | 'a2c';
  msg: {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
}

export function readTranscript(rel: string): TranscriptLine[] {
  return readFileSync(join(ACP_FIXTURES, rel), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptLine);
}

/**
 * 按 DshAdapter 的路径回放一份录制：`session/prompt` 请求开回合，dsh 写出的 `session/update` 按顺序交给会话
 * 队列，`session/prompt` 的结果或错误结束回合。返回每个会话的事件（按 sessionId）与告警。
 * `session/request_permission` 属于 T3.3，回放里不处理。
 */
export async function replayTranscript(
  lines: readonly TranscriptLine[],
): Promise<{ events: Record<string, AgentEvent[]>; warnings: string[] }> {
  const warnings: string[] = [];
  const warnOnce: WarnOnce = (key) => void warnings.push(key);
  const queues = new Map<string, SessionEventQueue>();
  const iterators = new Map<string, AsyncIterableIterator<AgentEvent>>();
  const queue = (sessionId: string) => {
    let q = queues.get(sessionId);
    if (q === undefined) {
      q = new SessionEventQueue(sessionId, warnOnce);
      queues.set(sessionId, q);
      iterators.set(sessionId, q.subscribe());
    }
    return q;
  };
  const prompts = new Map<number | string, string>();
  for (const { dir, msg } of lines) {
    if (dir === 'c2a' && msg.method === 'session/prompt' && msg.id !== undefined) {
      const sessionId = (msg.params as { sessionId: string }).sessionId;
      prompts.set(msg.id, sessionId);
      queue(sessionId).beginTurn();
    } else if (dir === 'a2c' && msg.method === 'session/update') {
      if (!isAcpSessionNotification(msg.params)) throw new Error('样本里有畸形的 session/update');
      queue(msg.params.sessionId).acpUpdate(msg.params);
    } else if (dir === 'a2c' && msg.method === undefined && msg.id !== undefined) {
      const engineSessionId = prompts.get(msg.id);
      if (engineSessionId === undefined) continue;
      if (msg.error !== undefined) {
        queue(engineSessionId).endTurn({
          type: 'turn.failed',
          engineSessionId,
          ...classifyTurnError(msg.error),
        });
      } else {
        const { stopReason } = msg.result as { stopReason: string };
        queue(engineSessionId).endTurn({
          type: 'turn.settled',
          engineSessionId,
          outcome: stopReason === 'cancelled' ? 'cancelled' : 'completed',
          stopReason,
        });
      }
    }
  }
  const events: Record<string, AgentEvent[]> = {};
  for (const [sessionId, q] of queues) {
    q.end();
    const list: AgentEvent[] = [];
    for await (const event of iterators.get(sessionId) as AsyncIterableIterator<AgentEvent>) {
      list.push(event);
    }
    events[sessionId] = list;
  }
  return { events, warnings };
}
