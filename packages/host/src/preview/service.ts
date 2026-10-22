// 开发服务器预览（0.84.0，`preview.*`，ADR-0013）：运行配置（store.ts）、候选（candidates.ts）与启动。启动等于在会话里起一个后台进程
// （processes.ts，带 `preview`），复用它的日志、停止与 Host 退出时结束；这里另外管四件事：
// - 同一根目录（会话目录）、同名的已在跑时不起第二份（`reused`）；
// - 启动前问环境就绪（ADR-0011 的相关阻塞项），有就不起（`blocked`）；
// - 配了端口而端口已被别的进程占着时不起（`port_in_use`，是 Wevir 起的另一项预览时带上它）；
// - 起来后判定就绪：配了端口时轮询 TCP 连接，没配端口时从输出里认本机地址再连，最多等 `PREVIEW_READY_TIMEOUT_MS`。

import { connect } from 'node:net';
import { join } from 'node:path';
import type {
  CheckId,
  PreviewCandidate,
  PreviewConfig,
  PreviewInput,
  ReadinessItem,
  SessionId,
  TurnId,
  WorkspaceId,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { AppToolError } from '../app-mcp.js';
import { HostError } from '../errors.js';
import type { ProcessInfo, ProcessManager } from '../processes.js';
import { findPreviewCandidates } from './candidates.js';
import type { PreviewStore } from './store.js';

/** 起来后最多等多久判定就绪；超时仍在跑的保持“启动中”。 */
export const PREVIEW_READY_TIMEOUT_MS = 120_000;
/** 轮询端口的间隔。 */
export const PREVIEW_POLL_MS = 500;
/** 一次 TCP 连接最多等多久。 */
const CONNECT_TIMEOUT_MS = 500;

/** 输出里的本机地址（Vite 的 `Local:   http://localhost:5173/`、Next 的 `- Local: http://localhost:3000`）。 */
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{1,5})?(?:\/[^\s'"<>)\]]*)?/i;

export type PreviewStart =
  | { status: 'started' | 'reused'; process: ProcessInfo }
  | { status: 'blocked'; readiness: ReadinessItem[] }
  /** `owner`：占着端口的是 Wevir 起的另一项预览（任一会话）时是它的进程。 */
  | { status: 'port_in_use'; port: number; url: string; owner?: ProcessInfo };

export interface PreviewList {
  root: string;
  configs: PreviewConfig[];
  candidates: PreviewCandidate[];
}

export interface PreviewServiceOptions {
  storage: Storage;
  store: PreviewStore;
  processes: ProcessManager;
  /** 环境就绪（ADR-0011）：命令相关的不就绪阻塞项。省略时不检查。 */
  readiness?: {
    blockingFor(
      workspaceId: WorkspaceId,
      sessionId: SessionId,
      check: { id: CheckId; cwd: string; command: string },
    ): Promise<ReadinessItem[]>;
  };
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** 端口能不能连上（测试替换）。 */
  probe?: (host: string, port: number) => Promise<boolean>;
  readyTimeoutMs?: number;
  pollMs?: number;
}

/** 把输出里认出的地址规整成能在本机打开的：`0.0.0.0` 与 `[::]` 换成 `localhost`。 */
export function normalizeLocalUrl(url: string): string {
  return url.replace(/^(https?:\/\/)(?:0\.0\.0\.0|\[::\])(?=[:/]|$)/i, '$1localhost');
}

/** 输出里的一行认出的本机地址；没有时 undefined。 */
export function localUrlIn(line: string): string | undefined {
  const match = LOCAL_URL.exec(line);
  return match === null ? undefined : normalizeLocalUrl(match[0]);
}

/** 地址里的端口（没写时按协议的默认端口）；地址不合法时 undefined。 */
export function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined;
  } catch {
    return undefined;
  }
}

function hostsOf(url: string | undefined): string[] {
  if (url === undefined) return ['127.0.0.1', '::1'];
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === ''
      ? ['127.0.0.1', '::1']
      : [host];
  } catch {
    return ['127.0.0.1', '::1'];
  }
}

