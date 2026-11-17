// 频道与助理（0.120.0）：echo 引擎跑通建助理、发帖唤醒协调者、换班、预算、线程、列表与订阅的通知。

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HostId, NotificationIntent, WorkspaceId } from '@wevir/protocol';
import {
  ASSISTANT_AVATAR_COLOR_COUNT,
  ASSISTANT_AVATAR_TYPES,
  type ChannelId,
  type ChannelPost,
  ChannelPostSchema,
  ChannelSchema,
  type ClientIdentity,
  DEFAULT_ASSISTANT_RULES,
  type EnvironmentId,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTools } from '../app-tools.js';
import { describeSchedule } from '../automations/automation-tools.js';
import { AutomationService } from '../automations/service.js';
import { EventStore } from '../event-store.js';
import { addWorkspace, createHostMethods } from '../host-methods.js';
import { ImageStore } from '../images.js';
import { InboxService } from '../inbox.js';
import { NotificationService } from '../notifications.js';
import type { ProcessNotice } from '../processes.js';
import { SessionManager } from '../session-manager.js';
import { boardEventTasks, TaskBoardStore } from '../task-board.js';
import { identity, useStorages, useTempDir } from '../test-utils.js';
import { AssistantFolders } from './assistants.js';
import {
  ChannelService,
  type ChannelServiceOptions,
  type ChannelSubscriptionMessage,
  channelActivity,
  postOfAnswer,
  ROTATE_WAKES,
} from './service.js';
import { CHANNEL_TOOLS, channelCoordinatorInstructions, channelToolAllowed } from './tools.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };
/** Windows 上的 CI 慢得多，等待放宽。 */
const WAIT = process.platform === 'win32' ? 30_000 : 5000;
const waitFor = <T>(callback: () => T | Promise<T>) => vi.waitFor(callback, { timeout: WAIT });
/** 用例结束时停下服务，免得回合在存储关闭后还在写。 */
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const phone: ClientIdentity = { deviceId: 'phone-1', clientId: 'app-1', clientKind: 'mobile' };

async function setup(
  options: {
    budget?: { dailyWakes: number; dailyTokens: number };
    removed?: ChannelServiceOptions['removed'];
    inventory?: ChannelServiceOptions['inventory'];
    canUseAppTools?: ChannelServiceOptions['canUseAppTools'];
    now?: () => number;
    timezone?: string;
    wakeDelayMs?: number;
    threadUpdateDelayMs?: number;
  } = {},
) {
  const dataDir = join(realpathSync(tempDir()), 'data');
  mkdirSync(dataDir, { recursive: true });
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const adapter = new EchoAdapter({ stepDelayMs: 0 });
  const assistants = new AssistantFolders({ dir: join(dataDir, 'assistants') });
  await assistants.load();
  const images = new ImageStore({ dir: join(dataDir, 'images') });
  const taskBoards = new TaskBoardStore({
    dir: join(dataDir, 'tasks'),
    onChange: (root) => channels?.tasksChanged(root),
  });
  let channels: ChannelService | undefined;
  let automations: AutomationService | undefined;
  let appTools: AppTools | undefined;
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    images,
    worktreesDir: join(dataDir, 'worktrees'),
    onTurnFinished: (info) => {
      channels?.onTurnFinished(info);
      appTools?.onTurnFinished(info);
    },
    approvalPolicy: (sessionId, tool) => channels?.approvalPolicy(sessionId, tool),
    // 用量统计照 Host 记：Echo 每回合报一次请求（第二回合起带缓存读取）。
    onUsage: ({ sessionId, providerId, modelId }, event) => {
      storage.usage.insert({
        sessionId,
        requestId: event.requestId,
        at: Date.now(),
        source: 'openai-compatible',
        providerId,
        providerName: providerId,
        model: event.model ?? modelId,
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheWriteTokens ?? 0,
        reasoningTokens: event.reasoningTokens ?? 0,
      });
    },
  });
  channels = new ChannelService({
    storage,
    events,
    sessions,
    assistants,
    images,
    identity: { deviceId: 'host', clientId: 'wevir-channels', clientKind: 'desktop' },
    inventory:
      options.inventory ?? (() => ({ connectors: ['Calendar'], skills: [], browser: true })),
    ...(options.canUseAppTools !== undefined && { canUseAppTools: options.canUseAppTools }),
    tasks: {
      list: async (root) => boardEventTasks(await taskBoards.list(root)),
      update: (root, id, patch, by) => taskBoards.update(root, id, patch, by),
    },
    wakeDelayMs: options.wakeDelayMs ?? 0,
    threadUpdateDelayMs: options.threadUpdateDelayMs ?? 0,
    ...(options.now !== undefined && { now: options.now }),
    ...(options.timezone !== undefined && { timezone: options.timezone }),
    schedules: {
      routines: (channelId) =>
        (automations?.forChannel(channelId) ?? [])
          .filter((item) => item.enabled && item.autoPausedAt === undefined)
          .map((item) => ({
            title: item.title,
            schedule: `${describeSchedule(item.schedule)} (${item.timezone})`,
          })),
      deleted: async (channelId) => {
        await automations?.deleteForChannel(channelId);
      },
    },
    ...(options.removed !== undefined && { removed: options.removed }),
    projects: {
      isProject: (workspace) => !assistants.isAssistant(workspace),
      add: async (path) =>
        (await addWorkspace({ storage, events, assistants }, { rootPath: path })).record,
    },
  });
  channels.start();
  const service0 = channels;
  automations = new AutomationService({
    dir: join(dataDir, 'automations'),
    storage,
    events,
    sessions,
    identity: { deviceId: 'host', clientId: 'wevir-automations', clientKind: 'desktop' },
    channels: {
      target: (channelId) => service0.scheduleTarget(channelId),
      wake: (channelId, schedule) => service0.wakeForSchedule(channelId, schedule),
    },
  });
  await automations.load();
  const inbox = new InboxService({ storage, events });
  inbox.start();
  const notifications = new NotificationService({
    storage,
    events,
    inbox,
    channels,
    settings: () => ({ sendWhileBusy: 'steer' }),
  });
  notifications.start();
  const intents: NotificationIntent[] = [];
  notifications.watch((intent) => intents.push(intent));
  const stopAutomations = automations;
  cleanups.push(
    () => sessions.dispose(),
    () => stopAutomations.dispose(),
    () => service0.dispose(),
    () => inbox.close(),
    () => notifications.close(),
  );
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
    channels,
    assistants,
    automations,
    images,
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
  });
  // 看不了图片的模型（0.135.0）。
  storage.providers.insert({
    id: 'blind',
    kind: 'openai-compatible',
    displayName: 'Blind',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm', supportsImages: false }],
    defaultModelId: 'm',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
  });
  const service = channels;
  const create = async (
    name: string,
    description: string,
    folders?: string[],
    providerId = 'mock',
  ) =>
    (
      await methods['channel.create'](
        {
          kind: 'assistant',
          name,
          description,
          ...(folders !== undefined && { folders }),
          coordinator: { providerId },
          ...(options.budget !== undefined && { budget: options.budget }),
        },
        context,
      )
    ).channel;
  const posts = (channelId: ChannelId) => service.posts({ channelId, limit: 200 }).posts;
  /** 等到协调者回答了这么多条。 */
  const coordinatorPosts = async (channelId: ChannelId, count: number) => {
    await waitFor(() => {
      expect(posts(channelId).filter((post) => post.author.kind === 'coordinator')).toHaveLength(
        count,
      );
    });
    return posts(channelId).filter((post) => post.author.kind === 'coordinator');
  };
  const tools = new AppTools({
    storage,
    events,
    sessions,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => 'queue',
    tasks: taskBoards,
    channels: service,
    automations,
  });
  appTools = tools;
  const call = (sessionId: SessionId, name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool
      .call(args, { sessionId, signal: new AbortController().signal })
      .catch((error: unknown) => ({
        isError: true as const,
        content: [{ type: 'text' as const, text: String(error) }],
        structuredContent: undefined,
      }));
  };
  return {
    storage,
    events,
    sessions,
    service,
    methods,
    create,
    posts,
    coordinatorPosts,
    tools,
    call,
    automations,
    intents,
    inbox,
  };
}

