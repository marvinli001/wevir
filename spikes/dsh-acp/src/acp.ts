// 启动 `dsh --profile acp` 并用 @agentclientprotocol/sdk 作为客户端连接。
// 在 SDK 的 Stream 外包一层，逐帧记录双向 JSON-RPC 原文，供 fixtures 与报告使用。

import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  type AnyMessage,
  type ClientConnection,
  type ClientContext,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk';
import { childEnv, DSH_BIN, DSH_HOME, ensureDir, FIXTURES_DIR, sanitize } from './env.ts';

export interface Frame {
  /** 自 spawn 起的毫秒数 */
  t: number;
  /** c2a：客户端 → dsh；a2c：dsh → 客户端 */
  dir: 'c2a' | 'a2c';
  msg: AnyMessage;
}

export interface PermissionEvent {
  t: number;
  params: RequestPermissionRequest;
  response: RequestPermissionResponse;
}

export type PermissionPolicy = (
  params: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export interface AcpRun {
  label: string;
  child: ChildProcess;
  conn: ClientConnection;
  agent: ClientContext;
  frames: Frame[];
  updates: Array<{ t: number; n: SessionNotification }>;
  /** stream-tap 插件经额外 fd 写出的 agent/assistant-stream 帧 */
  tapFrames: Array<{ t: number; frame: unknown }>;
  permissions: PermissionEvent[];
  /** 当前的审批策略，步骤之间可以替换 */
  policy: PermissionPolicy;
  spawnedAt: number;
  now(): number;
  stderrTail(): string;
  close(): Promise<number | null>;
}

export const rejectAll: PermissionPolicy = async (params) => ({
  outcome: { outcome: 'selected', optionId: pick(params, 'reject_once') },
});

export const allowAll: PermissionPolicy = async (params) => ({
  outcome: { outcome: 'selected', optionId: pick(params, 'allow_once') },
});

function pick(params: RequestPermissionRequest, kind: string): string {
  const option = params.options.find((o) => o.kind === kind) ?? params.options[0];
  if (option === undefined) throw new Error('request_permission 没有任何选项');
  return option.optionId;
}

function tap(raw: Stream, record: (dir: Frame['dir'], msg: AnyMessage) => void): Stream {
  const writer = raw.writable.getWriter();
  return {
    readable: raw.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform(msg, controller) {
          record('a2c', msg);
          controller.enqueue(msg);
        },
      }),
    ),
    writable: new WritableStream<AnyMessage>({
      async write(msg) {
        record('c2a', msg);
        await writer.write(msg);
      },
      async close() {
        await writer.close();
      },
      async abort(reason) {
        await writer.abort(reason);
      },
    }),
  };
}

export interface StartOptions {
  label: string;
  overlays?: string[];
  env?: Record<string, string | undefined>;
  /** dsh 进程自己的 cwd。默认 DSH_HOME：dsh 会读取 <进程 cwd>/.env 作为凭据回退，不能指向用户目录。 */
  processCwd?: string;
  /** 额外打开 fd 3 并设置 WEVIR_STREAM_FD=3，供 stream-tap 插件写增量分片 */
  streamTap?: boolean;
}

export function startAcp(opts: StartOptions): AcpRun {
  const args = ['--profile', 'acp', ...(opts.overlays ?? []).flatMap((p) => ['--patch', p])];
  const spawnedAt = performance.now();
  const withTap = opts.streamTap === true;
  const child = spawn(process.execPath, [DSH_BIN, ...args], {
    cwd: ensureDir(opts.processCwd ?? DSH_HOME),
    env: childEnv({ ...(withTap ? { WEVIR_STREAM_FD: '3' } : {}), ...opts.env }),
    stdio: withTap ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_000);
  });
  if (child.stdin === null || child.stdout === null) throw new Error('dsh stdio 未建立');

  const now = () => Math.round(performance.now() - spawnedAt);
  const tapFrames: AcpRun['tapFrames'] = [];
  const tapStream = child.stdio[3];
  if (withTap && tapStream instanceof Readable) {
    let buffer = '';
    tapStream.setEncoding('utf8');
    tapStream.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        tapFrames.push({ t: now(), frame: JSON.parse(buffer.slice(0, nl)) });
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });
  }
  const frames: Frame[] = [];
  const updates: AcpRun['updates'] = [];
  const permissions: PermissionEvent[] = [];
  const raw = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const stream = tap(raw, (dir, msg) => frames.push({ t: now(), dir, msg }));

  const run = {} as AcpRun;
  const conn = client({ name: 'wevir-spike' })
    .onRequest(methods.client.session.requestPermission, async ({ params, signal }) => {
      const t = now();
      const response = await run.policy(params, signal);
      permissions.push({ t, params, response });
      return response;
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push({ t: now(), n: params });
    })
    .connect(stream);

  Object.assign(run, {
    label: opts.label,
    child,
    conn,
    agent: conn.agent,
    frames,
    updates,
    tapFrames,
    permissions,
    policy: rejectAll,
    spawnedAt,
    now,
    stderrTail: () => stderr,
    close: () => stop(child, conn),
  } satisfies AcpRun);
  return run;
}

