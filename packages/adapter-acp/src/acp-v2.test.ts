import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpAdapter } from './acp-adapter.js';
import { AcpProcess } from './acp-process.js';
import type { AcpEngine } from './engine.js';

const PEER = String.raw`
const { createInterface } = require('node:readline');
const negotiation = process.env.FIXTURE_NEGOTIATION;
const v2 = negotiation === 'v2';
const info = { name: 'fixture', version: '1.0.0' };
const authMethod = { name: 'Sign in', type: 'agent' };
const calls = [];
const approvals = [];
let model = 'small';
const configOptions = () => [{
  [v2 ? 'configId' : 'id']: 'fixture-model',
  name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }],
}];
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result = {}) => write({ id, result });
const update = (sessionId, sessionUpdate, fields) => write({
  method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } },
});
const idle = (sessionId, stopReason, fields) => update(sessionId, 'state_update', {
  state: 'idle', stopReason, ...fields,
});
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (id === 'permission-1') { approvals.push(result); return; }
  if (method === 'fixture/trace') { reply(id, { pid: process.pid, calls, approvals }); return; }
  calls.push({ method, params });
  switch (method) {
    case 'initialize':
      if (negotiation.startsWith('retry') && params.protocolVersion !== 1) {
        write({ id, error: { code: negotiation === 'retry-version' ? -32022 : -32602, message: 'Unsupported protocol version' } });
      } else if (v2) {
        reply(id, { protocolVersion: 2, info,
          capabilities: { session: { mcp: { http: {}, stdio: {} } } },
          authMethods: [{ ...authMethod, methodId: 'fixture-login' }],
        });
      } else {
        reply(id, { protocolVersion: negotiation === 'legacy-2' ? 2 : 1,
          ...(negotiation === 'retry' && { agentInfo: info }),
          agentCapabilities: { loadSession: true }, authMethods: [{ ...authMethod, id: 'fixture-login' }],
        });
      }
      break;
    case 'authenticate':
    case 'logout':
    case 'auth/login':
    case 'auth/logout':
    case 'session/close':
      reply(id);
      break;
    case 'session/new':
      reply(id, { sessionId: 's1', configOptions: configOptions() });
      break;
    case 'session/resume':
    case 'session/load':
      reply(id, { configOptions: configOptions() });
      break;
    case 'session/set_config_option':
      model = params.value;
      reply(id, { configOptions: configOptions() });
      break;
    case 'session/prompt': {
      const { sessionId, prompt } = params;
      if (!v2) { reply(id, { stopReason: 'end_turn' }); break; }
      if (prompt[0].text === 'reject') {
        write({ id, error: { code: -32602, message: 'Prompt rejected' } });
        break;
      }
      if (prompt[0].text === 'early idle') {
        idle(sessionId, 'end_turn');
        reply(id);
        break;
      }
      reply(id);
      if (prompt[0].text === 'idle error') {
        idle(sessionId, 'error', { error: { code: -32000, message: 'Provider error', data: { retry: false } } });
      }
      if (prompt[0].text === 'approval') {
        const toolCallId = 'tool-1';
        update(sessionId, 'tool_call_update', { toolCallId, title: 'Shell', kind: 'execute' });
        write({ id: 'permission-1', method: 'session/request_permission', params: {
          sessionId, title: 'Confirm', subject: { type: 'tool_call', toolCall: { toolCallId } },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        } });
      }
      if (prompt[0].text === 'command approval') {
        write({ id: 'permission-1', method: 'session/request_permission', params: {
          sessionId, title: 'Run command', subject: { type: 'command', command: 'pwd', cwd: params.cwd ?? process.cwd() },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        } });
      }
      if (prompt[0].text === 'snapshot') {
        update(sessionId, 'agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'draft' } });
        update(sessionId, 'tool_call_update', { toolCallId: 't1', title: 'Lookup', status: 'completed' });
        update(sessionId, 'agent_message', { messageId: 'm1', content: [{ type: 'text', text: 'final answer' }] });
        idle(sessionId, 'end_turn');
      }
      break;
    }
    case 'session/cancel':
      idle(params.sessionId, 'cancelled');
      break;
    case 'fixture/model-options':
      update(params.sessionId, 'config_option_update', { configOptions: configOptions().map((option) => ({
        ...option, currentValue: 'small', options: option.options.slice(0, 1),
      })) });
      reply(id);
      break;
    case 'fixture/exit':
      process.exit(7);
      break;
    case 'fixture/finish': {
      const { sessionId } = params;
      const changes = [
        { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: 'aGk=' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' },
      ];
      process.stdout.write(JSON.stringify(changes.map((update) => ({
        jsonrpc: '2.0', method: 'session/update', params: { sessionId, update },
      }))) + '\n');
      update(sessionId, 'agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: 'Done' } });
      idle(sessionId, 'end_turn');
      reply(id);
      break;
    }
    default:
      write({ id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

const classifyTurnError = vi.fn((error: unknown) => {
  const { code, message } = error as Error & { code?: number };
  return { category: 'provider' as const, message, code };
});
const engine: AcpEngine = {
  name: 'fixture',
  version: '1.0.0',
  capabilities: { toolCalls: true, approvals: true, resume: true, concurrentSessions: true },
  tools: { display: () => ({ kind: 'unknown' }) },
  route: {
    modelOption: 'model',
    modelCategory: 'model',
    encode: (_, id) => id,
    decodeModel: (id) => id,
  },
  resumeMethod: 'load',
  initializeMeta: { fixture: 'initialize' },
  clientCapabilitiesMeta: { fixture: 'capabilities' },
  classifyTurnError,
  classifyResumeError: (error) => ({ failure: { kind: 'unknown' }, message: String(error) }),
};
const config = { cwd: process.cwd(), providerId: 'fixture', modelId: 'large' };
const mcpServers = [
  { name: 'stdio-fixture', command: 'unused', args: [], env: [] },
  { type: 'http' as const, name: 'http-fixture', url: 'https://example.invalid/mcp', headers: [] },
];
const adapters: AcpAdapter[] = [];

class FixtureAdapter extends AcpAdapter {
  complete(id: string) {
    return this.completeTurn(id, { stopReason: 'end_turn' });
  }
}

afterEach(async () => {
  classifyTurnError.mockClear();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

function setup(negotiation: 'v2' | 'retry' | 'retry-version' | 'legacy-2') {
  const adapter = new FixtureAdapter({
    engine,
    mcpServers,
    logger: { warn: () => {} },
    createProcess: (hooks) =>
      new AcpProcess({
        ...hooks,
        engine,
        restart: { maxRestarts: 0 },
        afterInitialize: async (connection, response) => {
          await connection.agent.request('authenticate', {
            methodId: response.authMethods?.[0]?.id,
          });
        },
        launcher: {
          prepare: async () => ({
            spawnSpec: () => ({
              command: process.execPath,
              args: ['-e', PEER],
              options: {
                cwd: config.cwd,
                env: { ...process.env, FIXTURE_NEGOTIATION: negotiation },
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            }),
          }),
        },
      }),
  });
  adapters.push(adapter);
  return adapter;
}

function trace(adapter: AcpAdapter) {
  return adapter.process.connection.agent.request<{
    pid: number;
    calls: Array<{ method: string; params?: Record<string, unknown> }>;
    approvals: unknown[];
  }>('fixture/trace', {});
}

function send(adapter: AcpAdapter, id: string, text: string) {
  return adapter.send(id, { content: [{ type: 'text', text }] });
}

async function collectTurn(iterator: AsyncIterator<AgentEvent>) {
  const events: AgentEvent[] = [];
  for (;;) {
    const { done, value } = await iterator.next();
    if (done) throw new Error('Session ended before the turn finished');
    events.push(value);
    if (value.type === 'turn.settled' || value.type === 'turn.failed') return events;
  }
}

it.each(['retry', 'retry-version', 'legacy-2'] as const)(
  'retains v1 behavior with %s negotiation',
  async (mode) => {
    const adapter = setup(mode);
    const { engineSessionId } = await adapter.createSession(config);
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await send(adapter, engineSessionId, 'hello');
    expect(await collectTurn(events)).toEqual([expect.objectContaining({ type: 'turn.settled' })]);
    await adapter.close(engineSessionId);
    await adapter.resumeSession(engineSessionId, config);
    const { pid, calls } = await trace(adapter);
    expect(adapter.process.generation).toBe(1);
    expect(adapter.process.connection.protocolVersion).toBe(1);
    expect(pid).toBe(adapter.process.pid);
    expect(
      calls
        .filter(({ method }) => method === 'initialize')
        .map(({ params }) => params?.protocolVersion),
    ).toEqual(mode === 'legacy-2' ? [2] : [2, 1]);
    expect(calls).toContainEqual({ method: 'authenticate', params: { methodId: 'fixture-login' } });
    expect(calls).toContainEqual(expect.objectContaining({ method: 'session/load' }));
  },
);

it('negotiates v2 session, model, authentication and MCP request shapes', async () => {
  const adapter = setup('v2');
  const session = await adapter.createSession(config);
  expect(adapter.process.connection.protocolVersion).toBe(2);
  expect(session).toMatchObject({ modelId: 'large' });
  expect(adapter.process.initializeResponse).toMatchObject({
    protocolVersion: 2,
    agentInfo: { name: 'fixture', version: '1.0.0' },
    authMethods: [{ id: 'fixture-login' }],
    agentCapabilities: { mcpCapabilities: { http: true } },
  });
  const { engineSessionId: sessionId } = session;
  await adapter.close(sessionId);
  await adapter.resumeSession(sessionId, config);
  await adapter.process.connection.agent.request('logout', {});

  const { calls } = await trace(adapter);
  const wireMcp = [{ ...mcpServers[0], type: 'stdio' }, mcpServers[1]];
  expect(calls).toEqual([
    {
      method: 'initialize',
      params: expect.objectContaining({
        protocolVersion: 2,
        info: expect.objectContaining({ name: 'wevir' }),
        clientInfo: expect.objectContaining({ name: 'wevir' }),
        capabilities: expect.objectContaining({ _meta: { fixture: 'capabilities' } }),
        _meta: { fixture: 'initialize' },
      }),
    },
    { method: 'auth/login', params: { methodId: 'fixture-login' } },
    { method: 'session/new', params: { cwd: config.cwd, mcpServers: wireMcp } },
    {
      method: 'session/set_config_option',
      params: { sessionId, type: 'id', configId: 'fixture-model', value: 'large' },
    },
    { method: 'session/close', params: { sessionId } },
    {
      method: 'session/resume',
      params: { sessionId, cwd: config.cwd, mcpServers: wireMcp, replayFrom: { type: 'start' } },
    },
    { method: 'auth/logout', params: {} },
  ]);
});

it('keeps a v2 prompt open after acknowledgement for tool approval, output and idle', async () => {
  const adapter = setup('v2');
  const { engineSessionId: id } = await adapter.createSession(config);
  const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
  const next = iterator.next();
  await send(adapter, id, 'approval');
  await trace(adapter);
  expect(adapter.complete(id)).toBe(false);
  await expect(send(adapter, id, 'too soon')).rejects.toMatchObject({ code: 'session_busy' });
  expect((await next).value).toMatchObject({ type: 'tool.started', toolCallId: 'tool-1' });
  const { value: approval } = await iterator.next();
  expect(approval).toMatchObject({ type: 'approval.requested', toolCallId: 'tool-1' });
  if (approval?.type !== 'approval.requested') throw new Error('Missing approval');
  await adapter.respondToApproval(id, approval.requestId, { optionId: 'allow' });
  await adapter.process.connection.agent.request('fixture/finish', { sessionId: id });
  expect(await collectTurn(iterator)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'tool.finished', toolCallId: 'tool-1' }),
      expect.objectContaining({ type: 'assistant.message', text: 'Done' }),
      expect.objectContaining({
        type: 'engine.raw',
        method: 'session/update',
        params: {
          sessionId: id,
          update: { sessionUpdate: 'terminal_output_chunk', terminalId: 't1', data: 'aGk=' },
        },
      }),
      expect.objectContaining({ type: 'turn.settled', stopReason: 'end_turn' }),
    ]),
  );
  expect((await trace(adapter)).approvals).toEqual([
    { outcome: { outcome: 'selected', optionId: 'allow' } },
  ]);
});

it('settles early v2 idle, prompt rejection, idle errors and cancellation separately', async () => {
  const adapter = setup('v2');
  const { engineSessionId: id } = await adapter.createSession(config);
  const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
  await send(adapter, id, 'early idle');
  expect((await collectTurn(iterator)).at(-1)).toMatchObject({
    type: 'turn.settled',
    stopReason: 'end_turn',
  });
  await send(adapter, id, 'reject');
  expect((await collectTurn(iterator)).at(-1)).toMatchObject({
    type: 'turn.failed',
    code: -32602,
    message: 'Prompt rejected',
  });
  await send(adapter, id, 'idle error');
  expect((await collectTurn(iterator)).at(-1)).toMatchObject({
    type: 'turn.failed',
    code: -32000,
    message: 'Provider error',
  });
  expect(classifyTurnError).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { retry: false } }),
  );
  await send(adapter, id, 'hold');
  await adapter.cancel(id);
  expect((await collectTurn(iterator)).at(-1)).toMatchObject({
    type: 'turn.settled',
    outcome: 'cancelled',
  });
});

it('publishes the command and working directory before a command-only approval', async () => {
  const adapter = setup('v2');
  const { engineSessionId: id } = await adapter.createSession(config);
  const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
  const next = iterator.next();
  await send(adapter, id, 'command approval');
  expect((await next).value).toMatchObject({
    type: 'tool.started',
    toolCallId: 'permission/permission-1',
    input: { command: 'pwd', cwd: config.cwd },
  });
  const { value: approval } = await iterator.next();
  if (approval?.type !== 'approval.requested') throw new Error('Missing approval');
  expect(approval.toolCallId).toBe('permission/permission-1');
  await adapter.respondToApproval(id, approval.requestId, { optionId: 'allow' });
  expect((await iterator.next()).value).toMatchObject({
    type: 'tool.finished',
    toolCallId: approval.toolCallId,
  });
  await adapter.cancel(id);
  await collectTurn(iterator);
});

it('cancels a v2 prompt after ACK when its request cancellation signal fires', async () => {
  const adapter = setup('v2');
  const { engineSessionId: sessionId } = await adapter.createSession(config);
  const abort = new AbortController();
  const prompt = adapter.process.connection.agent.request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: 'hold' }] },
    { cancellationSignal: abort.signal },
  );
  await trace(adapter);
  abort.abort();
  await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
  expect((await trace(adapter)).calls).toContainEqual({
    method: 'session/cancel',
    params: { sessionId },
  });
});

it('replaces an earlier streamed message when v2 sends a whole-message snapshot', async () => {
  const adapter = setup('v2');
  const { engineSessionId: id } = await adapter.createSession(config);
  const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
  await send(adapter, id, 'snapshot');
  const events = await collectTurn(iterator);
  const stream = events.find((event) => event.type === 'assistant.delta');
  expect(stream).toMatchObject({ text: 'draft' });
  expect(events.filter((event) => event.type === 'assistant.message')).toEqual([
    expect.objectContaining({ text: 'draft' }),
    expect.objectContaining({
      text: 'final answer',
      replaces: [{ attemptId: stream?.attemptId, blockIndex: 0 }],
    }),
  ]);
});

it('applies v2 model updates and ends a pending prompt on process exit', async () => {
  const adapter = setup('v2');
  const { engineSessionId: id } = await adapter.createSession(config);
  const iterator = adapter.subscribe(id)[Symbol.asyncIterator]();
  const next = iterator.next();
  await send(adapter, id, 'hold');
  await trace(adapter);
  await adapter.process.connection.agent.notify('fixture/exit', {});
  expect((await next).value).toMatchObject({ type: 'engine.exited' });
  expect((await iterator.next()).done).toBe(true);

  await adapter.resumeSession(id, config);
  await adapter.process.connection.agent.request('fixture/model-options', { sessionId: id });
  await expect(send(adapter, id, 'hello')).rejects.toMatchObject({ code: 'invalid_input' });
});