describe('ChannelService', () => {
  it('暂停接口只改暂停状态，恢复后保留身份与预算', async () => {
    const h = await setup();
    const bot = await h.create('Inbox', 'Sort messages.');
    await h.coordinatorPosts(bot.id, 1);
    const paused = await h.methods['channel.pause']({ channelId: bot.id, paused: true }, context);
    expect(paused.channel.state).toBe('paused');
    const resumed = await h.methods['channel.pause']({ channelId: bot.id, paused: false }, context);
    expect(resumed.channel).toMatchObject({ title: bot.title, budget: bot.budget });
    expect(resumed.channel.pausedAt).toBeUndefined();
  });
  it('助理通知正文取打码首行，并指向发出的帖子序号', async () => {
    const h = await setup();
    const bot = await h.create('Inbox', 'Sort messages.');
    await h.coordinatorPosts(bot.id, 1);
    h.intents.splice(0);
    const { channel: current } = await h.service.get(bot.id);
    const result = await h.call(current.coordinator?.sessionId as SessionId, 'wevir_channel_post', {
      text: `First sk-${'x'.repeat(48)}\nSecond line stays in the chat.`,
    });
    expect(result.isError).not.toBe(true);
    const intent = h.intents.find((value) => value.kind === 'channel');
    expect(intent).toMatchObject({ title: 'Inbox', seq: h.posts(bot.id).at(-1)?.seq });
    expect(intent?.body).toContain('First');
    expect(intent?.body).not.toContain('sk-');
    expect(intent?.body).not.toContain('Second line');
  });
  it('建两个助理：各自的隐藏工作区与协调者，第一次唤醒是 setup，不进会话与项目列表', {
    timeout: WAIT * 2,
  }, async () => {
    const h = await setup();
    const first = await h.create('Mail desk', 'Sort my inbox every morning.');
    const second = await h.create('Trip desk', 'Keep my travel bookings in order.');

    expect(ChannelSchema.parse(first)).toEqual(first);
    expect(first.assistant?.rules).toEqual(DEFAULT_ASSISTANT_RULES);
    expect(ASSISTANT_AVATAR_TYPES).toContain(first.assistant?.avatar.type);
    expect(first.assistant?.avatar.color).toBeLessThan(ASSISTANT_AVATAR_COLOR_COUNT);
    expect(first.workspaceId).not.toBe(second.workspaceId);

    const [[setupA], [setupB]] = await Promise.all([
      h.coordinatorPosts(first.id, 1),
      h.coordinatorPosts(second.id, 1),
    ]);
    for (const post of [setupA, setupB]) {
      expect(ChannelPostSchema.parse(post)).toEqual(post);
      const text = post?.content[0]?.type === 'text' ? post.content[0].text : '';
      expect(text).toContain('<channel_handover');
      expect(text).toContain('<setup>');
      expect(text).toContain('connectors="Calendar"');
      expect(text).toContain('working_folder="');
    }
    const textA = setupA?.content[0]?.type === 'text' ? setupA.content[0].text : '';
    expect(textA).toContain('Sort my inbox every morning.');
    expect(textA).not.toContain('travel bookings');

    // 工作区与会话都藏起来。
    expect((await h.methods['workspace.list']({}, context)).workspaces).toEqual([]);
    expect((await h.methods['session.list']({}, context)).sessions).toEqual([]);
    const listed = (await h.methods['channel.list']({}, context)).channels;
    expect(listed.map((channel) => channel.id).sort()).toEqual([first.id, second.id].sort());
    const workspace = h.storage.workspaces.get(first.workspaceId ?? '');
    expect(workspace?.rootPath.endsWith(join('assistants', first.id))).toBe(true);
  });

  it('大脑的引擎不注入连接器与 skills 时起步清单另列用不了的；换 Provider 后下次唤醒附上新引擎的；挂不上 Wevir 工具的不能当大脑', async () => {
    const h = await setup({
      // mock 当作 OpenCode：连接器与 skills 都不注入；codex 都注入。
      inventory: async (providerId) =>
        providerId === 'codex'
          ? { connectors: ['Calendar'], skills: ['pdf'], browser: true }
          : {
              connectors: [],
              skills: [],
              browser: true,
              unavailable: { engine: 'opencode', connectors: ['Calendar'], skills: ['pdf'] },
            },
      canUseAppTools: (providerId) => providerId !== 'plain',
    });
    for (const id of ['codex', 'plain']) {
      h.storage.providers.insert({
        id,
        kind: 'openai-compatible',
        displayName: id,
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'm' }],
        defaultModelId: 'm',
        createdAt: '2026-10-28T00:00:00.000Z',
        updatedAt: '2026-10-28T00:00:00.000Z',
      });
    }
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const textOf = (post: ChannelPost | undefined) =>
      post?.content[0]?.type === 'text' ? post.content[0].text : '';
    const setupText = textOf((await h.coordinatorPosts(bot.id, 1))[0]);
    expect(setupText).toContain('<inventory connectors="none" skills="none"');
    expect(setupText).toContain('Your engine (opencode) cannot use');
    expect(setupText).toContain(
      '<unavailable engine="opencode" connectors="Calendar" skills="pdf"/>',
    );
    expect(setupText).not.toContain('<brain_changed>');

    await expect(
      h.methods['channel.update'](
        { channelId: bot.id, coordinator: { providerId: 'plain' } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      h.methods['channel.create'](
        {
          kind: 'assistant',
          name: 'Plain',
          description: 'x',
          coordinator: { providerId: 'plain' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    // 换到 codex：下一次唤醒（新的一班）附上它能用的，再下一次不再附。
    await h.methods['channel.update'](
      { channelId: bot.id, coordinator: { providerId: 'codex' } },
      context,
    );
    await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Anything new?' }] },
      context,
    );
    const changed = textOf((await h.coordinatorPosts(bot.id, 2))[1]);
    expect(changed).toContain('<channel_handover');
    expect(changed).toContain('<brain_changed>');
    expect(changed).toContain('<inventory connectors="Calendar" skills="pdf" browser="yes"/>');
    expect(changed).not.toContain('<unavailable');

    await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'And now?' }] },
      context,
    );
    expect(textOf((await h.coordinatorPosts(bot.id, 3))[2])).not.toContain('<brain_changed>');
  });

  it('发帖唤醒协调者：回答回到时间线并指向那条帖子；另一个助理不受影响；未读按读者算', async () => {
    const h = await setup();
    const first = await h.create('Mail desk', 'Sort my inbox.');
    const second = await h.create('Trip desk', 'Bookings.');
    await h.coordinatorPosts(first.id, 1);
    await h.coordinatorPosts(second.id, 1);

    const { post } = await h.methods['channel.post'](
      {
        channelId: first.id,
        content: [{ type: 'text', text: 'Any news from the bank?' }],
        clientPostId: 'c1',
      },
      context,
    );
    const replies = await h.coordinatorPosts(first.id, 2);
    const reply = replies[1];
    expect(reply?.replyTo).toBe(post.id);
    const text = reply?.content[0]?.type === 'text' ? reply.content[0].text : '';
    expect(text).toContain('<channel_wake');
    expect(text).toContain('Any news from the bank?');
    expect(text).not.toContain('<channel_handover');
    expect(h.posts(second.id)).toHaveLength(1);

    // 重发同一个 clientPostId 不重复。
    const again = await h.methods['channel.post'](
      {
        channelId: first.id,
        content: [{ type: 'text', text: 'Any news from the bank?' }],
        clientPostId: 'c1',
      },
      context,
    );
    expect(again.post.id).toBe(post.id);

    // 本机读到自己发的那条为止，协调者的回答算未读；手机另算。
    await waitFor(async () => {
      const row = (await h.methods['channel.get']({ channelId: first.id }, context)).channel;
      expect(row.unreadCount).toBe(1);
      expect(row.lastPost?.author).toBe('coordinator');
    });
    h.service.markRead(first.id, reply?.seq ?? 0, identity);
    await waitFor(async () => {
      expect(
        (await h.methods['channel.get']({ channelId: first.id }, context)).channel.unreadCount ?? 0,
      ).toBe(0);
    });
    const mine = h.service.post(
      { channelId: first.id, content: [{ type: 'text', text: 'From the phone' }] },
      phone,
    );
    expect(mine.author).toEqual({ kind: 'user', deviceId: 'phone-1' });
  });

  it('列表变化与订阅：channels.changed 带新行，订阅补发并收到新帖', async () => {
    const h = await setup();
    const changes: { upserted: ChannelId[]; removed: ChannelId[] }[] = [];
    h.service.watch((change) =>
      changes.push({ upserted: change.upserted.map((row) => row.id), removed: change.removed }),
    );
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    await waitFor(() =>
      expect(changes.some((change) => change.upserted.includes(bot.id))).toBe(true),
    );

    const received: ChannelSubscriptionMessage[] = [];
    const { lastSeq, unsubscribe } = h.service.subscribe(bot.id, 0, (message) =>
      received.push(message),
    );
    expect(lastSeq).toBe(1);
    h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Hello there' }] },
      identity,
    );
    await h.coordinatorPosts(bot.id, 2);
    await waitFor(() =>
      expect(
        received
          .filter((message) => message.kind === 'posted')
          .map((message) => message.kind === 'posted' && message.post.seq),
      ).toEqual(expect.arrayContaining([2, 3])),
    );
    unsubscribe();

    await h.methods['channel.delete']({ channelId: bot.id }, context);
    await waitFor(() =>
      expect(changes.some((change) => change.removed.includes(bot.id))).toBe(true),
    );
    expect((await h.methods['channel.list']({}, context)).channels).toEqual([]);
  });

  it('唤醒次数到了换班的阈值：另开一班，首条是交接材料，旧会话关闭', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const [setupPost] = await h.coordinatorPosts(bot.id, 1);
    const firstSession =
      setupPost?.author.kind === 'coordinator' ? setupPost.author.sessionId : undefined;
    const record = h.storage.channels.get(bot.id);
    h.storage.channels.update(bot.id, {
      coordinator: { ...(record?.coordinator as object), wakes: ROTATE_WAKES },
      updatedAt: new Date().toISOString(),
    });

    h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Next shift please' }] },
      identity,
    );
    const [, reply] = await h.coordinatorPosts(bot.id, 2);
    expect(reply?.author).toMatchObject({ kind: 'coordinator', generation: 2 });
    const secondSession = reply?.author.kind === 'coordinator' ? reply.author.sessionId : undefined;
    expect(secondSession).not.toBe(firstSession);
    const text = reply?.content[0]?.type === 'text' ? reply.content[0].text : '';
    expect(text).toContain('<channel_handover');
    expect(text).toContain('generation="2"');
    await waitFor(() =>
      expect(h.events.snapshot(firstSession as SessionId)?.session.state).toBe('closed'),
    );
    const channel = h.service.channelOf(secondSession as SessionId);
    expect(channel?.role).toBe('coordinator');
    expect(channel?.channel.coordinator?.generation).toBe(2);
  });

  it(
    '连发三十条用户消息不计预算、不暂停，统计页仍记用量',
    async () => {
      const h = await setup({ budget: { dailyWakes: 1, dailyTokens: 200_000 } });
      const bot = await h.create('Mail desk', 'Sort my inbox.');
      await h.coordinatorPosts(bot.id, 1);
      for (let i = 0; i < 30; i++) {
        h.service.post(
          { channelId: bot.id, content: [{ type: 'text', text: `Message ${i}` }] },
          identity,
        );
        await h.coordinatorPosts(bot.id, i + 2);
      }
      const row = (await h.methods['channel.get']({ channelId: bot.id }, context)).channel;
      expect(row.state).toBe('idle');
      expect(row.pausedAt).toBeUndefined();
      expect(row.usage).toBeUndefined();
      expect(
        h
          .posts(bot.id)
          .some((post) => post.card?.kind === 'notice' && post.card.reason === 'budget'),
      ).toBe(false);
      expect(h.storage.usage.sessionTotals(row.coordinator?.sessionId ?? '').requests).toBe(31);
    },
    WAIT * 6,
  );

  it('预算的 token 按用量统计算，缓存读取不算', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.wakeForSchedule(bot.id, { title: 'Daily', prompt: 'Look at today.' });
    await h.coordinatorPosts(bot.id, 2);
    const sessionId = (await h.methods['channel.get']({ channelId: bot.id }, context)).channel
      .coordinator?.sessionId as SessionId;
    const rows = h.storage.usage.range(0, Number.MAX_SAFE_INTEGER);
    expect(rows.some((row) => row.cacheReadTokens > 0)).toBe(true);
    const day = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await waitFor(() => {
      const rows = h.storage.usage.range(0, Number.MAX_SAFE_INTEGER);
      const last = rows.at(-1);
      expect(h.storage.channels.usage(bot.id, day)?.tokens).toBe(
        (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0) + (last?.cacheWriteTokens ?? 0),
      );
    });
    expect(h.storage.usage.sessionTotals(sessionId).requests).toBe(2);
  });

  it('用户在自己的帖子上开线程：线程会话的首条是引用的原帖，标记解决', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    const { post } = await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Draft a reply to Ana' }] },
      context,
    );
    await h.coordinatorPosts(bot.id, 2);
    const { thread } = await h.methods['channel.startThread'](
      { channelId: bot.id, rootPostId: post.id },
      context,
    );
    expect(thread.rootPostId).toBe(post.id);
    expect(thread.title).toBe('Draft a reply to Ana');
    await waitFor(() => {
      const messages = h.events
        .readSince(thread.sessionId, 0)
        .filter((event) => event.type === 'user.message');
      const first = messages[0];
      const text =
        first?.type === 'user.message' && first.payload.content[0]?.type === 'text'
          ? first.payload.content[0].text
          : '';
      expect(text).toContain('<channel_relay');
      expect(text).toContain('<cited author="user"');
      expect(text).toContain('Draft a reply to Ana');
    });
    expect(h.service.channelOf(thread.sessionId)?.role).toBe('thread');
    expect((await h.methods['session.list']({}, context)).sessions).toEqual([]);

    const resolved = (
      await h.methods['channel.resolveThread'](
        { channelId: bot.id, sessionId: thread.sessionId, resolved: true },
        context,
      )
    ).thread;
    expect(resolved.status).toBe('resolved');
    const view = await h.methods['channel.get']({ channelId: bot.id }, context);
    expect(view.threads.map((item) => item.sessionId)).toEqual([thread.sessionId]);
  });

  it('助理自带环境：协调者与线程都用它，不列出、不能改删；删助理时环境、工作区、目录与按工作区记的都删掉', async () => {
    const removed = vi.fn(async () => {});
    const h = await setup({ removed });
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    const environments = h.storage.environments
      .list()
      .filter((environment) => environment.folders[0]?.workspaceId === bot.workspaceId);
    expect(environments).toEqual([
      expect.objectContaining({
        name: 'Mail desk',
        folders: [{ workspaceId: bot.workspaceId, worktree: 'none' }],
      }),
    ]);
    const environmentId = (environments[0]?.id ?? '') as EnvironmentId;
    const workspace = h.storage.workspaces.get(bot.workspaceId ?? '');
    expect(h.storage.sessions.get(coordinator)).toMatchObject({
      environmentId,
      cwd: workspace?.rootPath,
    });
    // 起步清单把自己的工作文件夹当作已有。
    const text = first?.content[0]?.type === 'text' ? first.content[0].text : '';
    expect(text).toContain(`working_folder="${workspace?.rootPath}"`);
    expect(text).toContain(`<working_folder>${workspace?.rootPath}</working_folder>`);

    // 不在环境列表里，也改不了、删不了，也不能拿助理的工作区建环境。
    expect((await h.methods['environment.list']({}, context)).environments).toEqual([]);
    await expect(
      h.methods['environment.update']({ environmentId, name: 'x' }, context),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' });
    await expect(h.methods['environment.remove']({ environmentId }, context)).rejects.toMatchObject(
      { code: 'ENVIRONMENT_NOT_FOUND' },
    );
    await expect(
      h.methods['environment.create'](
        { name: 'x', folders: [{ workspaceId: bot.workspaceId as WorkspaceId, worktree: 'none' }] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });

    // 改名时环境跟着改。
    await h.methods['channel.update']({ channelId: bot.id, name: 'Inbox desk' }, context);
    expect(h.storage.environments.get(environmentId)?.name).toBe('Inbox desk');

    // 之前建的助理没有环境：开线程时补建一个。
    h.storage.environments.remove(environmentId);
    const { post } = await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Draft a reply to Ana' }] },
      context,
    );
    await h.coordinatorPosts(bot.id, 2);
    const { thread } = await h.methods['channel.startThread'](
      { channelId: bot.id, rootPostId: post.id },
      context,
    );
    const rebuilt = h.storage.environments
      .list()
      .filter((environment) => environment.folders[0]?.workspaceId === bot.workspaceId);
    expect(rebuilt).toHaveLength(1);
    expect(h.storage.sessions.get(thread.sessionId)).toMatchObject({
      environmentId: rebuilt[0]?.id,
      cwd: workspace?.rootPath,
    });
    h.storage.approvalRules.insert({
      id: 'apr_1',
      workspaceId: bot.workspaceId,
      kind: 'command_prefix',
      prefix: ['ls'],
      source: 'approval',
      createdAt: '2026-10-28T00:00:00.000Z',
      useCount: 0,
    });

    await h.methods['channel.delete']({ channelId: bot.id }, context);
    expect(h.storage.environments.list()).toEqual([]);
    expect(h.storage.workspaces.get(bot.workspaceId ?? '')?.removedAt).toBeDefined();
    expect(existsSync(workspace?.rootPath ?? '')).toBe(false);
    expect(h.storage.approvalRules.listEffective(bot.workspaceId)).toEqual([]);
    expect(h.storage.sessions.get(coordinator)?.state).toBe('closed');
    expect(h.storage.sessions.get(thread.sessionId)?.state).toBe('closed');
    expect(removed).toHaveBeenCalledWith({
      channelId: bot.id,
      workspaceId: bot.workspaceId,
      environmentIds: [rebuilt[0]?.id],
    });
  });

  it('改名字与说明：下次唤醒附上新的身份', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    const updated = (
      await h.methods['channel.update'](
        { channelId: bot.id, description: 'Answer the school emails.' },
        context,
      )
    ).channel;
    expect(updated.assistant?.description).toBe('Answer the school emails.');
    h.service.post({ channelId: bot.id, content: [{ type: 'text', text: 'Hello' }] }, identity);
    const [, reply] = await h.coordinatorPosts(bot.id, 2);
    const text = reply?.content[0]?.type === 'text' ? reply.content[0].text : '';
    expect(text).toContain('Answer the school emails.');
  });
});

