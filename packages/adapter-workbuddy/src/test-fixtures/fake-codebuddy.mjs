#!/usr/bin/env node
// 合成的 CodeBuddy ACP 服务：不登录、不联网、不运行工具。形状依据 2.168.2 官方 ACP 面，非真实账号录音。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const env = process.env;
const args = process.argv.slice(2);
if (env.FAKE_WORKBUDDY_ARGV_LOG)
  appendFileSync(env.FAKE_WORKBUDDY_ARGV_LOG, `${JSON.stringify(args)}\n`);
if (args.includes('--version')) {
  process.stdout.write(`${env.FAKE_WORKBUDDY_VERSION ?? '2.168.2'}\n`);
  process.exit(Number(env.FAKE_WORKBUDDY_VERSION_EXIT ?? 0));
}
if (args.length !== 1 || args[0] !== '--acp') process.exit(2);
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
  if (!env.FAKE_WORKBUDDY_STORE) return;
  mkdirSync(env.FAKE_WORKBUDDY_STORE, { recursive: true });
  writeFileSync(
    join(env.FAKE_WORKBUDDY_STORE, `${id}.json`),
    JSON.stringify({ cwd: state.cwd, model: state.model, effort: state.effort, mode: state.mode }),
  );
}
function restore(id) {
  if (!env.FAKE_WORKBUDDY_STORE) return undefined;
  const file = join(env.FAKE_WORKBUDDY_STORE, `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
function configs(state) {
  const result = sample('configOptions');
  for (const option of result) {
    if (option.id === 'model') option.currentValue = state.model;
    if (option.id === 'mode') option.currentValue = state.mode;
    if (option.id === 'thought_level') {
      option.currentValue = state.effort;
      if (state.model === 'fixture-model-b')
        option.options = [
          { value: 'enabled', name: 'Default' },
          { value: 'low', name: 'Low' },
        ];
    }
  }
  if (env.FAKE_WORKBUDDY_NO_MODE === '1') return result.filter((option) => option.id !== 'mode');
  if (env.FAKE_WORKBUDDY_NO_MODELS === '1')
    return result.filter((option) => !['model', 'thought_level'].includes(option.id));
  return result;
}
function checkAuth() {
  if (env.FAKE_WORKBUDDY_SIGNED_OUT === '1')
    throw { code: -32000, message: 'Authentication required', data: { category: 'auth' } };
}
const handlers = {
  initialize: () => sample('initialize'),
  authenticate: () => {
    throw { code: -32602, message: 'Tests must never authenticate' };
  },
  'session/new': (params) => {
    checkAuth();
    if (env.FAKE_WORKBUDDY_PROBE_ERROR === '1')
      throw { code: -32603, message: 'ACP version changed' };
    const sessionId = `workbuddy-fake-${process.pid}-${sessions.size + 1}-${nextRequest++}`;
    const state = {
      cwd: params.cwd,
      model: 'fixture-model-a',
      effort: 'enabled',
      mode: env.FAKE_WORKBUDDY_INITIAL_MODE ?? 'default',
    };
    sessions.set(sessionId, state);
    persist(sessionId, state);
    return { sessionId, configOptions: configs(state) };
  },
  'session/resume': (params) => {
    checkAuth();
    const state = sessions.get(params.sessionId) ?? restore(params.sessionId);
    if (!state) throw { code: -32602, message: `Session not found: ${params.sessionId}` };
    sessions.set(params.sessionId, state);
    return { configOptions: configs(state) };
  },
  // 2.168.2 没有承诺 session/close；验证通用适配器的本地关闭兜底。
  'session/close': () => {
    throw { code: -32601, message: 'Method not found: session/close' };
  },
  'session/set_model': () => {
    throw { code: -32603, message: 'Use set_config_option' };
  },
  'session/set_config_option': (params) => {
    const state = sessions.get(params.sessionId);
    if (!state) throw { code: -32602, message: 'Session not found' };
    if (env.FAKE_WORKBUDDY_REJECT_MODE === params.value)
      throw { code: -32602, message: 'Mode unavailable' };
    const option = configs(state).find((option) => option.id === params.configId);
    const values = (entries) =>
      entries.flatMap((entry) =>
        entry.value !== undefined ? [entry.value] : values(entry.options ?? []),
      );
    if (!option || !values(option.options).includes(params.value))
      throw { code: -32602, message: 'Unknown option' };
    const key = { model: 'model', thought_level: 'effort', mode: 'mode' }[params.configId];
    state[key] = params.value;
    if (key === 'model') state.effort = 'enabled';
    persist(params.sessionId, state);
    const configOptions = configs(state);
    update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions });
    return { configOptions };
  },
  '_codebuddy.ai/resolveInterruption': (params) => {
    const state = sessions.get(params.sessionId);
    if (state?.questionTool !== params.toolCallId) return { resolved: false };
    state.answers = params.answers;
    return { resolved: true };
  },
};

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const state = sessions.get(sessionId);
  if (!state) return send({ id, error: { code: -32602, message: 'Unknown session' } });
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
        auth: { code: -32000, message: 'Authentication required' },
        provider: {
          code: -32603,
          message: 'Internal error',
          data: { details: '429 credit limit reached' },
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
    } else if (text === 'approval' || text === 'question' || text === 'exit-plan') {
      const name =
        text === 'approval' ? 'Write' : text === 'question' ? 'AskUserQuestion' : 'ExitPlanMode';
      const toolCallId = `tool-${id}`;
      const rawInput =
        text === 'question'
          ? sample('questionInput')
          : { file_path: join(state.cwd, 'approve.txt'), content: 'ok' };
      const meta = {
        'codebuddy.ai/toolName': name,
        ...(text === 'exit-plan' && { 'codebuddy.ai/plan': '# Fixture plan\n\nInspect the file.' }),
      };
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: name,
        kind: text === 'approval' ? 'edit' : 'other',
        status: 'pending',
        rawInput,
        _meta: meta,
      });
      state.questionTool = toolCallId;
      const permission = {
        sessionId,
        toolCall: { toolCallId, rawInput, _meta: meta },
        options: sample('permissionOptions'),
      };
      const answer = await Promise.race([
        request('session/request_permission', permission),
        cancelled,
      ]);
      const outcome = answer?.result?.outcome;
      if (answer === 'cancelled' || outcome?.outcome === 'cancelled') stopReason = 'cancelled';
      const allowed = outcome?.optionId?.startsWith('allow');
      if (text === 'question' && allowed && state.answers === undefined)
        throw new Error('Question answers were not delivered through ACP');
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: allowed ? 'completed' : 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text:
                text === 'question'
                  ? JSON.stringify(state.answers ?? {})
                  : allowed
                    ? 'done'
                    : 'Permission denied',
            },
          },
        ],
      });
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Finished' },
      });
    } else if (text === 'question-extension') {
      const answer = await Promise.race([
        request('_codebuddy.ai/question', {
          sessionId,
          toolCallId: `question-${id}`,
          inputType: 'question',
          schema: sample('questionInput'),
        }),
        cancelled,
      ]);
      if (answer === 'cancelled' || answer?.result?.outcome === 'cancelled')
        stopReason = 'cancelled';
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(answer?.result ?? {}) },
      });
    } else {
      if (text === 'tool') {
        emit('todo');
        emit('plan');
        emit('read');
        emit('readFinished');
      }
      if (text === 'extensions') {
        for (const method of [
          'authUrl',
          'checkpoint',
          'artifact',
          'artifactBatch',
          'command',
          'file_history_snapshot',
        ])
          send({ method: `_codebuddy.ai/${method}`, params: { sessionId, ignored: true } });
        emit('usage');
      }
      if (text === 'member')
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Child-only text' },
          _meta: { 'codebuddy.ai/memberEvent': 'worker' },
        });
      emit('thought');
      for (const chunk of ['echo: ', text])
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
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
  if (env.FAKE_WORKBUDDY_LOG) appendFileSync(env.FAKE_WORKBUDDY_LOG, `${line}\n`);
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
  if (message.method === 'session/prompt') {
    void prompt(message.id, message.params);
    return;
  }
  try {
    const handler = handlers[message.method];
    if (!handler) throw { code: -32601, message: `Method not found: ${message.method}` };
    send({ id: message.id, result: handler(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error });
  }
});
rl.on('close', () => process.exit(0));
