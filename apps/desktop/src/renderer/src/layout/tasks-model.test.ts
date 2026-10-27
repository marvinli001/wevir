import type { HostProcess, SessionId, SubagentSummary } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { clearMark, groupTasks, taskKey, withoutCleared } from './tasks-model';

const T0 = Date.parse('2026-10-27T08:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function child(n: number, extra: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    sessionId: `ses_01JA2B3C4D5E6F7G8H9JKMNP0${n}` as SessionId,
    parentToolCallId: `call_spawn_${n}`,
    title: `Agent ${n}`,
    modelId: 'deepseek-chat',
    status: 'running',
    startedAt: at(n),
    pendingApprovals: [],
    ...extra,
  };
}

function proc(n: number, extra: Partial<HostProcess> = {}): HostProcess {
  return {
    id: `p${n}`,
    workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
    source: { kind: 'agent', sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
    name: `Process ${n}`,
    command: 'pnpm dev',
    cwd: '/p',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: at(n),
    bytes: 0,
    stopSignals: ['SIGINT', 'SIGTERM', 'SIGKILL'],
    ...extra,
  } as HostProcess;
}

const names = (items: ReturnType<typeof groupTasks>['open']) =>
  items.map((item) => (item.kind === 'subagent' ? item.summary.title : item.process.name));

describe('后台任务的列表', () => {
  it('子智能体与后台进程合在一起：进行中按开始、已完成按结束，从新到旧', () => {
    const { open, done } = groupTasks(
      [child(1), child(2, { status: 'completed', endedAt: at(40) })],
      [
        proc(3),
        proc(4, { status: 'exited', exitCode: 0, endedAt: at(30), stopSignals: [] }),
        proc(5, { status: 'exited', exitCode: 1, endedAt: at(50), stopSignals: [] }),
      ],
    );
    expect(names(open)).toEqual(['Process 3', 'Agent 1']);
    expect(names(done)).toEqual(['Process 5', 'Agent 2', 'Process 4']);
  });

  it('进程的身份带启动时刻，子智能体的是会话 ID', () => {
    const [item] = groupTasks([], [proc(1)]).open;
    expect(item && taskKey(item)).toBe(`process:p1@${at(1)}`);
    const [agent] = groupTasks([child(1)], []).open;
    expect(agent && taskKey(agent)).toBe(`subagent:${child(1).sessionId}`);
  });

  it('清除已完成：只藏清除时已结束的，运行中的与之后结束的照常列出', () => {
    const before = groupTasks(
      [child(1, { status: 'completed', endedAt: at(30) }), child(3)],
      [proc(2, { status: 'exited', exitCode: 0, endedAt: at(50), stopSignals: [] })],
    );
    const mark = clearMark([...before.open, ...before.done]);
    expect(mark).toBe(at(50));
    const cleared = withoutCleared(before, mark);
    expect(names(cleared.open)).toEqual(['Agent 3']);
    expect(cleared.done).toEqual([]);
    const after = groupTasks(
      [
        child(1, { status: 'completed', endedAt: at(30) }),
        child(3, { status: 'failed', endedAt: at(80) }),
      ],
      [proc(2, { status: 'exited', exitCode: 0, endedAt: at(50), stopSignals: [] })],
    );
    expect(names(withoutCleared(after, mark).done)).toEqual(['Agent 3']);
    expect(withoutCleared(before, undefined)).toBe(before);
    expect(clearMark(before.open)).toBeUndefined();
  });
});
