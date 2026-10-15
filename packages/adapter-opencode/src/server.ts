// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/OpenCodeRuntime.ts（`startOpenCodeServerProcess`、
// `parseServerUrlFromOutput`、`resolveOpenCodeConfigContent`、`verifyOpenCodeServerVersion`）、OpenCodeServerLedger.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 的 Scope 换成显式的 stop()；服务器的密码由 Wevir 每次随机生成（T3 只在用户设了 OPENCODE_SERVER_PASSWORD 时带
// 密码）；台账记在 Wevir 数据目录的 engines/opencode/servers 下，Host 第一次起服务器时清理上一个 Host 崩溃留下的。
//
// opencode 的本机服务器（opencode-event-mapping.md §3）：`opencode serve --hostname=127.0.0.1 --port=<随机>`，只听本机，带 HTTP
// Basic 密码；stdout 打出 `opencode server listening on http://…` 即就绪，再用 `/global/health` 核对版本。服务器自成进程组
// （npm 装的 `opencode` 是个启动器，真正的服务器是它的子进程），停的时候整组先 SIGTERM、1 秒后 SIGKILL。Host 被强杀时进程组
// 会留下：台账记下每个服务器的进程身份，下一个 Host 起服务器前把主人已经不在的那些停掉（只停 pid、启动时间、进程组与命令行
// 都对得上的，不会误杀复用了 pid 的进程）。

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { serverConfigContent } from './permissions.js';

/** 等服务器就绪的时限（T3 的 DEFAULT_OPENCODE_SERVER_TIMEOUT_MS）。 */
export const SERVER_START_TIMEOUT_MS = 30_000;
/** 停服务器时 SIGTERM 之后等多久再 SIGKILL。 */
export const SERVER_STOP_GRACE_MS = 1_000;
/** stdout / stderr 的尾部留多少字符（启动失败与退出的诊断）。 */
const OUTPUT_TAIL_CHARS = 8 * 1024;
/** 只在本机听。 */
export const SERVER_HOSTNAME = '127.0.0.1';
/** 台账的目录名（`<数据目录>/engines/opencode/servers`）。 */
export const LEDGER_DIRECTORY = 'servers';

