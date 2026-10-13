// Gate M2（SKELETON_PLAN §6 M2）与 T2.5 进程入口的端到端验收。
//
// 运行：pnpm gate:m2（先构建 @wevir/host 及其依赖，再用 Node 直接执行本文件）。加 --keep 保留临时
// 数据目录。
//
// 本脚本是“最小测试客户端”：只用 Node 内置模块与全局 WebSocket，不 import 任何工作区包；端点、令牌与
// 协议版本都从 <数据目录>/run/host.json 读取，和真正的客户端一样（ADR-0002 §6）。Host 以子进程运行
// packages/host/dist/main.js（wevir-host），使用 EchoAdapter。
//
// A. Gate M2 主流程：hello → workspace.add → provider.upsert → session.create → events.subscribe →
//    session.send（流式增量）→ 审批并允许 → 再发一条并 cancel → SIGKILL 杀掉 Host → 重启 →
//    events.subscribe(sinceSeq=0) 回放的事件与之前逐条完全一致 → host.shutdown。
// B. T2.5 补充：--adapter dsh 能启动（T3.6 接通）、同一数据目录拒绝第二个 Host、SIGTERM 时取消运行中的回合
//    并把未决审批结为 cancelled（host_shutdown）、退出步骤顺序、stdin 归属管道 EOF 退出、日志脱敏。

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_BIN = join(ROOT, 'packages', 'host', 'dist', 'main.js');
const TIMEOUT_MS = 10_000;
const KEEP = process.argv.includes('--keep');
const POSIX = process.platform !== 'win32';

// ── 输出 ──────────────────────────────────────────────────────────────

let passed = 0;

function ok(label: string, detail?: string): void {
  passed += 1;
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

class GateFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GateFailure(message);
}

// ── Host 子进程 ───────────────────────────────────────────────────────

interface RuntimeInfo {
  pid: number;
  startedAt: string;
  url?: string;
  token?: string;
  protocolVersion: string;
  hostVersion: string;
}

interface Ready {
  event: 'ready';
  pid: number;
  url: string;
  hostId: string;
  home: string;
}

interface HostProcess {
  child: ChildProcess;
  ready: Promise<Ready>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
}

const children = new Set<ChildProcess>();

function spawnHost(
  home: string,
  extraArgs: string[] = [],
  stdin: 'ignore' | 'pipe' = 'ignore',
): HostProcess {
  // 不继承本进程的 execArgv，也不让 WEVIR_HOME 盖过 --home。
  const env = { ...process.env };
  delete env.WEVIR_HOME;
  const child = spawn(process.execPath, [HOST_BIN, '--home', home, ...extraArgs], {
    cwd: ROOT,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  const ready = new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GateFailure(`Host 未在 ${TIMEOUT_MS} ms 内就绪：${stderr}`)),
      TIMEOUT_MS,
    );
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((l) => l.startsWith('{"event":"ready"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Ready);
      }
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new GateFailure(`Host 在就绪前退出（code ${code}，signal ${signal}）：${stderr}`));
    });
  });
  ready.catch(() => {});
  return { child, ready, exited, stderr: () => stderr };
}

/** 跑一个预期很快退出的 wevir-host，返回退出码与 stderr。 */
async function runHostOnce(
  home: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  const host = spawnHost(home, args);
  const { code } = await withTimeout(host.exited, TIMEOUT_MS, 'wevir-host 退出');
  return { code, stderr: host.stderr() };
}

function runtimeFilePath(home: string): string {
  return join(home, 'run', 'host.json');
}

function readRuntimeInfo(home: string): RuntimeInfo {
  return JSON.parse(readFileSync(runtimeFilePath(home), 'utf8')) as RuntimeInfo;
}

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
}

