// 假 dsh：DshProcess 单元测试用。按 ACP 的 NDJSON 帧回应 initialize，行为由 FAKE_DSH_MODE 决定；
// 把收到的 argv、cwd、环境和 initialize 参数写到 <cwd>/fake-dsh.json（cwd 就是 DSH_HOME）。
//
// FAKE_DSH_MODE：
//   normal          读到 stdin EOF 即退出（真实 dsh 的行为）
//   ignore-eof      不理会 stdin EOF，SIGTERM 照常退出
//   ignore-sigterm  不理会 stdin EOF 与 SIGTERM，只能 SIGKILL
//   no-initialize   不回应 initialize
//   wrong-protocol  initialize 回应协议版本 99
//   exit-on-start   往 stderr 写一行后以退出码 7 退出
//   crash-after-init  回应 initialize 50 ms 后以退出码 3 退出（每次启动都这样）
//   crash-once      同上，但只在第一次启动时（以 cwd 里的标记文件区分）
//   ask-permission  回应 initialize 后发一条 session/update 和一个 session/request_permission
//   acp             DshAdapter 测试用（T3.2）：回应 session/new、session/prompt、session/cancel、
//                   session/close、session/set_config_option（T3.4：值里含 missing 时报 -32602，其余照收），
//                   按提示词的第一个词决定回合怎么走（见下方 PROMPT_SCRIPTS）。
//                   第一个词是 `replay:<样本名>` 时回放 $FAKE_DSH_FIXTURES/<样本名>.jsonl（T3.3，见 replay()）。
//                   session/resume（T3.5）：本进程里活跃的会话报 already active；会话 ID 以 RESUME_FAILURES 的前缀
//                   开头时回放 acp/errors/ 里对应的真实 dsh 错误；本进程建过的会话 cwd 不同时报 cwd does not match；
//                   其余（本进程没见过的 ID，相当于 Host 重启后）照收，configOptions 是会话最后选定的路由。
//                   收到的每条客户端消息（initialize 之外）按顺序记在 fake-dsh.json 的 received 里。
// FAKE_DSH_GRANDCHILD=1：再拉起一个不理会 SIGTERM 的子进程（留在同一进程组里）。
//
// stream-tap（T3.2a）：
//   `plugin --profile acp add link:<目录>` 模拟 dsh plugin：在 profiles/acp 写 package.json 并把
//   node_modules/@wevir/dsh-stream-tap 链到该目录，每次调用往 <cwd>/plugin-calls.log 追加一行；
//   目录里有 fake-install-fails 文件时往 stderr 写一行后以退出码 1 退出。
//   设了 WEVIR_STREAM_FD 时模拟插件往 fd 3 写：FAKE_DSH_TAP 为 frames（默认）时写 ready、一个分两次写
//   的文本增量、一行畸形数据、一个推理增量和 end 帧；为 silent 时什么都不写（插件没加载）。

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.argv[2] === 'plugin') {
  const spec = process.argv.at(-1);
  const dir = spec.slice('link:'.length);
  appendFileSync('plugin-calls.log', `${process.argv.slice(2).join(' ')}\n`);
  if (existsSync(join(dir, 'fake-install-fails'))) {
    process.stderr.write('fake dsh: pnpm failed\n');
    process.exit(1);
  }
  const profile = join('profiles', 'acp');
  const scope = join(profile, 'node_modules', '@wevir');
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ dependencies: { '@wevir/dsh-stream-tap': spec } }),
  );
  symlinkSync(dir, join(scope, 'dsh-stream-tap'), 'junction');
  process.exit(0);
}

const mode = process.env.FAKE_DSH_MODE ?? 'normal';
const record = { argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } };
const save = () => writeFileSync('fake-dsh.json', JSON.stringify(record));
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const crash = () =>
  setTimeout(() => {
    process.stderr.write('fake dsh: crashed\n');
    process.exit(3);
  }, 50);

save();
if (mode === 'exit-on-start') {
  process.stderr.write('fake dsh: cannot start\n');
  process.exit(7);
}
const tap =
  process.env.WEVIR_STREAM_FD !== undefined && process.env.FAKE_DSH_TAP !== 'silent'
    ? createWriteStream('', { fd: Number(process.env.WEVIR_STREAM_FD) })
    : undefined;
