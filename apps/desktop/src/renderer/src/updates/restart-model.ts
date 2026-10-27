// “重启以更新”前的确认（照 Claude Code 桌面端退出时的提示）：重启会中断进行中的会话、停掉后台命令，有这些时先问。

import type { HostProcess, Session } from '@wevir/protocol';

/** 重启会打断的会话：回合在跑（含等回答、取消中）或等审批。 */
export function sessionWorking(session: Pick<Session, 'state'>): boolean {
  return (
    session.state === 'running' ||
    session.state === 'cancelling' ||
    session.state === 'awaiting_approval'
  );
}

export interface RestartBlockers {
  /** 进行中的会话数。 */
  sessions: number;
  /** 有后台命令（Agent 起的命令、预览、检查）在跑的会话数。 */
  processSessions: number;
}

export function restartBlockers(
  sessions: Iterable<Pick<Session, 'state'>>,
  processes: readonly HostProcess[],
): RestartBlockers {
  let working = 0;
  for (const session of sessions) if (sessionWorking(session)) working++;
  const owners = new Set(
    processes.filter((item) => item.status === 'running').map((item) => item.source.sessionId),
  );
  return { sessions: working, processSessions: owners.size };
}

export function blocksRestart(blockers: RestartBlockers): boolean {
  return blockers.sessions > 0 || blockers.processSessions > 0;
}
