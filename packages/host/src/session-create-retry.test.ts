import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir(),
  cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
describe('client chosen session creation identity', () => {
  it('returns one session for concurrent and repeated requests, including after Host restart', async () => {
    const home = join(temp(), 'home'),
      root = join(temp(), 'project'),
      userHome = join(temp(), 'user');
    await mkdir(root);
    await mkdir(userHome);
    const options = {
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      adapter: new EchoAdapter(),
      engine: 'echo',
      logger: createLogger({ mirror: () => {} }),
    };
    let host = await startHost(options);
    const connect = async () => {
      const rpc = await TestRpcClient.connect(host.url);
      await rpc.hello(JSON.parse(await readFile(join(home, 'run/host.json'), 'utf8')).token);
      cleanups.push(() => rpc.ws.terminate());
      return rpc;
    };
    cleanups.push(() => host.shutdown());
    let rpc = await connect();
    const workspaceId = (await rpc.request('workspace.add', { rootPath: root })).workspace.id;
    await rpc.request('provider.upsert', {
      id: 'synthetic',
      kind: 'openai-compatible',
      displayName: 'Synthetic',
      api: 'openai-responses',
      baseURL: 'https://synthetic.invalid/v1',
      models: [{ id: 'synthetic' }],
      defaultModelId: 'synthetic',
    });
    const request = {
      sessionId: 'ses_0123456789abcdef0123456789abcdef',
      workspaceId,
      providerId: 'synthetic',
    };
    const [first, second] = await Promise.all([
      rpc.request('session.create', request),
      rpc.request('session.create', request),
    ]);
    expect(first.session.id).toBe(request.sessionId);
    expect(second.session.id).toBe(request.sessionId);
    rpc.ws.terminate();
    await host.shutdown();
    host = await startHost(options);
    rpc = await connect();
    expect((await rpc.request('session.create', request)).session.id).toBe(request.sessionId);
    expect((await rpc.request('session.list')).sessions).toHaveLength(1);
    expect(
      (await rpc.call('session.create', { ...request, modelId: 'other' })).error,
    ).toMatchObject({ code: -32602 });
  });
});
