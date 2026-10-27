import type { HostProcess, Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { blocksRestart, restartBlockers } from './restart-model';

const session = (state: Session['state']) => ({ state });
const process = (sessionId: string, status: HostProcess['status']) =>
  ({ status, source: { kind: 'agent', sessionId } }) as HostProcess;

describe('restartBlockers', () => {
  it('回合在跑、取消中、等审批的会话算进行中，空闲、出错、关闭的不算', () => {
    const blockers = restartBlockers(
      [
        session('running'),
        session('cancelling'),
        session('awaiting_approval'),
        session('idle'),
        session('error'),
        session('closed'),
      ],
      [],
    );
    expect(blockers).toEqual({ sessions: 3, processSessions: 0 });
    expect(blocksRestart(blockers)).toBe(true);
  });

  it('后台命令按会话计数，只算还在运行的', () => {
    const blockers = restartBlockers(
      [session('idle')],
      [process('a', 'running'), process('a', 'running'), process('b', 'exited')],
    );
    expect(blockers).toEqual({ sessions: 0, processSessions: 1 });
    expect(blocksRestart(blockers)).toBe(true);
  });

  it('都没有时不拦', () => {
    expect(blocksRestart(restartBlockers([session('idle')], [process('a', 'exited')]))).toBe(false);
  });
});