function readLog(home: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(home, 'logs', 'host.log'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── 最小 JSON-RPC 客户端 ───────────────────────────────────────────────

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

class RpcRequestError extends Error {
  readonly error: RpcError;
  constructor(method: string, error: RpcError) {
    super(`${method} 失败：${error.code} ${error.message}`);
    this.error = error;
  }
}

interface WevirEvent {
  seq: number;
  sessionId: string;
  ts: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
}

class RpcClient {
  readonly #ws: WebSocket;
  readonly #pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  readonly #waiters = new Set<() => void>();
  #nextId = 1;
  /** 按订阅收到的事件，按到达顺序。 */
  readonly events = new Map<string, WevirEvent[]>();
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (message) => this.#onMessage(String(message.data)));
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (event) => {
        for (const { reject } of this.#pending.values())
          reject(new Error(`连接已关闭（${event.code}）`));
        this.#pending.clear();
        this.#notify();
        resolve({ code: event.code, reason: event.reason });
      });
    });
  }

  static async connect(url: string): Promise<RpcClient> {
    const ws = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new GateFailure(`无法连接 ${url}`)), {
          once: true,
        });
      }),
      TIMEOUT_MS,
      `连接 ${url}`,
    );
    return new RpcClient(ws);
  }

  request<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = this.#nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
    });
    this.#ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return withTimeout(result, TIMEOUT_MS, method);
  }

  hello(info: RuntimeInfo, clientId: string): Promise<Record<string, unknown>> {
    return this.request('host.hello', {
      token: info.token,
      protocolVersion: info.protocolVersion,
      clientKind: 'cli',
      deviceId: 'gate-m2-device',
      clientId,
      capabilities: {},
    });
  }

  /** 订阅并返回 `{subscriptionId, replayedThroughSeq}`；之后的事件收进 `events`。 */
  async subscribe(
    sessionId: string,
    sinceSeq: number,
  ): Promise<{ subscriptionId: string; replayedThroughSeq: number }> {
    const result = await this.request<{ subscriptionId: string; replayedThroughSeq: number }>(
      'events.subscribe',
      {
        sessionId,
        sinceSeq,
      },
    );
    if (!this.events.has(result.subscriptionId)) this.events.set(result.subscriptionId, []);
    return result;
  }

  /** 每收到一帧（或连接关闭）就检查一次，直到 `check` 返回非 undefined。 */
  until<T>(check: () => T | undefined, label: string, timeoutMs = TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        let value: T | undefined;
        try {
          value = check();
        } catch (error) {
          finish();
          reject(error);
          return;
        }
        if (value !== undefined) {
          finish();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new GateFailure(`等待超时（${timeoutMs} ms）：${label}`));
      }, timeoutMs);
      const finish = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(run);
      };
      this.#waiters.add(run);
      run();
    });
  }

  close(): void {
    this.#ws.close();
  }

  #onMessage(text: string): void {
    const frame = JSON.parse(text) as {
      id?: number;
      result?: unknown;
      error?: RpcError;
      method?: string;
      params?: { subscriptionId: string; event: WevirEvent };
    };
    if (frame.method === 'events.event' && frame.params) {
      const list = this.events.get(frame.params.subscriptionId) ?? [];
      list.push(frame.params.event);
      this.events.set(frame.params.subscriptionId, list);
    } else if (typeof frame.id === 'number') {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        if (frame.error) pending.reject(new RpcRequestError(pending.method, frame.error));
        else pending.resolve(frame.result);
      }
    }
    this.#notify();
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GateFailure(`超时（${ms} ms）：${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }];
}

function turnEvents(events: WevirEvent[], turnId: string): WevirEvent[] {
  return events.filter((event) => event.payload.turnId === turnId);
}

function finishedTurn(events: WevirEvent[], turnId: string): WevirEvent | undefined {
  return events.find((event) => event.type === 'turn.finished' && event.payload.turnId === turnId);
}

function lastState(events: WevirEvent[]): string | undefined {
  const changes = events.filter((event) => event.type === 'session.state_changed');
  return changes.at(-1)?.payload.to as string | undefined;
}

function assertContiguous(events: WevirEvent[]): void {
  events.forEach((event, index) => {
    assert(event.seq === index + 1, `seq 不连续：第 ${index + 1} 条是 seq ${event.seq}`);
  });
}

/** 第一处不一致的位置与两边的内容，用于失败报告。 */
function firstDifference(a: WevirEvent[], b: WevirEvent[]): string {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (!isDeepStrictEqual(a[i], b[i])) {
      return `第 ${i + 1} 条：\n    之前 ${JSON.stringify(a[i])}\n    回放 ${JSON.stringify(b[i])}`;
    }
  }
  return '无';
}

// ── A. Gate M2 主流程 ──────────────────────────────────────────────────

const API_KEY = `sk-gate-m2-${Math.random().toString(36).slice(2)}`;
const seenTokens: string[] = [];

interface MainFlowResult {
  workspaceId: string;
  providerId: string;
}

async function mainFlow(home: string, workspaceDir: string): Promise<MainFlowResult> {
  section('A. Gate M2 主流程（EchoAdapter）');

  // A1 启动
  const host1 = spawnHost(home, ['--adapter', 'echo']);
  const ready1 = await host1.ready;
  const info1 = readRuntimeInfo(home);
  assert(
    info1.url === ready1.url && info1.pid === ready1.pid,
    'host.json 的 url / pid 与就绪行不一致',
  );
  assert(
    typeof info1.token === 'string' && Buffer.from(info1.token, 'base64url').length === 32,
    '令牌不是 32 字节 base64url',
  );
  seenTokens.push(info1.token);
  if (POSIX) {
    assert(mode(join(home, 'run')) === '0700', `run/ 权限是 ${mode(join(home, 'run'))}`);
    assert(
      mode(runtimeFilePath(home)) === '0600',
      `host.json 权限是 ${mode(runtimeFilePath(home))}`,
    );
  }
  ok(
    '启动 Host #1，读取 run/host.json',
    `pid ${info1.pid}，${info1.url}，令牌 32 字节${POSIX ? '，run/ 0700、host.json 0600' : ''}`,
  );

  // A2 hello
  const client = await RpcClient.connect(info1.url as string);
  const hello = await client.hello(info1, 'gate-m2-a');
  assert(hello.hostId === ready1.hostId, 'hello 的 hostId 与就绪行不一致');
  ok(
    'host.hello',
    `hostId ${hello.hostId}，协议 ${hello.protocolVersion}，Host ${hello.hostVersion}`,
  );

  // A3 workspace.add
  const { workspace } = await client.request<{ workspace: { id: string; rootPath: string } }>(
    'workspace.add',
    {
      rootPath: workspaceDir,
    },
  );
  ok('workspace.add', `${workspace.id} → ${workspace.rootPath}`);

  // session.create 需要一个 Provider；Key 只为验证日志脱敏，EchoAdapter 不用它。
  const providerId = 'gate-echo';
  await client.request('provider.upsert', {
    id: providerId,
    kind: 'openai-compatible',
    displayName: 'Gate M2 (echo)',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'echo-model' }],
    defaultModelId: 'echo-model',
    apiKey: API_KEY,
  });
  ok('provider.upsert', `${providerId}（session.create 需要 Provider）`);

  // A4 session.create + 订阅
  const { session } = await client.request<{
    session: { id: string; state: string; lastSeq: number };
  }>('session.create', { workspaceId: workspace.id, providerId });
  assert(
    session.state === 'idle' && session.lastSeq === 1,
    `新会话应为 idle、lastSeq 1，实际 ${session.state} / ${session.lastSeq}`,
  );
  const sub = await client.subscribe(session.id, 0);
  const live = client.events.get(sub.subscriptionId) as WevirEvent[];
  await client.until(() => (live.length >= 1 ? true : undefined), 'session.created');
  assert(live[0]?.type === 'session.created', '第一条事件不是 session.created');
  ok(
    'session.create + events.subscribe(sinceSeq=0)',
    `${session.id}，replayedThroughSeq ${sub.replayedThroughSeq}`,
  );

  // A5 发消息，收流式事件
  const send1 = await client.request<{ turnId: string; seq: number }>('session.send', {
    sessionId: session.id,
    content: text('你好，Gate M2：请回显这句话，验证流式增量。'),
  });
  const finished1 = await client.until(() => finishedTurn(live, send1.turnId), '第 1 回合结束');
  const turn1 = turnEvents(live, send1.turnId);
  const deltas1 = turn1.filter((event) => event.type === 'assistant.delta').length;
  const message1 = turn1.find((event) => event.type === 'assistant.message');
  assert(deltas1 >= 2, `应收到多条 assistant.delta，实际 ${deltas1}`);
  assert(message1, '没有 assistant.message');
  assert(finished1.payload.outcome === 'completed', `回合结果 ${finished1.payload.outcome}`);
  ok(
    'session.send → 流式事件',
    `${deltas1} 条 assistant.delta → assistant.message「${String(message1.payload.text).slice(0, 24)}…」→ turn.finished(completed)`,
  );

  // A6 审批并允许
  const send2 = await client.request<{ turnId: string }>('session.send', {
    sessionId: session.id,
    content: text('approve：请写一个文件（触发 EchoAdapter 的审批）'),
  });
  const requested = await client.until(
    () =>
      live.find(
        (event) =>
          event.type === 'approval.requested' &&
          (event.payload.approval as { turnId: string }).turnId === send2.turnId,
      ),
    'approval.requested',
  );
  const approval = requested.payload.approval as {
    id: string;
    options: Array<{ optionId: string; category: string }>;
  };
  const allow = approval.options.find((option) => option.category === 'allow');
  assert(allow, '审批没有 allow 类选项');
  assert(
    lastState(live) === 'awaiting_approval',
    `审批时会话应为 awaiting_approval，实际 ${lastState(live)}`,
  );
  const decision = await client.request<{ status: string }>('approval.respond', {
    approvalId: approval.id,
    optionId: allow.optionId,
  });
  assert(decision.status === 'approved', `approval.respond 结果 ${decision.status}`);
  const finished2 = await client.until(() => finishedTurn(live, send2.turnId), '第 2 回合结束');
  const resolvedEvent = live.find(
    (event) => event.type === 'approval.resolved' && event.payload.approvalId === approval.id,
  );
  const resolution = resolvedEvent?.payload.resolution as
    | { reason: string; decidedBy?: { clientId: string } }
    | undefined;
  assert(
    resolvedEvent?.payload.status === 'approved' && resolution?.decidedBy?.clientId === 'gate-m2-a',
    'approval.resolved 不对',
  );
  const tool2 = turnEvents(live, send2.turnId).find((event) => event.type === 'tool.finished');
  assert(tool2?.payload.status === 'completed', `审批后的工具结果 ${tool2?.payload.status}`);
  assert(finished2.payload.outcome === 'completed', `回合结果 ${finished2.payload.outcome}`);
  ok(
    '触发审批并允许',
    `${approval.id}：approval.requested → approval.respond(${allow.optionId}) → approval.resolved(approved, decidedBy=gate-m2-a) → tool.finished(completed)`,
  );

  // A7 再发一条并取消
  const prompt3 = `这一条会在流式输出中途被取消。${'取消我 '.repeat(800)}`;
  const send3 = await client.request<{ turnId: string }>('session.send', {
    sessionId: session.id,
    content: text(prompt3),
  });
  await client.until(
    () => turnEvents(live, send3.turnId).find((event) => event.type === 'assistant.delta'),
    '第 3 回合的第一条增量',
  );
  await client.request('session.cancel', { sessionId: session.id });
  const finished3 = await client.until(() => finishedTurn(live, send3.turnId), '第 3 回合结束');
  assert(finished3.payload.outcome === 'cancelled', `回合结果 ${finished3.payload.outcome}`);
  await client.until(() => (lastState(live) === 'idle' ? true : undefined), '取消后回到 idle');
  const partial = turnEvents(live, send3.turnId).find(
    (event) => event.type === 'assistant.message',
  );
  const partialLength = String(partial?.payload.text ?? '').length;
  // EchoAdapter 的完整回复是“Echo: <输入>”；补发的半段比它短，说明确实停在了中途。
  assert(
    partialLength > 0 && partialLength < `Echo: ${prompt3}`.length,
    `取消后补发的 assistant.message 长度 ${partialLength}`,
  );
  ok(
    '再发一条并 session.cancel',
    `流式中途取消 → turn.finished(cancelled) → idle；已生成的 ${partialLength}/${`Echo: ${prompt3}`.length} 字作为 assistant.message 补发`,
  );

  // A8 记录杀掉之前的事实
  const snapshotBefore = await client.request('session.get', { sessionId: session.id });
  assertContiguous(live);
  const lastSeq = (snapshotBefore.session as { lastSeq: number }).lastSeq;
  assert(live.length === lastSeq, `收到 ${live.length} 条事件，但 lastSeq 是 ${lastSeq}`);
  const types = new Map<string, number>();
  for (const event of live) types.set(event.type, (types.get(event.type) ?? 0) + 1);
  ok(
    `实时收到 ${live.length} 条事件，seq 1..${lastSeq} 连续`,
    [...types].map(([type, count]) => `${type}×${count}`).join('，'),
  );

  // A9 杀掉 Host
  host1.child.kill('SIGKILL');
  const exit1 = await withTimeout(host1.exited, TIMEOUT_MS, 'Host #1 退出');
  assert(exit1.signal === 'SIGKILL', `Host #1 退出方式 ${exit1.code}/${exit1.signal}`);
  assert(
    existsSync(runtimeFilePath(home)) && readRuntimeInfo(home).pid === info1.pid,
    'SIGKILL 后应留下陈旧的 host.json',
  );
  await client.closed;
  ok(
    'SIGKILL 杀掉 Host #1',
    `进程以 ${exit1.signal} 结束，留下陈旧的 host.json（pid ${info1.pid}）`,
  );

  // A10 重启
  const host2 = spawnHost(home, ['--adapter', 'echo']);
  const ready2 = await host2.ready;
  const info2 = readRuntimeInfo(home);
  assert(info2.pid === ready2.pid && info2.pid !== info1.pid, 'host.json 没有换成新进程');
  assert(info2.token && info2.token !== info1.token, '重启后令牌应重新生成');
  seenTokens.push(info2.token);
  const reclaimed = readLog(home).find(
    (line) => line.msg === 'reclaimed stale runtime file' && line.pid === info2.pid,
  );
  assert(reclaimed?.stalePid === info1.pid, '日志里没有回收陈旧 host.json 的记录');
  ok('重启 Host #2', `pid ${info2.pid}，回收了 pid ${info1.pid} 的陈旧 host.json，令牌已轮换`);

  // A11 旧令牌被拒，新令牌通过
  const stale = await RpcClient.connect(info2.url as string);
  const rejected = await stale.hello(info1, 'gate-m2-stale').then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(
    rejected instanceof RpcRequestError && rejected.error.code === -32001,
    `旧令牌应被拒（UNAUTHORIZED），实际 ${String(rejected)}`,
  );
  const staleClose = await stale.closed;
  assert(staleClose.code === 4004, `旧令牌的关闭码 ${staleClose.code}，应为 4004（UNAUTHORIZED）`);
  const client2 = await RpcClient.connect(info2.url as string);
  const hello2 = await client2.hello(info2, 'gate-m2-a');
  assert(hello2.hostId === hello.hostId, `hostId 跨重启变了：${hello.hostId} → ${hello2.hostId}`);
  ok(
    '旧令牌 hello 被拒，新令牌通过',
    `UNAUTHORIZED（关闭码 ${staleClose.code}）；hostId 跨重启不变`,
  );

  // A12 回放
  const sub2 = await client2.subscribe(session.id, 0);
  assert(
    sub2.replayedThroughSeq === lastSeq,
    `replayedThroughSeq ${sub2.replayedThroughSeq}，应为 ${lastSeq}`,
  );
  const replayed = client2.events.get(sub2.subscriptionId) as WevirEvent[];
  await client2.until(
    () => (replayed.length >= lastSeq ? true : undefined),
    `回放到 seq ${lastSeq}`,
  );
  const identical = isDeepStrictEqual(replayed, live);
  assert(identical, `回放与之前不一致，${firstDifference(live, replayed)}`);
  ok(
    `events.subscribe(sinceSeq=0) 回放 ${replayed.length} 条`,
    '与杀掉之前实时收到的事件逐条完全一致（seq、ts、type、source、payload）',
  );

  const snapshotAfter = await client2.request('session.get', { sessionId: session.id });
  assert(isDeepStrictEqual(snapshotAfter, snapshotBefore), '重启前后 session.get 快照不一致');
  ok(
    'session.get 快照重启前后一致',
    `state ${(snapshotAfter.session as { state: string }).state}，lastSeq ${lastSeq}`,
  );

  // A13 host.shutdown
  await client2.request('host.shutdown');
  const close2 = await withTimeout(client2.closed, TIMEOUT_MS, 'host.shutdown 后关闭连接');
  const exit2 = await withTimeout(host2.exited, TIMEOUT_MS, 'Host #2 退出');
  assert(close2.code === 1001, `关闭码 ${close2.code}，应为 1001（GOING_AWAY）`);
  assert(exit2.code === 0, `Host #2 退出码 ${exit2.code}`);
  assert(!existsSync(runtimeFilePath(home)), 'host.shutdown 后 host.json 仍在');
  ok('host.shutdown', '连接以 1001 关闭，进程退出码 0，host.json 已删除');

  return { workspaceId: workspace.id, providerId };
}

