// 进程输出（0.69.0，`process.*`）：客户端看 Host 起的后台进程。两处来源合在一起：Agent 的后台进程（processes.ts，ID `p<n>`）与
// 回合后验证的检查进程（verification/runner.ts，ID `v<n>`）。列表按会话所在的工作区过滤；读输出按字节偏移量分页（去掉控制序列）；
// 停止时 Agent 的进程按所选信号发给进程组，检查的进程等于取消这次检查（`VerificationService.cancelRun`）。不能写 stdin：这不是终端。

import {
  type HostProcess,
  PROCESS_COMMAND_MAX_LENGTH,
  PROCESS_OUTPUT_PAGE_MAX_BYTES,
  type ProcessId,
  type ProcessStopSignal,
  type SessionId,
  type VerificationRunId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { HostError } from './errors.js';
import type { ProcessChange, ProcessInfo, ProcessManager } from './processes.js';

export type ProcessOutputChange =
  | { process: HostProcess }
  | { removed: { id: ProcessId; startedAt: string } };

/** 检查那一侧：检查的进程与取消一次检查。 */
export interface CheckProcesses {
  readonly checkProcesses: ProcessManager;
  cancelRun(sessionId: SessionId, runId: VerificationRunId): boolean;
}

export interface ProcessOutputOptions {
  storage: Storage;
  /** 默认 `process.platform`。 */
  platform?: NodeJS.Platform;
}

const POSIX_SIGNALS: ProcessStopSignal[] = ['SIGINT', 'SIGTERM', 'SIGKILL'];

export class ProcessOutputService {
  readonly #storage: Storage;
  readonly #platform: NodeJS.Platform;
  #agent: ProcessManager | undefined;
  #checks: CheckProcesses | undefined;
  readonly #listeners = new Set<(change: ProcessOutputChange) => void>();

  constructor(options: ProcessOutputOptions) {
    this.#storage = options.storage;
    this.#platform = options.platform ?? process.platform;
  }

  /** Agent 的后台进程（有应用级工具时）。 */
  attachAgent(manager: ProcessManager): void {
    this.#agent = manager;
  }

  /** 回合后验证的检查（验证服务起得来时）。 */
  attachChecks(checks: CheckProcesses): void {
    this.#checks = checks;
  }

  get available(): boolean {
    return this.#agent !== undefined || this.#checks !== undefined;
  }

  /** 交给 `ProcessManager` 的 `onChange`。 */
  onChange(change: ProcessChange): void {
    const mapped: ProcessOutputChange | undefined =
      'process' in change
        ? (() => {
            const process = this.#toHost(change.process);
            return process === undefined ? undefined : { process };
          })()
        : {
            removed: {
              id: change.removed.id,
              startedAt: new Date(change.removed.startedAt).toISOString(),
            },
          };
    if (mapped === undefined) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(mapped);
      } catch {}
    }
  }

  /** 调过 `process.*` 的连接收 `process.changed`。 */
  watch(listener: (change: ProcessOutputChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(filter: { workspaceId?: WorkspaceId; sessionId?: SessionId }): HostProcess[] {
    const all = [
      ...(this.#agent?.listAll() ?? []),
      ...(this.#checks?.checkProcesses.listAll() ?? []),
    ];
    return all
      .flatMap((info) => {
        const process = this.#toHost(info);
        return process === undefined ? [] : [process];
      })
      .filter(
        (process) =>
          (filter.workspaceId === undefined || process.workspaceId === filter.workspaceId) &&
          (filter.sessionId === undefined || process.source.sessionId === filter.sessionId),
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async output(processId: ProcessId, offset?: number, until?: number) {
    const { manager, info } = this.#find(processId);
    const since = offset ?? Math.max(0, (until ?? info.bytes) - PROCESS_OUTPUT_PAGE_MAX_BYTES);
    const read = await manager.read(info.sessionId, info.id, since, until);
    return {
      text: read.text,
      from: read.from,
      next: read.next,
      start: read.start,
      bytes: read.bytes,
      more: read.more,
    };
  }

  /** 停止：Agent 的进程发信号（POSIX 发给进程组，Windows 结束进程树）；检查的进程取消这次检查。不等它退出。 */
  stop(processId: ProcessId, signal: ProcessStopSignal | undefined): HostProcess {
    const { manager, info } = this.#find(processId);
    const current = this.#toHost(info);
    if (current === undefined) throw notFound(processId);
    if (info.status !== 'running') return current;
    const chosen = signal ?? (current.stopSignals.includes('SIGTERM') ? 'SIGTERM' : 'SIGKILL');
    if (!current.stopSignals.includes(chosen)) {
      throw new HostError('INVALID_PARAMS', `process ${processId} cannot be sent ${chosen}`, {
        issues: [{ path: ['signal'], message: `allowed: ${current.stopSignals.join(', ')}` }],
      });
    }
    if (info.check !== undefined) {
      manager.markStopped(info.sessionId, info.id, 'user');
      this.#checks?.cancelRun(info.sessionId, info.check.runId);
    } else {
      manager.signal(info.sessionId, info.id, chosen, 'user');
    }
    return this.#toHost(manager.info(info.sessionId, info.id)) ?? current;
  }

  #find(processId: ProcessId): { manager: ProcessManager; info: ProcessInfo } {
    for (const manager of [this.#agent, this.#checks?.checkProcesses]) {
      const info = manager?.find(processId);
      if (manager !== undefined && info !== undefined && this.#visible(info.sessionId)) {
        return { manager, info };
      }
    }
    throw notFound(processId);
  }

  #visible(sessionId: SessionId): WorkspaceId | undefined {
    const record = this.#storage.sessions.get(sessionId);
    const workspace = record && this.#storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) return undefined;
    return record.workspaceId as WorkspaceId;
  }

  #toHost(info: ProcessInfo): HostProcess | undefined {
    const workspaceId = this.#visible(info.sessionId);
    if (workspaceId === undefined) return undefined;
    const running = info.status === 'running';
    const stopSignals: ProcessStopSignal[] = !running
      ? []
      : info.check !== undefined
        ? ['SIGTERM']
        : this.#platform === 'win32'
          ? ['SIGKILL']
          : POSIX_SIGNALS;
    return {
      id: info.id,
      workspaceId,
      source:
        info.check === undefined
          ? {
              kind: 'agent',
              sessionId: info.sessionId,
              ...(info.turnId !== undefined && { turnId: info.turnId }),
            }
          : {
              kind: 'check',
              sessionId: info.sessionId,
              ...(info.turnId !== undefined && { turnId: info.turnId }),
              runId: info.check.runId,
              checkId: info.check.checkId,
              trigger: info.check.trigger,
            },
      name: info.name.slice(0, 200),
      command: info.command.slice(0, PROCESS_COMMAND_MAX_LENGTH),
      cwd: info.cwd,
      ...(info.pid !== undefined && { pid: info.pid }),
      status: info.status,
      exitCode: info.exitCode,
      signal: info.signal,
      startedAt: new Date(info.startedAt).toISOString(),
      ...(info.endedAt !== undefined && { endedAt: new Date(info.endedAt).toISOString() }),
      bytes: info.bytes,
      ...(info.stoppedBy !== undefined && { stoppedBy: info.stoppedBy }),
      ...(info.error !== undefined && { error: info.error }),
      stopSignals,
    };
  }
}

function notFound(processId: ProcessId): HostError {
  return new HostError('INVALID_PARAMS', `process ${processId} not found`, {
    issues: [{ path: ['processId'], message: 'not found' }],
  });
}
