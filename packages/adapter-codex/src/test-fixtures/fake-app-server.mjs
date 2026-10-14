#!/usr/bin/env node
// 假的 codex-app-server（契约测试第 1 层，codex-adapter.contract.test.ts）：说 app-server 的逐行 JSON，回放
// app-server/*.jsonl 里真实二进制录下的通知与审批请求，不需要二进制、模型或 Key。照
// packages/adapter-dsh/src/test-fixtures/fake-dsh.mjs 的思路：样本按提示词选（`replay:<样本名>`，其余用 `stream`），
// 样本里的 thread、回合、item 与服务端请求的 ID 换成当前的。只用 Node 内置模块。
//
//   node fake-app-server.mjs [--fixtures <目录>] [--version] [--strict-config]
//
// - `--version`：打印锁定的版本（与 paths.ts 的 CODEX_VERSION 一致）后退出。
// - initialize / thread/start / thread/resume / thread/unsubscribe / turn/start / turn/interrupt 有回应，其余回 -32601。
// - 审批：样本里的 `{"serverRequest": …}` 发给客户端，等它回复 `{decision}`，接着回放 `<样本名>.<决定>.jsonl`
//   （acceptForSession 用 accept 的分支）；审批未决时 `turn/interrupt` 回放 `<样本名>.interrupt.jsonl`（turn/completed
//   之后才是 serverRequest/resolved，与真实的顺序相同）。
// - 恢复：有过回合的 thread 记在 cwd（CODEX_HOME）下的 fake-threads.json，进程被杀、重启之后照样能 thread/resume；没
//   见过的 ID 回 errors/resume-not-found.json 的措辞，不是 UUID 的回 errors/resume-invalid-id.json 的措辞。
// - 流式中途的 `turn/interrupt` 停止回放，发 `turn/completed`（interrupted）。
// - `turn/start` 的 `model` 与 `effort`（会话中换模型，0.9.0）、审批策略、审查方与沙箱（权限模式，0.11.0）逐行记在 cwd
//   下的 fake-turn-starts.jsonl，测试读它核对。
// - 子 agent（R4）：样本里第一个出现的 thread 是当前 thread，别的 thread（子 thread）换成每次回放新生成的 ID，回合 ID
//   同理（`rootTurnId` 照样指向当前回合）；当前 thread 的 `turn/completed` 之后接着回放子 thread 的行。只是回放，
//   子 thread 本身不能 turn/start 或 interrupt。

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '0.162.1';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`codex-app-server ${VERSION}\n`);
  process.exit(0);
}
const fixturesIndex = args.indexOf('--fixtures');
const FIXTURES =
  fixturesIndex >= 0
    ? args[fixturesIndex + 1]
    : fileURLToPath(new URL('./app-server/', import.meta.url));
const STORE = join(process.cwd(), 'fake-threads.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** threadId → { id, cwd, model, modelProvider, subscribed, turn? } */
const threads = new Map();
/** 有过回合（rollout 已写下）的 thread。 */
const materialized = new Set(existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : []);
/** 等客户端回复的服务端请求：id → resolve。 */
const waiting = new Map();
let nextRequestId = 0;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(thread, message) {
  if (thread.subscribed) write(message);
}

function fixture(name) {
  const path = join(FIXTURES, `${name}.jsonl`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((line) => !('_meta' in line));
}

function errorFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, 'errors', `${name}.json`), 'utf8'));
}

/**
 * 样本里的 ID 换成当前的：样本的（第一个）thread → 当前 thread，别的 thread → 新 ID；样本的（第一个）回合 →
 * 当前回合，别的回合 → 新 ID；item.id 与 itemId → `<回合>:<原 ID>`（同一会话的几个回合不重复）；
 * serverRequest/resolved 的 requestId → 当前的请求。
 */
function substitute(value, turn, key) {
  if (key === 'receiverThreadIds' && Array.isArray(value)) {
    return value.map((id) => mapped(turn, 'threads', id, turn.thread.id));
  }
  if (key === 'agentsStates' && typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([id, state]) => [
        mapped(turn, 'threads', id, turn.thread.id),
        state,
      ]),
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, turn));
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, turn, k);
    if (typeof value.id === 'string' && typeof value.type === 'string')
      out.id = `${turn.id}:${value.id}`;
    if (key === 'turn' && typeof value.id === 'string')
      out.id = mapped(turn, 'turns', value.id, turn.id);
    return out;
  }
  if (key === 'threadId' || key === 'senderThreadId') {
    return mapped(turn, 'threads', value, turn.thread.id);
  }
  if (key === 'turnId' || key === 'rootTurnId') return mapped(turn, 'turns', value, turn.id);
  if (key === 'itemId') return `${turn.id}:${value}`;
  if (key === 'requestId') return turn.requestId ?? value;
  return value;
}

/** 样本里的一个 ID（thread 或回合）→ 当前的：第一个出现的是 `current`，其余每个生成一个新的。 */
function mapped(turn, kind, recorded, current) {
  turn.ids ??= { threads: new Map(), turns: new Map() };
  const ids = turn.ids[kind];
  if (ids.size === 0) ids.set(recorded, current);
  let id = ids.get(recorded);
  if (id === undefined) {
    id = randomUUID();
    ids.set(recorded, id);
  }
  return id;
}

