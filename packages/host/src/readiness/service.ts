// 项目环境就绪（0.70.0，Host 功能 `workspace_readiness`）。
//
// - **预检**（`readiness.get`）只读文件、在空目录里跑工具的 `--version`；工具探测的结果缓存 `PROBE_TTL_MS`，`refresh` 重新探测。检查的
//   根目录是项目目录，给了会话时是会话的目录（worktree 里的依赖与主目录的不同）。
// - **安装**（`readiness.install`）只由用户发起：带着报告里方案的 ID 来，Host 重算一次，方案变了就拒绝（用户要看到新方案再确认）；同一个
//   根目录同时只有一次。Host 起进程，凭据只作为环境变量交给它，日志里遮住；可以取消、有超时；结束后重新预检并通知。
// - **凭据**（`readiness.setCredential`）：值进 Host 的秘密存储（`secrets.json`，0600），这里只记名字。
// - **回合后验证**用 `blockingFor`：检查失败时看与这个检查相关的不就绪阻塞项，有就记“环境不可用”，修复链不开。
//
// 安装记录留最近 `RUNS_KEPT` 个（`runs.json`），Host 重启时没跑完的记成取消（`host_restarted`）。

import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type CheckDefinition,
  INSTALL_OUTPUT_PAGE_MAX_BYTES,
  INSTALL_SUMMARY_MAX_LENGTH,
  INSTALL_TIMEOUT_DEFAULT_MS,
  type InstallRun,
  type InstallRunId,
  type NotificationParams,
  READINESS_CREDENTIALS_MAX,
  type ReadinessItem,
  type ReadinessReport,
  type SessionId,
  SUBSCRIPTION_KINDS,
  type WorkspaceId,
} from '@wevir/protocol';
import type { SecretStore, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import { completeUtf8 } from '../processes.js';
import { parseCheckCommand } from './checks.js';
import { joinRel, within } from './files.js';
import { classifyInstallFailure, type InstallProcess, Redactor, startInstall } from './install.js';
import { agentNetwork } from './network.js';
import { type ProbeResult, probeTools } from './probe.js';
import { buildReport } from './report.js';

/** 工具探测结果的缓存时长。 */
export const PROBE_TTL_MS = 5 * 60_000;
/** 探测全部工具的超时。 */
export const PROBE_TIMEOUT_MS = 20_000;
export const RUNS_KEPT = 50;
/** 安装输出变多时最多每隔这么久通知一次。 */
const OUTPUT_NOTIFY_MS = 1000;

type Change = NotificationParams<'readiness.changed'>;

export interface ReadinessServiceOptions {
  storage: Storage;
  /** 工作区的检查（回合后验证）；省略时报告里没有检查的项。 */
  checks?: (workspaceId: WorkspaceId) => Promise<readonly CheckDefinition[]>;
  secrets: SecretStore;
  dir: string;
  /** 不是 Codex 的订阅来源各有自己的引擎；别的 Provider 交给这个（`codex`、测试里的 `echo`）。 */
  defaultEngine: string;
  /** “对话”工作区只能按会话读。 */
  isChats?: (workspaceId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** 测试用：换掉工具探测。 */
  probe?: (names: readonly string[]) => Promise<ReadonlyMap<string, ProbeResult>>;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Running {
  run: InstallRun;
  /** 根目录是会话的目录时（装完重新预检用）。 */
  sessionId?: SessionId;
  process: InstallProcess;
  timer?: ReturnType<typeof setTimeout>;
}

export class ReadinessService {
  readonly #options: ReadinessServiceOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #listeners = new Set<(change: Change) => void>();
  readonly #probeCache = new Map<string, { result: ProbeResult; at: number }>();
  readonly #running = new Map<InstallRunId, Running>();
  #runs: InstallRun[] = [];
  #credentials: Record<string, string[]> = {};
  #loaded: Promise<void> | undefined;
  #disposed = false;

  constructor(options: ReadinessServiceOptions) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
  }

  /** 读安装记录与凭据名；上次没跑完的记成取消。返回记成取消的个数。 */
  async recover(): Promise<number> {
    await this.#load();
    let count = 0;
    const now = new Date().toISOString();
    this.#runs = this.#runs.map((run) => {
      if (run.status !== 'running') return run;
      count++;
      return { ...run, status: 'cancelled', reason: 'host_restarted', finishedAt: now };
    });
    if (count > 0) await this.#saveRuns();
    return count;
  }

  watch(listener: (change: Change) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ── 预检 ────────────────────────────────────────────────────

  async get(params: {
    workspaceId: WorkspaceId;
    sessionId?: SessionId;
    refresh?: boolean;
  }): Promise<ReadinessReport> {
    await this.#load();
    const root = this.#root(params.workspaceId, params.sessionId);
    if (params.refresh === true) this.#probeCache.clear();
    const report = await this.#build(params.workspaceId, params.sessionId, root);
    return report;
  }

  async #build(
    workspaceId: WorkspaceId,
    sessionId: SessionId | undefined,
    root: string,
  ): Promise<ReadinessReport> {
    const checks = (await this.#options.checks?.(workspaceId).catch(() => [])) ?? [];
    const record =
      sessionId === undefined ? undefined : this.#options.storage.sessions.get(sessionId);
    const provider =
      record === undefined ? undefined : this.#options.storage.providers.get(record.providerId);
    const kind = provider?.kind;
    const engine =
      kind !== undefined && (SUBSCRIPTION_KINDS as readonly string[]).includes(kind)
        ? kind
        : this.#options.defaultEngine;
    const home = this.#options.home ?? homedir();
    const report = await buildReport({
      workspaceId,
      ...(sessionId !== undefined && { sessionId }),
      root,
      checks,
      env: this.#env,
      platform: this.#platform,
      home,
      probe: (names) => this.#probe(names),
      credentials: new Set(this.#credentials[workspaceId] ?? []),
      userNpmrc: await readFile(join(home, '.npmrc'), 'utf8').catch(() => ''),
      ...(record !== undefined && {
        agent: agentNetwork(engine, record.permissionMode, this.#platform),
      }),
      ...(this.#lastRun(root) !== undefined && { install: this.#lastRun(root) as InstallRun }),
    });
    return report;
  }

  async #probe(names: readonly string[]): Promise<ReadonlyMap<string, ProbeResult>> {
    const now = Date.now();
    const result = new Map<string, ProbeResult>();
    const missing: string[] = [];
    for (const name of names) {
      const cached = this.#probeCache.get(name);
      if (cached !== undefined && now - cached.at < PROBE_TTL_MS) result.set(name, cached.result);
      else missing.push(name);
    }
    if (missing.length > 0) {
      const probed = this.#options.probe
        ? await this.#options.probe(missing)
        : await probeTools(missing, {
            env: this.#env,
            platform: this.#platform,
            cwd: await this.#probeDir(),
            timeoutMs: PROBE_TIMEOUT_MS,
          });
      for (const [name, value] of probed) {
        result.set(name, value);
        // 超时或起不来的不缓存，下次再试。
        if (value.problem !== 'timeout' && value.problem !== 'failed')
          this.#probeCache.set(name, { result: value, at: now });
      }
    }
    return result;
  }

  async #probeDir(): Promise<string> {
    const dir = join(this.#options.dir, 'probe');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * 回合后验证：检查失败后，这个检查相关的不就绪阻塞项（检查自己的命令、检查目录所在项目的依赖与锁文件、命令要用的工具）。
   */
  async blockingFor(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    check: Pick<CheckDefinition, 'id' | 'cwd' | 'command'>,
  ): Promise<ReadinessItem[]> {
    await this.#load();
    let root: string;
    try {
      root = this.#root(workspaceId, sessionId);
    } catch {
      return [];
    }
    // 每次重读文件（依赖可能刚被用户装上），工具探测用缓存。
    return relevantBlocking(await this.#build(workspaceId, sessionId, root), check);
  }

  // ── 安装 ────────────────────────────────────────────────────

  async install(params: {
    workspaceId: WorkspaceId;
    sessionId?: SessionId;
    planId: string;
    timeoutMs?: number;
  }): Promise<InstallRun> {
    await this.#load();
    if (this.#disposed) throw new HostError('HOST_SHUTTING_DOWN', 'the host is shutting down');
    const root = this.#root(params.workspaceId, params.sessionId);
    for (const running of this.#running.values()) {
      if (running.run.root === root) {
        throw new HostError('RESOURCE_IN_USE', 'an install is already running in this folder', {
          sessionIds: [],
        });
      }
    }
    const report = await this.#build(params.workspaceId, params.sessionId, root);
    const plan = report.plans.find((item) => item.id === params.planId);
    if (!plan) {
      throw new HostError(
        'INVALID_PARAMS',
        'the install plan changed; read the readiness report again',
        {
          issues: [{ path: ['planId'], message: 'plan_changed' }],
        },
      );
    }
    const extraEnv: Record<string, string> = {};
    const secrets: string[] = [];
    for (const credential of plan.credentials) {
      if (credential.source === 'wevir') {
        const value = await this.#options.secrets.get(
          secretRef(params.workspaceId, credential.name),
        );
        if (value !== undefined) {
          extraEnv[credential.name] = value;
          secrets.push(value);
        }
      } else if (credential.source === 'env') {
        const value = this.#env[credential.name];
        if (value !== undefined) secrets.push(value);
      }
    }
    const id = newId('ins');
    const logPath = await this.#logPath(id);
    const timeoutMs = params.timeoutMs ?? INSTALL_TIMEOUT_DEFAULT_MS;
    const run: InstallRun = {
      id,
      workspaceId: params.workspaceId,
      root,
      planId: plan.id,
      path: plan.path,
      manager: plan.manager,
      command: plan.command,
      status: 'running',
      startedAt: new Date().toISOString(),
      timeoutMs,
      bytes: 0,
    };
    const process = startInstall({
      command: plan.command,
      cwd: joinPath(root, plan.path),
      env: this.#env,
      extraEnv,
      platform: this.#platform,
      logPath,
      timeoutMs,
      redactor: new Redactor(secrets),
      onOutput: (bytes) => this.#onOutput(id, bytes),
    });
    const running: Running = {
      run,
      process,
      ...(params.sessionId !== undefined && { sessionId: params.sessionId }),
    };
    this.#running.set(id, running);
    this.#runs.push(run);
    await this.#saveRuns();
    this.#emit({ workspaceId: run.workspaceId, root, run });
    void process.result
      .then((result) => this.#finished(id, result))
      .catch((error: unknown) => {
        this.#options.onWarning?.('安装没能收尾', { id, error: String(error) });
      });
    return run;
  }

  cancel(runId: InstallRunId): InstallRun {
    const running = this.#running.get(runId);
    if (running) {
      running.process.cancel();
      return running.run;
    }
    const run = this.#runs.find((item) => item.id === runId);
    if (!run)
      throw new HostError('INVALID_PARAMS', `install ${runId} not found`, {
        issues: [{ path: ['runId'], message: 'not found' }],
      });
    return run;
  }

  async output(
    runId: InstallRunId,
    offset = 0,
  ): Promise<{ text: string; from: number; next: number; more: boolean; bytes: number }> {
    await this.#load();
    if (!this.#runs.some((run) => run.id === runId)) {
      throw new HostError('INVALID_PARAMS', `install ${runId} not found`, {
        issues: [{ path: ['runId'], message: 'not found' }],
      });
    }
    const path = join(this.#options.dir, 'logs', `${runId}.log`);
    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    const from = Math.min(offset, size);
    const length = Math.min(size - from, INSTALL_OUTPUT_PAGE_MAX_BYTES);
    if (length <= 0) return { text: '', from, next: from, more: false, bytes: size };
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      const usable =
        from + bytesRead < size ? completeUtf8(buffer.subarray(0, bytesRead)) : bytesRead;
      return {
        text: buffer.subarray(0, usable).toString('utf8'),
        from,
        next: from + usable,
        more: from + usable < size,
        bytes: size,
      };
    } finally {
      await handle.close();
    }
  }

  #onOutput(id: InstallRunId, bytes: number): void {
    const running = this.#running.get(id);
    if (!running) return;
    running.run = { ...running.run, bytes };
    if (running.timer !== undefined) return;
    running.timer = setTimeout(() => {
      running.timer = undefined;
      if (this.#running.get(id) !== running) return;
      this.#emit({
        workspaceId: running.run.workspaceId,
        root: running.run.root,
        run: running.run,
      });
    }, OUTPUT_NOTIFY_MS);
  }

  async #finished(id: InstallRunId, result: Awaited<InstallProcess['result']>): Promise<void> {
    const running = this.#running.get(id);
    if (!running) return;
    if (running.timer !== undefined) clearTimeout(running.timer);
    this.#running.delete(id);
    const started = Date.parse(running.run.startedAt);
    const summary =
      result.tail.length > INSTALL_SUMMARY_MAX_LENGTH
        ? result.tail.slice(-INSTALL_SUMMARY_MAX_LENGTH)
        : result.tail;
    const status: InstallRun['status'] =
      result.kind === 'cancelled'
        ? 'cancelled'
        : result.kind === 'timed_out'
          ? 'timed_out'
          : result.kind === 'exited' && result.exitCode === 0
            ? 'succeeded'
            : 'failed';
    const reason =
      status === 'cancelled'
        ? this.#disposed
          ? 'host_restarted'
          : 'user'
        : status === 'failed'
          ? result.kind === 'spawn_failed'
            ? 'not_found'
            : classifyInstallFailure(result.exitCode, result.tail)
          : undefined;
    const run: InstallRun = {
      ...running.run,
      status,
      ...(reason !== undefined && { reason }),
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
      exitCode: result.exitCode,
      ...(result.signal !== null && { signal: result.signal }),
      bytes: result.bytes,
      ...(summary.trim() !== '' && { summary }),
    };
    this.#runs = this.#runs.map((item) => (item.id === id ? run : item));
    await this.#saveRuns().catch(() => {});
    this.#emit({ workspaceId: run.workspaceId, root: run.root, run });
    if (this.#disposed) return;
    // 装完了：依赖的版本可能也变了（包管理器自己）；重新探测一次再预检。
    this.#probeCache.delete(run.manager);
    const sessionId = running.sessionId;
    try {
      const report = await this.#build(run.workspaceId, sessionId, run.root);
      this.#emit({ workspaceId: run.workspaceId, root: run.root, report });
    } catch (error) {
      this.#options.onWarning?.('安装后的预检失败', { id, error: String(error) });
    }
  }

  // ── 凭据 ────────────────────────────────────────────────────

  async setCredential(params: {
    workspaceId: WorkspaceId;
    name: string;
    value?: string;
  }): Promise<{ credentials: string[] }> {
    await this.#load();
    const workspace = this.#options.storage.workspaces.get(params.workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${params.workspaceId} not found`);
    }
    const names = new Set(this.#credentials[params.workspaceId] ?? []);
    const ref = secretRef(params.workspaceId, params.name);
    if (params.value === undefined) {
      await this.#options.secrets.delete(ref);
      names.delete(params.name);
    } else {
      if (!names.has(params.name) && names.size >= READINESS_CREDENTIALS_MAX) {
        throw new HostError('INVALID_PARAMS', 'too many credentials', {
          issues: [{ path: ['name'], message: 'too many credentials' }],
        });
      }
      await this.#options.secrets.set(ref, params.value);
      names.add(params.name);
    }
    const list = [...names].sort();
    if (list.length === 0) delete this.#credentials[params.workspaceId];
    else this.#credentials[params.workspaceId] = list;
    await this.#atomicWrite('credentials.json', this.#credentials);
    return { credentials: list };
  }

  /** 移除工作区：停掉它的安装、删掉它的凭据。 */
  async removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.#load();
    for (const running of this.#running.values()) {
      if (running.run.workspaceId === workspaceId) running.process.cancel();
    }
    for (const name of this.#credentials[workspaceId] ?? []) {
      await this.#options.secrets.delete(secretRef(workspaceId, name)).catch(() => false);
    }
    if (this.#credentials[workspaceId] !== undefined) {
      delete this.#credentials[workspaceId];
      await this.#atomicWrite('credentials.json', this.#credentials);
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const pending = [...this.#running.values()].map((running) => {
      running.process.cancel();
      return running.process.result;
    });
    await Promise.allSettled(pending);
    // `#finished` 在 result 之后的微任务里写记录；等它写完。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.#saveRuns().catch(() => {});
  }

  // ── 内部 ────────────────────────────────────────────────────

  #root(workspaceId: WorkspaceId, sessionId: SessionId | undefined): string {
    const workspace = this.#options.storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    if (sessionId === undefined) {
      if (this.#options.isChats?.(workspaceId) === true) {
        throw new HostError('INVALID_PARAMS', 'the chats workspace is read per session', {
          issues: [{ path: ['sessionId'], message: 'required for the chats workspace' }],
        });
      }
      return workspace.rootPath;
    }
    const session = this.#options.storage.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    return session.cwd;
  }

  #lastRun(root: string): InstallRun | undefined {
    for (let i = this.#runs.length - 1; i >= 0; i--) {
      const run = this.#runs[i] as InstallRun;
      if (run.root === root) return this.#running.get(run.id)?.run ?? run;
    }
    return undefined;
  }

  #emit(change: Change): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#options.onWarning?.('readiness listener threw', { error: String(error) });
      }
    }
  }

  async #logPath(id: InstallRunId): Promise<string> {
    const dir = join(this.#options.dir, 'logs');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${id}.log`);
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
      try {
        const runs = JSON.parse(
          await readFile(join(this.#options.dir, 'runs.json'), 'utf8'),
        ) as unknown;
        if (Array.isArray(runs)) this.#runs = runs as InstallRun[];
      } catch {}
      try {
        const credentials = JSON.parse(
          await readFile(join(this.#options.dir, 'credentials.json'), 'utf8'),
        ) as unknown;
        if (credentials && typeof credentials === 'object')
          this.#credentials = credentials as Record<string, string[]>;
      } catch {}
    })();
    return this.#loaded;
  }

  async #saveRuns(): Promise<void> {
    const dropped =
      this.#runs.length > RUNS_KEPT ? this.#runs.slice(0, this.#runs.length - RUNS_KEPT) : [];
    this.#runs = this.#runs.slice(-RUNS_KEPT);
    for (const run of dropped) {
      if (!this.#running.has(run.id))
        await rm(join(this.#options.dir, 'logs', `${run.id}.log`), { force: true }).catch(() => {});
    }
    await this.#atomicWrite(
      'runs.json',
      this.#runs.map((run) => this.#running.get(run.id)?.run ?? run),
    );
  }

  async #atomicWrite(name: string, value: unknown): Promise<void> {
    const path = join(this.#options.dir, name);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  }
}

function secretRef(workspaceId: string, name: string): string {
  return `readiness:${workspaceId}:${name}`;
}

function joinPath(root: string, rel: string): string {
  return rel === '' ? root : join(root, ...rel.split('/'));
}

/** 项属于哪种语言生态（看名字）；工具与目录以外的是 undefined。 */
function itemEcosystem(item: Pick<ReadinessItem, 'kind' | 'name'>): string | undefined {
  const name = item.name;
  if (
    /^(node|pnpm|npm|yarn|bun|node_modules|\.pnp\.cjs|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/.test(
      name,
    )
  )
    return 'node';
  if (
    /^(python|uv|poetry|pipenv|uv\.lock|poetry\.lock|Pipfile\.lock|virtualenv)$/.test(name) ||
    /(^|\/)\.?venv$/.test(name)
  )
    return 'python';
  if (name === 'go' || name === 'go.sum' || name === 'module cache' || name === 'vendor')
    return 'go';
  if (name === 'cargo' || name === 'rustc' || name === 'Cargo.lock' || name === 'registry cache')
    return 'rust';
  if (/^(cc|clang|gcc|c\+\+|make|cmake|meson|ninja)$/.test(name)) return 'c';
  if (name === 'swift') return 'swift';
  if (item.kind === 'lockfile' && name === 'lockfile') return 'node';
  return undefined;
}

/** 检查命令用的语言生态；认不出时 undefined（相关的都算）。 */
export function commandEcosystem(command: string): string | undefined {
  const first = parseCheckCommand(command).words[0]?.replace(/^.*[/\\]/, '');
  if (first === undefined) return undefined;
  if (
    /^(node|npm|pnpm|yarn|bun|npx|bunx|tsc|tsx|vitest|jest|mocha|eslint|biome|prettier|playwright|turbo|nx)$/.test(
      first,
    )
  )
    return 'node';
  if (/^(python3?|pytest|uv|uvx|poetry|pipenv|tox|nox|ruff|mypy|pyright)$/.test(first))
    return 'python';
  if (first === 'go' || first === 'gofmt' || first === 'golangci-lint') return 'go';
  if (first === 'cargo' || first === 'rustc') return 'rust';
  if (/^(make|cmake|ctest|ninja|meson|cc|gcc|clang|c\+\+)$/.test(first)) return 'c';
  if (first === 'swift') return 'swift';
  return undefined;
}

/** 报告里与这个检查相关的不就绪阻塞项：检查自己、检查目录所在项目的依赖与锁文件、命令要用的语言生态的工具。 */
export function relevantBlocking(
  report: Pick<ReadinessReport, 'items'>,
  check: Pick<CheckDefinition, 'id' | 'cwd' | 'command'>,
): ReadinessItem[] {
  const parsed = parseCheckCommand(check.command);
  const cwd = joinRel(check.cwd, parsed.cd ?? '').replace(/\/+$/, '');
  const ecosystem = commandEcosystem(check.command);
  const bad = report.items.filter((item) => item.blocking && item.status !== 'ready');
  const relevant = bad.filter((item) => {
    if (item.kind === 'check') return item.checkId === check.id;
    if (!within(cwd, item.path)) return false;
    const of = itemEcosystem(item);
    return ecosystem === undefined || of === undefined || of === ecosystem;
  });
  const order = [
    'check',
    'dependencies',
    'lockfile',
    'runtime',
    'package_manager',
    'compiler',
    'build_tool',
  ];
  return relevant.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
