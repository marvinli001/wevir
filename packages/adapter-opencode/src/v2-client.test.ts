import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountModels } from './models.js';
import { createOpenCodeV2Client } from './v2-client.js';

const directory = '/workspaces/含空格 workspace';
const password = 'fixture-päss';
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
const sessionID = 'ses_fixture';
const session = {
  id: sessionID,
  title: 'Fixture',
  time: { created: 1, updated: 2 },
  location: { directory },
};
const model = { providerID: 'fixture', modelID: 'vendor/model' };

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  accept: string | null;
  body: unknown;
}

function withFetch(route: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (target: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const call = {
        method: init.method ?? 'GET',
        path: target.pathname,
        query: target.searchParams,
        authorization: headers.get('Authorization'),
        accept: headers.get('Accept'),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return route(call);
    }),
  );
  return {
    calls,
    client: createOpenCodeV2Client({ baseUrl: 'http://opencode.test', directory, password }),
  };
}

const data = (value: unknown) => Response.json({ data: value });
const empty = () => new Response(null, { status: 204 });

afterEach(() => vi.unstubAllGlobals());

describe('OpenCode 2 native client', () => {
  it('authenticates requests and uses native create, model, prompt, note and interrupt routes', async () => {
    let catalogReads = 0;
    const { client, calls } = withFetch(({ path }) => {
      if (path === '/api/model') {
        if (++catalogReads === 1) return Response.json({ service: 'plugin' }, { status: 503 });
        return data([]);
      }
      if (path === '/api/info') return Response.json({ version: '2.3.2', pid: 4321 });
      if (path === '/api/session') return data(session);
      return empty();
    });
    expect(() => createOpenCodeV2Client({ baseUrl: 'http://opencode.test', directory })).toThrow(
      'requires a server password',
    );
    await expect(client.health()).resolves.toEqual({ healthy: true, version: '2.3.2' });
    const created = await client.createSession({
      permission: [
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'task', pattern: '*', action: 'allow' },
      ],
    });
    expect(created).toMatchObject({ id: sessionID, directory });
    await client.promptAsync({
      sessionID,
      messageID: 'msg_fixture',
      model,
      variant: 'high',
      system: 'Keep the rules',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', mime: 'image/png', filename: 'photo.png', url: 'file:///tmp/photo.png' },
      ],
    });
    await client.prompt({
      sessionID,
      noReply: true,
      messageID: 'msg_note',
      parts: [{ type: 'text', text: 'a note' }],
    });
    await client.abort(sessionID);
    expect(calls.every((call) => call.authorization === authorization)).toBe(true);
    expect(catalogReads).toBe(2);
    expect(calls.findLastIndex(({ path }) => path === '/api/model')).toBeLessThan(
      calls.findIndex(({ path }) => path === `/api/session/${sessionID}/model`),
    );
    expect(calls.find((call) => call.path === '/api/session')).toMatchObject({
      method: 'POST',
      body: {
        location: { directory },
        permissions: [
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'subagent', resource: '*', effect: 'allow' },
        ],
      },
    });
    expect(calls.find((call) => call.path === `/api/session/${sessionID}/model`)).toMatchObject({
      method: 'POST',
      body: { model: { providerID: 'fixture', id: 'vendor/model', variant: 'high' } },
    });
    expect(calls.find((call) => call.path.endsWith('/wevir.system'))).toMatchObject({
      method: 'PUT',
      body: { value: 'Keep the rules' },
    });
    expect(calls.find((call) => call.path.endsWith('/prompt'))?.body).toEqual({
      id: 'msg_fixture',
      text: 'hello',
      files: [{ uri: 'file:///tmp/photo.png', name: 'photo.png' }],
    });
    expect(calls.find((call) => call.path.endsWith('/synthetic'))?.body).toEqual({
      id: 'msg_note',
      text: 'a note',
      resume: false,
    });
    expect(calls.find((call) => call.path.endsWith('/interrupt'))?.query.get('resume')).toBe(
      'false',
    );
  });

  it('reads chronological history and forks by native message boundary', async () => {
    const { client, calls } = withFetch(({ method, path, query }) => {
      if (path.endsWith('/fork')) return data({ ...session, id: 'ses_fork' });
      if (path.endsWith('/active')) return data({ [sessionID]: { type: 'running' } });
      if (path.endsWith('/message')) {
        return query.get('cursor') === null
          ? Response.json({
              cursor: { next: 'page-2' },
              data: [{ id: 'msg_user', type: 'user', text: 'hello', time: { created: 1 } }],
            })
          : Response.json({
              cursor: { next: null },
              data: [
                {
                  id: 'msg_reply',
                  type: 'assistant',
                  content: [{ type: 'text', text: 'reply' }],
                  time: { created: 2 },
                },
              ],
            });
      }
      if (path === '/api/session' && method === 'GET') {
        return Response.json({
          cursor: { next: null },
          data: [{ ...session, id: 'ses_child', parentID: sessionID }],
        });
      }
      return empty();
    });
    const messages = await client.messages(sessionID);
    expect(messages.map(({ info }) => info)).toMatchObject([
      { id: 'msg_user', role: 'user' },
      { id: 'msg_reply', parentID: 'msg_user', role: 'assistant' },
    ]);
    expect(messages[1]?.parts).toMatchObject([{ type: 'text', text: 'reply' }]);
    expect(
      calls.filter(({ path }) => path.endsWith('/message')).map(({ query }) => query.get('order')),
    ).toEqual(['asc', 'asc']);
    await expect(client.forkSession(sessionID, 'msg_user')).resolves.toMatchObject({
      id: 'ses_fork',
    });
    expect(calls.find(({ path }) => path.endsWith('/fork'))?.body).toEqual({ before: 'msg_user' });
    await expect(client.children(sessionID)).resolves.toMatchObject([
      { id: 'ses_child', parentID: sessionID },
    ]);
    await expect(client.status()).resolves.toEqual({ [sessionID]: { type: 'busy' } });
    await client.deleteMessage(sessionID, 'msg_pending');
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/api/session/${sessionID}/inbox/msg_pending`,
    });
  });

  it('retries plugin activation for model reads and keeps per-workspace model metadata', async () => {
    const nativeModel = {
      id: 'vendor/model',
      providerID: 'fixture',
      name: 'Current',
      enabled: true,
      status: 'active',
      limit: { context: 120_000, input: 100_000, output: 20_000 },
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      variants: [{ id: 'high' }],
    };
    let reads = 0;
    const { client, calls } = withFetch(({ path }) => {
      if (path === '/api/provider') return data([{ id: 'fixture', name: 'Fixture' }]);
      if (path === '/api/model/default') return data(nativeModel);
      if (++reads === 1) {
        return Response.json(
          {
            _tag: 'ServiceUnavailableError',
            service: 'plugin',
            message: 'Location plugins did not finish activating',
          },
          { status: 503 },
        );
      }
      return data([nativeModel, { ...nativeModel, id: 'disabled', enabled: false }]);
    });
    expect(accountModels(await client.providers())).toEqual({
      defaultModelId: 'fixture/vendor/model',
      models: [
        {
          id: 'fixture/vendor/model',
          displayName: 'Fixture · Current',
          contextWindow: 100_000,
          maxTokens: 20_000,
          supportsImages: true,
          reasoningEfforts: ['high'],
        },
      ],
    });
    expect(reads).toBe(2);
    expect(calls.every(({ query }) => query.get('location[directory]') === directory)).toBe(true);
  });

  it('reads fragmented SSE, routes permission and form replies, and scopes unauthorized requests', async () => {
    const encoder = new TextEncoder();
    const messages = [
      'data: {"id":"connected","type":"server.connected","data":{}}\r\n\r\n',
      ': heartbeat\r\n\r\n',
      'data: broken\n\n',
      'data: {"id":"perm","type":"permission.asked",\n',
      `data: "data":{"id":"perm_1","sessionID":"${sessionID}","action":"shell","resources":["pwd"]}}\n\n`,
      `data: ${JSON.stringify({
        id: 'question',
        type: 'form.created',
        data: {
          form: {
            id: 'form_1',
            sessionID,
            title: 'Choice',
            fields: [
              {
                key: 'color',
                title: 'Color',
                type: 'string',
                options: [{ value: 'blue', label: 'Blue' }],
              },
            ],
          },
        },
      })}\n\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const message of messages) {
          controller.enqueue(encoder.encode(message.slice(0, 7)));
          controller.enqueue(encoder.encode(message.slice(7)));
        }
      },
    });
    const { client, calls } = withFetch(({ path }) => {
      if (path === '/api/session') return data(session);
      if (path === '/api/permission/request')
        return data([{ id: 'foreign', sessionID: 'ses_other' }]);
      if (path === '/api/event')
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      return empty();
    });
    await client.createSession({ permission: [] });
    const controller = new AbortController();
    const events: string[] = [];
    for await (const event of await client.subscribe(controller.signal)) {
      events.push(event.type);
      if (events.length === 3) break;
    }
    controller.abort();
    expect(events).toEqual(['server.connected', 'permission.asked', 'question.asked']);
    await client.replyPermission('perm_1', 'always');
    await client.replyQuestion('form_1', [['Blue']]);
    await expect(client.replyPermission('foreign', 'once')).rejects.toMatchObject({ status: 404 });
    expect(calls.find(({ path }) => path === '/api/event')).toMatchObject({
      accept: 'text/event-stream',
      authorization,
    });
    expect(calls.find(({ path }) => path.endsWith('/permission/perm_1/reply'))?.body).toEqual({
      decision: 'once',
    });
    expect(calls.find(({ path }) => path.endsWith('/form/form_1/reply'))?.body).toEqual({
      answer: { color: 'blue' },
    });
    expect(calls.some(({ path }) => path.includes('ses_other'))).toBe(false);
  });

  it('runs native commands and returns only an assistant produced by the command', async () => {
    let ran = false;
    const { client, calls } = withFetch(({ path, query }) => {
      if (path === '/api/model') return data([]);
      if (path.endsWith('/message')) {
        expect(query.get('type')).toBe('assistant');
        return data([
          {
            id: ran ? 'msg_new' : 'msg_previous',
            type: 'assistant',
            time: { created: 3 },
            content: [{ type: 'text', text: ran ? 'new output' : 'old output' }],
          },
        ]);
      }
      if (path.endsWith('/command')) ran = true;
      return empty();
    });
    const response = await client.command(
      {
        sessionID,
        messageID: 'msg_command',
        command: 'review',
        arguments: 'a.ts',
        model: 'fixture/vendor/model',
        system: 'Review only',
        parts: [],
      },
      new AbortController().signal,
    );
    expect(response).toMatchObject({
      info: { id: 'msg_new', parentID: 'msg_command' },
      parts: [{ text: 'new output' }],
    });
    expect(calls.find(({ path }) => path.endsWith('/command'))).toMatchObject({
      body: { name: 'review', text: 'a.ts', files: [] },
    });
    expect(calls.some(({ path }) => path.endsWith('/wait'))).toBe(true);
  });

  it('logs in through the native provider integration and removes only stored credentials', async () => {
    const integration = {
      id: 'provider-id',
      methods: [
        { type: 'env' },
        { type: 'key', label: 'Key' },
        { type: 'oauth', id: 'browser', label: 'Browser' },
      ],
      connections: [{ type: 'env' }, { type: 'credential', id: 'stored-key' }],
    };
    let polls = 0;
    const { client, calls } = withFetch(({ method, path }) => {
      if (path === '/api/provider')
        return data([
          { id: 'fixture', name: 'Fixture', integrationID: 'provider-id' },
          { id: 'no-integration', name: 'Without an integration' },
        ]);
      if (path === '/api/integration') return data([integration]);
      if (path === '/api/integration/provider-id') return data(integration);
      if (path.endsWith('/connect/oauth')) {
        return data({
          attemptID: 'attempt',
          url: 'https://example.test/auth',
          mode: 'auto',
          instructions: 'Authorize',
        });
      }
      if (method === 'GET' && path.endsWith('/attempt')) {
        return data({ status: ++polls === 1 ? 'pending' : 'complete' });
      }
      return empty();
    });
    expect(await client.providerAuth()).toEqual({
      fixture: [
        { type: 'api', label: 'Key' },
        { type: 'oauth', label: 'Browser' },
      ],
      'no-integration': [],
    });
    await expect(
      client.oauthAuthorize({ providerID: 'fixture', method: 1 }),
    ).resolves.toMatchObject({ method: 'auto' });
    await expect(client.oauthCallback({ providerID: 'fixture', method: 1 })).resolves.toBe(true);
    await client.setApiKey('fixture', 'fixture-key');
    await client.removeAuth('fixture');
    expect(polls).toBe(2);
    expect(calls.find(({ path }) => path.endsWith('/connect/oauth'))?.body).toEqual({
      methodID: 'browser',
    });
    expect(calls.find(({ path }) => path.endsWith('/connect/key'))?.body).toEqual({
      key: 'fixture-key',
    });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/credential/stored-key' });

    integration.connections.push({ type: 'credential', id: 'second-key' });
    await expect(client.removeAuth('fixture')).rejects.toThrow('opencode auth logout');
    expect(calls.filter(({ path }) => path.startsWith('/api/credential/'))).toHaveLength(1);
  });

  it('registers a workspace MCP server and logs in through its own integration', async () => {
    const { client, calls } = withFetch(({ method, path }) => {
      if (path === '/api/mcp')
        return data([
          { name: 'fixture/server', integrationID: 'mcp-id', status: { status: 'needs_auth' } },
        ]);
      if (path === '/api/integration/mcp-id')
        return data({
          id: 'mcp-id',
          methods: [{ type: 'oauth', id: 'browser', label: 'Browser' }],
          connections: [],
        });
      if (path.endsWith('/connect/oauth'))
        return data({
          attemptID: 'attempt',
          url: 'https://example.test/start',
          mode: 'code',
          instructions: 'Copy a code',
        });
      if (method === 'GET') throw new Error('Unexpected MCP GET');
      return empty();
    });
    const name = 'fixture/server';
    await client.addMcp(name, { type: 'remote', url: 'https://example.test/mcp' });
    await expect(client.authorizeMcp(name)).resolves.toMatchObject({
      method: 'code',
      url: 'https://example.test/start',
    });
    await expect(client.completeMcp(name, 'fixture-code')).resolves.toBe(true);
    await client.disconnectMcp(name);
    await client.removeMcp(name);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'PUT /api/experimental/mcp/fixture%2Fserver',
      'GET /api/mcp',
      'GET /api/integration/mcp-id',
      'POST /api/integration/mcp-id/connect/oauth',
      'POST /api/integration/mcp-id/connect/oauth/attempt/complete',
      'DELETE /api/integration/mcp-id/connect/oauth/attempt',
      'POST /api/experimental/mcp/fixture%2Fserver/disconnect',
      'DELETE /api/experimental/mcp/fixture%2Fserver',
    ]);
    expect(calls.every(({ query }) => query.get('location[directory]') === directory)).toBe(true);
  });
});
