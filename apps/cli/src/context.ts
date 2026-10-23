import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type ConnectionState, WevirClient, webSocketTransport } from '@wevir/client-sdk';
import { readHostEndpoint } from '@wevir/client-sdk/node';
import type { ClientIdentity, HostFeature, Workspace } from '@wevir/protocol';
import { CliError, describeError, UsageError } from './errors.js';
import { t } from './i18n/index.js';
import { loadCliIdentity } from './identity.js';
import { connectRemoteHost, mdnsDiscovery } from './remote/connect.js';
import type { browseWevirHosts } from './remote/mdns.js';
import { findRemoteHost } from './remote/store.js';
import { type Styles, stylesFor } from './style.js';

export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface OutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
}

/** `runCli` 用到的进程能力，测试时替换。 */
export interface CliIO {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** 相对路径的基准。 */
  cwd: string;
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  /** 订阅 SIGINT（终端不在 raw 模式时的 Ctrl-C），返回取消订阅的函数。 */
  onInterrupt(listener: () => void): () => void;
  /** 局域网 mDNS 发现（远程电脑）；测试换掉，默认发真的查询。 */
  browseMdns?: typeof browseWevirHosts;
}

export interface Context {
  io: CliIO;
  /** 数据目录（绝对路径），与 Host 的解析规则相同。 */
  home: string;
  styles: Styles;
  /** 写一行到 stdout。 */
  print(text?: string): void;
  /** 写一行错误说明与建议到 stderr。 */
  printError(error: unknown): void;
  identity(): Promise<ClientIdentity>;
  /** `--remote <名称>`：命令连到这台配对过的电脑，而不是本机 Host。 */
  remote?: string;
  /** 登记一个退出前要等完的写入（记回远程电脑的地址）。 */
  track(write: Promise<unknown>): void;
  /** 等登记的写入都结束。 */
  settle(): Promise<void>;
}

export interface ConnectOptions {
  /** 断线后自动重连（attach 用）。一次性命令默认不需要：首次连接失败即报错。 */
  onStateChange?: (state: ConnectionState) => void;
  connectMs?: number;
}

/**
 * 连接本机 Host。先读一次 `run/host.json`，Host 没在运行时立即报错（不去创建身份文件）；连接之后的每次
 * 重连都重读，Host 重启换了端口与令牌也能接上。
 */
export async function connect(ctx: Context, options: ConnectOptions = {}): Promise<WevirClient> {
  if (ctx.remote !== undefined) return connectRemote(ctx, ctx.remote, options);
  await readHostEndpoint(ctx.home);
  const identity = await ctx.identity();
  return WevirClient.connect({
    endpoint: () => readHostEndpoint(ctx.home),
    transport: webSocketTransport(globalThis.WebSocket),
    identity,
    timeouts: { connectMs: options.connectMs ?? 5000 },
    ...(options.onStateChange && { onStateChange: options.onStateChange }),
  });
}

/** 远程连接的时限：要并行试几个地址、做 Noise 握手，比本机 loopback 慢。 */
const REMOTE_CONNECT_MS = 10_000;

/** 连接配对过的电脑 `name`（`wevir remote pair` 记下的）。 */
async function connectRemote(
  ctx: Context,
  name: string,
  options: ConnectOptions,
): Promise<WevirClient> {
  const record = await findRemoteHost(ctx.home, name);
  if (record === undefined) {
    throw new CliError(t('remote.unknown', { name }), t('remote.unknown.hint'));
  }
  const browse = ctx.io.browseMdns;
  // 经中继时在 stderr 说一声（比直连慢、多一程）；之后换回直连时也说。直连是常态，不提。
  const note = stylesFor(ctx.io.stderr);
  let lastRoute: 'direct' | 'relay' | undefined;
  const onRoute = (kind: 'direct' | 'relay') => {
    if (kind === 'relay' ? lastRoute !== 'relay' : lastRoute === 'relay') {
      ctx.io.stderr.write(
        `${note.dim(t(kind === 'relay' ? 'remote.viaRelay' : 'remote.viaDirect', { name }))}\n`,
      );
    }
    lastRoute = kind;
  };
  return connectRemoteHost({
    home: ctx.home,
    record,
    identity: await ctx.identity(),
    connectMs: options.connectMs ?? REMOTE_CONNECT_MS,
    ...(options.onStateChange && { onStateChange: options.onStateChange }),
    onRoute,
    ...(browse !== undefined && { discover: mdnsDiscovery(record.routeId, browse) }),
    track: ctx.track,
  });
}

/** Host 没有某项功能（版本旧）时给出明确的说明。 */
export function requireFeature(
  client: Pick<WevirClient, 'supports' | 'hello'>,
  feature: HostFeature,
): void {
  if (!client.supports(feature)) {
    throw new CliError(
      t('host.unsupported', { version: client.hello.hostVersion, feature }),
      t('host.unsupported.hint'),
    );
  }
}

/**
 * 按路径找已登记的工作区：本机相对 cwd 解析，Host 按 realpath 存（目录不存在时按原样比较）；`--remote` 时是那台电脑上的路径，
 * 必须是绝对路径，按原样比较。
 */
export async function findWorkspace(
  ctx: Context,
  workspaces: readonly Workspace[],
  path: string,
): Promise<Workspace> {
  const resolved = workspacePath(ctx, path);
  const real = ctx.remote === undefined ? await realpath(resolved).catch(() => resolved) : resolved;
  const found = workspaces.find((w) => w.rootPath === real);
  if (!found) {
    throw new CliError(
      t('session.notWorkspace', { path: resolved }),
      t('session.notWorkspace.hint'),
    );
  }
  return found;
}

/** 工作区路径：本机相对 cwd 解析；`--remote` 时必须是绝对路径（POSIX 的 `/…` 或 Windows 的 `C:\\…`）。 */
export function workspacePath(ctx: Context, path: string): string {
  if (ctx.remote === undefined) return resolve(ctx.io.cwd, path);
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  throw new UsageError(t('session.remotePath', { path }), t('session.remotePath.hint'));
}

/** 连上 Host 执行 `fn`，结束后关闭连接。 */
export async function withClient<T>(
  ctx: Context,
  fn: (client: WevirClient) => Promise<T>,
): Promise<T> {
  const client = await connect(ctx);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export function createContext(io: CliIO, home: string, remote?: string): Context {
  const styles = stylesFor(io.stdout);
  const errStyles = stylesFor(io.stderr);
  let identity: Promise<ClientIdentity> | undefined;
  const writes = new Set<Promise<unknown>>();
  return {
    io,
    home,
    ...(remote !== undefined && { remote }),
    styles,
    track: (write) => {
      writes.add(write);
      void write.finally(() => writes.delete(write));
    },
    settle: async () => {
      while (writes.size > 0) await Promise.allSettled([...writes]);
    },
    print: (text = '') => {
      io.stdout.write(`${text}\n`);
    },
    printError: (error) => {
      const { message, hint } = describeError(error);
      io.stderr.write(`${errStyles.red(t('error.prefix', { message }))}\n`);
      if (hint) io.stderr.write(`${errStyles.dim(t('error.hint', { hint }))}\n`);
    },
    identity: () => {
      identity ??= loadCliIdentity(home);
      return identity;
    },
  };
}