describe('频道的应用级工具', () => {
  it('协调者全部、线程三个；needs 卡片、开线程；助理的任务只有用户能标完成', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    const names = async (sessionId: SessionId) =>
      (await h.tools.filterTools(sessionId, h.tools.tools))
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('wevir_channel_'));
    expect(await names(coordinator)).toEqual([...CHANNEL_TOOLS]);
    expect(await h.tools.instructions(coordinator)).toContain('coordinator of a Wevir assistant');

    const needs = await h.call(coordinator, 'wevir_channel_needs', {
      items: [
        { kind: 'connector', label: 'Gmail', ready: false },
        { kind: 'login', label: 'Bank website', ready: true },
      ],
    });
    expect(needs.isError).toBeUndefined();
    const card = h.posts(bot.id).find((post) => post.card?.kind === 'needs');
    expect(card?.card).toEqual({
      kind: 'needs',
      items: [
        { kind: 'connector', label: 'Gmail', ready: false },
        { kind: 'login', label: 'Bank website', ready: true },
      ],
    });

    const { post } = await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Draft a reply to Ana' }] },
      context,
    );
    await h.coordinatorPosts(bot.id, 3);
    const opened = await h.call(coordinator, 'wevir_channel_start_thread', {
      rootPostId: post.id,
      brief: 'Keep it short.',
    });
    expect(opened.isError).toBeUndefined();
    const thread = (opened.structuredContent as { thread: SessionId }).thread;
    expect(await names(thread)).toEqual([
      'wevir_channel_status',
      'wevir_channel_timeline',
      'wevir_channel_resolve',
    ]);
    expect(await h.tools.instructions(thread)).toContain('thread of a Wevir channel');
    const denied = await h.call(thread, 'wevir_channel_post', { text: 'Hi' });
    expect(denied.isError).toBe(true);

    // 协调者与线程共用频道的清单；Agent 标不了完成，用户可以。
    const created = await h.call(coordinator, 'wevir_task_create', { subject: 'Reply to Ana' });
    const board = created.structuredContent as { board: string; task: { id: string } };
    expect(board.board).toBe(bot.id);
    const done = await h.call(thread, 'wevir_task_update', {
      id: board.task.id,
      status: 'completed',
    });
    expect(done.isError).toBe(true);
    const { tasks } = await h.methods['channel.updateTask'](
      { channelId: bot.id, taskId: board.task.id, status: 'completed' },
      context,
    );
    expect(tasks.map((task) => task.status)).toEqual(['completed']);
  });
});