if (tap !== undefined && mode === 'acp') tap.write('{"type":"ready"}\n');
if (tap !== undefined && mode !== 'acp') {
  const frame = (frame) =>
    JSON.stringify({
      type: 'frame',
      sessionId: 'fake-session',
      frame: { attemptId: 'a:1', ...frame },
    });
  const delta = frame({
    type: 'chunk',
    index: 1,
    chunk: { type: 'text-delta', index: 1, text: '你好' },
  });
  tap.write(`{"type":"ready"}\n${delta.slice(0, 40)}`);
  setTimeout(() => {
    tap.write(`${delta.slice(40)}\nnot json\n`);
    tap.write(
      `${frame({ type: 'chunk', index: 2, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })}\n` +
        `${frame({ type: 'end', index: 3, outcome: { kind: 'committed' } })}\n`,
    );
  }, 20);
}
if (process.env.FAKE_DSH_GRANDCHILD === '1') {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: 'ignore' },
  );
  record.grandchild = child.pid;
  save();
}
if (mode === 'ignore-eof' || mode === 'ignore-sigterm') setInterval(() => {}, 1000);
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    record.initialize = message.params;
    save();
    if (mode === 'no-initialize') return;
    send({
      id: message.id,
      result: {
        protocolVersion: mode === 'wrong-protocol' ? 99 : 1,
        agentCapabilities: {},
        agentInfo: { name: 'fake-dsh', version: '0.0.0' },
      },
    });
    if (mode === 'crash-after-init') crash();
    if (mode === 'crash-once' && !existsSync('crashed-once')) {
      writeFileSync('crashed-once', '');
      crash();
    }
    if (mode === 'ask-permission') {
      send({
        method: 'session/update',
        params: {
          sessionId: 'fake-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        },
      });
      send({
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'fake-session',
          toolCall: { toolCallId: 'call-1' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
    }
  } else if (mode === 'acp') {
    record.received.push(message);
    save();
    if (message.method === undefined) {
      // 客户端对 dsh 所发请求（session/request_permission）的响应。
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    } else {
      acp(message);
    }
  } else if (message.id === 'permission-1') {
    record.permissionResponse = message.result ?? message.error;
    save();
  }
});
lines.on('close', () => {
  record.stdinClosed = true;
  save();
  if (mode !== 'ignore-eof' && mode !== 'ignore-sigterm') process.exit(0);
});

// ── acp 模式 ───────────────────────────────────────────────────────────────────────

record.received = [];
let sessionCount = 0;
/** dsh 发出、等客户端回复的请求 id → 收到回复时调用。 */
const waiters = new Map();
/** sessionId → 等 session/cancel 的 prompt 请求 id。 */
const hanging = new Map();
/** 引擎侧“丢了”的会话：session/close 报 unknown session（T0.3 fixtures/acp/errors/close-unknown-session.json）。 */
const forgotten = new Set();
/** session/close 失败、但仍挂在本进程上的会话（T3.5：之后的 session/resume 报 already active）。 */
const stubborn = new Set();
/** 本进程上活跃的会话。 */
const active = new Set();
/** sessionId → 建会话时的 cwd（本进程建的才有）。 */
const cwds = new Map();
/** sessionId → 最后选定的 model 选项值。 */
const routes = new Map();
/** session/resume：会话 ID 前缀 → 回放的真实 dsh 错误（acp/errors/，T3.5 录制）。 */
const RESUME_FAILURES = {
  'gone-': 'resume-not-resumable.json',
  'newer-': 'resume-format-newer.json',
  'corrupt-': 'resume-log-corrupt.json',
};
const DEFAULT_ROUTE = '["wevir-test","wevir-mock"]';
const configOptions = (sessionId, effort = 'high') => [
  {
    id: 'model',
    type: 'select',
    currentValue: routes.get(sessionId) ?? DEFAULT_ROUTE,
    options: [],
  },
  { id: 'reasoning_effort', type: 'select', currentValue: effort, options: [] },
];

const update = (sessionId, body) => ({
  method: 'session/update',
  params: { sessionId, update: body },
});
const chunk = (sessionId, kind, messageId, text) =>
  update(sessionId, { sessionUpdate: kind, messageId, content: { type: 'text', text } });
/** 一次写出多条消息：dsh 的 stdout 上，回合最后的更新和 prompt 的结果常在同一次读里到达。 */
const sendAll = (messages) =>
  process.stdout.write(
    messages.map((m) => `${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`).join(''),
  );
const tapFrame = (sessionId, frame) =>
  tap?.write(`${JSON.stringify({ type: 'frame', sessionId, frame })}\n`);

/** 提示词第一个词 → 回合脚本。 */
const PROMPT_SCRIPTS = {
  // 各类更新（含 dsh 不发的类型）与结果在同一次写里，检验顺序与 engine.raw。
  order: (sid, id) =>
    sendAll([
      update(sid, { sessionUpdate: 'usage_update', used: 10, size: 100 }),
      update(sid, { sessionUpdate: 'future_update', detail: { kept: true } }),
      update(sid, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-todo',
        title: 'todo_write',
        kind: 'other',
        status: 'in_progress',
        rawInput: { todos: [{ content: '读取', status: 'in_progress' }] },
      }),
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-todo',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Updated todo list' } }],
      }),
      chunk(sid, 'agent_message_chunk', 'msg-1', '好的。'),
      { id, result: { stopReason: 'end_turn' } },
    ]),
  // 与 T0.3 fixtures/acp/errors/prompt-missing-key.openai-compatible.json 同形。
  fail: (_sid, id) =>
    sendAll([
      {
        id,
        error: {
          code: -32603,
          message:
            'Internal error: turn failed: llm-pi-ai: no credential for provider route "wevir-test"; its profile resolves WEVIR_PROVIDER_WEVIR_TEST_KEY, which is not set',
        },
      },
    ]),
  // 增量先到 fd 3（含一个子 agent 会话的帧），已提交消息后到 stdout，committed 的 end 帧最后才到。
  stream: (sid, id) => {
    const attemptId = `${sid}:1`;
    const delta = (index, text) =>
      tapFrame(sid, {
        type: 'chunk',
        attemptId,
        index,
        chunk: { type: 'text-delta', index: 0, text },
      });
    tapFrame(sid, { type: 'start', attemptId, turn: 1, step: 1 });
    delta(1, '你好，');
    tapFrame('child-session', {
      type: 'chunk',
      attemptId: 'child-session:1',
      index: 1,
      chunk: { type: 'text-delta', index: 0, text: '子 agent' },
    });
    delta(2, '世界');
    setTimeout(() => {
      sendAll([
        chunk(sid, 'agent_message_chunk', 'msg-1', '你好，世界'),
        { id, result: { stopReason: 'end_turn' } },
      ]);
      setTimeout(
        () =>
          tapFrame(sid, {
            type: 'end',
            attemptId,
            index: 3,
            outcome: { kind: 'committed', eventType: 'assistant/message' },
          }),
        20,
      );
    }, 50);
  },
  // 生成中等取消：取消后一次补发已生成的半段，结算为 cancelled（T0.3 场景 E2）。
  hang: (sid, id) => {
    const attemptId = `${sid}:1`;
    tapFrame(sid, {
      type: 'chunk',
      attemptId,
      index: 1,
      chunk: { type: 'text-delta', index: 0, text: '指南针、' },
    });
    tapFrame(sid, {
      type: 'chunk',
      attemptId,
      index: 2,
      chunk: { type: 'text-delta', index: 0, text: '造纸术' },
    });
    hanging.set(sid, id);
  },
  // 回合正常结束，但引擎从此不认识这个会话。
  forget: (sid, id) => {
    forgotten.add(sid);
    active.delete(sid);
    sendAll([{ id, result: { stopReason: 'end_turn' } }]);
  },
  // 回合正常结束；之后的 session/close 失败，会话仍挂在本进程上。
  stubborn: (sid, id) => {
    stubborn.add(sid);
    sendAll([{ id, result: { stopReason: 'end_turn' } }]);
  },
  // 不理会取消：cancel 应在时限内报 cancel_unconfirmed。
  stuck: () => {},
  // 回合中途进程退出。
  exit: () => {
    process.stderr.write('fake dsh: exit during turn\n');
    process.exit(3);
  },
};

