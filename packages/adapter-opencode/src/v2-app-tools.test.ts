import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  v2AppToolsPluginEntry,
  v2ServerConfigContent,
  writeV2AppToolsPlugin,
} from './v2-app-tools.js';

interface Tool {
  name: string;
  input: unknown;
  execute(args: unknown, context: unknown): Promise<unknown>;
}

const endpoint = { url: 'http://127.0.0.1/mcp', token: 'test-engine-token' };
const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
const definitions = ['wevir_session_list', 'wevir_call'].map((name) => ({
  name,
  inputSchema: schema,
}));

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadPlugin(assert?: (input: unknown) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wevir-opencode-v2-plugin-'));
  directories.push(dir);
  const url = writeV2AppToolsPlugin(dir);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const { method } = JSON.parse(String(init.body));
    return Response.json({
      result:
        method === 'tools/list'
          ? { tools: definitions }
          : { content: [{ type: 'text', text: 'result' }] },
    });
  });
  const module = await import(`${url}/index.js`);
  const tools: Tool[] = [];
  await module.default.setup({
    options: v2AppToolsPluginEntry(url, endpoint).options,
    permission: { assert },
    tool: {
      transform: async (install: (editor: { add: (tool: Tool) => void }) => void) =>
        install({ add: (tool) => tools.push(tool) }),
    },
  });
  return { tools, requests };
}

describe('OpenCode 2 app tools', () => {
  it('preserves the schema and routes approved calls with OpenCode session identity', async () => {
    const assert = vi.fn(async (_input: unknown) => {});
    const { tools, requests } = await loadPlugin(assert);
    const context = {
      sessionID: 'ses_one',
      agent: 'build',
      messageID: 'msg_one',
      id: 'call_one',
      signal: new AbortController().signal,
    };
    const [read, write] = tools;
    expect(read?.input).toEqual(schema);
    expect(await read?.execute({}, context)).toEqual({ content: 'result' });
    expect(assert).not.toHaveBeenCalled();
    const args = { name: 'wevir_session_send', arguments: { message: 'ping' } };
    expect(await write?.execute(args, context)).toEqual({ content: 'result' });
    expect(assert).toHaveBeenCalledExactlyOnceWith({
      sessionID: 'ses_one',
      agent: 'build',
      action: 'wevir_call',
      resources: ['wevir_session_send'],
      save: ['wevir_session_send'],
      metadata: args,
      source: { type: 'tool', messageID: 'msg_one', id: 'call_one' },
    });
    expect(
      requests.map(({ url, init }) => ({
        url,
        auth: new Headers(init.headers).get('authorization'),
        session: new Headers(init.headers).get('x-wevir-engine-session'),
      })),
    ).toEqual([
      { url: `${endpoint.url}?tier=dispatch`, auth: `Bearer ${endpoint.token}`, session: null },
      {
        url: `${endpoint.url}?tier=dispatch`,
        auth: `Bearer ${endpoint.token}`,
        session: 'ses_one',
      },
      {
        url: `${endpoint.url}?tier=dispatch`,
        auth: `Bearer ${endpoint.token}`,
        session: 'ses_one',
      },
    ]);
    expect(requests.at(-1)?.init.signal).toBe(context.signal);

    assert.mockRejectedValueOnce(new Error('permission denied'));
    await expect(write?.execute(args, context)).rejects.toThrow('permission denied');
    expect(requests).toHaveLength(3);
  });

  it('omits tools requiring approval on releases without plugin permission assertions', async () => {
    const { tools } = await loadPlugin();
    expect(tools.map(({ name }) => name)).toEqual(['wevir_session_list']);
  });
});

describe('OpenCode 2 server config', () => {
  it('keeps mixed native and legacy JSONC settings and adds the managed plugin and rules', () => {
    const plugin = v2AppToolsPluginEntry(
      'file:///engines/plugins/wevir-v2-app-tools-new',
      endpoint,
    );
    const merged = JSON.parse(
      v2ServerConfigContent(
        `{
      // Comment with a trailing comma on the next line.
      "provider": { "custom": { "options": { "baseURL": "https://api.test" }, }, },
      "mcp": { "service": { "type": "remote", "url": "https://mcp.test" } },
      "permission": {"read":"allow"},
      "permissions": [{"action":"read","resource":"some-file","effect":"ask"}],
      "plugin": ["legacy", "file:///plugins/wevir-app-tools-old.mjs"],
      "plugins": ["native", { "package": "file:///plugins/wevir-v2-app-tools-old" }],
    }`,
        plugin,
      ),
    );
    expect(merged).toMatchObject({
      provider: { custom: { options: { baseURL: 'https://api.test' } } },
      mcp: { service: { type: 'remote', url: 'https://mcp.test' } },
      permission: { read: 'allow' },
      plugin: ['legacy'],
      plugins: ['native', plugin],
    });
    expect(merged.permissions[0]).toEqual({ action: 'read', resource: 'some-file', effect: 'ask' });
    for (const action of ['shell', 'edit', 'external_directory']) {
      expect(merged.permissions).toContainEqual({ action, resource: '*', effect: 'ask' });
    }
  });
});