describe('开进用户项目的线程与会话（0.134.0）', () => {
  it('线程开在已登记的项目里：是那个项目的会话、进会话列表，回报照旧；授权的文件夹自动登记；别的文件夹拒绝', async () => {
    const h = await setup();
    const root = realpathSync(tempDir());
    const repo = join(root, 'repo');
    const granted = join(root, 'granted');
    const stranger = join(root, 'stranger');
    for (const dir of [repo, granted, stranger]) mkdirSync(dir);
    const { workspace } = await h.methods['workspace.add']({ rootPath: repo }, context);
    const bot = await h.create('Coder', 'Fix my bugs.', [granted]);
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    expect(await h.tools.instructions(coordinator)).toContain(
      'pass project (the folder path of one of',
    );
    const { post } = await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Fix the login bug' }] },
      context,
    );
    await h.coordinatorPosts(bot.id, 2);

    const opened = await h.call(coordinator, 'wevir_channel_start_thread', {
      rootPostId: post.id,
      project: repo,
    });
    expect(opened.isError).toBeUndefined();
    const result = opened.structuredContent as { thread: SessionId; project: string };
    expect(result.project).toBe(workspace.id);
    const record = h.storage.sessions.get(result.thread);
    expect(record).toMatchObject({ workspaceId: workspace.id, cwd: repo });
    expect(record?.environmentId).toBeUndefined();
    expect(h.service.channelOf(result.thread)?.role).toBe('thread');
    const listed = (await h.methods['session.list']({ workspaceId: workspace.id }, context))
      .sessions;
    expect(listed.map((session) => [session.id, session.channel])).toEqual([
      [result.thread, { channelId: bot.id, role: 'thread' }],
    ]);
    // 协调者不进列表。
    expect((await h.methods['session.list']({}, context)).sessions.map((s) => s.id)).toEqual([
      result.thread,
    ]);
    const view = await h.methods['channel.get']({ channelId: bot.id }, context);
    expect(view.threads.map((thread) => thread.workspaceId)).toEqual([workspace.id]);
    // 规矩照样管它：在项目里跑命令不问。
    expect(h.service.isAssistantSession(result.thread)).toBe(true);

    // 授权的文件夹还不是项目：登记成项目再开。
    const second = await h.call(coordinator, 'wevir_channel_start_thread', {
      rootPostId: post.id,
      project: granted,
      worktree: false,
    });
    expect(second.isError).toBeUndefined();
    const added = (await h.methods['workspace.list']({}, context)).workspaces.find(
      (item) => item.rootPath === granted,
    );
    expect(added).toBeDefined();
    expect(
      h.storage.sessions.get((second.structuredContent as { thread: SessionId }).thread)
        ?.workspaceId,
    ).toBe(added?.id);

    for (const project of [stranger, h.storage.workspaces.get(bot.workspaceId ?? '')?.rootPath]) {
      const denied = await h.call(coordinator, 'wevir_channel_start_thread', {
        rootPostId: post.id,
        project,
      });
      expect(denied.isError).toBe(true);
    }
    const noProject = await h.call(coordinator, 'wevir_channel_start_thread', {
      rootPostId: post.id,
      worktree: true,
    });
    expect(noProject.isError).toBe(true);
  });

  it('普通会话和助理都能指定当前项目；助理的 wevir_session_list 默认看全部项目', async () => {
    const h = await setup();
    const root = realpathSync(tempDir());
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const { workspace } = await h.methods['workspace.add']({ rootPath: repo }, context);
    const mine = await h.sessions.create({ workspaceId: workspace.id, providerId: 'mock' });
    const bot = await h.create('Coder', 'Fix my bugs.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;

    const listed = await h.call(coordinator, 'wevir_session_list');
    const ids = (listed.structuredContent as { sessions: { sessionId: string }[] }).sessions.map(
      (session) => session.sessionId,
    );
    expect(ids).toEqual([mine.id]);
    const own = await h.call(mine.id, 'wevir_session_list');
    expect(
      (own.structuredContent as { sessions: { sessionId: string }[] }).sessions.map(
        (session) => session.sessionId,
      ),
    ).toEqual([mine.id]);

    const opened = await h.call(coordinator, 'wevir_session_create', {
      message: 'Run the tests',
      project: repo,
      reportBack: false,
    });
    expect(opened.isError).toBeUndefined();
    const created = (opened.structuredContent as { sessionId: SessionId }).sessionId;
    expect(h.storage.sessions.get(created)?.workspaceId).toBe(workspace.id);
    const selected = await h.call(mine.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: repo,
      reportBack: false,
    });
    expect(selected.isError).toBeUndefined();
    const child = (selected.structuredContent as { sessionId: SessionId }).sessionId;
    expect(h.storage.sessions.get(child)).toMatchObject({ workspaceId: workspace.id, cwd: repo });
    const hidden = await h.call(mine.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: h.storage.workspaces.get(bot.workspaceId ?? '')?.rootPath,
    });
    expect(hidden.isError).toBe(true);
  });

  it('普通会话跨项目开子会话：使用目标目录、保留权限上限与父子关系，结果回报给原会话', async () => {
    const h = await setup();
    const root = realpathSync(tempDir());
    const repo = join(root, 'repo');
    const other = join(root, 'other');
    for (const dir of [repo, other]) mkdirSync(dir);
    const { workspace } = await h.methods['workspace.add']({ rootPath: repo }, context);
    const { workspace: target } = await h.methods['workspace.add']({ rootPath: other }, context);
    const parent = await h.sessions.create({
      workspaceId: workspace.id,
      providerId: 'mock',
      permissionMode: 'auto_review',
    });
    const denied = await h.call(parent.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: other,
      permissionMode: 'full_access',
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining('broader than'),
    });

    const opened = await h.call(parent.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: other,
    });
    expect(opened.isError).toBeUndefined();
    const child = (opened.structuredContent as { sessionId: SessionId }).sessionId;
    expect(h.storage.sessions.get(child)).toMatchObject({
      workspaceId: target.id,
      cwd: other,
      permissionMode: 'auto_review',
    });
    expect(h.events.snapshot(child)?.session.openedBy).toEqual({ sessionId: parent.id });
    await waitFor(() => {
      expect(
        h.events
          .readSince(parent.id, 0)
          .some(
            (event) =>
              event.type === 'user.message' &&
              event.payload.from?.kind === 'report' &&
              event.payload.from.sessionId === child,
          ),
      ).toBe(true);
    });
  });

  it('普通会话可选授权的额外文件夹，拒绝未授权、移除或无效的项目路径', async () => {
    const h = await setup();
    const root = realpathSync(tempDir());
    const repo = join(root, 'repo');
    const granted = join(root, 'granted');
    const stranger = join(root, 'stranger');
    const removed = join(root, 'removed');
    for (const dir of [repo, granted, stranger, removed]) mkdirSync(dir);
    const { workspace } = await h.methods['workspace.add'](
      { rootPath: repo, extraFolders: [granted] },
      context,
    );
    const { workspace: old } = await h.methods['workspace.add']({ rootPath: removed }, context);
    h.storage.workspaces.markRemoved(old.id, '2026-11-03T00:00:00.000Z');
    const parent = await h.sessions.create({ workspaceId: workspace.id, providerId: 'mock' });
    for (const project of [stranger, removed, 'relative/path', join(root, 'missing')]) {
      const denied = await h.call(parent.id, 'wevir_session_create', {
        message: 'Run the tests',
        project,
      });
      expect(denied.isError).toBe(true);
    }
    const opened = await h.call(parent.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: granted,
      reportBack: false,
    });
    expect(opened.isError).toBeUndefined();
    const child = (opened.structuredContent as { sessionId: SessionId }).sessionId;
    const target = h.storage.workspaces.getByRootPath(granted);
    expect(target).toBeDefined();
    expect(h.storage.sessions.get(child)).toMatchObject({ workspaceId: target?.id, cwd: granted });
  });
});

