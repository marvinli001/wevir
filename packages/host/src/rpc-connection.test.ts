import type {
  ChannelPost,
  PendingMessage,
  Session,
  UserContentPart,
  UserImagePart,
  WevirEventOf,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  adaptEventForClient,
  adaptResultForClient,
  channelNotificationForClient,
} from './rpc-connection.js';
import { identity, SES, T0 } from './test-utils.js';

// 按连接的能力位降级（host-api.md §10）。0.5.0：`TitleSource` 的 `generated` 只发给声明了 `title_source_generated`
// 的连接，其余连接看到 `first_prompt`；事件不扣下，seq 不变。

const titleEvent: WevirEventOf<'session.title_changed'> = {
  seq: 7,
  sessionId: SES,
  ts: T0,
  type: 'session.title_changed',
  source: 'host',
  payload: { title: '修复登录', source: 'generated', description: '登录 500' },
};

const session = (titleSource: Session['titleSource']): Session => ({
  id: SES,
  workspaceId: 'ws_1',
  cwd: '/w',
  engine: { kind: 'codex', sessionId: 'thread-1' },
  providerId: 'p',
  modelId: 'm',
  title: '修复登录',
  titleSource,
  state: 'idle',
  createdAt: T0,
  updatedAt: T0,
  lastSeq: 7,
});

describe('adaptEventForClient', () => {
  it('不认识 generated 的连接：降级成 first_prompt，其余不变', () => {
    expect(adaptEventForClient(titleEvent, {})).toEqual({
      ...titleEvent,
      payload: { ...titleEvent.payload, source: 'first_prompt' },
    });
    expect(adaptEventForClient(titleEvent, { title_source_generated: true })).toBe(titleEvent);
    const user = { ...titleEvent, payload: { title: 't', source: 'user' as const } };
    expect(adaptEventForClient(user, {})).toBe(user);
  });
});

describe('adaptResultForClient', () => {
  it('会话的结果（create / get / resume / list）里的 titleSource 一样降级', () => {
    expect(adaptResultForClient('session.create', { session: session('generated') }, {})).toEqual({
      session: session('first_prompt'),
    });
    expect(
      adaptResultForClient(
        'session.get',
        { session: session('generated'), pendingApprovals: [] },
        {},
      ),
    ).toEqual({ session: session('first_prompt'), pendingApprovals: [] });
    expect(
      adaptResultForClient(
        'session.list',
        { sessions: [session('generated'), session('user')] },
        {},
      ),
    ).toEqual({ sessions: [session('first_prompt'), session('user')] });
    const result = { session: session('generated') };
    expect(adaptResultForClient('session.resume', result, { title_source_generated: true })).toBe(
      result,
    );
    expect(adaptResultForClient('workspace.list', { workspaces: [] }, {})).toEqual({
      workspaces: [],
    });
  });
});

