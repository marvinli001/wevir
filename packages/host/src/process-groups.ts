// 子进程组的登记与回收（POSIX）：Host 以 detached 起的长时间运行的子进程（后台进程、预览、检查、安装、语言服务器、引擎，经
// runtime-adapter 的 `trackProcessGroup` 报来）各自是一个进程组的组长。Host 正常退出时各自的服务结束它们；Host 被强行结束
// （崩溃、SIGKILL、桌面主进程崩溃时被直接结束）时它们会留下来，所以：
//
// - 看门狗：第一次登记时起一个 `/bin/sh` 小脚本（自成进程组），Host 经它的 stdin 逐行报 `+ <组号>` / `- <组号>`。Host 正常
//   关闭时发 `q` 让它直接退出；Host 死掉时 stdin 读到 EOF，它给记着的组发 SIGTERM，宽限后 SIGKILL。不用原生模块。
// - 登记文件：每个组一个 `<数据目录>/process-groups/<组号>.json`（组号、组长的启动指纹、Host 的 PID、种类与所属会话），组长
//   关闭时删掉。看门狗也一起被结束时（整棵进程树被杀、关机）由下次启动的 `reap` 收拾：在接受连接之前，组长还活着且启动指纹
//   相同的组发 SIGTERM，宽限后 SIGKILL；PID 被别的进程重用了（指纹不同）的不碰。之后清掉登记。
//
// 启动指纹：Linux 是 `/proc/<pid>/stat` 的 starttime 加本次开机的 boot_id；其他 POSIX 系统是 `ps -o lstart=`（秒级）。组长
// 已经退出、只剩组里别的进程时不回收（认不出那个组号是不是被重用了）。Windows 没有进程组，保持各服务现在的 taskkill /T，
// 不登记。
//
// 这个文件只用 Node 内置模块（类型除外），测试里能直接用 node 跑一个“Host 一侧”的子进程。

import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcessGroupInfo, ProcessGroupTracker } from '@wevir/runtime-adapter';

/** SIGTERM 之后等多久再 SIGKILL（回收与看门狗）。 */
export const PROCESS_GROUP_KILL_GRACE_MS = 3000;
/** 等组退出时查看的间隔。 */
const POLL_MS = 50;

export interface ProcessGroupRecord extends ProcessGroupInfo {
  pgid: number;
  /** 组长的启动指纹（`processFingerprint`）。 */
  fingerprint: string;
  /** 登记它的 Host 进程与登记表实例（同一进程里的多个测试 Host 互不回收）。 */
  hostPid: number;
  hostInstance: string;
  /** 登记的时刻（毫秒）。 */
  startedAt: number;
}

export interface ReapedGroup {
  record: ProcessGroupRecord;
  /** `stopped`：发了信号结束的；`gone`：组长已不在；`reused`：PID 是别的进程了，没碰；`failed`：发不了信号。 */
  outcome: 'stopped' | 'gone' | 'reused' | 'failed';
  /** `stopped` 时最后发的信号。 */
  signal?: 'SIGTERM' | 'SIGKILL';
}

export interface ProcessGroupRegistryOptions {
  dir: string;
  /** 默认 `process.platform`；Windows 上什么都不做。 */
  platform?: NodeJS.Platform;
  /** 起看门狗（默认 true）。 */
  watchdog?: boolean;
  /** 默认 `PROCESS_GROUP_KILL_GRACE_MS`（测试用小值；看门狗按整秒取，至少 1 秒）。 */
  graceMs?: number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 本进程里还开着的登记表实例。 */
const live = new Set<string>();

/**
 * 看门狗脚本：`$1` 是宽限的秒数。`g` 是以空格分隔、两头带空格的组号表。
 */
const WATCHDOG_SCRIPT = `g=' '
while IFS=' ' read -r op id; do
  case $op in
    +) g="$g$id " ;;
    -) case $g in *" $id "*) g="\${g%%" $id "*} \${g#*" $id "}" ;; esac ;;
    q) exit 0 ;;
  esac
done
[ "$g" = ' ' ] && exit 0
for id in $g; do kill -TERM -"$id" 2>/dev/null || kill -TERM "$id" 2>/dev/null; done
n=0
while [ "$n" -lt "$1" ]; do
  alive=
  for id in $g; do { kill -0 -"$id" || kill -0 "$id"; } 2>/dev/null && alive=1; done
  [ -z "$alive" ] && exit 0
  sleep 1
  n=$((n + 1))
done
for id in $g; do kill -KILL -"$id" 2>/dev/null || kill -KILL "$id" 2>/dev/null; done
`;

export class ProcessGroupRegistry implements ProcessGroupTracker {
  readonly #options: ProcessGroupRegistryOptions;
  readonly #instance = randomUUID();
  readonly #posix: boolean;
  /** 每个组的写盘队列：写登记与删登记按顺序。 */
  readonly #writes = new Map<number, Promise<void>>();
  #watchdog: ChildProcess | undefined;
  #watchdogFailed = false;
  #closed = false;
  #dirReady: Promise<void> | undefined;