describe('聊天交互', () => {
  it('自发唤醒超额留在缓冲、次日交出；用户消息与手动唤醒仍可交出缓冲', async () => {
    let now = Date.parse('2026-11-16T01:30:00.000Z');
    const h = await setup({
      budget: { dailyWakes: 1, dailyTokens: 200_000 },
      now: () => now,
      timezone: 'Pacific/Auckland',
    });
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.wakeForSchedule(bot.id, { title: 'First', prompt: 'Look at today.' });
    await h.coordinatorPosts(bot.id, 2);
    h.service.wakeForSchedule(bot.id, { title: 'Held', prompt: 'Keep this update.' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const limited = (await h.service.get(bot.id)).channel;
    expect(limited.proactiveLimited).toBe(true);
    expect(limited.pausedAt).toBeUndefined();
    expect(limited.answering).toBeUndefined();
    expect(limited.usage?.wakes).toBe(1);
    expect(h.posts(bot.id)).toHaveLength(2);
    now += 24 * 60 * 60 * 1000;
    expect((await h.service.get(bot.id)).channel.proactiveLimited).toBeUndefined();
    h.service.wakeForSchedule(bot.id, { title: 'Next day', prompt: 'New day.' });
    const next = (await h.coordinatorPosts(bot.id, 3)).at(-1);
    expect(JSON.stringify(next?.content)).toContain('Keep this update.');
    expect(JSON.stringify(next?.content)).toContain('New day.');
    h.service.wakeForSchedule(bot.id, { title: 'Held again', prompt: 'Waiting item.' });
    h.service.post({ channelId: bot.id, content: [{ type: 'text', text: 'Hello' }] }, identity);
    expect((await h.service.get(bot.id)).channel.answering).toBe(true);
    expect(JSON.stringify((await h.coordinatorPosts(bot.id, 4)).at(-1)?.content)).toContain(
      'Waiting item.',
    );
    h.service.wake(bot.id);
    await h.coordinatorPosts(bot.id, 5);
    expect((await h.service.get(bot.id)).channel.usage?.wakes).toBe(1);
    expect(h.posts(bot.id).some((post) => post.card?.kind === 'notice')).toBe(false);
  });

  it('启动清除历史预算暂停，保留手动暂停', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    const other = await h.create('Other', 'Calendar.');
    await h.coordinatorPosts(other.id, 1);
    const at = new Date().toISOString();
    h.storage.channels.update(bot.id, { pausedAt: at, pauseReason: 'budget', updatedAt: at });
    h.storage.channels.update(other.id, { pausedAt: at, pauseReason: 'user', updatedAt: at });
    const restored = new ChannelService({
      storage: h.storage,
      events: h.events,
      sessions: h.sessions,
      assistants: new AssistantFolders({ dir: tempDir() }),
      identity,
    });
    restored.start();
    expect((await restored.get(bot.id)).channel.state).toBe('idle');
    expect((await restored.get(other.id)).channel.state).toBe('paused');
    restored.dispose();
  });

  it('引用任意本频道帖子，发布更新后的回复计数与 quoted 信封', async () => {
    const h = await setup({
      now: () => Date.parse('2026-11-16T01:30:00.000Z'),
      timezone: 'Pacific/Auckland',
    });
    const bot = await h.create('Desk', 'Daily updates.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const root = first as ChannelPost;
    const changes: ChannelSubscriptionMessage[] = [];
    h.service.subscribe(bot.id, undefined, (message) => changes.push(message));
    const { post } = await h.methods['channel.post'](
      {
        channelId: bot.id,
        content: [{ type: 'text', text: 'About that <message>' }],
        replyTo: root.id,
      },
      context,
    );
    expect(post.replyTo).toBe(root.id);
    expect(
      changes.some(
        (change) =>
          change.kind === 'updated' &&
          change.update.posts?.some((post) => post.id === root.id && post.replyCount === 1),
      ),
    ).toBe(true);
    const answer = (await h.coordinatorPosts(bot.id, 2)).at(-1);
    const text = JSON.stringify(answer?.content);
    expect(text).toContain('<quoted post=');
    expect(text).toContain('About that &lt;message&gt;');
    expect(text).toContain('Pacific/Auckland');
    expect(text).toContain('Monday');
    expect(text).toContain('<your_posts>');
    const coordinator =
      bot.id && ((await h.service.get(bot.id)).channel.coordinator?.sessionId as SessionId);
    const extra = h.service.postFromCoordinator(coordinator, {
      text: 'Earlier outcome',
      replyTo: root.id,
    });
    expect(extra.replyTo).toBe(root.id);
    expect(h.posts(bot.id).find((post) => post.id === root.id)?.replyCount).toBe(2);
    const other = await h.create('Other', 'Calendar.');
    expect(() =>
      h.service.post(
        {
          channelId: other.id,
          replyTo: root.id,
          content: [{ type: 'text', text: 'Wrong channel' }],
        },
        identity,
      ),
    ).toThrow(/not in this channel/);
  });

  it('表情按双方写入、替换、取消，用户表情不唤醒，下一次唤醒携带', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    const root = h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Thanks' }] },
      identity,
    );
    await h.coordinatorPosts(bot.id, 2);
    const coordinator = (await h.service.get(bot.id)).channel.coordinator?.sessionId as SessionId;
    const react = (emoji: string | null) =>
      h.methods['channel.react']({ channelId: bot.id, postId: root.id, emoji }, context);
    expect((await react('👍')).post.reactions).toEqual([{ emoji: '👍', by: 'user' }]);
    await react('❤️');
    await h.call(coordinator, 'wevir_channel_react', { postId: root.id, emoji: '✅' });
    expect(h.posts(bot.id).find((post) => post.id === root.id)?.reactions).toEqual([
      { emoji: '❤️', by: 'user' },
      { emoji: '✅', by: 'assistant' },
    ]);
    await react(null);
    await h.call(coordinator, 'wevir_channel_react', { postId: root.id, emoji: '👀' });
    await h.call(coordinator, 'wevir_channel_react', { postId: root.id, emoji: null });
    expect(h.posts(bot.id).find((post) => post.id === root.id)?.reactions).toBeUndefined();
    expect(() => react('👍👍')).toThrow(/one grapheme/);
    expect(() => react('a'.repeat(17))).toThrow(/16 UTF-16/);
    await react('👨‍👩‍👧‍👦');
    expect(h.posts(bot.id).filter((post) => post.author.kind === 'coordinator')).toHaveLength(2);
    h.service.wake(bot.id);
    expect(JSON.stringify((await h.coordinatorPosts(bot.id, 3)).at(-1)?.content)).toContain(
      '<reaction post=',
    );
    h.service.wake(bot.id);
    expect(JSON.stringify((await h.coordinatorPosts(bot.id, 4)).at(-1)?.content)).not.toContain(
      '<reactions>',
    );
    const outsider = await h.create('Other', 'Calendar.');
    expect(() =>
      h.service.react({ channelId: outsider.id, postId: root.id, emoji: '👍' }, 'user'),
    ).toThrow(/not a message/);
  });

  it('线程转交完成后回到根帖，用户在线程直接发起的回合不回报', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    const root = h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Prepare a draft' }] },
      identity,
    );
    await h.coordinatorPosts(bot.id, 2);
    const thread = await h.service.startThread({
      channelId: bot.id,
      rootPostId: root.id,
      openedBy: 'user',
    });
    const result = (await h.coordinatorPosts(bot.id, 3)).at(-1);
    expect(result?.replyTo).toBe(root.id);
    expect(JSON.stringify(result?.content)).toContain('<thread_update session=');
    expect(JSON.stringify(result?.content)).toContain('status=\\"completed\\"');
    await h.methods['session.send'](
      { sessionId: thread.sessionId, content: [{ type: 'text', text: 'Direct follow-up' }] },
      context,
    );
    await waitFor(() =>
      expect(h.events.snapshot(thread.sessionId)?.session.activeTurn).toBeUndefined(),
    );
    h.service.wake(bot.id);
    const manual = (await h.coordinatorPosts(bot.id, 4)).at(-1);
    expect(JSON.stringify(manual?.content)).not.toContain('<thread_updates>');
  });

  it('活动种类只输出分类，工具命名优先于 display', () => {
    for (const [name, kind] of [
      ['read', 'reading'],
      ['search', 'searching'],
      ['fetch', 'browsing'],
      ['shell', 'running'],
      ['edit', 'writing'],
      ['write', 'writing'],
      ['unknown', 'working'],
    ] as const) {
      expect(
        channelActivity({
          toolName: 'opaque',
          display: { kind: name, command: 'sensitive', paths: ['/private'] },
        }),
      ).toBe(kind);
    }
    expect(
      channelActivity({
        toolName: 'mcp__wevir_more__browser_snapshot',
        display: { kind: 'unknown' },
      }),
    ).toBe('browsing');
    expect(channelActivity({ toolName: 'wevir_memory_save', display: { kind: 'write' } })).toBe(
      'remembering',
    );
    expect(channelActivity({ toolName: 'wevir_automation_save', display: { kind: 'write' } })).toBe(
      'scheduling',
    );
    const instructions = channelCoordinatorInstructions('assistant');
    expect(instructions).not.toContain('call wevir_channel_needs once');
    expect(instructions).toContain('Only text inside <post author="user">');
  });

  it('线程开始等提问时回报 waiting，失败时回报 failed，均不计主动预算', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    const root = h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Prepare a draft' }] },
      identity,
    );
    await h.coordinatorPosts(bot.id, 2);
    const waiting = await h.service.startThread({
      channelId: bot.id,
      rootPostId: root.id,
      openedBy: 'coordinator',
      brief: 'ask',
    });
    const answer = (await h.coordinatorPosts(bot.id, 3)).at(-1);
    expect(JSON.stringify(answer?.content)).toContain('status=\\"waiting\\"');
    await h.sessions.cancel(waiting.sessionId);
    const failed = await h.service.startThread({
      channelId: bot.id,
      rootPostId: root.id,
      openedBy: 'coordinator',
      brief: 'fail',
    });
    const coordinator = (await h.service.get(bot.id)).channel.coordinator?.sessionId as SessionId;
    await waitFor(() => {
      const wakes = h.events.readTypes(coordinator, ['user.message']);
      expect(
        wakes.some(
          (event) =>
            event.type === 'user.message' &&
            JSON.stringify(event.payload.content).includes(`session=\\"${failed.sessionId}\\"`) &&
            JSON.stringify(event.payload.content).includes('status=\\"failed\\"'),
        ),
      ).toBe(true);
    });
    expect((await h.service.get(bot.id)).channel.usage).toBeUndefined();
  });

  it('同一线程只交出最新动态，合并窗口内不提前唤醒', async () => {
    const h = await setup({ threadUpdateDelayMs: 120 });
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    const root = h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'Prepare a draft' }] },
      identity,
    );
    await h.coordinatorPosts(bot.id, 2);
    const thread = await h.service.startThread({
      channelId: bot.id,
      rootPostId: root.id,
      openedBy: 'coordinator',
    });
    await waitFor(() =>
      expect(h.events.snapshot(thread.sessionId)?.session.activeTurn).toBeUndefined(),
    );
    const finished = h.events.readTypes(thread.sessionId, ['turn.finished']).at(-1);
    expect(finished?.type).toBe('turn.finished');
    if (finished?.type !== 'turn.finished') return;
    h.service.onTurnFinished({
      sessionId: thread.sessionId,
      turnId: finished.payload.turnId,
      outcome: 'failed',
    });
    const coordinator = (await h.service.get(bot.id)).channel.coordinator?.sessionId as SessionId;
    const latestWake = () => h.events.readTypes(coordinator, ['user.message']).at(-1);
    expect(JSON.stringify(latestWake())).not.toContain('<thread_updates>');
    await waitFor(() => expect(JSON.stringify(latestWake())).toContain('<thread_updates>'));
    const wake = latestWake();
    const text = wake?.type === 'user.message' ? JSON.stringify(wake.payload.content) : '';
    expect(text.match(/<thread_update session=/g)).toHaveLength(1);
    expect(text).toContain('status=\\"failed\\"');
  });
});

