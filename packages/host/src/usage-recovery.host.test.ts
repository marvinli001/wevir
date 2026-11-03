import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AutomationRun,
  ChannelId,
  MethodResult,
  SessionId,
  WevirEvent,
} from '@wevir/protocol';
import type { AgentInput, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { SessionManager } from './session-manager.js';
import { TestRpcClient, useStorages, useTempDir } from './test-utils.js';
import { usageRecoveryReports } from './usage-recovery.js';

const tempDir = useTempDir();
const storages = useStorages();
afterEach(() => vi.restoreAllMocks());

async function setup(mode: 'relay' | 'exhausted' | 'off', blockCoordinator = false) {
  const root = tempDir();
  const home = join(root, 'data');
  const storage = storages.open(home);
  const now = new Date().toISOString();
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: root,
    displayName: 'Workspace',
    createdAt: now,
    updatedAt: now,
  });
  for (const id of ['first', 'second', 'third']) {
    storage.providers.insert({
      id,
      kind: 'openai-compatible',
      displayName: id,
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: now,
      updatedAt: now,
    });
  }
  const adapter = new EchoAdapter({ stepDelayMs: 0, chunkSize: 4096 });
  const configs = new Map<string, SessionConfig>();
  const deliveries: { providerId: string; input: AgentInput }[] = [];
  const create = adapter.createSession.bind(adapter);
  vi.spyOn(adapter, 'createSession').mockImplementation(async (config) => {
    const engine = await create(config);
    configs.set(engine.engineSessionId, config);
    return engine;
  });
  const send = adapter.send.bind(adapter);
  vi.spyOn(adapter, 'send').mockImplementation((id, input) => {
    const config = configs.get(id) as SessionConfig;
    deliveries.push({ providerId: config.providerId, input });
    const coordinator = input.content.some(
      (part) => part.type === 'text' && part.text.includes('<channel_wake'),
    );
    const blocked =
      (!coordinator || blockCoordinator) && (config.providerId === 'first' || mode === 'exhausted');
    return send(id, {
      ...input,
      content: [{ type: 'text', text: blocked ? 'hitlimit' : 'ready' }],
    });
  });
  const events = new EventStore({ storage });
  const manager = new SessionManager({ storage, events, adapter });
  const parent = await manager.create({ workspaceId: 'ws_1', providerId: 'second' });
  const agent = await manager.create(
    { workspaceId: 'ws_1', providerId: 'first' },
    { openedBy: parent.id },
  );
  await manager.dispose();
  events.close();
  storage.close();
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      sendWhileBusy: 'steer',
      routing: {
        enabled: mode !== 'off',
        chain: [{ providerId: 'second' }, { providerId: 'third' }],
        preferSoonestReset: true,
      },
    }),
  );
  const userHome = join(root, 'user');
  mkdirSync(userHome);
  const boot = () =>
    startHost({
      home,
      adapter,
      engine: 'echo',
      pluginUserHome: userHome,
      userHome,
      logger: createLogger({ level: 'error' }),
    });
  const connect = async (host: RunningHost) => {
    const client = await TestRpcClient.connect(host.url);
    const runtime = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as {
      token: string;
    };
    await client.hello(runtime.token);
    return client;
  };
  return { boot, connect, deliveries, agent: agent.id };
}