async function stop(child: ChildProcess, conn: ClientConnection): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  conn.close();
  child.stdin?.end();
  const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
  if ((await Promise.race([exited, timeout(8000)])) !== 'timeout') return exited;
  child.kill('SIGTERM');
  if ((await Promise.race([exited, timeout(3000)])) !== 'timeout') return exited;
  child.kill('SIGKILL');
  return exited;
}

export async function initialize(run: AcpRun) {
  return run.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'wevir-spike', version: '0.0.0' },
  });
}

export interface PromptOutcome {
  sessionId: string;
  text: string;
  response?: PromptResponse;
  error?: unknown;
  sentAt: number;
  settledAt: number;
  firstUpdateAt?: number;
  updates: Array<{ t: number; n: SessionNotification }>;
  /** stream-tap 插件经额外 fd 写出的 agent/assistant-stream 帧 */
  tapFrames: Array<{ t: number; frame: unknown }>;
  permissions: PermissionEvent[];
  frames: Frame[];
}

export interface PromptOptions {
  /** 收到第一个满足条件的 update 后发送 session/cancel */
  cancelWhen?: (n: SessionNotification) => boolean;
  /** cancelWhen 命中后再等多久才取消；期间执行 beforeCancel */
  cancelDelayMs?: number;
  beforeCancel?: () => void;
  /** 发出后多少毫秒仍未结束则发送 session/cancel */
  cancelAfterMs?: number;
}

export async function prompt(
  run: AcpRun,
  sessionId: string,
  text: string,
  opts: PromptOptions = {},
): Promise<PromptOutcome & { cancelSentAt?: number }> {
  const u0 = run.updates.length;
  const p0 = run.permissions.length;
  const f0 = run.frames.length;
  const k0 = run.tapFrames.length;
  const sentAt = run.now();
  let cancelSentAt: number | undefined;
  const cancel = () => {
    if (cancelSentAt !== undefined) return;
    cancelSentAt = run.now();
    void run.agent.notify(methods.agent.session.cancel, { sessionId });
  };
  let timer: NodeJS.Timeout | undefined;
  if (opts.cancelAfterMs !== undefined) timer = setTimeout(cancel, opts.cancelAfterMs);
  let watcher: NodeJS.Timeout | undefined;
  if (opts.cancelWhen !== undefined) {
    const when = opts.cancelWhen;
    watcher = setInterval(() => {
      if (run.updates.slice(u0).some((u) => u.n.sessionId === sessionId && when(u.n))) {
        clearInterval(watcher);
        setTimeout(() => {
          opts.beforeCancel?.();
          cancel();
        }, opts.cancelDelayMs ?? 0);
      }
    }, 20);
  }
  const outcome: PromptOutcome & { cancelSentAt?: number } = {
    sessionId,
    text,
    sentAt,
    settledAt: 0,
    updates: [],
    tapFrames: [],
    permissions: [],
    frames: [],
  };
  try {
    outcome.response = await run.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  } catch (error) {
    outcome.error = error;
  } finally {
    clearTimeout(timer);
    clearInterval(watcher);
  }
  outcome.settledAt = run.now();
  outcome.cancelSentAt = cancelSentAt;
  outcome.updates = run.updates.slice(u0).filter((u) => u.n.sessionId === sessionId);
  outcome.firstUpdateAt = outcome.updates[0]?.t;
  outcome.permissions = run.permissions.slice(p0).filter((p) => p.params.sessionId === sessionId);
  outcome.frames = run.frames.slice(f0);
  outcome.tapFrames = run.tapFrames.slice(k0);
  return outcome;
}

/** 汇总一组 update：按 sessionUpdate 计数，拼出助手文本。 */
export function summarizeUpdates(updates: Array<{ n: SessionNotification }>) {
  const counts: Record<string, number> = {};
  let assistantText = '';
  for (const { n } of updates) {
    const kind = n.update.sessionUpdate;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === 'agent_message_chunk' && n.update.content.type === 'text') {
      assistantText += n.update.content.text;
    }
  }
  return { counts, assistantText };
}

export function errorInfo(error: unknown): unknown {
  if (error === undefined) return undefined;
  if (error instanceof Error) {
    const extra = error as Error & { code?: unknown; data?: unknown };
    return { name: error.name, message: error.message, code: extra.code, data: extra.data };
  }
  return error;
}

/** 写一个 JSON fixture（脱敏）。 */
export function saveFixture(rel: string, data: unknown): string {
  const file = join(FIXTURES_DIR, rel);
  ensureDir(join(file, '..'));
  writeFileSync(file, `${sanitize(JSON.stringify(data, null, 2))}\n`);
  return file;
}

/** 写完整的线上帧记录（脱敏的 JSON Lines），供离线回放测试。 */
export function saveTranscript(rel: string, frames: Frame[]): string {
  const file = join(FIXTURES_DIR, rel);
  ensureDir(join(file, '..'));
  writeFileSync(
    file,
    frames
      .map((f) => sanitize(JSON.stringify(f)))
      .join('\n')
      .concat('\n'),
  );
  return file;
}