describe('日程与晨间简报', () => {
  it(
    '新助理没有自动化，默认平衡；交接只带自己的启用例行事务',
    async () => {
      const h = await setup();
      const bot = await h.create('Desk', 'Daily updates.');
      await h.coordinatorPosts(bot.id, 1);
      expect(h.automations.forChannel(bot.id)).toEqual([]);
      expect(bot.budget).toEqual({ dailyWakes: 20, dailyTokens: 400_000 });
      await h.automations.create(
        {
          title: 'Daily review <data>',
          prompt: 'Look at today.',
          schedule: { kind: 'daily', time: '09:30' },
          channelId: bot.id,
        },
        { kind: 'user' },
      );
      await h.automations.create(
        {
          title: 'Disabled routine',
          prompt: 'Look later.',
          schedule: { kind: 'interval', minutes: 30 },
          channelId: bot.id,
          enabled: false,
        },
        { kind: 'user' },
      );
      await h.service.rotate(bot.id);
      h.service.wake(bot.id);
      const last = (await h.coordinatorPosts(bot.id, 2)).at(-1);
      const text = JSON.stringify(last?.content);
      expect(text).toContain('<routines>');
      expect(text).toContain('Daily review &lt;data&gt;: daily at 09:30');
      expect(text).not.toContain('Disabled routine');
    },
    WAIT * 3,
  );

  it('助理默认只列自己的例行事务，scope all 列全部；已交出的 agent 一次性跟进删除并持久化', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Daily updates.');
    const first = (await h.coordinatorPosts(bot.id, 1))[0];
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    const other = await h.create('Other', 'Calendar.');
    await h.coordinatorPosts(other.id, 1);
    await h.automations.create(
      {
        title: 'Other routine',
        prompt: 'Read calendar.',
        schedule: { kind: 'daily', time: '09:00' },
        channelId: other.id,
      },
      { kind: 'user' },
    );
    const saved = await h.call(coordinator, 'wevir_automation_save', {
      title: 'Review outcome',
      prompt: 'Look at the outcome for cpo_original.',
      schedule: { kind: 'once', at: '2099-01-01T01:00:00.000Z' },
    });
    expect(saved.isError).toBeUndefined();
    const [own] = h.automations.forChannel(bot.id);
    expect(own?.createdBy).toMatchObject({ kind: 'agent', sessionId: coordinator });
    const ownList = await h.call(coordinator, 'wevir_automations');
    expect((ownList.structuredContent as { automations: unknown[] }).automations).toHaveLength(1);
    const all = await h.call(coordinator, 'wevir_automations', { scope: 'all' });
    expect((all.structuredContent as { automations: unknown[] }).automations).toHaveLength(2);
    const deleted: unknown[] = [];
    const unwatch = h.automations.watch((change) => deleted.push(change));
    const result = await h.automations.runNow(own?.id ?? '');
    expect(result.status).toBe('completed');
    expect(h.automations.forChannel(bot.id)).toEqual([]);
    expect(deleted).toContainEqual({ automationId: own?.id, deleted: true });
    unwatch();
    await h.automations.load();
    expect(h.automations.forChannel(bot.id)).toEqual([]);
    const answer = (await h.coordinatorPosts(bot.id, 2)).at(-1);
    expect(JSON.stringify(answer?.content)).toContain('Look at the outcome for cpo_original.');
    expect(h.automations.forChannel(other.id)).toHaveLength(1);
    const userOnce = await h.automations.create(
      {
        title: 'User reminder',
        prompt: 'Read this.',
        schedule: { kind: 'once', at: '2099-01-01T01:00:00.000Z' },
        channelId: bot.id,
      },
      { kind: 'user' },
    );
    await h.automations.runNow(userOnce.id);
    expect(h.automations.forChannel(bot.id)).toHaveLength(1);
  });

  it('晨间简报回答 NOTHING_TO_REPORT 时整条不发', async () => {
    let now = Date.parse('2026-11-17T01:00:00.000Z');
    const h = await setup({ now: () => now });
    const bot = await h.create('Desk', 'Daily updates.');
    await h.coordinatorPosts(bot.id, 1);
    expect((await h.service.get(bot.id)).channel.lastActiveAt).toBe(new Date(now).toISOString());
    now += 60_000;
    const original = h.sessions.send.bind(h.sessions);
    vi.spyOn(h.sessions, 'send').mockImplementationOnce((params, by, options) =>
      original(
        { ...params, content: [{ type: 'text', text: 'Quiet today.\nNOTHING_TO_REPORT' }] },
        by,
        options,
      ),
    );
    h.service.wakeForSchedule(bot.id, {
      title: 'Morning brief',
      prompt: 'Look at today.',
      brief: true,
    });
    const coordinator = (await h.service.get(bot.id)).channel.coordinator?.sessionId as SessionId;
    await waitFor(() => {
      expect(h.events.readTypes(coordinator, ['user.message'])).toHaveLength(2);
      expect(h.events.snapshot(coordinator)?.session.activeTurn).toBeUndefined();
    });
    expect(h.posts(bot.id)).toHaveLength(1);
    expect((await h.service.get(bot.id)).channel.lastActiveAt).toBe(new Date(now).toISOString());
    expect((await h.service.get(bot.id)).channel.coordinator).not.toHaveProperty('lastActiveAt');
  });
  it('晨间简报用普通消息呈现，清单只作为数据；删助理一起删日程', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    await h.automations.create(
      {
        title: 'Morning brief',
        prompt: 'Look at today.',
        schedule: { kind: 'daily', time: '08:00' },
        channelId: bot.id,
        brief: true,
      },
      { kind: 'user' },
    );
    const schedules = h.automations.forChannel(bot.id);
    expect(schedules).toEqual([
      expect.objectContaining({
        title: 'Morning brief',
        schedule: { kind: 'daily', time: '08:00' },
        channelId: bot.id,
        brief: true,
        notify: 'never',
        workspaceId: bot.workspaceId,
        providerId: 'mock',
        newSessionEachRun: false,
      }),
    ]);
    // 简报要列的：一项待办、一条没回应的建议。
    await h.call(coordinator, 'wevir_task_create', { subject: 'Reply to Ana' });
    await h.call(coordinator, 'wevir_channel_suggest', { text: 'Archive last week’s newsletters' });

    const briefRun = await h.automations.runNow(schedules[0]?.id ?? '');
    expect(briefRun.status).toBe('completed');
    const brief = (await h.coordinatorPosts(bot.id, 3)).at(-1);
    expect(brief?.author.kind).toBe('coordinator');
    expect(brief?.card).toBeUndefined();
    const text = brief?.content[0]?.type === 'text' ? brief.content[0].text : '';
    expect(text).toContain('<schedule title="Morning brief" brief="true">');
    expect(text).toContain('<todo>\n- Reply to Ana\n</todo>');
    expect(h.automations.get(schedules[0]?.id ?? '').runs[0]?.status).toBe('completed');

    // 助理开口时的提醒：带助理、按助理收起。
    expect(h.intents.filter((intent) => intent.kind === 'channel').at(-1)).toMatchObject({
      kind: 'channel',
      channelId: bot.id,
      title: 'Mail desk',
      collapseKey: `channel:${bot.id}`,
    });

    const created = await h.automations.create(
      {
        title: 'Friday wrap-up',
        prompt: 'Sum up the week.',
        schedule: { kind: 'daily', time: '17:00', weekdays: [5] },
        channelId: bot.id,
      },
      { kind: 'user' },
    );
    expect(created).toMatchObject({ channelId: bot.id, notify: 'never' });
    await expect(
      h.automations.create(
        {
          title: 'x',
          prompt: 'y',
          schedule: { kind: 'manual' },
          providerId: 'mock',
          workspaceId: bot.workspaceId,
          brief: true,
        },
        { kind: 'user' },
      ),
    ).rejects.toThrow(/brief needs channelId/);

    await h.methods['channel.delete']({ channelId: bot.id }, context);
    await waitFor(() => expect(h.automations.forChannel(bot.id)).toEqual([]));
  });

  it('协调者等批准：助理是 waiting，审批进 channel.get，收件箱与提醒带上助理', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'approve this send' }] },
      identity,
    );
    await waitFor(async () => {
      const view = await h.methods['channel.get']({ channelId: bot.id }, context);
      expect(view.channel.state).toBe('waiting');
      expect(view.channel.pendingCount).toBe(1);
      expect(view.approvals).toHaveLength(1);
    });
    await waitFor(() => {
      expect(h.inbox.list()).toEqual([
        expect.objectContaining({ kind: 'approval', channelId: bot.id, title: 'Mail desk' }),
      ]);
      expect(h.intents.find((intent) => intent.kind === 'approval')).toMatchObject({
        channelId: bot.id,
        title: 'Mail desk',
      });
    });
  });

  it('提醒只给助理开口的帖子：用户发的不算', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    const before = h.intents.length;
    h.service.post({ channelId: bot.id, content: [{ type: 'text', text: 'Hello' }] }, identity);
    await h.coordinatorPosts(bot.id, 2);
    expect(h.intents.slice(before).map((intent) => intent.kind)).toEqual(['channel']);
  });
});

describe('助理之间与助理群', () => {
  const textOf = (post: { content: { type: string; text?: string }[] } | undefined) =>
    post?.content[0]?.type === 'text' ? (post.content[0].text ?? '') : '';
  const assistantPosts = (h: Awaited<ReturnType<typeof setup>>, channelId: ChannelId) =>
    h.posts(channelId).filter((post) => post.author.kind === 'assistant');
  const coordinatorOf = async (h: Awaited<ReturnType<typeof setup>>, channelId: ChannelId) =>
    (await h.methods['channel.get']({ channelId }, context)).channel.coordinator
      ?.sessionId as SessionId;

  it('一个助理给另一个发消息：两边时间线都有，对方回答落回发起方并唤醒它，不再自动送回', async () => {
    const h = await setup();
    const mail = await h.create('Mail desk', 'Sort my inbox.');
    const trip = await h.create('Trip desk', 'Bookings.');
    await h.coordinatorPosts(mail.id, 1);
    await h.coordinatorPosts(trip.id, 1);
    const mailSession = await coordinatorOf(h, mail.id);

    const listed = await h.call(mailSession, 'wevir_channel_assistants');
    expect(JSON.stringify(listed.structuredContent)).toContain('Trip desk');
    expect(JSON.stringify(listed.structuredContent)).not.toContain('Mail desk');
    expect(
      (await h.call(mailSession, 'wevir_channel_message', { to: 'mail desk', text: 'hi' })).isError,
    ).toBe(true);

    const sent = await h.call(mailSession, 'wevir_channel_message', {
      to: 'trip desk',
      text: 'When is the Berlin flight?',
    });
    expect(sent.isError).not.toBe(true);
    const outgoing = h.posts(mail.id).find((post) => post.to !== undefined);
    expect(outgoing?.to).toEqual({ channelId: trip.id, name: 'Trip desk' });
    expect(outgoing?.author.kind).toBe('coordinator');

    // 对方：一条来自 Mail desk 的帖子，协调者以 reason=message 醒来回答它。
    const replies = await h.coordinatorPosts(trip.id, 2);
    const incoming = assistantPosts(h, trip.id)[0];
    expect(incoming?.author).toEqual({ kind: 'assistant', channelId: mail.id, name: 'Mail desk' });
    expect(ChannelPostSchema.parse(incoming)).toEqual(incoming);
    expect(replies[1]?.replyTo).toBe(incoming?.id);
    expect(textOf(replies[1])).toContain('reason="message"');
    expect(textOf(replies[1])).toContain('from="Mail desk"');

    // 发起方：回答以 Trip desk 的名义落回，回复发出的那条；协调者以 reason=reply 醒来。
    await waitFor(() => expect(assistantPosts(h, mail.id)).toHaveLength(1));
    const answer = assistantPosts(h, mail.id)[0];
    expect(answer?.author).toEqual({ kind: 'assistant', channelId: trip.id, name: 'Trip desk' });
    expect(answer?.replyTo).toBe(outgoing?.id);
    const mailReplies = await h.coordinatorPosts(mail.id, 3);
    expect(textOf(mailReplies[2])).toContain('reason="reply"');
    // 发起方对回答的回答不再送回对方。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(assistantPosts(h, trip.id)).toHaveLength(1);
    expect(h.posts(trip.id).filter((post) => post.author.kind === 'coordinator')).toHaveLength(2);
  });

  it('建群：没有 @ 时全体成员各自回答，@ 了只唤醒被 @ 的；群外的助理不受影响', async () => {
    const h = await setup();
    const ann = await h.create('Ann', 'Calendar.');
    const bob = await h.create('Bob', 'Travel.');
    const cid = await h.create('Cid', 'Finance.');
    for (const bot of [ann, bob, cid]) await h.coordinatorPosts(bot.id, 1);

    await expect(
      h.methods['channel.create']({ kind: 'group', name: 'Solo', members: [ann.id] }, context),
    ).rejects.toThrow(/2 to 8/);
    const { channel: group } = await h.methods['channel.create'](
      { kind: 'group', name: 'Weekly', members: [ann.id, bob.id] },
      context,
    );
    expect(ChannelSchema.parse(group)).toEqual(group);
    expect(group).toMatchObject({ kind: 'group', group: { members: [ann.id, bob.id] } });
    expect(group.coordinator).toBeUndefined();
    expect(group.workspaceId).toBeUndefined();
    expect(() => h.methods['channel.wake']({ channelId: group.id }, context)).toThrow(
      /no coordinator/,
    );

    await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: 'Plan the week' }] },
      context,
    );
    await waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(2));
    const first = assistantPosts(h, group.id);
    expect(
      first.map((post) => post.author.kind === 'assistant' && post.author.name).sort(),
    ).toEqual(['Ann', 'Bob']);
    expect(textOf(first[0])).toContain('<group_wake');
    expect(textOf(first[0])).toContain('Plan the week');
    for (const post of first) expect(ChannelPostSchema.parse(post)).toEqual(post);
    // 回答发在群里，不在成员自己的时间线上；Cid 没被唤醒。
    expect(h.posts(ann.id).filter((post) => post.author.kind === 'coordinator')).toHaveLength(1);
    expect(h.posts(cid.id)).toHaveLength(1);

    const { post: asked } = await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: '@Bob what about Friday?' }] },
      context,
    );
    expect(asked.mentions).toEqual([bob.id]);
    await waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(3));
    const third = assistantPosts(h, group.id)[2];
    expect(third?.author).toMatchObject({ kind: 'assistant', channelId: bob.id });
    expect(third?.replyTo).toBe(asked.id);
    // Bob 只看到它上次之后的新帖：上一轮 Ann 的回答与这条。
    expect(textOf(third)).toContain('what about Friday?');
    expect(textOf(third)).not.toContain('Plan the week');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(assistantPosts(h, group.id)).toHaveLength(3);
    const row = (await h.methods['channel.get']({ channelId: group.id }, context)).channel;
    expect(row.lastPost).toMatchObject({ author: 'assistant', assistantId: bob.id });

    // 删掉 Bob：从群里移出。
    await h.methods['channel.delete']({ channelId: bob.id }, context);
    const after = (await h.methods['channel.get']({ channelId: group.id }, context)).channel;
    expect(after.group?.members).toEqual([ann.id]);
  });

  it('群里助理 @ 助理接话：层数到上限就停，等用户再发言', async () => {
    const h = await setup();
    // 职责里写着 @ 对方：echo 复述信封的成员表，回答就会 @ 到对方（避开 echo 的触发词，如 ask）。
    const ann = await h.create('Ann', 'Dates. Ping @Bob for travel.');
    const bob = await h.create('Bob', 'Travel. Ping @Ann for dates.');
    for (const bot of [ann, bob]) await h.coordinatorPosts(bot.id, 1);
    const { channel: group } = await h.methods['channel.create'](
      { kind: 'group', name: 'Pair', members: [ann.id, bob.id] },
      context,
    );
    await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: 'Hi' }], mentions: [ann.id] },
      context,
    );
    await waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const chain = assistantPosts(h, group.id);
    expect(chain).toHaveLength(3);
    expect(chain.map((post) => post.author.kind === 'assistant' && post.author.name)).toEqual([
      'Ann',
      'Bob',
      'Ann',
    ]);
    expect(chain[0]?.mentions).toEqual([bob.id]);
    const idle = (await h.methods['channel.get']({ channelId: group.id }, context)).channel;
    expect(idle.state).toBe('idle');
  });

  it('群里的用户发言绕过成员的主动预算，不贴预算说明', async () => {
    const h = await setup({ budget: { dailyWakes: 1, dailyTokens: 1_000_000 } });
    const ann = await h.create('Ann', 'Calendar.');
    const bob = await h.create('Bob', 'Travel.');
    for (const bot of [ann, bob]) await h.coordinatorPosts(bot.id, 1);
    for (const bot of [ann, bob])
      h.storage.channels.addUsage(
        bot.id,
        new Intl.DateTimeFormat('en-CA', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        { wakes: 1 },
      );
    const { channel: group } = await h.methods['channel.create'](
      { kind: 'group', name: 'Weekly', members: [ann.id, bob.id] },
      context,
    );
    await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: 'Plan the week' }] },
      context,
    );
    await waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(2));
    expect(h.posts(group.id).some((post) => post.card?.kind === 'notice')).toBe(false);
  });
});

