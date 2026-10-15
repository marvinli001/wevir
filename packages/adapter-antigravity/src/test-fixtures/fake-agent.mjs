// 测试用的假 Antigravity ACP 运行体：照 T3 Code 测试里的 Antigravity 样本（initialize、configOptions、interaction_* 提问、
// run_command 的原生字段、逐字增量没有 messageId）说 ACP，没有任何真实的 Google 账号或网络请求。测试把它复制成
// `agy_acp_server.par`（首行换成当前 Node 的 shebang），旁边放一个 `localharness_external`。
//
// 登录（authenticate）：GEMINI_HOME/antigravity-acp/acp_token.json 在就直接通过；不在就在 127.0.0.1 上开一个回调端口，
// 用 BROWSER 命令“打开” Google 的登录网址（FAKE_AGY_NATIVE_URL=1 时照 1.1.1 把提示行写在 stdout 上），测试对回调端口发
// `?code=…&state=…` 后写下登录文件。会话记在 GEMINI_HOME/fake-sessions.json，进程之间共用（resume）。
//
// 提示词决定回合：含 slow 逐字慢慢写直到取消；含 approve 申请写文件的审批；含 ask 借审批方法提问；含 tool 跑一个命令；
// 含 mode 报出当前模型与模式；其余是一段思考加两段回答。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

const AUTH_PREFIX = 'Open the following link to authenticate the ACP server: ';
const home = process.env.GEMINI_HOME;
if (!home) {
  process.stderr.write('GEMINI_HOME is not set\n');
  process.exit(2);
}
const acpDir = path.join(home, 'antigravity-acp');
const tokenPath = path.join(acpDir, 'acp_token.json');
const sessionsPath = path.join(home, 'fake-sessions.json');

if (process.env.FAKE_AGY_ENV_DUMP) {
  fs.writeFileSync(
    process.env.FAKE_AGY_ENV_DUMP,
    JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) }),
  );
}
if (process.env.FAKE_AGY_EXIT_AT_START) process.exit(Number(process.env.FAKE_AGY_EXIT_AT_START));