// 0.28.0：消息里的图片只发给声明了 `user_images` 的连接，其余连接看到文本 `[image]`，段数不变。
describe('user_images', () => {
  const image: UserImagePart = {
    type: 'image',
    imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR',
    mimeType: 'image/png',
    size: 10,
  };
  const content: UserContentPart[] = [{ type: 'text', text: '看' }, image];
  const downgraded: UserContentPart[] = [
    { type: 'text', text: '看' },
    { type: 'text', text: '[image]' },
  ];
  const message: WevirEventOf<'user.message'> = {
    seq: 3,
    sessionId: SES,
    ts: T0,
    type: 'user.message',
    source: 'host',
    payload: { turnId: 'trn_1', content, sentBy: identity },
  };
  const pending: PendingMessage = {
    id: 'pnd_1',
    content,
    delivery: 'queue',
    status: 'waiting',
    sentBy: identity,
    createdAt: T0,
    updatedAt: T0,
  };

  it('事件：user.message、user.steered、turn.started 的输入、pending.*', () => {
    expect(adaptEventForClient(message, { user_images: true })).toBe(message);
    expect(adaptEventForClient(message, {})).toEqual({
      ...message,
      payload: { ...message.payload, content: downgraded },
    });
    const steered: WevirEventOf<'user.steered'> = {
      ...message,
      type: 'user.steered',
      payload: { turnId: 'trn_1', pendingId: 'pnd_1', content, sentBy: identity },
    };
    expect(adaptEventForClient(steered, {})).toMatchObject({ payload: { content: downgraded } });
    const started: WevirEventOf<'turn.started'> = {
      ...message,
      type: 'turn.started',
      payload: { turnId: 'trn_1', input: content },
    };
    expect(adaptEventForClient(started, {})).toMatchObject({ payload: { input: downgraded } });
    const added: WevirEventOf<'pending.added'> = {
      ...message,
      type: 'pending.added',
      payload: { pending },
    };
    expect(adaptEventForClient(added, {})).toMatchObject({
      payload: { pending: { content: downgraded } },
    });
    // 没有图片的不动。
    const text: WevirEventOf<'user.message'> = {
      ...message,
      payload: { ...message.payload, content: [{ type: 'text', text: '看' }] },
    };
    expect(adaptEventForClient(text, {})).toBe(text);
  });

  it('结果：session.get 与 pending.* 里的待发消息', () => {
    const snapshot = { session: session('user'), pendingApprovals: [], pendingMessages: [pending] };
    expect(adaptResultForClient('session.get', snapshot, { title_source_generated: true })).toEqual(
      {
        ...snapshot,
        pendingMessages: [{ ...pending, content: downgraded }],
      },
    );
    expect(adaptResultForClient('pending.update', { pending }, {})).toEqual({
      pending: { ...pending, content: downgraded },
    });
    expect(adaptResultForClient('pending.resume', { pendingMessages: [pending] }, {})).toEqual({
      pendingMessages: [{ ...pending, content: downgraded }],
    });
    expect(adaptResultForClient('pending.update', { pending }, { user_images: true })).toEqual({
      pending,
    });
  });
});

// 0.72.0：超时自动回答的 `timeout` 只发给声明了 `question_timeout` 的连接，其余连接看到 `user`（回答照旧，没有 `answeredBy`）。
describe('question_timeout', () => {
  const resolution = { reason: 'timeout' as const, answers: { scope: { answers: ['全链路'] } } };
  const resolved: WevirEventOf<'question.resolved'> = {
    seq: 9,
    sessionId: SES,
    ts: T0,
    type: 'question.resolved',
    source: 'host',
    payload: { questionId: 'qst_1' as never, status: 'answered', resolution },
  };

  it('事件与 question.respond 的结果降级成 user', () => {
    expect(adaptEventForClient(resolved, {})).toEqual({
      ...resolved,
      payload: { ...resolved.payload, resolution: { ...resolution, reason: 'user' } },
    });
    expect(adaptEventForClient(resolved, { question_timeout: true })).toBe(resolved);
    const result = { questionId: 'qst_1' as never, status: 'answered' as const, resolution };
    expect(adaptResultForClient('question.respond', result, {})).toEqual({
      ...result,
      resolution: { ...resolution, reason: 'user' },
    });
    expect(adaptResultForClient('question.respond', result, { question_timeout: true })).toEqual(
      result,
    );
  });
});

// 0.118.0：展示类型 `image` 只发给声明了 `tool_display_image` 的连接，其余连接看到 `unknown`。
describe('tool_display_image', () => {
  const started: WevirEventOf<'tool.started'> = {
    seq: 9,
    sessionId: SES,
    ts: T0,
    type: 'tool.started',
    source: 'engine',
    payload: {
      turnId: 'trn_1' as never,
      toolCallId: 'ig1',
      toolName: 'imageGeneration',
      display: { kind: 'image' },
    },
  };
  const updated: WevirEventOf<'tool.updated'> = {
    ...started,
    seq: 10,
    type: 'tool.updated',
    payload: {
      turnId: 'trn_1' as never,
      toolCallId: 'ig1',
      display: { kind: 'image', summary: 'a fox' },
    },
  };

  it('tool.started 与 tool.updated 降级成 unknown，其余字段不变', () => {
    expect(adaptEventForClient(started, {})).toEqual({
      ...started,
      payload: { ...started.payload, display: { kind: 'unknown' } },
    });
    expect(adaptEventForClient(updated, {})).toEqual({
      ...updated,
      payload: { ...updated.payload, display: { kind: 'unknown', summary: 'a fox' } },
    });
    expect(adaptEventForClient(started, { tool_display_image: true })).toBe(started);
    expect(adaptEventForClient(updated, { tool_display_image: true })).toBe(updated);
  });
});

