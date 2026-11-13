import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, startHost } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startMockZuv } from '../../host/src/zuv/mock.test-utils.js';
import { connectLocalHost } from './node.js';
import { TranscriptProjection } from './projection.js';
import { identity, useTempDir } from './test-utils.js';
import { webSocketTransport } from './transport.js';

const tempDir = useTempDir();
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('projects a real two-Host late history backfill in source order through the SDK subscription', async () => {
  const mock = await startMockZuv();
  cleanups.push(() => mock.close());
  const boot = async (name: string) => {
    const directory = join(tempDir(), name);
    await mkdir(directory);
    const home = join(directory, 'home');
    const user = join(directory, 'user');
    const project = join(directory, 'project');
    await mkdir(user);
    await mkdir(project);
    const gitconfig = join(directory, 'gitconfig');
    const template = join(directory, 'template');
    await writeFile(gitconfig, '');
    await mkdir(template);
    execFileSync('git', ['init', '-q', `--template=${template}`, project], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const adapter = new EchoAdapter();
    const host = await startHost({
      home,
      userHome: user,
      pluginUserHome: user,
      importEnv: {},
      adapter,
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      zuv: {
        origin: mock.origin,
        allowLoopback: true,
        deviceName: 'Synthetic SDK',
        syncIntervalMs: 20,
      },
    });
    cleanups.push(() => host.shutdown());
    const client = await connectLocalHost({
      home,
      identity,
      transport: webSocketTransport(WebSocket),
    });
    cleanups.push(() => client.close());
    const workspace = (await client.request('workspace.add', { rootPath: project })).workspace;
    const login = (await client.request('account.login', { kind: 'zuv', method: 'browser' }))
      .account;
    const authUrl = login.login?.authUrl;
    if (!authUrl) throw new Error('missing synthetic enrollment');
    mock.approve(authUrl);
    await expect
      .poll(async () => (await client.request('account.get', { kind: 'zuv' })).account.status)
      .toBe('signed_in');
    return { client, workspace, adapter };
  };
  const first = await boot('first');
  const second = await boot('second');
  const receivedCreate = vi.spyOn(second.adapter, 'createSession');
  await first.client.request('provider.upsert', {
    id: 'synthetic-api',
    kind: 'openai-compatible',
    displayName: 'Synthetic',
    api: 'openai-responses',
    baseURL: 'https://synthetic.invalid/v1',
    models: [{ id: 'synthetic-model' }],
    defaultModelId: 'synthetic-model',
  });
  const session = (
    await first.client.request('session.create', {
      workspaceId: first.workspace.id,
      providerId: 'synthetic-api',
      modelId: 'synthetic-model',
    })
  ).session;
  const send = async (text: string) => {
    await first.client.request('session.send', {
      sessionId: session.id,
      clientMessageId: text,
      content: [{ type: 'text', text }],
    });
    await expect
      .poll(
        async () =>
          (await first.client.request('session.get', { sessionId: session.id })).session.state,
      )
      .toBe('idle');
  };
  await send('Synthetic earlier work');
  const categories = ['project', 'session', 'event-segment'] as const;
  const selected = await first.client.request('sync.configure', {
    enabled: true,
    categories: [...categories],
    projects: [{ workspaceId: first.workspace.id }],
    includeHistory: false,
  });
  const projectId = selected.binding?.projectIds[0];
  if (!projectId) throw new Error('missing synthetic project');
  const target = {
    enabled: true,
    categories: [...categories],
    projects: [{ workspaceId: second.workspace.id, projectId }],
    includeHistory: false,
  };
  await expect(second.client.request('sync.configure', target)).rejects.toMatchObject({
    data: { code: 'RECOVERY_REQUIRED' },
  });
  const deviceId = (await second.client.request('sync.status')).binding?.deviceId;
  if (!deviceId) throw new Error('missing synthetic device');
  await first.client.request('sync.approveDevice', { deviceId });
  await second.client.request('sync.configure', target);
  await send('Synthetic later work');
  const remote = async () =>
    (
      await second.client.request('session.list', { workspaceId: second.workspace.id })
    ).sessions.find(
      (value) => value.origin?.kind === 'synced' && value.origin.sessionId === session.id,
    );
  await expect.poll(remote, { timeout: 8000 }).toBeDefined();
  const source = await remote();
  if (!source) throw new Error('missing synthetic source');
  const projection = new TranscriptProjection();
  const subscription = second.client.subscribe(source.id, { elideSuperseded: true });
  const consumption = (async () => {
    for await (const item of subscription) {
      if (item.type === 'event') projection.apply(item.event);
      else if (item.type === 'reset') projection.reset();
    }
  })();
  cleanups.push(async () => {
    subscription.close();
    await consumption;
  });
  const userTexts = () =>
    projection
      .snapshot()
      .messages.filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.parts.filter((part) => part.type === 'text').map((part) => part.text),
      );
  await expect.poll(userTexts, { timeout: 8000 }).toEqual(['Synthetic later work']);
  await first.client.request('sync.configure', {
    enabled: true,
    categories: [...categories],
    projects: [{ workspaceId: first.workspace.id, projectId }],
    includeHistory: true,
    expectedRevision: selected.binding?.revision,
  });
  await expect
    .poll(userTexts, { timeout: 8000 })
    .toEqual(['Synthetic earlier work', 'Synthetic later work']);
  expect(projection.snapshot()).toMatchObject({
    state: 'closed',
    pendingApprovals: [],
    readOnly: { reason: 'synchronized' },
  });
  expect(receivedCreate).not.toHaveBeenCalled();
}, 20000);
