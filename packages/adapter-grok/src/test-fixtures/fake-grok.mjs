#!/usr/bin/env node
// 假 grok（adapter-grok 的测试用）：按子命令回应，ACP 部分回放 T3 Code 录的真实 Grok Build 样本（./acp/，见 README.md）。
//
//   grok --version                       打印 FAKE_GROK_VERSION（默认 `grok 1.0.41`）
//   grok models                          打印 FAKE_GROK_MODELS（默认已登录与三个模型）；FAKE_GROK_MODELS_EXIT 是退出码；
//                                        FAKE_GROK_MODELS_FILE 指向的文件有内容时打印它（测试中途改它来换登录状态）；
//                                        FAKE_GROK_MODELS_ONCE 指向的文件在时打印它并删掉（只有下一次这样说）
//   grok logout                          FAKE_GROK_MODELS_FILE 有值时把它改成“没登录”；FAKE_GROK_LOGOUT_EXIT 是退出码
//   grok [--permission-mode M] agent [--always-approve] stdio
//                                        说 ACP（NDJSON），`initialize` 与 `session/new` 的结果取自 simple 样本
//
// ACP 的 `session/prompt` 按提示词决定做什么：
//   replay:<样本>[#n]   回放样本里第 n 个（默认第 1 个）`session/prompt` 到下一个请求之间引擎写出的消息：会话 ID 与 promptId
//                       换成当前的；引擎发的请求（审批、提问）等客户端回复再往下；样本在等 `session/cancel` 时等它。审批选
//                       了拒绝时工具失败、回合照常结束；回放中途收到 `session/cancel` 时以 cancelled 结束（同 message_steering
//                       样本的写法）。
//   hang                 不回答，直到 `session/cancel`
//   其他                 回显：三段 `agent_message_chunk`，然后 `turn_completed`、`prompt_complete` 与 end_turn
//
// 环境变量：FAKE_GROK_FIXTURES（样本目录，默认 ./acp）、FAKE_GROK_STORE（会话记在这个目录，重启后的进程能 resume）、
// FAKE_GROK_LOG（把收到的每条消息追加成一行 JSON）、FAKE_GROK_ARGV_LOG（每次启动追加一行 argv）、
// FAKE_GROK_ENV_LOG（每次启动追加一行 JSON：argv 与 GROK_DISABLE_AUTOUPDATER）、
// FAKE_GROK_REQUIRE_AUTH=1（`authenticate` 之前 `session/new` / `session/resume` 报 -32000 Authentication required）、
// FAKE_GROK_PROMPT_RESPONSE=never（只发 `prompt_complete`，不回 `session/prompt`）。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const env = process.env;
const args = process.argv.slice(2);

// Windows 上经 grok.cmd（cmd.exe）启动（harness.ts）：测试直接结束 cmd.exe 时这里收不到信号，跟着它退出，免得留下
// 占着工作目录的进程。
if (process.platform === 'win32') {
  const launcher = process.ppid;
  setInterval(() => {
    try {
      process.kill(launcher, 0);
    } catch {
      process.exit(0);
    }
  }, 100).unref();
}
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = env.FAKE_GROK_FIXTURES ?? join(here, 'acp');

if (env.FAKE_GROK_ARGV_LOG) appendFileSync(env.FAKE_GROK_ARGV_LOG, `${JSON.stringify(args)}\n`);
if (env.FAKE_GROK_ENV_LOG) {
  appendFileSync(
    env.FAKE_GROK_ENV_LOG,
    `${JSON.stringify({ argv: args, autoupdater: env.GROK_DISABLE_AUTOUPDATER ?? null })}\n`,
  );
}

if (args[0] === '--version') {
  process.stdout.write(`${env.FAKE_GROK_VERSION ?? 'grok 1.0.41'}\n`);
  process.exit(0);
}
if (args[0] === 'logout') {
  if (env.FAKE_GROK_MODELS_FILE)
    writeFileSync(env.FAKE_GROK_MODELS_FILE, 'You are not authenticated.\n');
  process.stdout.write('Logged out.\n');
  process.exit(Number(env.FAKE_GROK_LOGOUT_EXIT ?? 0));
}
if (args[0] === 'models') {
  if (env.FAKE_GROK_MODELS_ONCE && existsSync(env.FAKE_GROK_MODELS_ONCE)) {
    process.stdout.write(readFileSync(env.FAKE_GROK_MODELS_ONCE, 'utf8'));
    rmSync(env.FAKE_GROK_MODELS_ONCE);
    process.exit(0);
  }
  const fromFile =
    env.FAKE_GROK_MODELS_FILE && existsSync(env.FAKE_GROK_MODELS_FILE)
      ? readFileSync(env.FAKE_GROK_MODELS_FILE, 'utf8')
      : undefined;
  process.stdout.write(
    fromFile ??
      env.FAKE_GROK_MODELS ??
      [
        'You are logged in with grok.com.',
        'Default model: grok-4.7',
        'Available models:',
        '  * grok-4.7 (default)',
        '  - grok-4.7-build-fast',
        '  - grok-4.6',
        '',
      ].join('\n'),
  );
  process.exit(Number(env.FAKE_GROK_MODELS_EXIT ?? 0));
}
if (!(args.includes('agent') && args.includes('stdio'))) {
  process.stderr.write(`fake grok: unknown command ${args.join(' ')}\n`);
  process.exit(2);
}

