#!/usr/bin/env node
// 合成的 Devin CLI：不登录、不联网、不运行工具。形状依据 3000.11.92 的官方 ACP 面，非真实账号录音。
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
if (env.FAKE_DEVIN_ARGV_LOG) appendFileSync(env.FAKE_DEVIN_ARGV_LOG, `${JSON.stringify(args)}\n`);
const signedIn = () =>
  env.FAKE_DEVIN_SIGNED_IN === '1' ||
  (env.FAKE_DEVIN_AUTH_STATE !== undefined && existsSync(env.FAKE_DEVIN_AUTH_STATE));
if (args[0] === '--version' || args[0] === 'version') {
  process.stdout.write(`devin ${env.FAKE_DEVIN_VERSION ?? '3000.11.92'} (7f4e64980e22)\n`);
  process.exit(Number(env.FAKE_DEVIN_VERSION_EXIT ?? 0));
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (env.FAKE_DEVIN_STATUS_OUTPUT !== undefined) {
    process.stdout.write(env.FAKE_DEVIN_STATUS_OUTPUT);
  } else if (signedIn()) {
    process.stdout.write(
      'Logged in as Fixture User (via Devin)\n  Name:              Fixture User\n  Email:             me@example.com\n  Plan:              Pro\n',
    );
  } else {
    process.stdout.write(
      'Not logged in.\n  Credentials path: /fixture/credentials.toml\nRun `devin auth login` to authenticate.\n',
    );
  }
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'logout') {
  if (env.FAKE_DEVIN_AUTH_STATE) rmSync(env.FAKE_DEVIN_AUTH_STATE, { force: true });
  process.stdout.write('Logged out successfully\n');
  process.exit(0);
}
if (args.length !== 1 || args[0] !== 'acp') process.exit(2);
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
const samples = readFileSync(join(here, 'acp.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const sample = (name) => structuredClone(samples.find((entry) => entry.name === name).value);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, value) =>
  send({ method: 'session/update', params: { sessionId, update: value } });
const sessions = new Map();
const pending = new Map();
let nextRequest = 1000;

function request(method, params) {
  const id = ++nextRequest;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
function persist(id, state) {
  if (!env.FAKE_DEVIN_STORE) return;
  mkdirSync(env.FAKE_DEVIN_STORE, { recursive: true });
  writeFileSync(
    join(env.FAKE_DEVIN_STORE, `${id}.json`),
    JSON.stringify({
      cwd: state.cwd,
      model: state.model,
      mode: state.mode,
      history: state.history,
    }),
  );
}
function restore(id) {
  if (!env.FAKE_DEVIN_STORE) return undefined;
  const file = join(env.FAKE_DEVIN_STORE, `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
function configs(state) {
  const mode = sample('modeOption');
  mode.currentValue = state.mode;
  if (env.FAKE_DEVIN_NO_SMART === '1')
    mode.options = mode.options.filter((option) => option.value !== 'smart');
  const model = sample('modelOption');
  model.currentValue = state.model;
  // 真 CLI 没登录时模型选项是空的。
  if (!signedIn()) model.options = [];
  return [mode, model];
}
const handlers = {
  initialize: () => sample('initialize'),
  'session/new': (params) => {
    const sessionId = `devin-fake-${process.pid}-${sessions.size + 1}-${nextRequest++}`;
    const state = { cwd: params.cwd, model: 'fixture-model-a', mode: 'accept-edits', history: [] };
    sessions.set(sessionId, state);
    persist(sessionId, state);
    if (env.FAKE_DEVIN_SESSION_LOG)
      appendFileSync(env.FAKE_DEVIN_SESSION_LOG, `${JSON.stringify({ new: sessionId })}\n`);
    return { sessionId, configOptions: configs(state) };
  },
  'session/resume': () => {
    throw { code: -32601, message: 'Method not found' };
  },
  'session/close': () => ({}),
  'session/delete': (params) => {
    sessions.delete(params.sessionId);
    if (env.FAKE_DEVIN_STORE)
      rmSync(join(env.FAKE_DEVIN_STORE, `${params.sessionId}.json`), { force: true });
    if (env.FAKE_DEVIN_SESSION_LOG)
      appendFileSync(
        env.FAKE_DEVIN_SESSION_LOG,
        `${JSON.stringify({ deleted: params.sessionId })}\n`,
      );
    return {};
  },
  'session/set_config_option': (params) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw sample('notFound');
    const option = configs(state).find((option) => option.id === params.configId);
    if (!option?.options.some((entry) => entry.value === params.value))
      throw {
        code: -32602,
        message: 'Invalid params',
        data: `Invalid value '${params.value}' for config option '${params.configId}'`,
      };
    state[params.configId] = params.value;
    persist(params.sessionId, state);
    const configOptions = configs(state);
    update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions });
    return { configOptions };
  },
};

async function load(id, params) {
  const state = sessions.get(params.sessionId) ?? restore(params.sessionId);
  if (!state) return send({ id, error: sample('notFound') });
  sessions.set(params.sessionId, state);
  // 和真的一样：先把历史作 session/update 回放，再回答。
  for (const text of state.history) {
    update(params.sessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
    });
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `echo: ${text}` },
    });
  }
  send({ id, result: { configOptions: configs(state) } });
}

// 只在 FAKE_DEVIN_ALLOW_AUTH=1 时才认 authenticate：等 FAKE_DEVIN_AUTH_DONE 文件出现（用户“在浏览器里登录”）再成功，或按
// FAKE_DEVIN_AUTH_FAIL 失败。
async function authenticate(id, params) {
  if (env.FAKE_DEVIN_ALLOW_AUTH !== '1')
    return send({ id, error: { code: -32602, message: 'Tests must never authenticate' } });
  if (env.FAKE_DEVIN_AUTH_LOG)
    appendFileSync(env.FAKE_DEVIN_AUTH_LOG, `${JSON.stringify({ methodId: params.methodId })}\n`);
  if (env.FAKE_DEVIN_AUTH_FAIL === '1') {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return send({ id, error: { code: -32000, message: 'Failed to receive authorization code' } });
  }
  while (!env.FAKE_DEVIN_AUTH_DONE || !existsSync(env.FAKE_DEVIN_AUTH_DONE))
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (env.FAKE_DEVIN_AUTH_STATE) writeFileSync(env.FAKE_DEVIN_AUTH_STATE, 'signed-in');
  send({ id, result: {} });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const state = sessions.get(sessionId);
  if (!state) return send({ id, error: sample('notFound') });
  if (!signedIn()) return send({ id, error: sample('authError') });
  let cancel;
  const cancelled = new Promise((resolve) => {
    cancel = () => resolve('cancelled');
  });
  state.cancel = cancel;
  const text = params.prompt?.find((part) => part.type === 'text')?.text ?? '';
  const emit = (name) => update(sessionId, sample(name));
  let stopReason = 'end_turn';
  try {
    if (text.startsWith('error:')) {
      const errors = {
        provider: {
          code: -32603,
          message: 'Internal error',
          data: { details: '429 usage limit reached' },
        },
        unknown: { code: -32603, message: 'Unexpected failure' },
      };
      return send({ id, error: errors[text.slice(6)] });
    }
    if (text === 'hang') {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting' },
      });
      await cancelled;
      stopReason = 'cancelled';
    } else if (text === 'elicitation-form') {
      // ACP `elicitation/create`（引擎的 MCP 服务要用户输入）：回答原样作为助手的文字交回去。
      const answer = await Promise.race([
        request('elicitation/create', {
          sessionId,
          mode: 'form',
          message: 'New ticket',
          requestedSchema: {
            type: 'object',
            properties: { title: { type: 'string', title: 'Title' } },
            required: ['title'],
          },
        }),
        cancelled,
      ]);
      if (answer === 'cancelled') stopReason = 'cancelled';
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(answer?.result ?? {}) },
      });
    } else if (text === 'approval') {
      const toolCallId = `tool-${id}`;
      const rawInput = { command: 'echo ok > approve.txt' };
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'exec',
        kind: 'execute',
        status: 'pending',
        rawInput,
      });
      const answer = await Promise.race([
        request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId, title: 'exec', kind: 'execute', rawInput },
          options: sample('permissionOptions'),
        }),
        cancelled,
      ]);
      const outcome = answer?.result?.outcome;
      if (answer === 'cancelled' || outcome?.outcome === 'cancelled') stopReason = 'cancelled';
      const allowed = outcome?.optionId?.startsWith('allow');
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: allowed ? 'completed' : 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: allowed ? 'done' : 'Permission denied' },
          },
        ],
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Finished' },
      });
    } else {
      if (text === 'tool') {
        emit('read');
        emit('readFinished');
      }
      emit('thought');
      for (const chunk of ['echo: ', text])
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        });
      state.history.push(text);
      persist(sessionId, state);
    }
    send({ id, result: { stopReason } });
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } });
  } finally {
    state.cancel = undefined;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (env.FAKE_DEVIN_LOG) appendFileSync(env.FAKE_DEVIN_LOG, `${line}\n`);
  if (message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'session/cancel') {
    sessions.get(message.params?.sessionId)?.cancel?.();
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'authenticate') return void authenticate(message.id, message.params ?? {});
  if (message.method === 'session/prompt') return void prompt(message.id, message.params);
  if (message.method === 'session/load') return void load(message.id, message.params);
  try {
    const handler = handlers[message.method];
    if (!handler) throw { code: -32601, message: 'Method not found' };
    send({ id: message.id, result: handler(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error });
  }
});
rl.on('close', () => process.exit(0));