function acp(message) {
  const { id, method, params } = message;
  if (method === 'session/new') {
    record.sessionNew = params;
    save();
    sessionCount += 1;
    const sessionId = `fake-${sessionCount}`;
    active.add(sessionId);
    cwds.set(sessionId, params.cwd);
    send({ id, result: { sessionId, configOptions: configOptions(sessionId) } });
  } else if (method === 'session/resume') {
    const { sessionId, cwd } = params;
    const failure = Object.entries(RESUME_FAILURES).find(([prefix]) =>
      sessionId.startsWith(prefix),
    );
    if (active.has(sessionId)) {
      send({
        id,
        error: { code: -32602, message: `Invalid params: session is already active: ${sessionId}` },
      });
    } else if (failure !== undefined) {
      const recorded = readFileSync(new URL(`./acp/errors/${failure[1]}`, import.meta.url), 'utf8');
      const { name: _name, ...error } = JSON.parse(
        recorded.replaceAll('<SESSION_ID>', sessionId),
      ).error;
      send({ id, error });
    } else if (cwds.has(sessionId) && cwds.get(sessionId) !== cwd) {
      send({
        id,
        error: { code: -32602, message: `Invalid params: session cwd does not match: ${cwd}` },
      });
    } else {
      active.add(sessionId);
      cwds.set(sessionId, cwd);
      send({ id, result: { configOptions: configOptions(sessionId) } });
    }
  } else if (method === 'session/prompt') {
    const word = params.prompt[0]?.text.split(' ')[0] ?? '';
    if (word.startsWith('replay:')) {
      void replay(word.slice('replay:'.length), params.sessionId, id);
      return;
    }
    const script = PROMPT_SCRIPTS[word] ?? PROMPT_SCRIPTS.order;
    script(params.sessionId, id);
  } else if (method === 'session/cancel') {
    const promptId = hanging.get(params.sessionId);
    if (promptId === undefined) return;
    hanging.delete(params.sessionId);
    sendAll([
      chunk(params.sessionId, 'agent_message_chunk', 'msg-half', '指南针、造纸术'),
      { id: promptId, result: { stopReason: 'cancelled' } },
    ]);
  } else if (method === 'session/set_config_option') {
    if (params.value.includes('missing')) {
      send({
        id,
        error: { code: -32602, message: `Invalid params: unknown model option: ${params.value}` },
      });
      return;
    }
    if (params.configId === 'model') routes.set(params.sessionId, params.value);
    send({
      id,
      result: {
        configOptions: configOptions(
          params.sessionId,
          params.configId === 'reasoning_effort' ? params.value : 'high',
        ),
      },
    });
  } else if (method === 'session/close') {
    if (forgotten.has(params.sessionId)) {
      send({
        id,
        error: { code: -32602, message: `Invalid params: unknown session: ${params.sessionId}` },
      });
    } else if (stubborn.has(params.sessionId)) {
      stubborn.delete(params.sessionId);
      send({ id, error: { code: -32603, message: 'Internal error: fake close failure' } });
    } else {
      active.delete(params.sessionId);
      send({ id, result: {} });
    }
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `"Method not found": ${method}` } });
  }
}