// ── 样本 ───────────────────────────────────────────────────────────────────────

const transcripts = new Map();
function transcript(name) {
  let entries = transcripts.get(name);
  if (entries === undefined) {
    entries = readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    transcripts.set(name, entries);
  }
  return entries;
}

function recordedResult(name, method) {
  return transcript(name).find(
    (entry) => entry.frame?.kind === 'response' && entry.frame.method === method,
  )?.frame.result;
}

/** 样本里根会话的 ID（`session/new` 的结果，或 metadata 里的）。 */
function recordedSessionId(name) {
  const entries = transcript(name);
  return (
    recordedResult(name, 'session/new')?.sessionId ?? entries[0]?.metadata?.nativeSessionId ?? ''
  );
}

// ── 连接 ───────────────────────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

let nextRequestId = 1000;
const pending = new Map();
function request(method, params) {
  const id = nextRequestId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

const sessions = new Map();
let authenticated = env.FAKE_GROK_REQUIRE_AUTH !== '1';

function store(id, state) {
  if (env.FAKE_GROK_STORE === undefined) return;
  mkdirSync(env.FAKE_GROK_STORE, { recursive: true });
  writeFileSync(join(env.FAKE_GROK_STORE, `${encodeURIComponent(id)}.json`), JSON.stringify(state));
}

function stored(id) {
  if (env.FAKE_GROK_STORE === undefined) return undefined;
  const file = join(env.FAKE_GROK_STORE, `${encodeURIComponent(id)}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function configOptions(state) {
  const options = structuredClone(recordedResult('simple', 'session/new').configOptions);
  for (const option of options) {
    if (option.id === 'model') option.currentValue = state.model;
    if (option.id === 'reasoning_effort') option.currentValue = state.effort;
  }
  return options;
}

function newSessionState(cwd) {
  return { cwd, model: 'grok-4.7', effort: 'high', cancel: undefined };
}

const update = (sessionId, update) =>
  send({ method: 'session/update', params: { sessionId, update } });

function finish(sessionId, promptId, stopReason, requestId) {
  send({
    method: '_x.ai/session_notification',
    params: {
      sessionId,
      update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: stopReason },
    },
  });
  send({
    method: '_x.ai/session/prompt_complete',
    params: { sessionId, promptId, stopReason, agentResult: null },
  });
  if (env.FAKE_GROK_PROMPT_RESPONSE !== 'never') {
    send({ id: requestId, result: { stopReason, _meta: { sessionId, promptId } } });
  }
}

const AUTH_REQUIRED = { code: -32000, message: 'Authentication required' };

const handlers = {
  initialize: () => recordedResult('simple', 'initialize'),
  authenticate: (params) => {
    const methods = recordedResult('simple', 'initialize').authMethods.map((method) => method.id);
    if (!methods.includes(params.methodId)) {
      throw { code: -32602, message: `Unknown auth method: ${params.methodId}` };
    }
    authenticated = true;
    return {};
  },
  'session/new': (params) => {
    if (!authenticated) throw AUTH_REQUIRED;
    const id = `grok-fake-${process.pid}-${sessions.size + 1}-${Date.now()}`;
    const state = newSessionState(params.cwd);
    sessions.set(id, state);
    store(id, { cwd: params.cwd });
    const recorded = recordedResult('simple', 'session/new');
    return { ...recorded, sessionId: id, configOptions: configOptions(state) };
  },
  'session/resume': (params) => {
    if (!authenticated) throw AUTH_REQUIRED;
    const known = sessions.get(params.sessionId) ?? stored(params.sessionId);
    if (known === undefined) {
      throw { code: -32602, message: `Session not found: ${params.sessionId}` };
    }
    const state = sessions.get(params.sessionId) ?? newSessionState(known.cwd);
    sessions.set(params.sessionId, state);
    return { configOptions: configOptions(state) };
  },
  'session/close': (params) => {
    sessions.delete(params.sessionId);
    return { _meta: { 'x.ai/closeOutcome': 'closed' } };
  },
  'session/set_model': (params) => {
    const state = sessions.get(params.sessionId);
    if (state === undefined) throw { code: -32602, message: 'unknown session' };
    state.model = params.modelId;
    const effort = params._meta?.reasoningEffort;
    if (typeof effort === 'string') state.effort = effort;
    update(params.sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: configOptions(state),
    });
    return { _meta: { model: { Ok: params.modelId } } };
  },
};

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const state = sessions.get(sessionId);
  if (state === undefined) {
    send({ id, error: { code: -32602, message: `unknown session ${sessionId}` } });
    return;
  }
  const promptId = params._meta?.promptId ?? `fake-prompt-${id}`;
  let cancelled;
  const cancelSignal = new Promise((resolve) => {
    cancelled = resolve;
  });
  state.cancel = () => cancelled('cancel');
  const text = params.prompt?.[0]?.text ?? '';
  try {
    const replay = /^replay:([\w-]+)(?:#(\d+))?$/.exec(text);
    if (replay) {
      await runReplay(id, sessionId, promptId, replay[1], Number(replay[2] ?? 1), cancelSignal);
    } else if (text === 'hang') {
      await cancelSignal;
      finish(sessionId, promptId, 'cancelled', id);
    } else {
      for (const part of ['echo: ', text.slice(0, 3), text.slice(3)]) {
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: part },
        });
      }
      finish(sessionId, promptId, 'end_turn', id);
    }
  } finally {
    state.cancel = undefined;
  }
}

/** 回放样本里第 n 个 `session/prompt` 之后、下一个客户端请求之前引擎写出的消息。 */
async function runReplay(requestId, sessionId, promptId, name, nth, cancelSignal) {
  const entries = transcript(name);
  const prompts = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.type === 'expect_outbound' &&
        entry.frame.kind === 'request' &&
        entry.frame.method === 'session/prompt',
    );
  const start = prompts[nth - 1];
  if (start === undefined) throw new Error(`${name} has no prompt #${nth}`);
  const recordedPrompt = start.entry.frame.params._meta?.promptId;
  const recordedSession = recordedSessionId(name);
  const rewrite = (frame) => {
    let json = JSON.stringify(frame);
    if (recordedSession) json = json.split(recordedSession).join(sessionId);
    if (recordedPrompt) json = json.split(recordedPrompt).join(promptId);
    return JSON.parse(json);
  };
  let responded = false;
  for (const entry of entries.slice(start.index + 1)) {
    const frame = entry.frame;
    if (frame === undefined) continue;
    if (entry.type === 'expect_outbound') {
      if (frame.kind === 'request') break;
      if (frame.kind === 'notification' && frame.method === 'session/cancel' && !responded) {
        await cancelSignal;
      }
      continue;
    }
    if (entry.type !== 'emit_inbound') continue;
    const live = rewrite(frame);
    if (live.kind === 'notification') {
      send({ method: live.method, params: live.params });
    } else if (live.kind === 'request') {
      if (responded) continue;
      const answer = await Promise.race([request(live.method, live.params), cancelSignal]);
      // 取消时客户端把未决的审批答成 cancelled；这个回复可能先于 session/cancel 读到，同样按取消结束。
      if (answer === 'cancel' || answer.result?.outcome?.outcome === 'cancelled') {
        finish(sessionId, promptId, 'cancelled', requestId);
        return;
      }
      if (live.method === 'session/request_permission') {
        const chosen = answer.result?.outcome?.optionId;
        const kind = live.params.options.find((option) => option.optionId === chosen)?.kind;
        if (!kind?.startsWith('allow')) {
          const toolCallId = live.params.toolCall.toolCallId;
          update(sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
            content: [
              { type: 'content', content: { type: 'text', text: 'Permission denied by the user' } },
            ],
          });
          update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Okay, I did not run it.' },
          });
          finish(sessionId, promptId, 'end_turn', requestId);
          return;
        }
      }
    } else if (live.kind === 'response' && live.method === 'session/prompt') {
      if (env.FAKE_GROK_PROMPT_RESPONSE !== 'never') {
        send({ id: requestId, ...(live.error ? { error: live.error } : { result: live.result }) });
      }
      // 回合结束之后引擎还会写（会话标题、后台任务结束后自己开的回合）：照样回放到下一个客户端请求为止。
      responded = true;
    }
    // 让客户端有机会在回放中途插进来（取消等）。
    await new Promise((resolve) => setImmediate(resolve));
    if (!responded && (await Promise.race([cancelSignal, Promise.resolve('go')])) === 'cancel') {
      finish(sessionId, promptId, 'cancelled', requestId);
      return;
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (env.FAKE_GROK_LOG) appendFileSync(env.FAKE_GROK_LOG, `${line}\n`);
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
    return;
  }
  if (message.id === undefined) {
    if (message.method === 'session/cancel') sessions.get(message.params?.sessionId)?.cancel?.();
    return;
  }
  if (message.method === 'session/prompt') {
    void prompt(message.id, message.params);
    return;
  }
  const handler = handlers[message.method];
  if (handler === undefined) {
    send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
    return;
  }
  try {
    send({ id: message.id, result: handler(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error });
  }
});
rl.on('close', () => process.exit(0));
