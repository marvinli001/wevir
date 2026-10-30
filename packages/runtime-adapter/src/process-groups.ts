// 子进程组的登记（host/src/process-groups.ts）：Host 与引擎适配器在 POSIX 上以 detached 起的长时间运行的子进程（后台进程、预览、
// 检查、安装、语言服务器、引擎）在这里报给 Host 的登记表，Host 被强行结束时由看门狗结束它们，下次启动时回收还活着的。适配器
// 由 Host 之外的代码创建，所以经这个进程内的钩子，而不是构造参数；没有 Host 设置钩子（单独的适配器测试）时什么都不做。

import type { ChildProcess } from 'node:child_process';

export interface ProcessGroupInfo {
  /** 谁起的：`process`（后台进程）、`preview`、`check`、`install`、`lsp`、`engine`。 */
  kind: string;
  /** 显示名（日志里看）。 */
  name: string;
  sessionId?: string;
  /** Host 里的记录 ID（后台进程的 `p3`）。 */
  ownerId?: string;
  command?: string;
  cwd?: string;
  /** 后台进程的日志文件（重启后把它记成被中断时用）。 */
  logPath?: string;
}

export interface ProcessGroupTracker {
  /** `child` 是刚以 detached 起的组长；它关闭（`close`）时登记自动撤掉。 */
  track(child: ChildProcess, info: ProcessGroupInfo): void;
}

let current: ProcessGroupTracker | undefined;

/** Host 启动时设置；已有一个时不换（同一进程里的多个测试 Host 只有第一个登记）。返回撤销的函数。 */
export function setProcessGroupTracker(tracker: ProcessGroupTracker): () => void {
  if (current !== undefined) return () => {};
  current = tracker;
  return () => {
    if (current === tracker) current = undefined;
  };
}

/** 登记一个刚起的、自成进程组的子进程。Windows 上不登记（没有进程组，见 host 的 process-groups.ts）。 */
export function trackProcessGroup(child: ChildProcess, info: ProcessGroupInfo): void {
  if (process.platform === 'win32' || child.pid === undefined) return;
  current?.track(child, info);
}
