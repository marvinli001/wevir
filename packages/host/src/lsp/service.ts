// 语言服务器的状态与安装（0.71.0，Host 功能 `lsp_status`）：`lsp.*` 方法背后的服务。
//
// 状态 = 扫描项目目录得到的（语言 × 项目根）+ LspManager 里每个服务器的查找结果与运行情况。安装只由用户发起：按服务器给出的一个
// 方案起进程（不经 shell，参数就是显示的命令），有超时、可取消、记下输出末尾；退出码 0 后重新查找、重启这个服务器、对扫描时找到
// 的一个文件取一次诊断，通过才算装好。用户级与系统的方案要调用方明确 `confirmGlobal`。

import { type ChildProcess, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  LSP_INSTALL_OUTPUT_MAX,
  LSP_LOG_MAX,
  LSP_SERVERS_MAX,
  type LspInstallId,
  type LspInstallRun,
  type LspServerStatus,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import { stripAnsi } from '../processes.js';
import { type LspManager, planCommand } from './manager.js';
import { type DetectedServer, type ScanResult, scanLanguages } from './scan.js';
import { findExecutable } from './servers.js';

/** 扫描结果缓存多久。 */
const SCAN_CACHE_MS = 30_000;
/** 安装的时限。 */
export const LSP_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** 装完验证时等诊断多久。 */
const VERIFY_DIAGNOSTICS_MS = 60_000;
/** 记着的安装记录上限。 */
const RUNS_MAX = 50;

export interface LspStatusServiceOptions {
  lsp: LspManager;
  /** 测试用。 */
  installTimeoutMs?: number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Run {
  info: LspInstallRun;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  /** 用户取消或超时：退出时按它记状态。 */
  stopping?: 'cancelled' | 'timed_out';
}

export type LspChange = { serverId?: string; root?: string };

export class LspStatusService {
  readonly #options: LspStatusServiceOptions;
  readonly #lsp: LspManager;
  readonly #scans = new Map<string, { at: number; result: Promise<ScanResult> }>();
  readonly #runs = new Map<LspInstallId, Run>();
  readonly #listeners = new Set<(change: LspChange) => void>();
  #closed = false;

  constructor(options: LspStatusServiceOptions) {
    this.#options = options;
    this.#lsp = options.lsp;
  }

  /** `lsp.changed` 的来源：rpc 连接订阅。 */
  watch(listener: (change: LspChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** LspManager 的 `onChange` 接到这里。 */
  changed(change: LspChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#options.onWarning?.('lsp.changed listener threw', { error });
      }
    }
  }

  #scan(dir: string, refresh: boolean): Promise<ScanResult> {
    const hit = this.#scans.get(dir);
    if (!refresh && hit !== undefined && Date.now() - hit.at < SCAN_CACHE_MS) return hit.result;
    const result = scanLanguages(dir, this.#lsp.servers);
    this.#scans.set(dir, { at: Date.now(), result });
    if (this.#scans.size > 50) {
      const oldest = this.#scans.keys().next().value;
      if (oldest !== undefined) this.#scans.delete(oldest);
    }
    return result;
  }

  async status(
    dir: string,
    refresh = false,
  ): Promise<{ dir: string; servers: LspServerStatus[]; truncated?: boolean }> {
    const scan = await this.#scan(dir, refresh);
    const detected = scan.servers.slice(0, LSP_SERVERS_MAX);
    const servers = await Promise.all(detected.map((found) => this.#describe(found, refresh)));
    const truncated = scan.truncated || scan.servers.length > LSP_SERVERS_MAX;
    return { dir, servers, ...(truncated && { truncated }) };
  }

  async #describe(found: DetectedServer, refresh = false): Promise<LspServerStatus> {
    const status = await this.#lsp.status(found.spec, found.root, refresh);
    const run = this.#latest(found.spec.id, found.root);
    return run === undefined ? status : { ...status, install: { ...run.info } };
  }

  /** 扫描里的一个服务器；客户端给的 `serverId` 与 `root` 必须是扫描到的，不能指向任意目录。 */
  async #find(dir: string, serverId: string, root: string): Promise<DetectedServer> {
    for (const refresh of [false, true]) {
      const found = (await this.#scan(dir, refresh)).servers.find(
        (item) => item.spec.id === serverId && item.root === root,
      );
      if (found !== undefined) return found;
    }
    throw invalidParams(['root'], `no ${serverId} language server for ${root} in ${dir}`);
  }

  async restart(dir: string, serverId: string, root: string): Promise<LspServerStatus> {
    const found = await this.#find(dir, serverId, root);
    await this.#lsp.restart(found.spec, found.root);
    return this.#describe(found);
  }

  async log(dir: string, serverId: string, root: string): Promise<string> {
    const found = await this.#find(dir, serverId, root);
    const run = this.#latest(serverId, root)?.info;
    const parts = [this.#lsp.log(found.spec, found.root)];
    if (run !== undefined) {
      parts.push(
        `${run.startedAt} install (${run.scope}): ${run.command} → ${run.status}${run.reason === undefined ? '' : `: ${run.reason}`}`,
      );
    }
    const text = parts.filter((part) => part !== '').join('\n');
    return text.length > LSP_LOG_MAX ? text.slice(-LSP_LOG_MAX) : text;
  }

  #latest(serverId: string, root: string): Run | undefined {
    let latest: Run | undefined;
    for (const run of this.#runs.values()) {
      if (run.info.serverId === serverId && run.info.root === root) latest = run;
    }
    return latest;
  }

  // ── 安装 ───────────────────────────────────────────────────────────

  async install(
    dir: string,
    serverId: string,
    root: string,
    planId: string,
    confirmGlobal: boolean,
  ): Promise<LspInstallRun> {
    if (this.#closed) throw new HostError('HOST_SHUTTING_DOWN', 'the host is shutting down');
    const found = await this.#find(dir, serverId, root);
    const plan = (await this.#lsp.plans(found.spec, found.root)).find((item) => item.id === planId);
    if (plan === undefined) {
      throw invalidParams(['planId'], `${planId} is not an install plan for this language server`);
    }
    if (!plan.runnable) {
      throw invalidParams(['planId'], `${planCommand(plan.argv)} has to be run by hand`);
    }
    if (plan.scope !== 'project' && !confirmGlobal) {
      throw invalidParams(['confirmGlobal'], 'installing outside the project needs confirmGlobal');
    }
    const running = this.#latest(serverId, root);
    if (running?.info.status === 'running' || running?.info.status === 'verifying') {
      throw new HostError('RESOURCE_IN_USE', 'this language server is already being installed', {
        sessionIds: [],
      });
    }
    const command = planCommand(plan.argv);
    const run: Run = {
      info: {
        id: newId('lsi'),
        serverId,
        root,
        planId,
        scope: plan.scope,
        command,
        status: 'running',
        startedAt: new Date().toISOString(),
        output: '',
      },
    };
    this.#runs.set(run.info.id, run);
    this.#prune();
    const env = this.#lsp.env;
    const program = (await findExecutable(plan.argv[0] ?? '', env)) ?? plan.argv[0] ?? '';
    const cwd = plan.cwd ?? homedir();
    this.#append(run, `$ ${command}\n${plan.cwd === undefined ? '' : `(in ${cwd})\n`}`);
    // Windows 上 npm、pnpm 是 .cmd 启动脚本，要经 shell；参数来自固定的方案，没有用户输入。
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(program);
    let child: ChildProcess;
    try {
      child = spawn(shell ? `"${program}"` : program, plan.argv.slice(1), {
        cwd,
        env: { ...env, CI: '1', npm_config_yes: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell,
      });
    } catch (error) {
      this.#finish(run, 'failed', error instanceof Error ? error.message : String(error));
      return { ...run.info };
    }
    run.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.#append(run, chunk));
    child.stderr?.on('data', (chunk: string) => this.#append(run, chunk));
    run.timer = setTimeout(() => {
      run.stopping = 'timed_out';
      kill(child);
    }, this.#options.installTimeoutMs ?? LSP_INSTALL_TIMEOUT_MS);
    run.timer.unref();
    let settled = false;
    const done = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(run.timer);
      run.child = undefined;
      run.info.exitCode = code;
      if (run.stopping !== undefined) {
        this.#finish(run, run.stopping);
      } else if (error !== undefined) {
        this.#finish(run, 'failed', `${plan.argv[0]} could not start: ${error.message}`);
      } else if (code !== 0) {
        this.#finish(run, 'failed', failureReason(run.info.output, code));
      } else {
        void this.#verify(run, found);
      }
    };
    child.once('error', (error) => done(null, error));
    child.once('close', (code) => done(code));
    this.changed({ serverId, root });
    return { ...run.info };
  }

  async #verify(run: Run, found: DetectedServer): Promise<void> {
    run.info.status = 'verifying';
    this.#append(run, '\n');
    this.changed({ serverId: run.info.serverId, root: run.info.root });
    try {
      this.#lsp.forget(found.spec.id, found.root);
      const result = await this.#lsp.verify(
        found.spec,
        found.root,
        found.sample,
        VERIFY_DIAGNOSTICS_MS,
      );
      if (this.#closed) return;
      run.info.verification = {
        server: result.server,
        file: path.relative(found.root, found.sample) || path.basename(found.sample),
        diagnostics: result.diagnostics,
        ...(result.timedOut && { timedOut: true }),
      };
      this.#finish(run, 'succeeded');
    } catch (error) {
      this.#finish(
        run,
        'failed',
        `The install finished, but the language server is still not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  cancel(installId: LspInstallId): LspInstallRun {
    const run = this.#runs.get(installId);
    if (run === undefined) throw invalidParams(['installId'], `install ${installId} not found`);
    if (run.info.status === 'running' && run.child !== undefined) {
      run.stopping = 'cancelled';
      kill(run.child);
    }
    return { ...run.info };
  }

  #append(run: Run, chunk: string): void {
    const output = run.info.output + stripAnsi(chunk);
    run.info.output =
      output.length > LSP_INSTALL_OUTPUT_MAX ? output.slice(-LSP_INSTALL_OUTPUT_MAX) : output;
  }

  #finish(run: Run, status: LspInstallRun['status'], reason?: string): void {
    run.info.status = status;
    run.info.endedAt = new Date().toISOString();
    if (reason !== undefined) run.info.reason = reason.slice(0, 4000);
    else if (status === 'cancelled') run.info.reason = 'Cancelled.';
    else if (status === 'timed_out') {
      run.info.reason = `Did not finish within ${Math.round((this.#options.installTimeoutMs ?? LSP_INSTALL_TIMEOUT_MS) / 60_000)} min.`;
    }
    this.#lsp.forget(run.info.serverId, run.info.root);
    this.changed({ serverId: run.info.serverId, root: run.info.root });
  }

  #prune(): void {
    for (const [id, run] of this.#runs) {
      if (this.#runs.size <= RUNS_MAX) break;
      if (run.info.status !== 'running' && run.info.status !== 'verifying') this.#runs.delete(id);
    }
  }

  /** Host 退出：结束还在跑的安装。 */
  close(): void {
    this.#closed = true;
    for (const run of this.#runs.values()) {
      if (run.child !== undefined) {
        run.stopping = 'cancelled';
        kill(run.child);
      }
    }
  }
}

function kill(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => {},
      );
    } else {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
      }, 3000).unref();
    }
  } catch {
    child.kill('SIGKILL');
  }
}

/** 像错误原因的行（npm 的 `error code`、`FetchError`，`E` 开头的错误码，`not found`、权限等）。 */
const ERROR_LINE =
  /(error code|errno|\w*Error:|error:|ERR!|\bE[A-Z]{4,}\b|not found|permission denied|could not|cannot|failed)/i;

/** 失败的原因：输出里像错误原因的前几行，没有时是最后几行，再没有时只有退出码。 */
function failureReason(output: string, code: number | null): string {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.startsWith('$ ') && !line.startsWith('(in '));
  const errors = lines.filter((line) => ERROR_LINE.test(line));
  const tail = (errors.length > 0 ? errors.slice(0, 4) : lines.slice(-6)).join('\n');
  return `Exited with code ${code ?? 'unknown'}.${tail === '' ? '' : `\n${tail}`}`;
}

function invalidParams(path: string[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}
