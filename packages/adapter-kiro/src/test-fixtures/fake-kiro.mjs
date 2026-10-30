#!/usr/bin/env node
// 合成的 Kiro CLI：不登录、不联网、不运行工具。形状依据 2.36.0 的官方程序与 ACP 文档，非真实账号录音。
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
if (env.FAKE_KIRO_ARGV_LOG) {
  appendFileSync(
    env.FAKE_KIRO_ARGV_LOG,
    `${JSON.stringify({ args, autoUpdate: env.KIRO_NO_AUTO_UPDATE ?? null, apiKey: env.KIRO_API_KEY ? 'set' : null })}\n`,
  );
}
function readState() {
  try {
    return JSON.parse(readFileSync(env.FAKE_KIRO_STATE, 'utf8'));
  } catch {
    return undefined;
  }
}
function writeState(state) {
  mkdirSync(dirname(env.FAKE_KIRO_STATE), { recursive: true });
  writeFileSync(env.FAKE_KIRO_STATE, JSON.stringify(state));
}
const signedIn = () =>
  env.FAKE_KIRO_SIGNED_IN === '1' || Boolean(env.KIRO_API_KEY) || readState() !== undefined;

if (args[0] === '--version' || args[0] === '-V') {
  process.stdout.write(`kiro-cli ${env.FAKE_KIRO_VERSION ?? '2.36.0'}\n`);
  process.exit(Number(env.FAKE_KIRO_VERSION_EXIT ?? 0));
}
if (args[0] === 'whoami') {
  if (!args.includes('json')) process.exit(2);
  const state = readState();
  const account = state ?? (signedIn() ? { accountType: 'ApiKey' } : null);
  process.stdout.write(`${JSON.stringify({ account })}\n`);
  process.exit(0);
}
if (args[0] === 'logout') {
  if (env.KIRO_API_KEY) {
    process.stderr.write('Already authenticated via KIRO_API_KEY. To logout unset KIRO_API_KEY\n');
    process.exit(1);
  }
  if (env.FAKE_KIRO_STATE) rmSync(env.FAKE_KIRO_STATE, { force: true });
  process.stdout.write('You are now logged out\nRun kiro-cli login to log back in to Kiro\n');
  process.exit(0);
}
if (args[0] === 'login') {
  if (!args.includes('--use-device-flow')) process.exit(2);
  // 与 2.36.0 的 `kiro-cli login --use-device-flow` 打印的相同（后面跟着画进度条的控制序列）。
  process.stdout.write(
    '\nConfirm the following code in the browser\nCode: FAKE-1234\n\nOpen this URL: https://view.awsapps.com/start/#/device?user_code=FAKE-1234\n\u001b[?25l\r▀▁ Logging in...',
  );
  if (env.FAKE_KIRO_AUTH_FAIL === '1') {
    setTimeout(() => {
      process.stderr.write('\nerror: Device authorization expired\n');
      process.exit(1);
    }, 50);
  } else {
    const timer = setInterval(() => {
      if (!env.FAKE_KIRO_AUTH_DONE || !existsSync(env.FAKE_KIRO_AUTH_DONE)) return;
      clearInterval(timer);
      const social = args[args.indexOf('--social') + 1];
      writeState({
        accountType: args.includes('--social') ? 'Social' : 'BuilderId',
        ...(args.includes('--social') && { provider: social }),
        email: env.FAKE_KIRO_EMAIL ?? 'me@example.com',
      });
      process.stdout.write('\nLogged in successfully\n');
      process.exit(0);
    }, 25);
  }
} else if (args[0] === 'acp') {
  if (!signedIn()) {
    process.stderr.write(
      'Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.\n',
    );
    process.exit(1);
  }
  serve();
} else {
  process.exit(2);
}

