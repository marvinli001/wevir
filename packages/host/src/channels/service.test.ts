// 频道与助理（0.120.0）：echo 引擎跑通建助理、发帖唤醒协调者、换班、预算、线程、列表与订阅的通知。

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HostId, NotificationIntent, WorkspaceId } from '@wevir/protocol';
import {
  ASSISTANT_AVATAR_COLOR_COUNT,
  ASSISTANT_AVATAR_TYPES,
  type ChannelId,
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
import { AutomationService } from '../automations/service.js';
import { EventStore } from '../event-store.js';
import { addWorkspace, createHostMethods } from '../host-methods.js';
import { InboxService } from '../inbox.js';
import { NotificationService } from '../notifications.js';
import { SessionManager } from '../session-manager.js';
import { boardEventTasks, TaskBoardStore } from '../task-board.js';
import { identity, useStorages, useTempDir } from '../test-utils.js';
import { AssistantFolders } from './assistants.js';
import {
  ChannelService,
  type ChannelServiceOptions,
  type ChannelSubscriptionMessage,
  MORNING_BRIEF_TIME,
  morningBriefAutomation,
  postOfAnswer,
  ROTATE_WAKES,
} from './service.js';
import { CHANNEL_TOOLS, channelToolAllowed } from './tools.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };
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
  } = {},
) {
  const dataDir = join(realpathSync(tempDir()), 'data');
  mkdirSync(dataDir, { recursive: true });
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const adapter = new EchoAdapter({ stepDelayMs: 0 });
  const assistants = new AssistantFolders({ dir: join(dataDir, 'assistants') });
  await assistants.load();
  const taskBoards = new TaskBoardStore({
    dir: join(dataDir, 'tasks'),
    onChange: (root) => channels?.tasksChanged(root),
  });
  let channels: ChannelService | undefined;
  let automations: AutomationService | undefined;
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    worktreesDir: join(dataDir, 'worktrees'),
    onTurnFinished: (info) => channels?.onTurnFinished(info),
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
    identity: { deviceId: 'host', clientId: 'wevir-channels', clientKind: 'desktop' },
    inventory: () => ({ connectors: ['Calendar'], browser: true }),
    tasks: {
      list: async (root) => boardEventTasks(await taskBoards.list(root)),
      update: (root, id, patch, by) => taskBoards.update(root, id, patch, by),
    },
    wakeDelayMs: 0,
    schedules: {
      created: async (channel) => {
        await automations?.create(morningBriefAutomation(channel.id), { kind: 'user' });
      },
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
  const service = channels;
  const create = async (name: string, description: string, folders?: string[]) =>
    (
      await methods['channel.create'](
        {
          kind: 'assistant',
          name,
          description,
          ...(folders !== undefined && { folders }),
          coordinator: { providerId: 'mock' },
          ...(options.budget !== undefined && { budget: options.budget }),
        },
        context,
      )
    ).channel;
  const posts = (channelId: ChannelId) => service.posts({ channelId, limit: 200 }).posts;
  /** 等到协调者回答了这么多条。 */
  const coordinatorPosts = async (channelId: ChannelId, count: number) => {
    await vi.waitFor(
      () => {
        expect(posts(channelId).filter((post) => post.author.kind === 'coordinator')).toHaveLength(
          count,
        );
      },
      { timeout: 5000 },
    );
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
  });
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
  it('建两个助理：各自的隐藏工作区与协调者，第一次唤醒是 setup，不进会话与项目列表', async () => {
    const h = await setup();
    const first = await h.create('Mail desk', 'Sort my inbox every morning.');
    const second = await h.create('Trip desk', 'Keep my travel bookings in order.');

    expect(ChannelSchema.parse(first)).toEqual(first);
    expect(first.assistant?.rules).toEqual(DEFAULT_ASSISTANT_RULES);
    expect(ASSISTANT_AVATAR_TYPES).toContain(first.assistant?.avatar.type);
    expect(first.assistant?.avatar.color).toBeLessThan(ASSISTANT_AVATAR_COLOR_COUNT);
    expect(first.workspaceId).not.toBe(second.workspaceId);

    const [setupA] = await h.coordinatorPosts(first.id, 1);
    const [setupB] = await h.coordinatorPosts(second.id, 1);
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
    await vi.waitFor(async () => {
      const row = (await h.methods['channel.get']({ channelId: first.id }, context)).channel;
      expect(row.unreadCount).toBe(1);
      expect(row.lastPost?.author).toBe('coordinator');
    });
    h.service.markRead(first.id, reply?.seq ?? 0, identity);
    await vi.waitFor(async () => {
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
    await vi.waitFor(() =>
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
    await vi.waitFor(() =>
      expect(
        received
          .filter((message) => message.kind === 'posted')
          .map((message) => message.kind === 'posted' && message.post.seq),
      ).toEqual(expect.arrayContaining([2, 3])),
    );
    unsubscribe();

    await h.methods['channel.delete']({ channelId: bot.id }, context);
    await vi.waitFor(() =>
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
    await vi.waitFor(() =>
      expect(h.events.snapshot(firstSession as SessionId)?.session.state).toBe('closed'),
    );
    const channel = h.service.channelOf(secondSession as SessionId);
    expect(channel?.role).toBe('coordinator');
    expect(channel?.channel.coordinator?.generation).toBe(2);
  });

  it('预算用完时暂停并贴一条说明，帖子照收', async () => {
    const h = await setup({ budget: { dailyWakes: 1, dailyTokens: 200_000 } });
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.post({ channelId: bot.id, content: [{ type: 'text', text: 'One more' }] }, identity);
    await vi.waitFor(() => {
      const notice = h.posts(bot.id).find((post) => post.card?.kind === 'notice');
      expect(notice?.card).toEqual({ kind: 'notice', reason: 'budget' });
      expect(ChannelPostSchema.parse(notice)).toEqual(notice);
    });
    const row = (await h.methods['channel.get']({ channelId: bot.id }, context)).channel;
    expect(row.state).toBe('paused');
    expect(row.pauseReason).toBe('budget');
    expect(h.posts(bot.id).filter((post) => post.author.kind === 'coordinator')).toHaveLength(1);
  });

  it('预算的 token 按用量统计算，缓存读取不算', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.post({ channelId: bot.id, content: [{ type: 'text', text: 'One more' }] }, identity);
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
    await vi.waitFor(() => {
      expect(h.storage.channels.usage(bot.id, day)?.tokens).toBe(
        h.storage.usage.sessionTotals(sessionId).tokens,
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
    await vi.waitFor(() => {
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

  it('wevir_session_create 的 project 只给助理；助理的 wevir_session_list 默认看全部项目', async () => {
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
    const refused = await h.call(mine.id, 'wevir_session_create', {
      message: 'Run the tests',
      project: repo,
    });
    expect(refused.isError).toBe(true);
  });
});

describe('日程与晨间简报', () => {
  it('建助理时建好每天的晨间简报；运行时贴一条带简报卡片的回答；删助理一起删', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    const [first] = await h.coordinatorPosts(bot.id, 1);
    const coordinator = (
      first?.author.kind === 'coordinator' ? first.author.sessionId : ''
    ) as SessionId;
    const schedules = h.automations.forChannel(bot.id);
    expect(schedules).toEqual([
      expect.objectContaining({
        title: 'Morning brief',
        schedule: { kind: 'daily', time: MORNING_BRIEF_TIME },
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
    const brief = await vi.waitFor(
      () => {
        const post = h.posts(bot.id).find((candidate) => candidate.card?.kind === 'brief');
        expect(post).toBeDefined();
        return post;
      },
      { timeout: 5000 },
    );
    expect(brief?.author.kind).toBe('coordinator');
    expect(brief?.card).toMatchObject({
      kind: 'brief',
      todo: [{ title: 'Reply to Ana' }],
      done: [],
      decisions: [{ title: 'Archive last week’s newsletters' }],
    });
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
    await vi.waitFor(() => expect(h.automations.forChannel(bot.id)).toEqual([]));
  });

  it('协调者等批准：助理是 waiting，审批进 channel.get，收件箱与提醒带上助理', async () => {
    const h = await setup();
    const bot = await h.create('Mail desk', 'Sort my inbox.');
    await h.coordinatorPosts(bot.id, 1);
    h.service.post(
      { channelId: bot.id, content: [{ type: 'text', text: 'approve this send' }] },
      identity,
    );
    await vi.waitFor(
      async () => {
        const view = await h.methods['channel.get']({ channelId: bot.id }, context);
        expect(view.channel.state).toBe('waiting');
        expect(view.channel.pendingCount).toBe(1);
        expect(view.approvals).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
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
    await vi.waitFor(() => expect(assistantPosts(h, mail.id)).toHaveLength(1), { timeout: 5000 });
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
    await vi.waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(2), {
      timeout: 5000,
    });
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
    await vi.waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(3), {
      timeout: 5000,
    });
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
    await vi.waitFor(() => expect(assistantPosts(h, group.id)).toHaveLength(3), {
      timeout: 3000,
    });
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

  it('成员的预算用完：群里贴一条说明，带是哪个成员', async () => {
    const h = await setup({ budget: { dailyWakes: 1, dailyTokens: 1_000_000 } });
    const ann = await h.create('Ann', 'Calendar.');
    const bob = await h.create('Bob', 'Travel.');
    for (const bot of [ann, bob]) await h.coordinatorPosts(bot.id, 1);
    const { channel: group } = await h.methods['channel.create'](
      { kind: 'group', name: 'Weekly', members: [ann.id, bob.id] },
      context,
    );
    await h.methods['channel.post'](
      { channelId: group.id, content: [{ type: 'text', text: 'Plan the week' }] },
      context,
    );
    await vi.waitFor(
      () => {
        const notices = h
          .posts(group.id)
          .filter((post) => post.card?.kind === 'notice' && post.card.reason === 'budget');
        expect(
          notices.map((post) => post.card?.kind === 'notice' && post.card.assistantId).sort(),
        ).toEqual([ann.id, bob.id].sort());
      },
      { timeout: 5000 },
    );
    expect(assistantPosts(h, group.id)).toHaveLength(0);
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
    await vi.waitFor(() =>
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
    await vi.waitFor(
      async () => {
        const view = await h.methods['channel.get']({ channelId: bot.id }, context);
        expect(view.approvals).toHaveLength(1);
        expect(view.approvals[0]?.detail?.toolName).toBe('mcp__gmail__send_email');
        approvalId = view.approvals[0]?.id as string;
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() =>
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
