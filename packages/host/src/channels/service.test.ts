// 频道与助理（0.120.0）：echo 引擎跑通建助理、发帖唤醒协调者、换班、预算、线程、列表与订阅的通知。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HostId, NotificationIntent } from '@wevir/protocol';
import {
  ASSISTANT_AVATAR_COLOR_COUNT,
  ASSISTANT_AVATAR_TYPES,
  type ChannelId,
  ChannelPostSchema,
  ChannelSchema,
  type ClientIdentity,
  DEFAULT_ASSISTANT_RULES,
  type SessionId,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTools } from '../app-tools.js';
import { AutomationService } from '../automations/service.js';
import { EventStore } from '../event-store.js';
import { createHostMethods } from '../host-methods.js';
import { InboxService } from '../inbox.js';
import { NotificationService } from '../notifications.js';
import { SessionManager } from '../session-manager.js';
import { boardEventTasks, TaskBoardStore } from '../task-board.js';
import { identity, useStorages, useTempDir } from '../test-utils.js';
import { AssistantFolders } from './assistants.js';
import {
  ChannelService,
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

async function setup(options: { budget?: { dailyWakes: number; dailyTokens: number } } = {}) {
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
  const create = async (name: string, description: string) =>
    (
      await methods['channel.create'](
        {
          kind: 'assistant',
          name,
          description,
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
    }
    const textA = setupA?.content[0]?.type === 'text' ? setupA.content[0].text : '';
    expect(textA).toContain('Sort my inbox every morning.');
    expect(textA).not.toContain('travel bookings');

    // 工作区与会话都藏起来。
    expect((await h.methods['workspace.list']({}, context)).workspaces).toEqual([]);
    expect((await h.methods['session.list']({}, context)).sessions).toEqual([]);
    const listed = (await h.methods['channel.list']({}, context)).channels;
    expect(listed.map((channel) => channel.id).sort()).toEqual([first.id, second.id].sort());
    const workspace = h.storage.workspaces.get(first.workspaceId);
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
    expect(channel?.channel.coordinator.generation).toBe(2);
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
    expect(h.tools.instructions(coordinator)).toContain('coordinator of a Wevir assistant');

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
    expect(h.tools.instructions(thread)).toContain('thread of a Wevir channel');
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