/**
 * 回放一份 T0.3 录制（`mock/transcripts/*.jsonl`）里 dsh 在第一个 session/prompt 之后写出的消息：会话 ID 换成
 * 当前会话，prompt 的结果换成当前请求的 id，其他响应（回应录制里别的请求）跳过。连续的消息一次写出，所以
 * 审批请求与它前面的 tool_call 在同一次读里到达。遇到 dsh 发出的请求（session/request_permission）先停下，
 * 等客户端回复了再继续：回复的内容不影响后面回放什么，测试要用与决定相符的样本（B allow、C deny、D cancel）。
 */
async function replay(name, sessionId, promptId) {
  const lines = readFileSync(join(process.env.FAKE_DSH_FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const start = lines.findIndex((l) => l.dir === 'c2a' && l.msg.method === 'session/prompt');
  const recordedSession = lines[start].msg.params.sessionId;
  const recordedPrompt = lines[start].msg.id;
  let batch = [];
  const flush = () => {
    if (batch.length > 0) process.stdout.write(batch.map((m) => `${JSON.stringify(m)}\n`).join(''));
    batch = [];
  };
  for (const { dir, msg } of lines.slice(start + 1)) {
    if (dir !== 'a2c') continue;
    const out = JSON.parse(JSON.stringify(msg).replaceAll(recordedSession, sessionId));
    if (out.method === undefined) {
      if (out.id !== recordedPrompt) continue;
      batch.push({ ...out, id: promptId });
      continue;
    }
    batch.push(out);
    if (out.id !== undefined) {
      const answered = new Promise((resolve) => waiters.set(out.id, resolve));
      flush();
      await answered;
    }
  }
  flush();
}
