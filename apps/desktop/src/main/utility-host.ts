// 以 Electron 的 utility process 跑 Host（ADR-0007 补记 10）：活动监视器与任务管理器里它归在 Wevir 名下（serviceName），
// 生命周期由 Electron 管，Host 不再靠 `ELECTRON_RUN_AS_NODE` 启动。
//
// - utility process 没有 stdin 管道，归属管道（--exit-on-stdin-eof）用不上：退出时经 parentPort 发
//   `PARENT_SHUTDOWN_MESSAGE`，Host 随即优雅退出。
// - 主进程崩溃或被强制结束时 Electron 直接结束 utility process，Host 来不及走退出流程（同 Windows 上 job object 的
//   结果）：留下的 host.json 是陈旧的，下次启动按陈旧处理；引擎子进程的 stdin 随之关闭，各自退出。
// - `fork` 只能在 app ready 之后调用：拉起前先等它。附着已有 Host 的探活不等。
// - macOS 上 utility process 是 `Wevir Helper`，Host 的 `process.execPath` 也就是它；Host 用它跑脚本时带
//   `ELECTRON_RUN_AS_NODE=1`，Helper 同样认。

import { PARENT_SHUTDOWN_MESSAGE } from '@wevir/host/runtime';
import { app, utilityProcess } from 'electron';
import type { HostChild, HostSpawner } from './host-lifecycle.js';

/** 活动监视器、`app.getAppMetrics()` 与 `child-process-gone` 里 Host 的名字。 */
export const HOST_SERVICE_NAME = 'Wevir Host';

export function utilityHostSpawner(): HostSpawner {
  return {
    executable: 'utilityProcess',
    spawn: async (entry, args, env) => {
      await app.whenReady();
      const proc = utilityProcess.fork(entry, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        serviceName: HOST_SERVICE_NAME,
      });
      // utility process 的 exit 只给退出码（waitpid / GetExitCodeProcess），没有信号。
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => proc.once('exit', (code) => resolveExit({ code, signal: null })),
      );
      // spawn 之后才有 pid；起不来时只有 exit。
      await Promise.race([
        new Promise<void>((resolveSpawn) => proc.once('spawn', () => resolveSpawn())),
        exited,
      ]);
      const pid = proc.pid;
      const child: HostChild = {
        pid,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited,
        spawnError: () => undefined,
        requestExit: () => proc.postMessage(PARENT_SHUTDOWN_MESSAGE),
        // `proc.kill()` 在 POSIX 上是 SIGTERM（Host 当成优雅退出）；强制结束要 SIGKILL，Windows 上 process.kill 是
        // TerminateProcess。
        kill: () => {
          if (pid === undefined) return;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // 已经退出。
          }
        },
      };
      return child;
    },
  };
}