export function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export class PreviewService {
  readonly #options: PreviewServiceOptions;
  readonly #listeners = new Set<
    (change: { workspaceId: WorkspaceId; configs: PreviewConfig[] }) => void
  >();
  /** 正在启动的（同一根目录、同名的并发启动合成一次）。 */
  readonly #starting = new Map<string, Promise<PreviewStart>>();
  /** 判定就绪的循环：Host 退出时停下。 */
  readonly #watching = new AbortController();

  constructor(options: PreviewServiceOptions) {
    this.#options = options;
  }

  /** 工作区的配置变了（保存、删除）。 */
  watch(
    listener: (change: { workspaceId: WorkspaceId; configs: PreviewConfig[] }) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async list(sessionId: SessionId): Promise<PreviewList> {
    const { workspaceId, root } = this.#session(sessionId);
    const configs = await this.#options.store.list(workspaceId);
    const saved = new Set(configs.map((config) => `${config.cwd}\0${config.command}`));
    const candidates = (await findPreviewCandidates(root)).filter(
      (candidate) => !saved.has(`${candidate.cwd}\0${candidate.command}`),
    );
    return { root, configs, candidates };
  }

  /** 会话所在的工作区（会话不在了时抛 `SESSION_NOT_FOUND`）。 */
  workspaceOf(sessionId: SessionId): WorkspaceId {
    return this.#session(sessionId).workspaceId;
  }

  configs(workspaceId: WorkspaceId): Promise<PreviewConfig[]> {
    this.#workspace(workspaceId);
    return this.#options.store.list(workspaceId);
  }

  async save(
    workspaceId: WorkspaceId,
    input: PreviewInput,
    options: { previous?: string; addedBy: PreviewConfig['addedBy'] },
  ): Promise<PreviewConfig[]> {
    this.#workspace(workspaceId);
    const configs = await this.#options.store.save(workspaceId, input, options);
    this.#changed(workspaceId, configs);
    return configs;
  }

  async remove(workspaceId: WorkspaceId, name: string): Promise<PreviewConfig[]> {
    this.#workspace(workspaceId);
    const before = await this.#options.store.list(workspaceId);
    const configs = await this.#options.store.remove(workspaceId, name);
    if (configs.length !== before.length) this.#changed(workspaceId, configs);
    return configs;
  }

  /** 工作区移除时：删掉它的配置（进程随会话删除结束）。 */
  removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    return this.#options.store.removeWorkspace(workspaceId);
  }

  /** 这个根目录下这项配置在跑的预览（任一会话起的）。 */
  running(root: string, name: string): ProcessInfo | undefined {
    return this.#options.processes
      .listAll()
      .find(
        (info) =>
          info.status === 'running' &&
          info.preview !== undefined &&
          info.preview.root === root &&
          info.preview.name === name,
      );
  }

  /** 这个根目录下的预览（在跑的与已退出的），新的在后。 */
  previews(root: string): ProcessInfo[] {
    return this.#options.processes
      .listAll()
      .filter((info) => info.preview?.root === root)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 在这个会话里按名字启动。 */
  start(params: {
    sessionId: SessionId;
    name: string;
    startedBy: 'user' | 'agent';
    turnId?: TurnId;
  }): Promise<PreviewStart> {
    const { root } = this.#session(params.sessionId);
    const key = `${root}\0${params.name}`;
    const pending = this.#starting.get(key);
    if (pending !== undefined) return pending;
    const started = this.#start(params).finally(() => this.#starting.delete(key));
    this.#starting.set(key, started);
    return started;
  }

  /** 等它就绪、退出或超时（`signal` 中止时也返回），返回此刻的状态。 */
  async waitReady(
    sessionId: SessionId,
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessInfo> {
    const deadline = Date.now() + timeoutMs;
    const poll = Math.min(this.#options.pollMs ?? PREVIEW_POLL_MS, 250);
    for (;;) {
      const info = this.#options.processes.info(sessionId, id);
      if (info.status !== 'running' || info.preview?.ready === true) return info;
      if (Date.now() >= deadline || signal?.aborted === true) return info;
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  dispose(): void {
    this.#watching.abort();
    this.#listeners.clear();
  }

  async #start(params: {
    sessionId: SessionId;
    name: string;
    startedBy: 'user' | 'agent';
    turnId?: TurnId;
  }): Promise<PreviewStart> {
    const { sessionId, name, startedBy } = params;
    const { workspaceId, root } = this.#session(sessionId);
    const config = (await this.#options.store.list(workspaceId)).find((c) => c.name === name);
    if (config === undefined) {
      throw new HostError('INVALID_PARAMS', `no run configuration named ${name}`, {
        issues: [{ path: ['name'], message: 'not found' }],
      });
    }
    const running = this.running(root, name);
    if (running !== undefined) return { status: 'reused', process: running };

    const readiness = this.#options.readiness;
    if (readiness !== undefined) {
      const items = await readiness
        .blockingFor(workspaceId, sessionId, {
          id: 'preview' as CheckId,
          cwd: config.cwd,
          command: config.command,
        })
        .catch((error: unknown) => {
          this.#options.onWarning?.('环境预检失败', { name, error: String(error) });
          return [] as ReadinessItem[];
        });
      if (items.length > 0) return { status: 'blocked', readiness: items.slice(0, 8) };
    }

    const port = config.port ?? (config.url === undefined ? undefined : portOf(config.url));
    const url = config.url ?? (port === undefined ? undefined : `http://localhost:${port}`);
    if (port !== undefined && (await this.#open(hostsOf(config.url), port))) {
      const owner = this.#previewOnPort(port);
      return {
        status: 'port_in_use',
        port,
        url: url ?? `http://localhost:${port}`,
        ...(owner !== undefined && { owner }),
      };
    }

    let info: ProcessInfo;
    try {
      info = await this.#options.processes.start(sessionId, {
        command: config.command,
        cwd: config.cwd === '' ? root : join(root, config.cwd),
        name: config.name,
        ...(config.env !== undefined && { env: config.env }),
        // 用户起的不叫醒 Agent；Agent 起的退出时照常告诉它。
        notifyOnExit: startedBy === 'agent',
        ...(params.turnId !== undefined && { turnId: params.turnId }),
        preview: {
          name: config.name,
          root,
          ...(port !== undefined && { port }),
          ...(url !== undefined && { url }),
          ready: false,
          startedBy,
        },
      });
    } catch (error) {
      if (error instanceof AppToolError) {
        throw new HostError('INVALID_PARAMS', error.message, {
          issues: [{ path: ['sessionId'], message: error.message }],
        });
      }
      throw error;
    }
    if (info.status === 'running') {
      void this.#watchReady(info, port, config.url).catch((error: unknown) =>
        this.#options.onWarning?.('预览的就绪判定出错', { id: info.id, error: String(error) }),
      );
    }
    return { status: 'started', process: info };
  }

  /** 判定就绪：配了端口时轮询；没配时先等输出里的本机地址。 */
  async #watchReady(info: ProcessInfo, port: number | undefined, url: string | undefined) {
    const { processes } = this.#options;
    const signal = this.#watching.signal;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? PREVIEW_READY_TIMEOUT_MS);
    let target = port;
    let hosts = hostsOf(url);
    if (target === undefined) {
      const waited = await processes.wait(
        info.sessionId,
        info.id,
        LOCAL_URL,
        Math.max(0, deadline - Date.now()),
        signal,
      );
      const found = waited.line === undefined ? undefined : localUrlIn(waited.line);
      if (waited.reason !== 'match' || found === undefined) return;
      target = portOf(found);
      hosts = hostsOf(found);
      if (!this.#alive(info)) return;
      processes.setPreview(info.sessionId, info.id, { url: found });
      if (target === undefined) return;
    }
    const poll = this.#options.pollMs ?? PREVIEW_POLL_MS;
    while (Date.now() < deadline && !signal.aborted && this.#alive(info)) {
      if (await this.#open(hosts, target)) {
        if (this.#alive(info)) processes.setPreview(info.sessionId, info.id, { ready: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  /** 在跑、端口是 `port` 的预览（配置的端口，或输出里认出的地址的端口）。 */
  #previewOnPort(port: number): ProcessInfo | undefined {
    return this.#options.processes
      .listAll()
      .find(
        (info) =>
          info.status === 'running' &&
          info.preview !== undefined &&
          (info.preview.port ??
            (info.preview.url === undefined ? undefined : portOf(info.preview.url))) === port,
      );
  }

  #alive(info: ProcessInfo): boolean {
    return this.#options.processes.find(info.id)?.status === 'running';
  }

  async #open(hosts: readonly string[], port: number): Promise<boolean> {
    const probe = this.#options.probe ?? tcpProbe;
    const results = await Promise.all(hosts.map((host) => probe(host, port)));
    return results.some(Boolean);
  }

  #changed(workspaceId: WorkspaceId, configs: PreviewConfig[]): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener({ workspaceId, configs: structuredClone(configs) });
      } catch {}
    }
  }

  #workspace(workspaceId: WorkspaceId) {
    const workspace = this.#options.storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    return workspace;
  }

  #session(sessionId: SessionId): { workspaceId: WorkspaceId; root: string } {
    const record = this.#options.storage.sessions.get(sessionId);
    const workspace = record && this.#options.storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) {
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    return { workspaceId: record.workspaceId as WorkspaceId, root: record.cwd };
  }
}