/** T3 的 `parseServerUrlFromOutput`。 */
export function parseServerUrl(output: string): string | undefined {
  for (const line of output.split('\n')) {
    const match = /server listening on\s+(https?:\/\/\S+)/i.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** 服务器怎么退出的。 */
export interface ServerExit {
  code: number | null;
  signal: string | null;
  /** stderr 的尾部。 */
  stderrTail: string;
}

/** 起来的服务器。 */
export interface OpenCodeServerHandle {
  readonly url: string;
  readonly password: string;
  readonly version: string;
  readonly pid: number | undefined;
  /** 进程退出时 resolve（`stop` 引起的也算）。 */
  readonly exited: Promise<ServerExit>;
  /** 停掉整个进程组，等它退出；幂等。 */
  stop(): Promise<void>;
}

export interface StartServerOptions {
  executable: string;
  env: Record<string, string | undefined>;
  /** 核对版本：连上 `url` 读 `/global/health`，返回版本号，不合要求时抛错。 */
  verify: (url: string, password: string) => Promise<string>;
  ledger?: ServerLedger;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 本机一个空闲端口（T3 的 NetService.findAvailablePort(0)）。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, SERVER_HOSTNAME, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // 进程组可能已经没了。
  }
}

/**
 * 起一个 opencode 服务器（T3 的 `startOpenCodeServerProcess`）。`OPENCODE_CONFIG_CONTENT` 沿用调用方或继承的值（T3：不能盖掉用户
 * 自己的配置，否则用户配的 Provider 与模型都看不见），并进 Wevir 的权限配置（permissions.ts 的 serverConfigContent）。
 */
export async function startOpenCodeServer(
  options: StartServerOptions,
): Promise<OpenCodeServerHandle> {
  const port = await findFreePort();
  const password = randomBytes(32).toString('base64url');
  const args = ['serve', `--hostname=${SERVER_HOSTNAME}`, `--port=${port}`];
  const child = spawn(options.executable, args, {
    env: {
      ...options.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: serverConfigContent(options.env.OPENCODE_CONFIG_CONTENT),
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let ready = false;
  const exited = new Promise<ServerExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, stderrTail: stderr.trim() }));
    child.once('error', (error) =>
      resolve({ code: null, signal: null, stderrTail: `${stderr}\n${error.message}`.trim() }),
    );
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  // 就绪之后也一直读完两路输出：不读的话管道写满，opencode 会卡住（T3 同）。
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-OUTPUT_TAIL_CHARS);
  });

  let stopping: Promise<void> | undefined;
  let forget: (() => void) | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        signalGroup(child, 'SIGTERM');
        const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), SERVER_STOP_GRACE_MS);
        await exited;
        clearTimeout(timer);
        // 启动器先退出时组里可能还留着真正的服务器。
        signalGroup(child, 'SIGKILL');
      }
      forget?.();
    })();
    return stopping;
  };

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? SERVER_START_TIMEOUT_MS;
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for the OpenCode server after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      const onAbort = () => reject(new Error('OpenCode server start was aborted'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: string) => {
        if (ready) return;
        stdout = `${stdout}${chunk}`.slice(-OUTPUT_TAIL_CHARS);
        const found = parseServerUrl(stdout);
        if (found !== undefined) {
          ready = true;
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          resolve(found);
        }
      });
      void exited.then((exit) => {
        if (ready) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(
          new Error(
            [
              `OpenCode server exited before startup completed (code: ${String(exit.code)}${exit.signal === null ? '' : `, signal: ${exit.signal}`}).`,
              stdout.trim() === '' ? undefined : `stdout:\n${stdout.trim()}`,
              exit.stderrTail === '' ? undefined : `stderr:\n${exit.stderrTail}`,
            ]
              .filter((line) => line !== undefined)
              .join('\n\n'),
          ),
        );
      });
    });
    stdout = '';
    if (options.ledger !== undefined && child.pid !== undefined) {
      forget = await options.ledger.track({ pid: child.pid, port, args });
    }
    const version = await options.verify(url, password);
    return { url, password, version, pid: child.pid, exited, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// ── 台账（T3 的 OpenCodeServerLedger）──────────────────────────────────────

interface ProcessIdentity {
  pid: number;
  startTime: string;
}

interface LedgerEntry {
  version: 1;
  /** 起的那个进程的 pid，也是进程组 ID 与文件名。 */
  pgid: number;
  /** 起的时候看到的组成员：pid、启动时间与命令行都要对得上才发信号。 */
  pid: number;
  startTime: string;
  command: string;
  port: number;
  /** 跟着数据目录一起拷走的条目只删、不动进程。 */
  stateDir: string;
  /** 起它的 Host 进程；主人还活着的条目不动。 */
  owner: ProcessIdentity;
}

interface ObservedProcess {
  pid: number;
  pgid: number;
  startTime: string;
  command: string;
  zombie: boolean;
}

// `ps -o lstart` 打出 `Sat Sep  6 20:51:57 2026`；C 区域与 UTC 让它稳定。
const DARWIN_PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

/** T3 的 `parseDarwinPs`。 */
export function parseDarwinPs(output: string): ObservedProcess[] {
  return output.split('\n').flatMap((line) => {
    const match = DARWIN_PS_LINE.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        zombie: (match[3] ?? '').startsWith('Z'),
        startTime: match[4] ?? '',
        command: (match[5] ?? '').trimEnd(),
      },
    ];
  });
}

function psDarwin(selection: string[]): Promise<ObservedProcess[]> {
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-ww', '-o', 'pid=,pgid=,stat=,lstart=,args=', ...selection],
      { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 5_000, maxBuffer: 16 << 20 },
      (_error, stdout) => resolve(parseDarwinPs(String(stdout))),
    );
  });
}

function observeLinux(pid: number, group?: number): ObservedProcess | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 括号里的进程名之后：state、ppid、pgrp、session、… starttime（第 19 个）。
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(pgid) || startTime === undefined) return undefined;
    if (group !== undefined && pgid !== group) return undefined;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return {
      pid,
      pgid,
      startTime,
      command: cmdline.replace(/\0$/, '').replaceAll('\0', ' '),
      zombie: fields[0] === 'Z',
    };
  } catch {
    return undefined;
  }
}

async function observe(pid: number): Promise<ObservedProcess | undefined> {
  if (process.platform === 'linux') return observeLinux(pid);
  if (process.platform === 'darwin') {
    return (await psDarwin(['-p', String(pid)])).find((candidate) => candidate.pid === pid);
  }
  return undefined;
}

