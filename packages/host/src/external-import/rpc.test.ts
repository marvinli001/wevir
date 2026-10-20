// 导入（0.74.0）经 RPC：hello 声明 external_import；import.scan / import.apply；memory.read 带出 importedFrom；connector.add 的
// workspaceId；项目的连接器按会话所在的项目交给引擎（echo 报出它拿到的连接器）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const temp = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function launch() {
  const home = join(temp(), 'host');
  const userHome = join(temp(), 'user');
  const host = await startHost({
    home,
    engine: 'echo',
    adapter: new EchoAdapter({ stepDelayMs: 0 }),
    logger: createLogger({ level: 'error', mirror: () => {} }),
    pluginUserHome: userHome,
    importEnv: {},
  });
  running.push(host);
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
  const hello = await client.hello(info.token);
  await client.request('provider.upsert', {
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-responses',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'mock' }],
    defaultModelId: 'mock',
    apiKey: 'mock-not-a-secret',
  });
  return { client, hello, userHome };
}

/** 在这个项目里开个会话，发 “plugins”，返回 echo 报出的连接器。 */
async function connectorsSeen(client: TestRpcClient, workspaceId: string): Promise<string> {
  const { session } = await client.request('session.create', {
    providerId: 'mock',
    workspaceId,
  });
  const { subscriptionId } = await client.request('events.subscribe', {
    sessionId: session.id,
    sinceSeq: 0,
  });
  await client.request('session.send', {
    sessionId: session.id,
    content: [{ type: 'text', text: 'plugins' }],
  });
  await client.until(
    () => client.events(subscriptionId).find((item) => item.type === 'turn.finished'),
    'turn.finished',
  );
  const text = client
    .events(subscriptionId)
    .filter((item) => item.type === 'assistant.message')
    .map((item) => JSON.stringify(item.payload))
    .join();
  return /Connectors: ([^\\]*)/.exec(text)?.[1] ?? '';
}

describe('import.* 与项目的连接器（RPC + echo）', () => {
  it('项目的连接器只交给那个项目的会话；项目不在时 connector.add 回 WORKSPACE_NOT_FOUND', async () => {
    const { client, hello } = await launch();
    expect(hello.result.features.external_import).toBe(true);
    mkdirSync(join(temp(), 'a'), { recursive: true });
    mkdirSync(join(temp(), 'b'), { recursive: true });
    const a = (await client.request('workspace.add', { rootPath: join(temp(), 'a') })).workspace;
    const b = (await client.request('workspace.add', { rootPath: join(temp(), 'b') })).workspace;
    await client.request('connector.add', {
      name: 'global_one',
      config: { transport: 'stdio', command: 'g' },
    });
    const { connector } = await client.request('connector.add', {
      name: 'only_a',
      config: { transport: 'stdio', command: 'a' },
      workspaceId: a.id,
    });
    expect(connector.workspaceId).toBe(a.id);
    // 不同项目可以重名。
    await client.request('connector.add', {
      name: 'only_a',
      config: { transport: 'stdio', command: 'b' },
      workspaceId: b.id,
    });
    await expect(
      client.request('connector.add', {
        name: 'x',
        config: { transport: 'stdio', command: 'x' },
        workspaceId: 'ws_missing',
      }),
    ).rejects.toMatchObject({ code: -32010 });
    expect(await connectorsSeen(client, a.id)).toBe('global_one, only_a');
    expect(await connectorsSeen(client, b.id)).toBe('global_one, only_a');
    // 删掉 A 的之后，B 的同名连接器不会交给 A 的会话。
    await client.request('connector.remove', { id: connector.id });
    expect(await connectorsSeen(client, a.id)).toBe('global_one');
    const list = await client.request('plugins.list', {});
    expect(list.connectors.map((item: { name: string }) => item.name)).toEqual([
      'global_one',
      'only_a',
    ]);
  }, 30_000);

  it('import.scan / import.apply：记忆带 importedFrom，连接器缺值不交给引擎', async () => {
    const { client, userHome } = await launch();
    const root = join(temp(), 'proj');
    mkdirSync(root, { recursive: true });
    const ws = (await client.request('workspace.add', { rootPath: root })).workspace;
    const memoryPath = put(
      join(
        userHome,
        '.claude',
        'projects',
        ws.rootPath.replace(/[^a-zA-Z0-9]/g, '-'),
        'memory',
        'n.md',
      ),
      '---\nname: n\ndescription: A note\ntype: user\n---\nBody\n',
    );
    put(
      join(userHome, '.claude.json'),
      JSON.stringify({ mcpServers: { keyed: { command: 'k', env: { TOKEN: 'secret-value' } } } }),
    );
    const scan = await client.request('import.scan', { app: 'claude' });
    expect(scan).toMatchObject({ app: 'claude', found: true, unsupported: [] });
    expect(JSON.stringify(scan)).not.toContain('secret-value');
    expect(scan.memories).toMatchObject([{ name: 'n', scope: 'project', workspaceId: ws.id }]);
    const { results } = await client.request('import.apply', {
      app: 'claude',
      items: [...scan.memories, ...scan.connectors].map((item: { key: string }) => ({
        key: item.key,
      })),
    });
    expect(results.map((item: { outcome: string }) => item.outcome)).toEqual([
      'imported',
      'imported',
    ]);
    const { note } = await client.request('memory.read', {
      scope: 'project',
      workspaceId: ws.id,
      name: 'n',
    });
    expect(note.origin).toMatchObject({
      by: 'user',
      importedFrom: { app: 'claude', path: memoryPath },
    });
    const list = await client.request('plugins.list', {});
    expect(list.connectors[0]).toMatchObject({
      name: 'keyed',
      missingInputs: ['TOKEN'],
      importedFrom: { app: 'claude' },
    });
    expect(await connectorsSeen(client, ws.id)).toBe('');
    await client.request('connector.update', {
      id: list.connectors[0].id,
      config: { transport: 'stdio', env: { TOKEN: 'filled' } },
    });
    expect(await connectorsSeen(client, ws.id)).toBe('keyed');
    const grok = await client.request('import.scan', { app: 'grok' });
    expect(grok).toMatchObject({ found: false, unsupported: ['memory', 'connector'] });
  }, 30_000);
});