// 0.80.0：按审批规则自动允许的 `rule` 只发给声明了 `approval_rules` 的连接，其余连接看到 `user`（没有 `decidedBy`）。
describe('approval_rules', () => {
  const resolution = { reason: 'rule' as const, optionId: 'accept', ruleIds: ['arl_1' as never] };
  const resolved: WevirEventOf<'approval.resolved'> = {
    seq: 9,
    sessionId: SES,
    ts: T0,
    type: 'approval.resolved',
    source: 'host',
    payload: { approvalId: 'apr_1' as never, status: 'approved', resolution },
  };

  it('事件降级成 user', () => {
    expect(adaptEventForClient(resolved, {})).toEqual({
      ...resolved,
      payload: { ...resolved.payload, resolution: { ...resolution, reason: 'user' } },
    });
    expect(adaptEventForClient(resolved, { approval_rules: true })).toBe(resolved);
  });
});

describe('channel groups (0.133.0)', () => {
  const A = 'chn_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
  const G = 'chn_01JA2B3C4D5E6F7G8H9JKMNPG1' as const;
  const group = {
    id: G,
    kind: 'group' as const,
    title: 'Weekly',
    group: { members: [A] },
    state: 'idle' as const,
    lastPostSeq: 1,
    lastPost: { seq: 1, author: 'assistant' as const, assistantId: A, preview: 'Hi', at: T0 },
    createdAt: T0,
    updatedAt: T0,
  };
  const post = {
    id: 'cpo_01JA2B3C4D5E6F7G8H9JKMNPQR' as const,
    channelId: A,
    seq: 1,
    author: { kind: 'assistant' as const, channelId: A, name: 'Ann' },
    content: [{ type: 'text' as const, text: 'Hi' }],
    createdAt: T0,
  };

  it('older clients see no groups and get posts by other assistants as host posts', () => {
    const assistant = { ...group, id: A, kind: 'assistant' as const };
    expect(
      adaptResultForClient(
        'channel.list',
        { channels: [group, assistant], listVersion: 1 },
        {},
        '0.132.0',
      ),
    ).toEqual({
      channels: [
        {
          ...assistant,
          lastPost: { seq: 1, author: 'host', preview: 'Hi', at: T0 },
        },
      ],
      listVersion: 1,
    });
    expect(
      adaptResultForClient('channel.posts', { posts: [post], lastSeq: 1 }, {}, '0.132.0'),
    ).toEqual({
      posts: [{ ...post, author: { kind: 'host' } }],
      lastSeq: 1,
    });
    expect(
      channelNotificationForClient(
        'channels.changed',
        { listVersion: 2, upserted: [group], removed: [] },
        '0.132.0',
      ).upserted,
    ).toEqual([]);
    const posted = { subscriptionId: 'sub_01JA2B3C4D5E6F7G8H9JKMNPQR' as const, post };
    expect(channelNotificationForClient('channel.posted', posted, '0.132.0').post.author).toEqual({
      kind: 'host',
    });
    expect(channelNotificationForClient('channel.posted', posted, '0.133.0')).toBe(posted);
    expect(
      adaptResultForClient('channel.posts', { posts: [post], lastSeq: 1 }, {}, '0.133.0'),
    ).toEqual({
      posts: [post],
      lastSeq: 1,
    });
  });
});

describe('assistant notices', () => {
  const post = (card: ChannelPost['card']): ChannelPost => ({
    id: 'cpo_1' as ChannelPost['id'],
    channelId: 'chn_1' as ChannelPost['channelId'],
    seq: 1,
    author: { kind: 'host' },
    content: [{ type: 'text', text: 'notes/today.md' }],
    ...(card !== undefined && { card }),
    createdAt: '2026-10-28T00:00:00.000Z',
  });

  it('0.132.0 之前的客户端：规矩的三种说明去掉卡片只留文字，旧的说明照旧', () => {
    const acted = post({ kind: 'notice', reason: 'acted', category: 'local_files' });
    const failed = post({ kind: 'notice', reason: 'failed' });
    const result = { posts: [acted, failed], lastSeq: 2 };
    expect(adaptResultForClient('channel.posts', result, {}, '0.131.0')).toEqual({
      posts: [post(undefined), failed],
      lastSeq: 2,
    });
    expect(adaptResultForClient('channel.posts', result, {}, '0.132.0')).toEqual(result);
  });
});