describe('助理的规矩由 Host 执行（0.132.0）', () => {
  type Harness = Awaited<ReturnType<typeof setup>>;

  async function ready(h: Harness) {
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    const sessionId = (await h.methods['channel.get']({ channelId: bot.id }, context)).channel
      .coordinator?.sessionId as SessionId;
    return { bot, sessionId };
  }

  /** 协调者会话里每个工具的结局：工具名 → `tool.finished` 的状态。 */
  function toolResults(h: Harness, sessionId: SessionId): Record<string, string> {
    const names = new Map<string, string>();
    const results: Record<string, string> = {};
    for (const event of h.events.readSince(sessionId, 0)) {
      if (event.type === 'tool.started')
        names.set(event.payload.toolCallId, event.payload.toolName);
      if (event.type === 'tool.finished') {
        results[names.get(event.payload.toolCallId) ?? '?'] = event.payload.status;
      }
    }
    return results;
  }

  const approvalsIn = (h: Harness, sessionId: SessionId) =>
    h.events.readSince(sessionId, 0).filter((event) => event.type === 'approval.requested');

  const notices = (h: Harness, channelId: ChannelId) =>
    h
      .posts(channelId)
      .filter((post) => post.author.kind === 'host' && post.card?.kind === 'notice')
      .map((post) => ({
        card: post.card,
        text: post.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      }));

  const say = (h: Harness, channelId: ChannelId, text: string) =>
    h.service.post({ channelId, content: [{ type: 'text', text }] }, identity);

  it('默认规矩：联网命令、工作区里写文件、只读的连接器、Wevir 自己的工具都不问；写文件做完在时间线上告知', async () => {
    const h = await setup();
    const { bot, sessionId } = await ready(h);
    say(
      h,
      bot.id,
      'approval:shell:curl+-s+https://example.com approval:write:notes/today.md approval:mcp:github/list_issues approval:mcp:wevir/wevir_process_start',
    );
    await h.coordinatorPosts(bot.id, 2);
    expect(approvalsIn(h, sessionId)).toEqual([]);
    expect(toolResults(h, sessionId)).toMatchObject({
      echo_shell: 'completed',
      echo_write: 'completed',
      mcp__github__list_issues: 'completed',
      mcp__wevir__wevir_process_start: 'completed',
    });
    await waitFor(() =>
      expect(notices(h, bot.id)).toEqual([
        {
          card: { kind: 'notice', reason: 'acted', category: 'local_files' },
          text: 'notes/today.md',
        },
      ]),
    );
    // 告知的说明不发提醒。
    expect(h.intents.filter((intent) => intent.kind === 'approval')).toEqual([]);
  });

  it('档位为 ask 的动作照常发审批，进助理的视图与收件箱；批准后接着做', async () => {
    const h = await setup();
    const { bot, sessionId } = await ready(h);
    say(h, bot.id, 'approval:mcp:gmail/send_email');
    let approvalId = '';
    await waitFor(async () => {
      const view = await h.methods['channel.get']({ channelId: bot.id }, context);
      expect(view.approvals).toHaveLength(1);
      expect(view.approvals[0]?.detail?.toolName).toBe('mcp__gmail__send_email');
      approvalId = view.approvals[0]?.id as string;
    });
    await waitFor(() =>
      expect(h.inbox.list()).toEqual([
        expect.objectContaining({ kind: 'approval', channelId: bot.id }),
      ]),
    );
    await h.methods['approval.respond'](
      { approvalId: approvalId as never, optionId: 'allow-once' },
      context,
    );
    await h.coordinatorPosts(bot.id, 2);
    expect(toolResults(h, sessionId)).toMatchObject({ mcp__gmail__send_email: 'completed' });
    expect(notices(h, bot.id)).toEqual([]);
  });

  it('hand_off 的动作与转账都由 Host 拒绝，不发审批，时间线上写明拦下了什么', async () => {
    const h = await setup();
    const { bot, sessionId } = await ready(h);
    say(h, bot.id, 'approval:mcp:shop/checkout_cart approval:mcp:bank/transfer_money');
    await h.coordinatorPosts(bot.id, 2);
    expect(approvalsIn(h, sessionId)).toEqual([]);
    expect(toolResults(h, sessionId)).toMatchObject({
      mcp__shop__checkout_cart: 'failed',
      mcp__bank__transfer_money: 'failed',
    });
    expect(notices(h, bot.id)).toEqual([
      {
        card: { kind: 'notice', reason: 'handed_off', category: 'purchases' },
        text: 'shop/checkout_cart',
      },
      { card: { kind: 'notice', reason: 'blocked' }, text: 'bank/transfer_money' },
    ]);
  });

  it('改了规矩对已有的协调者马上生效；交易无论哪一档都拦', async () => {
    const h = await setup();
    const { bot, sessionId } = await ready(h);
    await h.methods['channel.update'](
      {
        channelId: bot.id,
        rules: { ...DEFAULT_ASSISTANT_RULES, messages: 'do', purchases: 'do' },
      },
      context,
    );
    say(h, bot.id, 'approval:mcp:gmail/send_email approval:mcp:alpaca/place_order');
    await h.coordinatorPosts(bot.id, 2);
    const after = (await h.methods['channel.get']({ channelId: bot.id }, context)).channel
      .coordinator?.sessionId;
    expect(after).toBe(sessionId);
    expect(approvalsIn(h, sessionId)).toEqual([]);
    expect(toolResults(h, sessionId)).toMatchObject({
      mcp__gmail__send_email: 'completed',
      mcp__alpaca__place_order: 'failed',
    });
    expect(notices(h, bot.id).map((notice) => notice.card)).toEqual([
      { kind: 'notice', reason: 'blocked' },
    ]);
  });

  it('不是助理的会话不管；看不到是什么调用时照常问', async () => {
    const h = await setup();
    const { sessionId } = await ready(h);
    const tool = { toolName: 'mcp__gmail__send_email', display: { kind: 'unknown' as const } };
    expect(h.service.approvalPolicy('ses_other' as SessionId, tool)).toBeUndefined();
    expect(h.service.approvalPolicy(sessionId, undefined)).toBe('ask');
    expect(h.service.approvalPolicy(sessionId, tool)).toBe('ask');
  });
});