function serve() {
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
    if (!env.FAKE_KIRO_STORE) return;
    mkdirSync(env.FAKE_KIRO_STORE, { recursive: true });
    writeFileSync(
      join(env.FAKE_KIRO_STORE, `${id}.json`),
      JSON.stringify({ cwd: state.cwd, model: state.model, history: state.history }),
    );
  }
  function restore(id) {
    if (!env.FAKE_KIRO_STORE) return undefined;
    const file = join(env.FAKE_KIRO_STORE, `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  }
  function models(state) {
    const value = sample('models');
    value.currentModelId = state.model;
    return value;
  }
  const handlers = {
    initialize: () => sample('initialize'),
    'session/new': (params) => {
      const sessionId = `kiro-fake-${process.pid}-${sessions.size + 1}-${nextRequest++}`;
      const state = { cwd: params.cwd, model: 'auto', history: [] };
      sessions.set(sessionId, state);
      persist(sessionId, state);
      if (env.FAKE_KIRO_SESSION_LOG)
        appendFileSync(env.FAKE_KIRO_SESSION_LOG, `${JSON.stringify({ new: sessionId })}\n`);
      return { sessionId, models: models(state), modes: sample('modes') };
    },
    'session/resume': () => {
      throw { code: -32601, message: 'Method not found' };
    },
    'session/set_config_option': () => {
      throw { code: -32601, message: 'Method not found' };
    },
    'session/close': (params) => {
      if (env.FAKE_KIRO_SESSION_LOG)
        appendFileSync(
          env.FAKE_KIRO_SESSION_LOG,
          `${JSON.stringify({ closed: params.sessionId })}\n`,
        );
      return {};
    },
    'session/set_model': (params) => {
      const state = sessions.get(params.sessionId);
      if (!state) throw sample('notFound');
      if (!sample('models').availableModels.some((model) => model.modelId === params.modelId))
        throw { code: -32602, message: 'Invalid params', data: `Unknown model: ${params.modelId}` };
      state.model = params.modelId;
      persist(params.sessionId, state);
      return {};
    },
  };

  async function load(id, params) {
    const state = sessions.get(params.sessionId) ?? restore(params.sessionId);
    if (!state) return send({ id, error: sample('notFound') });
    sessions.set(params.sessionId, state);
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
    send({ id, result: { models: models(state), modes: sample('modes') } });
  }

  async function prompt(id, params) {
    const sessionId = params.sessionId;
    const state = sessions.get(sessionId);
    if (!state) return send({ id, error: sample('notFound') });
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
          auth: { code: -32603, message: 'Not logged in. Run `kiro-cli login` first.' },
          provider: {
            code: -32603,
            message: 'MonthlyRequestCount: you have used all your credits',
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
      } else if (text === 'approval') {
        const toolCallId = `tool-${id}`;
        const rawInput = { command: 'echo ok > approve.txt' };
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'execute_bash',
          kind: 'execute',
          status: 'pending',
          rawInput,
        });
        const answer = await Promise.race([
          request('session/request_permission', {
            sessionId,
            toolCall: { toolCallId, title: 'execute_bash', kind: 'execute', rawInput },
            options: sample('permissionOptions'),
          }),
          cancelled,
        ]);
        const outcome = answer?.result?.outcome;
        if (env.FAKE_KIRO_PERMISSION_LOG)
          appendFileSync(env.FAKE_KIRO_PERMISSION_LOG, `${JSON.stringify(outcome ?? null)}\n`);
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
        for (const chunk of ['echo: ', text])
          update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: chunk },
          });
        state.history.push(text);
        persist(sessionId, state);
      }
      // Kiro 的扩展通知：适配器不认识，SDK 丢掉。
      send({ method: '_kiro.dev/metadata', params: { sessionId, ...sample('metadata') } });
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
    if (env.FAKE_KIRO_LOG) appendFileSync(env.FAKE_KIRO_LOG, `${line}\n`);
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
    if (message.method === 'authenticate')
      return send({
        id: message.id,
        error: { code: -32602, message: 'Tests must never authenticate' },
      });
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
}