async function observeGroup(pgid: number): Promise<ObservedProcess[]> {
  if (process.platform === 'linux') {
    try {
      return readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map((name) => observeLinux(Number(name), pgid))
        .filter((candidate): candidate is ObservedProcess => candidate !== undefined);
    } catch {
      return [];
    }
  }
  if (process.platform === 'darwin') {
    return (await psDarwin(['-A'])).filter((candidate) => candidate.pgid === pgid);
  }
  return [];
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 记下起过的服务器，Host 崩溃后由下一个 Host 停掉（T3 的 OpenCodeServerLedger；Windows 上的服务器不分离，不记）。 */
export class ServerLedger {
  readonly #dir: string;
  readonly #stateDir: string;
  readonly #warn: (message: string, fields?: Record<string, unknown>) => void;
  #owner: Promise<ProcessIdentity | undefined> | undefined;
  #reaping: Promise<void> | undefined;

  constructor(input: {
    engineDir: string;
    warn?: (message: string, fields?: Record<string, unknown>) => void;
  }) {
    this.#stateDir = input.engineDir;
    this.#dir = path.join(input.engineDir, LEDGER_DIRECTORY);
    this.#warn = input.warn ?? (() => {});
  }

  get recordable(): boolean {
    return process.platform === 'linux' || process.platform === 'darwin';
  }

  #ownerIdentity(): Promise<ProcessIdentity | undefined> {
    this.#owner ??= observe(process.pid).then((found) =>
      found === undefined ? undefined : { pid: process.pid, startTime: found.startTime },
    );
    return this.#owner;
  }

  /** 记下一个刚起的服务器，返回优雅停止后删掉条目的函数。 */
  async track(server: { pid: number; port: number; args: string[] }): Promise<() => void> {
    if (!this.recordable) return () => {};
    try {
      const pgid = server.pid;
      const leader = await observe(pgid);
      const members =
        leader !== undefined && !leader.zombie && leader.pgid === pgid
          ? [leader]
          : (await observeGroup(pgid)).filter((candidate) => !candidate.zombie);
      const member =
        members.find((candidate) => candidate.command.endsWith(` ${server.args.join(' ')}`)) ??
        members[0];
      const owner = await this.#ownerIdentity();
      if (owner === undefined || member === undefined) {
        this.#warn('could not record an OpenCode server; it will outlive a crashed host', {
          pid: pgid,
          port: server.port,
        });
        return () => {};
      }
      const entry: LedgerEntry = {
        version: 1,
        pgid,
        pid: member.pid,
        startTime: member.startTime,
        command: member.command,
        port: server.port,
        stateDir: this.#stateDir,
        owner,
      };
      mkdirSync(this.#dir, { recursive: true });
      const file = path.join(this.#dir, `${pgid}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
      renameSync(temp, file);
      return () => rmSync(file, { force: true });
    } catch (error) {
      this.#warn('could not record an OpenCode server', { error: String(error) });
      return () => {};
    }
  }

  /** 停掉主人已经不在的服务器、删掉过期的条目（只做一次）。 */
  reapOrphans(): Promise<void> {
    this.#reaping ??= this.#reap();
    return this.#reaping;
  }

  async #reap(): Promise<void> {
    if (!this.recordable) return;
    let names: string[];
    try {
      names = readdirSync(this.#dir).filter((name) => /^\d+\.json$/.test(name));
    } catch {
      return;
    }
    await Promise.all(names.map((name) => this.#reapEntry(path.join(this.#dir, name))));
  }

  async #reapEntry(file: string): Promise<void> {
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as Partial<LedgerEntry>;
      if (
        entry.version === 1 &&
        entry.stateDir === this.#stateDir &&
        typeof entry.pgid === 'number' &&
        typeof entry.pid === 'number' &&
        entry.owner !== undefined
      ) {
        const owner = await observe(entry.owner.pid);
        if (owner !== undefined && !owner.zombie && owner.startTime === entry.owner.startTime) {
          return;
        }
        const observed = await observe(entry.pid);
        if (
          observed !== undefined &&
          !observed.zombie &&
          observed.startTime === entry.startTime &&
          observed.pgid === entry.pgid &&
          observed.command === entry.command
        ) {
          this.#warn('stopping an OpenCode server left by a previous host', {
            pid: entry.pgid,
            port: entry.port,
          });
          try {
            process.kill(-entry.pgid, 'SIGTERM');
          } catch {
            // 已经没了。
          }
          for (let attempt = 0; attempt < 40 && groupExists(entry.pgid); attempt += 1) {
            await sleep(50);
          }
          // 组没清空，pgid 不可能被复用。
          if (groupExists(entry.pgid)) {
            try {
              process.kill(-entry.pgid, 'SIGKILL');
            } catch {
              // 已经没了。
            }
          }
        }
      }
      rmSync(file, { force: true });
    } catch (error) {
      this.#warn('could not clean up a recorded OpenCode server', { file, error: String(error) });
    }
  }
}