describe('助理输入框的图片与停止（0.135.0）', () => {
  /** 只有文件头的 PNG（签名 + IHDR）。 */
  const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes.toString('base64');
  };
  const textOf = (post: { content: { type: string; text?: string }[] } | undefined) =>
    post?.content[0]?.type === 'text' ? (post.content[0].text ?? '') : '';
  const row = async (h: Awaited<ReturnType<typeof setup>>, channelId: ChannelId) =>
    (await h.methods['channel.get']({ channelId }, context)).channel;

  it('普通文件跟随帖子进入协调者的信封，频道记录保有自己的引用', async () => {
    const h = await setup();
    const bot = await h.create('Desk', 'Read notes.');
    await h.coordinatorPosts(bot.id, 1);
    const { file } = await h.methods['file.upload']({ name: 'notes.txt', data: 'b2s=' }, context);
    const { post } = await h.methods['channel.post'](
      { channelId: bot.id, content: [file] },
      context,
    );
    expect(post.content).toEqual([file]);
    const [, answer] = await h.coordinatorPosts(bot.id, 2);
    expect(textOf(answer)).toContain(`${file.fileId}.data.txt`);
    expect(h.storage.events.attachmentRefs().get(file.fileId)).toContain(bot.id);
  });

  it('帖子带图片：图片挪出暂存区、进协调者的信封；模型看不了图片时换成说明与本机的文件', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const blind = await h.create('Trip desk', 'Bookings.', undefined, 'blind');
    await h.coordinatorPosts(bot.id, 1);
    await h.coordinatorPosts(blind.id, 1);

    for (const channel of [bot, blind]) {
      const { image } = await h.methods['image.upload'](
        { mimeType: 'image/png', data: png(4, 3), name: 'receipt.png' },
        context,
      );
      const { post } = await h.methods['channel.post'](
        {
          channelId: channel.id,
          content: [{ type: 'text', text: 'What is this?' }, image],
        },
        context,
      );
      expect(ChannelPostSchema.parse(post)).toEqual(post);
      expect(post.content[1]).toMatchObject({ type: 'image', imageId: image.imageId, width: 4 });
    }
    const [, seen] = await h.coordinatorPosts(bot.id, 2);
    expect(textOf(seen)).toContain('[image: receipt.png]');
    expect(textOf(seen)).not.toContain('<attached_images');
    const [, described] = await h.coordinatorPosts(blind.id, 2);
    expect(textOf(described)).toContain('<attached_images count="1">');
    expect(textOf(described)).toMatch(/- receipt\.png: .*images.*\.png/);
    expect(textOf(described)).not.toContain('[image:');

    // 没有这张图片：回 IMAGE_NOT_FOUND，不进时间线。
    const before = h.posts(bot.id).length;
    await expect(
      h.methods['channel.post'](
        {
          channelId: bot.id,
          content: [
            {
              type: 'image',
              imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' as never,
              mimeType: 'image/png',
              size: 33,
            },
          ],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
    expect(h.posts(bot.id)).toHaveLength(before);
  });

  it('停止：协调者回这条时间线时 answering，channel.stop 中断回合、不发回答', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    await waitFor(async () => expect((await row(h, bot.id)).answering).toBeUndefined());

    // echo 的 ask 停在提问上，回合一直在跑。
    await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'ask me first' }] },
      context,
    );
    const sessionId = (await row(h, bot.id)).coordinator?.sessionId as SessionId;
    await waitFor(() =>
      expect(h.events.snapshot(sessionId)?.pendingQuestions?.length ?? 0).toBeGreaterThan(0),
    );
    const busy = await row(h, bot.id);
    expect(busy.answering).toBe(true);
    expect(ChannelSchema.parse(busy)).toEqual(busy);

    await h.methods['channel.stop']({ channelId: bot.id }, context);
    await waitFor(async () => {
      expect(h.events.snapshot(sessionId)?.session.activeTurn).toBeUndefined();
      expect((await row(h, bot.id)).answering).toBeUndefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.posts(bot.id).filter((post) => post.author.kind === 'coordinator')).toHaveLength(1);
    expect(h.posts(bot.id).filter((post) => post.author.kind === 'host')).toHaveLength(0);
    // 没有在回时无操作；之后照常回答。
    await h.methods['channel.stop']({ channelId: bot.id }, context);
    await h.methods['channel.post'](
      { channelId: bot.id, content: [{ type: 'text', text: 'Any news?' }] },
      context,
    );
    const replies = await h.coordinatorPosts(bot.id, 2);
    expect(textOf(replies[1])).toContain('Any news?');
  });

  it('群里停止：正在回这个群的成员都停下，这一轮不再有回答', async () => {
    const h = await setup();
    const ann = await h.create('Ann', 'Calendar.');
    const bob = await h.create('Bob', 'Travel.');
    for (const bot of [ann, bob]) await h.coordinatorPosts(bot.id, 1);
    const { channel: group } = await h.methods['channel.create'](
      { kind: 'group', name: 'Weekly', members: [ann.id, bob.id] },
      context,
    );
    await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: 'ask both of you' }] },
      context,
    );
    const sessions = [
      (await row(h, ann.id)).coordinator?.sessionId as SessionId,
      (await row(h, bob.id)).coordinator?.sessionId as SessionId,
    ];
    await waitFor(() => {
      for (const sessionId of sessions) {
        expect(h.events.snapshot(sessionId)?.pendingQuestions?.length ?? 0).toBeGreaterThan(0);
      }
    });
    expect((await row(h, group.id)).answering).toBe(true);

    await h.methods['channel.stop']({ channelId: group.id }, context);
    await waitFor(async () => {
      for (const sessionId of sessions) {
        expect(h.events.snapshot(sessionId)?.session.activeTurn).toBeUndefined();
      }
      expect((await row(h, group.id)).answering).toBeUndefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.posts(group.id).filter((post) => post.author.kind === 'assistant')).toHaveLength(0);
  });
});

describe('发给协调者的事', () => {
  const textOf = (post: { content: { type: string; text?: string }[] } | undefined) =>
    post?.content[0]?.type === 'text' ? (post.content[0].text ?? '') : '';
  const coordinatorOf = async (h: Awaited<ReturnType<typeof setup>>, channelId: ChannelId) =>
    (await h.methods['channel.get']({ channelId }, context)).channel.coordinator
      ?.sessionId as SessionId;
  const exited = (sessionId: SessionId): ProcessNotice => ({
    event: 'exit',
    tail: 'build ok',
    process: {
      id: 'p1',
      sessionId,
      name: 'nightly build',
      command: 'make',
      cwd: '/tmp',
      pid: 42,
      startedAt: Date.now() - 1000,
      status: 'exited',
      exitCode: 0,
      signal: null,
      endedAt: Date.now(),
      logPath: '/tmp/p1.log',
      bytes: 8,
      killed: false,
    },
  });
  /** 协调者会话里不是频道唤醒的消息（直接发进去、用户看不到的）。 */
  const directMessages = (h: Awaited<ReturnType<typeof setup>>, sessionId: SessionId) =>
    h.events
      .readSince(sessionId, 0)
      .filter(
        (event) => event.type === 'user.message' && event.payload.from?.channel?.kind !== 'wake',
      );

  it('协调者派出的顶层会话也把额度报告交回同一频道', async () => {
    const h = await setup();
    const bot = await h.create('Work desk', 'Keep track of work.');
    await h.coordinatorPosts(bot.id, 1);
    const coordinator = await coordinatorOf(h, bot.id);
    const child = await h.sessions.create(
      { workspaceId: bot.workspaceId, providerId: 'mock' },
      { openedBy: coordinator },
    );
    const text = '因额度从 A 接力到 B（第 1 次）';
    h.service.onUsageRecovery({
      sessionId: child.id,
      turnId: 'trn_1',
      originTurnId: 'trn_1',
      seq: 1,
      at: new Date().toISOString(),
      text,
    });
    const replies = await h.coordinatorPosts(bot.id, 2);
    expect(textOf(replies[1])).toContain(text);
    expect(directMessages(h, coordinator)).toEqual([]);
  });

  it('协调者起的后台进程退出：以 reason=event 唤醒，回答成帖', async () => {
    const h = await setup();
    const bot = await h.create('Build desk', 'Watch my builds.');
    await h.coordinatorPosts(bot.id, 1);
    const sessionId = await coordinatorOf(h, bot.id);

    h.tools.onProcessNotice(exited(sessionId));
    const replies = await h.coordinatorPosts(bot.id, 2);
    const text = textOf(replies[1]);
    expect(text).toContain('reason="event"');
    expect(text).toContain('<event kind="process"');
    expect(text).toContain('nightly build');
    expect(replies[1]?.replyTo).toBeUndefined();
    expect(directMessages(h, sessionId)).toEqual([]);
  });

  it('换班后旧一班起的进程退出：交给当前一班', async () => {
    const h = await setup();
    const bot = await h.create('Build desk', 'Watch my builds.');
    await h.coordinatorPosts(bot.id, 1);
    const first = await coordinatorOf(h, bot.id);
    await h.methods['channel.rotate']({ channelId: bot.id }, context);
    await waitFor(() => expect(h.events.snapshot(first)?.session.state).toBe('closed'));

    h.tools.onProcessNotice(exited(first));
    const replies = await h.coordinatorPosts(bot.id, 2);
    expect(replies[1]?.author).toMatchObject({ kind: 'coordinator', generation: 2 });
    const second = replies[1]?.author.kind === 'coordinator' ? replies[1].author.sessionId : '';
    expect(second).not.toBe(first);
    expect(textOf(replies[1])).toContain('<event kind="process"');
    expect(directMessages(h, first)).toEqual([]);
  });

  it('协调者开出的会话回报：以 reason=event 唤醒，回答成帖', async () => {
    const h = await setup();
    const bot = await h.create('Build desk', 'Watch my builds.');
    await h.coordinatorPosts(bot.id, 1);
    const sessionId = await coordinatorOf(h, bot.id);

    const created = await h.call(sessionId, 'wevir_session_create', {
      message: 'Count the files',
      title: 'Counter',
    });
    expect(created.isError).not.toBe(true);
    const replies = await h.coordinatorPosts(bot.id, 2);
    const text = textOf(replies[1]);
    expect(text).toContain('reason="event"');
    expect(text).toContain('<event kind="report"');
    expect(text).toContain('Counter');
    expect(directMessages(h, sessionId)).toEqual([]);
  });

  it('撤回还没交出去的事：不再唤醒；不是协调者的会话不收', async () => {
    const h = await setup();
    const bot = await h.create('Build desk', 'Watch my builds.');
    await h.coordinatorPosts(bot.id, 1);
    const sessionId = await coordinatorOf(h, bot.id);
    // 协调者在原始对话里忙着：事攒在缓冲里。
    h.storage.channels.update(bot.id, {
      pausedAt: new Date().toISOString(),
      pauseReason: 'user',
      updatedAt: new Date().toISOString(),
    });
    const id = h.service.deliverEvent(sessionId, { kind: 'blocked', text: 'waiting' });
    expect(id).toBeDefined();
    expect(h.service.retractEvent(id as string)).toBe(true);
    expect(h.service.retractEvent(id as string)).toBe(false);
    expect(h.service.deliverEvent('ses_other' as SessionId, { kind: 'report', text: 'x' })).toBe(
      undefined,
    );
  });
});

describe('postOfAnswer', () => {
  it('最后一行是 NOTHING_TO_REPORT 时不开口', () => {
    expect(postOfAnswer('All quiet.\nNOTHING_TO_REPORT')).toEqual({
      text: 'All quiet.',
      quiet: true,
    });
    expect(postOfAnswer('**NOTHING_TO_REPORT**')).toEqual({ text: '', quiet: true });
    expect(postOfAnswer('Done: two emails sorted.')).toEqual({
      text: 'Done: two emails sorted.',
      quiet: false,
    });
  });
});

describe('channelToolAllowed', () => {
  it('协调者全部、线程三个、别的会话没有', () => {
    for (const name of CHANNEL_TOOLS) {
      expect(channelToolAllowed(name, 'coordinator')).toBe(true);
      expect(channelToolAllowed(name, undefined)).toBe(false);
    }
    expect(CHANNEL_TOOLS.filter((name) => channelToolAllowed(name, 'thread'))).toEqual([
      'wevir_channel_status',
      'wevir_channel_timeline',
      'wevir_channel_resolve',
    ]);
    expect(channelToolAllowed('wevir_session_list', undefined)).toBe(true);
  });
});