/** 这一行属于样本里的子 thread（不是第一个出现的 thread）。 */
function childLine(turn, line) {
  const threadId = line.params?.threadId ?? line.serverRequest?.params?.threadId;
  const first = turn.ids?.threads.keys().next().value;
  return typeof threadId === 'string' && first !== undefined && threadId !== first;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function replay(turn, name) {
  for (const line of fixture(name)) {
    if (turn.ended && !(turn.completed && childLine(turn, line))) return;
    await tick();
    if (turn.ended && !(turn.completed && childLine(turn, line))) return;
    if ('serverRequest' in line) {
      const id = nextRequestId++;
      turn.requestId = id;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      turn.pending = { id, base: name };
      write({
        id,
        method: line.serverRequest.method,
        params: substitute(line.serverRequest.params, turn),
      });
      const answer = await reply;
      waiting.delete(id);
      if (turn.ended || answer === 'interrupt') return;
      turn.pending = undefined;
      const decision = answer?.result?.decision;
      await replay(turn, `${name}.${decision === 'acceptForSession' ? 'accept' : decision}`);
      return;
    }
    emit(turn, line);
  }
}

function emit(turn, line) {
  const message = substitute(line, turn);
  notify(turn.thread, message);
  if (message.method === 'turn/completed' && message.params.threadId === turn.thread.id) {
    endTurn(turn);
    turn.completed = true;
  }
}

function endTurn(turn) {
  turn.ended = true;
  if (turn.thread.turn === turn) turn.thread.turn = undefined;
}

function threadResult(thread) {
  return {
    thread: { id: thread.id },
    model: thread.model ?? 'wevir-mock',
    modelProvider: thread.modelProvider ?? 'wevir_mock',
    cwd: thread.cwd,
    reasoningEffort: null,
  };
}

const handlers = {
  initialize: () => ({
    userAgent: `wevir/${VERSION} (fake-app-server)`,
    codexHome: process.cwd(),
    platformFamily: 'unix',
    platformOs: process.platform,
  }),
  'thread/start': (params) => {
    const thread = {
      id: randomUUID(),
      cwd: params.cwd,
      model: params.model,
      modelProvider: params.modelProvider,
      subscribed: true,
    };
    threads.set(thread.id, thread);
    return threadResult(thread);
  },
  'thread/resume': (params) => {
    const { threadId } = params;
    if (!UUID.test(threadId)) throw rpcError(errorFixture('resume-invalid-id'));
    let thread = threads.get(threadId);
    if (thread === undefined) {
      if (!materialized.has(threadId)) {
        const { code, message } = errorFixture('resume-not-found');
        throw { code, message: message.replace(/[0-9a-f-]{36}$/i, threadId) };
      }
      thread = {
        id: threadId,
        cwd: params.cwd,
        model: params.model,
        modelProvider: params.modelProvider,
      };
      threads.set(threadId, thread);
    }
    thread.subscribed = true;
    return threadResult(thread);
  },
  'thread/unsubscribe': (params) => {
    const thread = threads.get(params.threadId);
    if (thread === undefined) return { status: 'notLoaded' };
    thread.subscribed = false;
    return { status: 'unsubscribed' };
  },
  'turn/start': (params) => {
    const thread = threads.get(params.threadId);
    if (thread === undefined)
      throw { code: -32600, message: `thread not found: ${params.threadId}` };
    appendFileSync(
      join(process.cwd(), 'fake-turn-starts.jsonl'),
      `${JSON.stringify({
        threadId: params.threadId,
        model: params.model,
        effort: params.effort,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandboxPolicy: params.sandboxPolicy,
      })}\n`,
    );
    const text = params.input?.[0]?.text ?? '';
    const name = text.startsWith('replay:') ? text.slice('replay:'.length).trim() : 'stream';
    const turn = { id: randomUUID(), thread, ended: false };
    thread.turn = turn;
    if (!materialized.has(thread.id)) {
      materialized.add(thread.id);
      writeFileSync(STORE, JSON.stringify([...materialized]));
    }
    setImmediate(
      () => void replay(turn, name).catch((error) => process.stderr.write(`${error}\n`)),
    );
    return { turn: { id: turn.id, status: 'inProgress', error: null, items: [] } };
  },
  'turn/interrupt': (params) => {
    const thread = threads.get(params.threadId);
    const turn = thread?.turn;
    if (turn === undefined || turn.id !== params.turnId) return {};
    // 先回应，再发回合结束（与真实的一样，turn/completed 很快就到）。
    setImmediate(() => interrupt(turn));
    return {};
  },
};

function interrupt(turn) {
  if (turn.ended) return;
  const pending = turn.pending;
  if (pending !== undefined) {
    turn.pending = undefined;
    waiting.get(pending.id)?.('interrupt');
    for (const line of fixture(`${pending.base}.interrupt`)) emit({ ...turn, ended: false }, line);
    endTurn(turn);
    return;
  }
  emit(turn, {
    method: 'turn/completed',
    params: {
      threadId: turn.thread.id,
      turn: { id: turn.id, items: [], status: 'interrupted', error: null },
    },
  });
}

function rpcError({ code, message }) {
  return { code, message };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (typeof message.method !== 'string') {
    // 客户端对服务端请求的回复。
    waiting.get(message.id)?.(message);
    return;
  }
  if (message.id === undefined) return; // initialized 等通知
  const handler = handlers[message.method];
  if (handler === undefined) {
    write({
      id: message.id,
      error: { code: -32601, message: `fake-app-server 不支持 ${message.method}` },
    });
    return;
  }
  try {
    write({ id: message.id, result: handler(message.params ?? {}) });
  } catch (error) {
    write({
      id: message.id,
      error: { code: error.code ?? -32603, message: String(error.message ?? error) },
    });
  }
});
rl.on('close', () => process.exit(0));
