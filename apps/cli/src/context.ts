import { type ConnectionState, WevirClient, webSocketTransport } from '@wevir/client-sdk';
import { readHostEndpoint } from '@wevir/client-sdk/node';
import type { ClientIdentity } from '@wevir/protocol';
import { describeError } from './errors.js';
import { t } from './i18n/index.js';
import { loadCliIdentity } from './identity.js';
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

export function createContext(io: CliIO, home: string): Context {
  const styles = stylesFor(io.stdout);
  const errStyles = stylesFor(io.stderr);
  let identity: Promise<ClientIdentity> | undefined;
  return {
    io,
    home,
    styles,
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