let nextId = 1;
const waiting = new Map();
const cancelled = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function respond(id, result) {
  send({ id, result });
}
function fail(id, code, message) {
  send({ id, error: { code, message } });
}
function notify(sessionId, update) {
  send({ method: 'session/update', params: { sessionId, update } });
}
function request(method, params) {
  const id = `agent-${nextId++}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  } catch {
    return {};
  }
}
function saveSessions(sessions) {
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
}

const MODELS = [
  { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
  {
    groupId: 'pro',
    name: 'Pro',
    options: [
      { value: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
      { value: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
    ],
  },
];
const MODES = [
  { value: 'default', name: 'Default' },
  { value: 'auto_edit', name: 'Auto edit' },
  { value: 'yolo', name: 'YOLO' },
];
const MODEL_IDS = ['gemini-3.7-flash-high', 'gemini-pro-agent', 'gemini-3.1-pro-low'];

function configOptions(session) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: session.model,
      options: MODELS,
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: session.mode,
      options: MODES,
    },
  ];
}

function initializeResult() {
  return {
    protocolVersion: Number(process.env.FAKE_AGY_PROTOCOL ?? 1),
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, resume: {} },
      auth: { logout: {} },
    },
    authMethods: [
      {
        id: 'oauth-personal',
        name: 'Log in with Google',
        description: 'Log in with your Google account',
      },
    ],
    agentInfo: {
      name: process.env.FAKE_AGY_NAME ?? 'antigravity-acp',
      title: 'Google Antigravity',
      version: process.env.FAKE_AGY_VERSION ?? '1.3.0',
    },
  };
}

/** 照 Python shlex 的单引号规则切开 BROWSER 命令。 */
function splitCommand(command) {
  const parts = [];
  let current = '';
  let quoted = false;
  let any = false;
  for (const char of command) {
    if (quoted) {
      if (char === "'") quoted = false;
      else current += char;
    } else if (char === "'") {
      quoted = true;
      any = true;
    } else if (char === '"') {
    } else if (char === ' ') {
      if (any || current !== '') parts.push(current);
      current = '';
      any = false;
    } else {
      current += char;
    }
  }
  if (any || current !== '') parts.push(current);
  return parts;
}

function authenticate(id) {
  if (fs.existsSync(tokenPath)) {
    respond(id, {});
    return;
  }
  const state = randomUUID();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('bad state');
      return;
    }
    const error = url.searchParams.get('error');
    res.writeHead(200).end('ok');
    server.close();
    if (error) {
      fail(id, -32000, `Authentication failed: ${error}`);
      return;
    }
    fs.mkdirSync(acpDir, { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ fake: true }));
    respond(id, {});
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=fake&state=${state}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/`)}`;
    if (process.env.FAKE_AGY_NATIVE_URL) {
      process.stdout.write(`${AUTH_PREFIX}${authUrl}\n`);
      return;
    }
    const [command, ...args] = splitCommand(process.env.BROWSER ?? '').map((part) =>
      part.replaceAll('%s', authUrl),
    );
    if (!command) {
      process.stdout.write(`${AUTH_PREFIX}${authUrl}\n`);
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', () => process.stdout.write(`${AUTH_PREFIX}${authUrl}\n`));
  });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const session = loadSessions()[sessionId];
  if (!session) {
    fail(id, -32602, `Session not found: ${sessionId}`);
    return;
  }
  cancelled.delete(sessionId);
  const text = params.prompt.map((part) => part.text ?? '').join('');
  const chunk = (value, kind = 'agent_message_chunk') =>
    notify(sessionId, { sessionUpdate: kind, content: { type: 'text', text: value } });

  if (/slow/i.test(text)) {
    for (let i = 0; i < 500; i++) {
      if (cancelled.has(sessionId)) {
        respond(id, { stopReason: 'cancelled' });
        return;
      }
      chunk('tick ');
      await sleep(20);
    }
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (/approve/i.test(text)) {
    const target = path.join(path.dirname(session.cwd), 'outside.txt');
    notify(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-write',
      title: 'write_to_file',
      kind: 'edit',
      status: 'pending',
      rawInput: { TargetFile: target, CodeContent: 'hello' },
      locations: [{ path: target }],
    });
    const response = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-write', title: 'Write outside.txt', kind: 'edit' },
      options: [
        { optionId: 'remember', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const outcome = response?.outcome;
    const allowed =
      outcome?.outcome === 'selected' &&
      (outcome.optionId === 'once' || outcome.optionId === 'remember');
    notify(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-write',
      status: allowed ? 'completed' : 'failed',
    });
    if (cancelled.has(sessionId) || outcome?.outcome === 'cancelled') {
      respond(id, { stopReason: 'cancelled' });
      return;
    }
    chunk(allowed ? 'Wrote the file.' : 'Did not write the file.');
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (/ask/i.test(text)) {
    const response = await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: 'interaction_9960062f',
        status: 'pending',
        title: 'Which result label should be used for the verification?',
        rawInput: {},
      },
      options: [
        { optionId: '1', name: 'Verified', kind: 'allow_once' },
        { optionId: '2', name: 'Needs review', kind: 'allow_once' },
      ],
    });
    if (response?.outcome?.outcome !== 'selected') {
      respond(id, { stopReason: 'cancelled' });
      return;
    }
    chunk(`You chose ${response.outcome.optionId}.`);
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (/tool/i.test(text)) {
    notify(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'fc28d0af6ad14be8bbba20f4258d4d3e',
      title: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'cat probe.txt', Cwd: session.cwd },
    });
    notify(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fc28d0af6ad14be8bbba20f4258d4d3e',
      status: 'completed',
      rawOutput: {
        commandLine: 'cat probe.txt',
        workingDir: session.cwd,
        exitCode: 0,
        exit_code: 0,
        combinedOutput: 'after\n',
        formatted_output: 'after\n',
      },
    });
    chunk('Done.');
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (/mode/i.test(text)) {
    chunk(`mode=${session.mode} model=${session.model}`);
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  chunk('Thinking about it.', 'agent_thought_chunk');
  chunk('Hello');
  chunk(' from Antigravity.');
  respond(id, { stopReason: 'end_turn' });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      respond(id, initializeResult());
      return;
    case 'authenticate':
      authenticate(id);
      return;
    case 'logout':
      fs.rmSync(tokenPath, { force: true });
      respond(id, {});
      return;
    case 'session/new': {
      if (!fs.existsSync(tokenPath)) {
        fail(id, -32000, 'Authentication required.');
        return;
      }
      const sessionId = randomUUID();
      const sessions = loadSessions();
      sessions[sessionId] = { cwd: params.cwd, model: MODEL_IDS[0], mode: 'default' };
      saveSessions(sessions);
      fs.mkdirSync(path.join(acpDir, 'conversations'), { recursive: true });
      fs.writeFileSync(
        path.join(acpDir, 'conversations', `${sessionId}.meta`),
        JSON.stringify({ cwd: params.cwd }),
      );
      fs.writeFileSync(path.join(acpDir, 'conversations', `${sessionId}.db`), '');
      respond(id, { sessionId, configOptions: configOptions(sessions[sessionId]) });
      return;
    }
    case 'session/resume': {
      const session = loadSessions()[params.sessionId];
      if (!session) {
        fail(id, -32602, `Session not found: ${params.sessionId}`);
        return;
      }
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case 'session/close':
      respond(id, {});
      return;
    case 'session/set_config_option': {
      const sessions = loadSessions();
      const session = sessions[params.sessionId];
      const valid =
        params.configId === 'model'
          ? MODEL_IDS.includes(params.value)
          : params.configId === 'mode' && MODES.some((mode) => mode.value === params.value);
      if (!session || !valid) {
        fail(id, -32602, `Invalid config option ${params.configId}=${params.value}`);
        return;
      }
      session[params.configId] = params.value;
      saveSessions(sessions);
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case 'session/cancel':
      cancelled.add(params.sessionId);
      return;
    case 'session/prompt':
      void prompt(id, params);
      return;
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message);
});
lines.on('close', () => process.exit(0));