// ── B. T2.5 进程入口补充检查 ─────────────────────────────────────────────

async function processChecks(home: string, flow: MainFlowResult): Promise<void> {
  section('B. T2.5 进程入口补充检查');

  // B1 --adapter dsh 能启动（T3.6）：dsh 进程等到第一个会话才拉起，这里只确认 Host 起得来、退得干净。
  const dsh = spawnHost(home, ['--adapter', 'dsh']);
  await dsh.ready;
  dsh.child.kill('SIGTERM');
  const dshExit = await withTimeout(dsh.exited, TIMEOUT_MS, '--adapter dsh 的 Host 退出');
  const dshStarting = readLog(home).findLast((line) => line.msg === 'starting');
  assert(dshStarting?.adapter === 'dsh', `日志里最后一次启动的适配器是 ${dshStarting?.adapter}`);
  assert(dshExit.code === 0, `--adapter dsh：退出码 ${dshExit.code}，${dsh.stderr()}`);
  assert(!existsSync(runtimeFilePath(home)), '--adapter dsh 的 Host 退出后 host.json 仍在');
  ok('--adapter dsh 能启动', 'SIGTERM 后退出码 0，host.json 已删除');

  // B2 第二个 Host 被拒
  const host3 = spawnHost(home, ['--adapter', 'echo']);
  const ready3 = await host3.ready;
  const info3 = readRuntimeInfo(home);
  seenTokens.push(info3.token as string);
  const second = await runHostOnce(home, ['--adapter', 'echo']);
  assert(second.code === 3, `第二个 Host 退出码 ${second.code}：${second.stderr}`);
  assert(readRuntimeInfo(home).pid === ready3.pid, '第二个 Host 动了第一个的 host.json');
  ok('同一数据目录拒绝第二个 Host', `退出码 3，host.json 仍属于 pid ${ready3.pid}`);

  // B3 SIGTERM：取消运行中的回合，未决审批结为 cancelled（host_shutdown）
  const client = await RpcClient.connect(info3.url as string);
  await client.hello(info3, 'gate-m2-b');
  const { session } = await client.request<{ session: { id: string } }>('session.create', {
    workspaceId: flow.workspaceId,
    providerId: flow.providerId,
  });
  const sub = await client.subscribe(session.id, 0);
  const events = client.events.get(sub.subscriptionId) as WevirEvent[];
  const send = await client.request<{ turnId: string }>('session.send', {
    sessionId: session.id,
    content: text('approve：等待审批时 Host 收到 SIGTERM'),
  });
  const requested = await client.until(
    () => events.find((event) => event.type === 'approval.requested'),
    'approval.requested',
  );
  const approvalId = (requested.payload.approval as { id: string }).id;
  host3.child.kill('SIGTERM');
  const close3 = await withTimeout(client.closed, TIMEOUT_MS, 'SIGTERM 后关闭连接');
  const exit3 = await withTimeout(host3.exited, TIMEOUT_MS, 'Host #3 退出');
  const resolved = events.find(
    (event) => event.type === 'approval.resolved' && event.payload.approvalId === approvalId,
  );
  const reason = (resolved?.payload.resolution as { reason?: string } | undefined)?.reason;
  assert(
    resolved?.payload.status === 'cancelled' && reason === 'host_shutdown',
    `审批应结为 cancelled(host_shutdown)，实际 ${resolved?.payload.status}(${reason})`,
  );
  const finished = finishedTurn(events, send.turnId);
  assert(
    finished?.payload.outcome === 'cancelled',
    `回合应为 cancelled，实际 ${finished?.payload.outcome}`,
  );
  assert(lastState(events) === 'idle', `会话最后应为 idle，实际 ${lastState(events)}`);
  assert(close3.code === 1001, `关闭码 ${close3.code}`);
  assert(exit3.code === 0, `Host #3 退出码 ${exit3.code}`);
  assert(!existsSync(runtimeFilePath(home)), 'SIGTERM 后 host.json 仍在');
  const transitions = events
    .filter((event) => event.type === 'session.state_changed')
    .map((event) => `${event.payload.from}→${event.payload.to}`)
    .join('，');
  ok(
    'SIGTERM 优雅退出：客户端在断开前收到取消事件',
    `approval.resolved(cancelled, host_shutdown)、turn.finished(cancelled)；${transitions}；关闭码 1001，退出码 0，host.json 已删除`,
  );

  const steps = readLog(home)
    .filter((line) => line.pid === ready3.pid && line.msg === 'shutdown step done')
    .map((line) => `${line.step}(${line.ms}ms)`);
  const expected = [
    'stop_accepting',
    'cancel_turns',
    'dispose_adapter',
    'flush_storage',
    'close_connections',
    'remove_runtime_file',
  ];
  assert(
    isDeepStrictEqual(
      steps.map((step) => step.replace(/\(.*$/, '')),
      expected,
    ),
    `退出步骤顺序不对：${steps.join(' → ')}`,
  );
  ok('退出步骤顺序（ADR-0002 §6）', steps.join(' → '));

  // B4 stdin 归属管道
  const host5 = spawnHost(home, ['--adapter', 'echo', '--exit-on-stdin-eof'], 'pipe');
  const ready5 = await host5.ready;
  seenTokens.push(readRuntimeInfo(home).token as string);
  const startedAt = performance.now();
  host5.child.stdin?.end();
  const exit5 = await withTimeout(host5.exited, TIMEOUT_MS, 'stdin EOF 后退出');
  assert(exit5.code === 0, `退出码 ${exit5.code}`);
  assert(!existsSync(runtimeFilePath(home)), 'stdin EOF 后 host.json 仍在');
  const trigger = readLog(home).find(
    (line) => line.pid === ready5.pid && line.msg === 'shutting down',
  )?.trigger as { kind: string } | undefined;
  assert(trigger?.kind === 'stdin_eof', `退出原因 ${JSON.stringify(trigger)}`);
  ok(
    '--exit-on-stdin-eof：关闭 stdin 即优雅退出',
    `${Math.round(performance.now() - startedAt)} ms 内退出码 0，host.json 已删除`,
  );

  // B5 日志脱敏
  const log = readFileSync(join(home, 'logs', 'host.log'), 'utf8');
  const lines = readLog(home);
  const leaked = [...seenTokens, API_KEY].filter((secret) => log.includes(secret));
  assert(leaked.length === 0, `日志里出现了 ${leaked.length} 个令牌或密钥`);
  ok(
    '日志为 JSON 行且已脱敏',
    `${lines.length} 行全部可解析；${seenTokens.length} 个令牌与 Provider Key 均未出现在 logs/host.log`,
  );
}

// ── 入口 ──────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (!existsSync(HOST_BIN)) {
    console.error(
      `找不到 ${HOST_BIN}，先运行：pnpm --filter "@wevir/host..." build（或直接 pnpm gate:m2）`,
    );
    return 1;
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-gate-m2-')));
  const home = join(scratch, 'home');
  const workspaceDir = mkdtempSync(join(scratch, 'workspace-'));
  console.log(
    `Gate M2 — wevir-host（${HOST_BIN.slice(ROOT.length + 1)}）+ EchoAdapter，Node ${process.version}`,
  );
  console.log(`数据目录：${home}`);
  const started = performance.now();
  try {
    const flow = await mainFlow(home, workspaceDir);
    await processChecks(home, flow);
    console.log(
      `\nGate M2：通过（${passed} 项检查，${((performance.now() - started) / 1000).toFixed(1)} s）`,
    );
    return 0;
  } catch (error) {
    console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}`);
    if (!(error instanceof GateFailure) && error instanceof Error) console.error(error.stack);
    console.error(`\nGate M2：未通过（已通过 ${passed} 项）`);
    return 1;
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (KEEP) console.log(`保留临时目录：${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
}

process.exitCode = await main();
