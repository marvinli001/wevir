// 自动更新在界面上的取舍（ADR-0007 补记 4），纯逻辑：侧栏左下角显示什么、下载完了能不能直接重启。

import type { Session } from '@wevir/protocol';
import type { UpdateState } from '../../../shared/desktop-api.js';

/** 侧栏左下角的更新入口；undefined 时不显示（没有新版本、更新关闭、正在检查）。 */
export type UpdateEntry =
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  /** 下载好了，有回合在跑：等用户点。 */
  | { kind: 'restart'; version: string }
  | { kind: 'installing'; version: string }
  /** 下载或安装失败：点了重新检查。只在已经发现过新版本时显示，连不上服务器不打扰。 */
  | { kind: 'failed'; version: string };

export function updateEntry(
  state: UpdateState | undefined,
  busy: boolean,
): UpdateEntry | undefined {
  if (state === undefined) return undefined;
  switch (state.phase) {
    case 'available':
      return { kind: 'available', version: state.version };
    case 'downloading':
      return { kind: 'downloading', version: state.version, percent: Math.floor(state.percent) };
    case 'downloaded':
      // 没有回合在跑时渲染进程会直接安装（shouldInstallNow），这一刻也显示成“正在安装”，不闪一下“重启以更新”。
      return busy
        ? { kind: 'restart', version: state.version }
        : { kind: 'installing', version: state.version };
    case 'installing':
      return { kind: 'installing', version: state.version };
    case 'error':
      return state.version !== undefined && (state.code === 'download' || state.code === 'install')
        ? { kind: 'failed', version: state.version }
        : undefined;
    default:
      return undefined;
  }
}

/** 下载完、没有回合在跑（含等审批、等回答）时直接安装并重启；有的话等用户点“重启以更新”，不打断 Agent。 */
export function shouldInstallNow(state: UpdateState | undefined, busy: boolean): boolean {
  return state?.phase === 'downloaded' && !busy;
}

/** 有没有会话的回合还没结束：运行中、取消中、等审批。 */
export function hasActiveTurn(sessions: Iterable<Session>): boolean {
  for (const session of sessions) {
    if (
      session.state === 'running' ||
      session.state === 'cancelling' ||
      session.state === 'awaiting_approval'
    ) {
      return true;
    }
  }
  return false;
}