describe('无人值守额度接力与报告（echo Host）', () => {
  for (const kind of ['agent', 'channel', 'automation'] as const) {
    it.each(['relay', 'exhausted', 'off'] as const)(
      `${kind}: %s`,
      async (mode) => {
        const h = await setup(mode);
        let host = await h.boot();
        let client = await h.connect(host);
        try {
          let sessionId: SessionId = h.agent;
          let channelId: ChannelId | undefined;
          let run: AutomationRun | undefined;
          if (kind === 'agent') {
            await client.request('session.send', {
              sessionId,
              content: [{ type: 'text', text: '开始' }],
            });
          } else if (kind === 'automation') {
            const { automation } = await client.request('automation.create', {
              title: '巡检',
              prompt: '开始',
              schedule: { kind: 'manual' },
              enabled: false,
              workspaceId: 'ws_1',
              providerId: 'first',
              notify: 'never',
            });
            ({ run } = await client.request('automation.run', { automationId: automation.id }));
            if (run === undefined) throw new Error('missing automation run');
            sessionId = run.sessionId as SessionId;
          } else {
            const { channel } = await client.request('channel.create', {
              kind: 'assistant',
              name: '协调者',
              description: '处理工作',
              coordinator: { providerId: 'first' },
            });
            channelId = channel.id;
            const { post } = await client.request('channel.post', {
              channelId,
              content: [{ type: 'text', text: '开始' }],
            });
            const { thread } = await client.request('channel.startThread', {
              channelId,
              rootPostId: post.id,
            });
            sessionId = thread.sessionId;
          }
          const { subscriptionId } = await client.request('events.subscribe', {
            sessionId,
            sinceSeq: 0,
          });
          const turns = mode === 'relay' ? 2 : mode === 'exhausted' ? 3 : 1;
          const log = await client.until(() => {
            const events = client.events(subscriptionId) as WevirEvent[];
            const waiting = events.some(
              (event) => event.type === 'session.auto_continue' && event.payload.resumeAt !== null,
            );
            return events.filter((event) => event.type === 'turn.finished').length === turns &&
              (mode === 'relay' || waiting)
              ? events
              : undefined;
          }, 'quota recovery');
          const reports = usageRecoveryReports(log, (id) => id);
          expect(reports).toHaveLength(mode === 'exhausted' ? 3 : 1);
          if (mode === 'off') {
            expect(log.filter((event) => event.type === 'routing.decided')).toEqual([]);
            expect(log.filter((event) => event.type === 'session.handoff')).toEqual([]);
          } else {
            expect(reports[0]?.text).toBe('因额度从 first / m 接力到 second / m（第 1 次）');
          }
          const snapshot = await client.request('session.get', { sessionId });
          if (mode === 'relay') {
            expect(snapshot.session.providerId).toBe('second');
            expect(snapshot.session.autoContinue).toBeUndefined();
          } else {
            expect(snapshot.session.autoContinue).toBeDefined();
            expect(reports.at(-1)?.text).toBe(
              `额度用完，${snapshot.session.autoContinue?.resumeAt}后继续`,
            );
          }
          await vi.waitFor(async () => {
            const { items }: MethodResult<'inbox.list'> = await client.request('inbox.list');
            const relevant = items.filter((item) => item.sessionId === sessionId);
            expect(relevant.map((item) => item.summary)).toEqual(
              expect.arrayContaining(reports.map((report) => report.text)),
            );
            expect(relevant).toHaveLength(reports.length);
          });
          if (channelId !== undefined) {
            await vi.waitFor(
              () => {
                const text = h.deliveries
                  .flatMap(({ input }) => input.content)
                  .filter((part) => part.type === 'text' && part.text.includes('<channel_wake'))
                  .map((part) => (part.type === 'text' ? part.text : ''))
                  .join('\n');
                for (const report of reports) expect(text).toContain(report.text);
              },
              { timeout: 10_000 },
            );
          }
          if (run !== undefined) {
            const result = await client.request('automation.get', {
              automationId: run.automationId,
            });
            expect(result.runs[0]).toMatchObject({
              id: run.id,
              turnId: run.turnId,
              status: 'failed',
            });
            for (const report of reports) expect(result.runs[0]?.error).toContain(report.text);
            expect(result.runs[0]?.summary).toBeUndefined();
            if (mode === 'relay') {
              client.ws.terminate();
              await host.shutdown();
              host = await h.boot();
              client = await h.connect(host);
              const restored = await client.request('automation.get', {
                automationId: run.automationId,
              });
              expect(restored.runs).toEqual(result.runs);
            }
          }
          if (kind === 'agent' && mode === 'relay') {
            const before = (await client.request('inbox.list')).items;
            client.ws.terminate();
            await host.shutdown();
            host = await h.boot();
            client = await h.connect(host);
            expect((await client.request('inbox.list')).items).toEqual(before);
            const item = before[0];
            if (item === undefined) throw new Error('missing report');
            await client.request('inbox.dismiss', { itemId: item.id });
            client.ws.terminate();
            await host.shutdown();
            host = await h.boot();
            client = await h.connect(host);
            expect((await client.request('inbox.list')).items).toEqual([]);
          }
        } finally {
          client.ws.terminate();
          await host.shutdown();
        }
      },
      25_000,
    );
  }

  it('协调者自身接力只记 Host 帖子，不因报告再唤醒自己', async () => {
    const h = await setup('relay', true);
    const host = await h.boot();
    const client = await h.connect(host);
    try {
      const { channel } = await client.request('channel.create', {
        kind: 'assistant',
        name: '协调者',
        description: '处理工作',
        coordinator: { providerId: 'first' },
      });
      await vi.waitFor(async () => {
        const result = await client.request('channel.get', { channelId: channel.id });
        expect(result.channel.state).toBe('idle');
        const { posts } = await client.request('channel.posts', { channelId: channel.id });
        expect(
          posts.some((post: { content: { type: string; text?: string }[] }) =>
            post.content.some((part) =>
              part.text?.includes('因额度从 first / m 接力到 second / m（第 1 次）'),
            ),
          ),
        ).toBe(true);
      });
      expect(
        h.deliveries.filter(({ input }) =>
          input.content.some((part) => part.type === 'text' && part.text.includes('<channel_wake')),
        ),
      ).toHaveLength(1);
    } finally {
      client.ws.terminate();
      await host.shutdown();
    }
  });
});
