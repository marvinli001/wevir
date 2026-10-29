#!/usr/bin/env node
// 合成的 GitHub Copilot CLI：不登录、不联网、不运行工具。形状依据 1.0.103 的官方 ACP 面，非真实账号录音。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const env = process.env;
const args = process.argv.slice(2);
if (env.FAKE_COPILOT_ARGV_LOG) {
  appendFileSync(
    env.FAKE_COPILOT_ARGV_LOG,
    `${JSON.stringify({ args, home: env.COPILOT_HOME ?? null, gh: env.GH_CONFIG_DIR ?? null, token: env.GH_TOKEN ?? null, autoUpdate: env.COPILOT_AUTO_UPDATE ?? null })}\n`,
  );
}
const configDir = env.COPILOT_HOME || join(homedir(), '.copilot');
const configFile = join(configDir, 'config.json');
function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return {};
  }
}
function writeConfig(config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configFile,
    `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(config, null, 2)}\n`,
  );
}
const signedIn = () =>
  env.FAKE_COPILOT_SIGNED_IN === '1' || readConfig().lastLoggedInUser !== undefined;

if (args[0] === '--version' || args[0] === 'version') {
  process.stdout.write(
    `GitHub Copilot CLI ${env.FAKE_COPILOT_VERSION ?? '1.0.103'}.\nRun 'copilot update' to check for updates.\n`,
  );
  process.exit(Number(env.FAKE_COPILOT_VERSION_EXIT ?? 0));
}
if (args[0] === 'login') {
  if (!args.includes('--device-code')) process.exit(2);
  // 与 1.0.103 的 `copilot login --device-code` 打印的相同。
  process.stdout.write(
    'To authenticate, visit https://github.com/login/device and enter code FAKE-1234\n',
  );
  process.stdout.write('Waiting for authorization...\n');
  if (env.FAKE_COPILOT_AUTH_FAIL === '1') {
    setTimeout(() => {
      process.stderr.write('Login failed: Error: the device code expired\n');
      process.exit(1);
    }, 50);
  } else {
    const timer = setInterval(() => {
      if (!env.FAKE_COPILOT_AUTH_DONE || !existsSync(env.FAKE_COPILOT_AUTH_DONE)) return;
      clearInterval(timer);
      writeConfig({
        ...readConfig(),
        lastLoggedInUser: {
          host: 'https://github.com',
          login: env.FAKE_COPILOT_LOGIN ?? 'octocat',
        },
      });
      process.stdout.write('Signed in successfully as octocat.\n');
      process.exit(0);
    }, 25);
  }
} else {
  if (!(args.includes('--acp') && args.includes('--stdio'))) process.exit(2);
  serve();
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
    if (!env.FAKE_COPILOT_STORE) return;
    mkdirSync(env.FAKE_COPILOT_STORE, { recursive: true });
    writeFileSync(
      join(env.FAKE_COPILOT_STORE, `${id}.json`),
      JSON.stringify({ cwd: state.cwd, model: state.model, history: state.history }),
    );
  }
  function restore(id) {
    if (!env.FAKE_COPILOT_STORE) return undefined;
    const file = join(env.FAKE_COPILOT_STORE, `${id}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  }
  function configs(state) {
    const model = sample('modelOption');
    model.currentValue = state.model;
    return [sample('modeOption'), model];
  }
  const handlers = {
    initialize: () => sample('initialize'),
    'session/new': (params) => {
      if (!signedIn()) throw sample('authError');
      const sessionId = `copilot-fake-${process.pid}-${sessions.size + 1}-${nextRequest++}`;
      const state = { cwd: params.cwd, model: 'auto', history: [] };
      sessions.set(sessionId, state);
      persist(sessionId, state);
      if (env.FAKE_COPILOT_SESSION_LOG)
        appendFileSync(env.FAKE_COPILOT_SESSION_LOG, `${JSON.stringify({ new: sessionId })}\n`);
      return { sessionId, configOptions: configs(state) };
    },
    'session/resume': () => {
      throw { code: -32601, message: 'Method not found' };
    },
    'session/close': (params) => {
      if (env.FAKE_COPILOT_SESSION_LOG)
        appendFileSync(
          env.FAKE_COPILOT_SESSION_LOG,
          `${JSON.stringify({ closed: params.sessionId })}\n`,
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
      if (option.category === 'model') state.model = params.value;
      persist(params.sessionId, state);
      const configOptions = configs(state);
      update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions });
      return { configOptions };
    },
    logout: () => {
      if (env.FAKE_COPILOT_SIGNED_IN === '1')
        throw {
          code: -32603,
          message:
            'The active authentication source is not managed by Copilot and cannot be logged out',
        };
      const { lastLoggedInUser: _user, ...rest } = readConfig();
      writeConfig(rest);
      return {};
    },
  };

  async function load(id, params) {
    if (!signedIn()) return send({ id, error: sample('authError') });
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
    send({ id, result: { configOptions: configs(state) } });
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
          provider: { code: -32603, message: 'You have exceeded your premium request allowance' },
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
          title: 'Execute shell command',
          kind: 'execute',
          status: 'pending',
          rawInput,
        });
        const answer = await Promise.race([
          request('session/request_permission', {
            sessionId,
            toolCall: { toolCallId, title: 'Execute shell command', kind: 'execute', rawInput },
            options: sample('permissionOptions'),
          }),
          cancelled,
        ]);
        const outcome = answer?.result?.outcome;
        if (env.FAKE_COPILOT_PERMISSION_LOG)
          appendFileSync(env.FAKE_COPILOT_PERMISSION_LOG, `${JSON.stringify(outcome ?? null)}\n`);
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
      if (env.FAKE_COPILOT_USAGE === '1') {
        send({
          method: 'github.com/copilot/sessionEvent',
          params: { ...sample('usageEvent'), sessionId },
        });
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
    if (env.FAKE_COPILOT_LOG) appendFileSync(env.FAKE_COPILOT_LOG, `${line}\n`);
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