  constructor(options: ProcessGroupRegistryOptions) {
    this.#options = options;
    this.#posix = (options.platform ?? process.platform) !== 'win32';
    live.add(this.#instance);
  }

  /**
   * 回收上一次 Host 留下的组（启动时、接受连接之前）：组长还活着且指纹相同的结束掉，然后删掉所有登记（本进程里还开着的
   * 登记表的除外）。
   */
  async reap(): Promise<ReapedGroup[]> {
    if (!this.#posix) return [];
    const records = await this.#readRecords();
    const stale = records.filter(
      (record) => !(record.hostPid === process.pid && live.has(record.hostInstance)),
    );
    const results = await Promise.all(stale.map((record) => this.#reapOne(record)));
    await Promise.all(
      stale.map((record) => rm(this.#path(record.pgid), { force: true }).catch(() => {})),
    );
    return results;
  }

  track(child: ChildProcess, info: ProcessGroupInfo): void {
    const pgid = child.pid;
    if (!this.#posix || this.#closed || pgid === undefined) return;
    this.#watch(`+ ${pgid}`);
    const startedAt = Date.now();
    let released = false;
    child.once('close', () => {
      released = true;
      this.#watch(`- ${pgid}`);
      this.#queue(pgid, () => rm(this.#path(pgid), { force: true }));
    });
    this.#queue(pgid, async () => {
      const fingerprint = await processFingerprint(pgid);
      if (released || fingerprint === undefined) return;
      const record: ProcessGroupRecord = {
        ...info,
        pgid,
        fingerprint,
        hostPid: process.pid,
        hostInstance: this.#instance,
        startedAt,
      };
      await this.#ensureDir();
      const path = this.#path(pgid);
      const temp = `${path}.${this.#instance}.tmp`;
      await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temp, path);
    });
  }

  /** Host 正常退出：让看门狗不动手就退出，等登记写完。没结束的组的登记留着，下次启动回收。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    live.delete(this.#instance);
    const watchdog = this.#watchdog;
    this.#watchdog = undefined;
    if (watchdog?.stdin?.writable === true) watchdog.stdin.end('q\n');
    await Promise.all(this.#writes.values());
  }

  #path(pgid: number): string {
    return join(this.#options.dir, `${pgid}.json`);
  }

  #ensureDir(): Promise<void> {
    this.#dirReady ??= mkdir(this.#options.dir, { recursive: true, mode: 0o700 }).then(() => {});
    return this.#dirReady;
  }

  #queue(pgid: number, task: () => Promise<unknown>): void {
    const previous = this.#writes.get(pgid) ?? Promise.resolve();
    const next = previous
      .then(task)
      .then(
        () => {},
        (error: unknown) =>
          this.#options.onWarning?.('子进程组的登记写不进去', { pgid, error: String(error) }),
      )
      .finally(() => {
        if (this.#writes.get(pgid) === next) this.#writes.delete(pgid);
      });
    this.#writes.set(pgid, next);
  }

  #watch(line: string): void {
    if (this.#options.watchdog === false || this.#watchdogFailed || this.#closed) return;
    if (this.#watchdog === undefined) {
      const graceSeconds = Math.max(
        1,
        Math.ceil((this.#options.graceMs ?? PROCESS_GROUP_KILL_GRACE_MS) / 1000),
      );
      try {
        const child = spawn(
          '/bin/sh',
          ['-c', WATCHDOG_SCRIPT, 'wevir-watchdog', `${graceSeconds}`],
          {
            stdio: ['pipe', 'ignore', 'ignore'],
            // 自成进程组：发给 Host 所在组的信号（终端的 Ctrl-C）不到它这里，Host 正常退出时会发 `q`。
            detached: true,
          },
        );
        child.on('error', (error) => this.#watchdogDied(error));
        child.on('exit', (code, signal) => {
          if (!this.#closed) this.#watchdogDied(`exited (${code ?? signal})`);
        });
        child.stdin?.on('error', () => {});
        // 不拖住 Host 的事件循环（CLI 的 Host 照常退出，退出时 stdin 关掉就是 EOF）。
        child.unref();
        (child.stdin as { unref?: () => void } | null)?.unref?.();
        this.#watchdog = child;
      } catch (error) {
        this.#watchdogDied(error);
        return;
      }
    }
    this.#watchdog?.stdin?.write(`${line}\n`);
  }

  #watchdogDied(reason: unknown): void {
    if (this.#watchdogFailed) return;
    this.#watchdogFailed = true;
    this.#watchdog = undefined;
    this.#options.onWarning?.('子进程组的看门狗不在了，Host 被强行结束时要等下次启动回收', {
      reason: String(reason),
    });
  }

  async #readRecords(): Promise<ProcessGroupRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#options.dir);
    } catch {
      return [];
    }
    const records: ProcessGroupRecord[] = [];
    for (const name of names) {
      const path = join(this.#options.dir, name);
      if (!name.endsWith('.json')) {
        // 写到一半的临时文件。
        if (name.endsWith('.tmp')) await rm(path, { force: true }).catch(() => {});
        continue;
      }
      try {
        const record = parseRecord(JSON.parse(await readFile(path, 'utf8')));
        if (record !== undefined) records.push(record);
        else await rm(path, { force: true });
      } catch {
        await rm(path, { force: true }).catch(() => {});
      }
    }
    return records;
  }

  async #reapOne(record: ProcessGroupRecord): Promise<ReapedGroup> {
    const fingerprint = await processFingerprint(record.pgid);
    if (fingerprint === undefined) return { record, outcome: 'gone' };
    if (fingerprint !== record.fingerprint) return { record, outcome: 'reused' };
    if (!signalGroup(record.pgid, 'SIGTERM')) return { record, outcome: 'failed' };
    const grace = this.#options.graceMs ?? PROCESS_GROUP_KILL_GRACE_MS;
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (!groupAlive(record.pgid)) return { record, outcome: 'stopped', signal: 'SIGTERM' };
    }
    signalGroup(record.pgid, 'SIGKILL');
    return { record, outcome: 'stopped', signal: 'SIGKILL' };
  }
}

/** 发给整个组；组已不在（组长换了组）时退回只发给组长。发不出去时 false。 */
function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    try {
      process.kill(pgid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseRecord(value: unknown): ProcessGroupRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<ProcessGroupRecord>;
  if (
    !Number.isInteger(record.pgid) ||
    (record.pgid ?? 0) <= 1 ||
    typeof record.fingerprint !== 'string' ||
    record.fingerprint === '' ||
    typeof record.kind !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.hostPid !== 'number' ||
    typeof record.hostInstance !== 'string'
  ) {
    return undefined;
  }
  return record as ProcessGroupRecord;
}

let bootId: Promise<string> | undefined;

/**
 * 进程的启动指纹：同一个 PID 被别的进程重用后会不同。进程不在（或读不到）时 undefined。
 */
export async function processFingerprint(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // `pid (comm) state ppid pgrp …`：comm 里可能有空格与括号，从最后一个 `)` 之后数；starttime 是第 22 个字段。
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const start = fields[19];
      if (start === undefined || start === '') return undefined;
      bootId ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
        (text) => text.trim(),
        () => '',
      );
      return `linux:${await bootId}:${start}`;
    } catch {
      return undefined;
    }
  }
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 5000 },
      (error, stdout) => {
        const start = String(stdout).trim();
        resolve(error !== null || start === '' ? undefined : `ps:${start}`);
      },
    );
  });
}
