import type { ApprovalRequest, BoardTask, Channel, ChannelPost } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  applyListChange,
  applyUpdate,
  assistantPatch,
  assistantsAvailability,
  assistantsById,
  brainLimit,
  groupMembers,
  groupTasks,
  mentionedIn,
  mentionQuery,
  mergePosts,
  outgoingText,
  postText,
  previewLine,
  randomAvatar,
  rerollAvatar,
  rowState,
  schedulesSupported,
  sortAssistants,
  threadsByRoot,
} from './assistants-model';

const AT = '2026-10-24T08:00:00.000Z';

function channel(patch: Partial<Channel> = {}): Channel {
  return {
    id: 'chn_1' as never,
    kind: 'assistant',
    workspaceId: 'ws_1' as never,
    title: 'Mail desk',
    assistant: {
      description: 'Sort my inbox.',
      avatar: { type: 'pebble', color: 0, seed: 0.5 },
      rules: {},
      folders: [],
    },
    coordinator: { providerId: 'mock' as never, mode: 'act', generation: 1 },
    budget: { dailyWakes: 20, dailyTokens: 200_000 },
    state: 'idle',
    lastPostSeq: 0,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

function post(seq: number, text: string, patch: Partial<ChannelPost> = {}): ChannelPost {
  return {
    id: `cpo_${seq}` as never,
    channelId: 'chn_1' as never,
    seq,
    author: { kind: 'user' },
    content: [{ type: 'text', text }],
    createdAt: AT,
    ...patch,
  };
}

function task(id: string, status: BoardTask['status'], createdAt = AT): BoardTask {
  return {
    id,
    subject: id,
    status,
    blockedBy: [],
    notes: [],
    createdBy: 'ses_1' as never,
    createdAt,
    updatedAt: createdAt,
  };
}

/** 依次返回给定的数，用完从头再来。 */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

describe('功能门控', () => {
  it('没读到功能表时等，没有 channels 时不支持', () => {
    expect(assistantsAvailability(undefined)).toBe('pending');
    expect(assistantsAvailability({} as never)).toBe('unsupported');
    expect(assistantsAvailability({ channels: true } as never)).toBe('ready');
    expect(schedulesSupported({ channels: true } as never)).toBe(false);
    expect(schedulesSupported({ channel_schedules: true } as never)).toBe(true);
  });
});

describe('大脑的引擎', () => {
  const codex = { engine: 'codex', mcpServers: true, skills: true, appTools: true, commands: [] };
  const opencode = {
    engine: 'opencode',
    mcpServers: false,
    skills: false,
    appTools: true,
    commands: [],
  };
  const plain = { engine: 'plain', mcpServers: false, skills: false, commands: [] };
  it('挂不上 Wevir 工具的不能当大脑，不注入连接器或 skills 的提示，旧 Host 不提示', () => {
    const features = { 'openai-compatible': codex, opencode, grok: plain };
    expect(brainLimit(features, 'openai-compatible')).toBeUndefined();
    expect(brainLimit(features, 'opencode')).toBe('plugins');
    expect(brainLimit(features, 'grok')).toBe('tools');
    expect(brainLimit(undefined, 'opencode')).toBeUndefined();
    expect(brainLimit(features, undefined)).toBeUndefined();
    // 只有 echo 这类都挂不上的 Host：Host 不查，只提示连接器与 skills。
    expect(brainLimit({ grok: plain }, 'grok')).toBe('plugins');
  });
});

describe('列表', () => {
  it('Host 的 waiting 是“待处理”，其余原样', () => {
    expect(rowState({ state: 'waiting' })).toBe('needsYou');
    expect(rowState({ state: 'working' })).toBe('working');
    expect(rowState({ state: 'paused' })).toBe('paused');
  });

  it('最近有帖子的在前，只列助理', () => {
    const quiet = channel({ id: 'chn_a' as never, title: 'A' });
    const recent = channel({
      id: 'chn_b' as never,
      title: 'B',
      lastPost: { seq: 3, author: 'coordinator', preview: 'Hi', at: '2026-10-24T09:00:00.000Z' },
    });
    const project = channel({
      id: 'chn_c' as never,
      kind: 'project',
      updatedAt: '2027-01-01T00:00:00.000Z',
    });
    expect(sortAssistants([quiet, project, recent]).map((item) => item.title)).toEqual(['B', 'A']);
  });

  it('版本连续时套用变化，不连续时要重读', () => {
    const a = channel({ id: 'chn_a' as never, title: 'A' });
    const b = channel({ id: 'chn_b' as never, title: 'B' });
    const current = { channels: [a, b], listVersion: 4 };
    const renamed = { ...a, title: 'A2' };
    expect(
      applyListChange(current, { listVersion: 5, upserted: [renamed], removed: [b.id] }),
    ).toEqual({ channels: [renamed], listVersion: 5 });
    expect(applyListChange(current, { listVersion: 7, upserted: [], removed: [] })).toBeUndefined();
  });
});

describe('头像', () => {
  it('随机抽形状、颜色与 seed', () => {
    expect(randomAvatar(sequence(0.99, 0.5, 0.1234))).toEqual({
      type: 'cloud',
      color: 3,
      seed: 0.123,
    });
  });

  it('换一个时形状或颜色至少变一样', () => {
    const current = { type: 'pebble', color: 0, seed: 0 } as const;
    // 第一次抽到同一个，第二次才不同。
    expect(rerollAvatar(current, sequence(0, 0, 0.2, 0.2, 0.5, 0.3))).toMatchObject({
      type: 'clover',
      color: 3,
    });
    // 一直抽到同一个：换颜色。
    expect(rerollAvatar(current, () => 0)).toEqual({ ...current, color: 1 });
  });
});

describe('时间线', () => {
  it('文字是各段文字，图片不算', () => {
    expect(
      postText({
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', mimeType: 'image/png', data: '' } as never,
          { type: 'text', text: 'there ' },
        ],
      }),
    ).toBe('Hello\n\nthere');
  });

  it('并进新帖与改了的帖子，按 seq 排好、不重复', () => {
    const merged = mergePosts([post(2, 'b'), post(3, 'c')], [post(1, 'a'), post(3, 'c2')]);
    expect(merged.map((item) => `${item.seq}${postText(item)}`)).toEqual(['1a', '2b', '3c2']);
  });

  it('channel.updated 只换给出的部分', () => {
    const view = {
      channel: channel(),
      threads: [],
      approvals: [],
      tasks: [task('t1', 'pending')],
      posts: [post(1, 'a')],
      hasOlder: false,
    };
    const next = applyUpdate(view, {
      channel: channel({ state: 'working' }),
      posts: [post(1, 'a', { routedTo: ['ses_9' as never] })],
    });
    expect(next.channel.state).toBe('working');
    expect(next.tasks).toBe(view.tasks);
    expect(next.posts[0]?.routedTo).toEqual(['ses_9']);
  });

  it('线程按根帖分组', () => {
    const thread = (sessionId: string, rootPostId: string) => ({ sessionId, rootPostId }) as never;
    const map = threadsByRoot([thread('s1', 'p1'), thread('s2', 'p2'), thread('s3', 'p1')]);
    expect(map.get('p1')?.map((item: { sessionId: string }) => item.sessionId)).toEqual([
      's1',
      's3',
    ]);
  });
});

describe('审批要发出的原文', () => {
  const approval = (input: unknown): Pick<ApprovalRequest, 'detail'> => ({
    detail: { toolName: 'send', display: { kind: 'other', summary: 'Send mail' } as never, input },
  });

  it('正文字段原样列出', () => {
    expect(
      outgoingText(approval({ to: 'ana@example.com', subject: 'Hi', body: 'Line 1\nLine 2' })),
    ).toBe('body: Line 1\nLine 2\nsubject: Hi\nto: ana@example.com');
  });

  it('认不出时是整个输入的 JSON，没有输入时是摘要', () => {
    expect(outgoingText(approval({ path: '/tmp/a' }))).toContain('"path": "/tmp/a"');
    expect(outgoingText(approval(undefined))).toBe('Send mail');
    expect(outgoingText({ detail: null })).toBe('');
  });
});

describe('任务分组', () => {
  it('进行中在前、待办其次，完成与取消的另一组', () => {
    const { open, done } = groupTasks([
      task('a', 'pending', '2026-10-24T01:00:00.000Z'),
      task('b', 'completed'),
      task('c', 'in_progress', '2026-10-24T02:00:00.000Z'),
      task('d', 'cancelled'),
    ]);
    expect(open.map((item) => item.id)).toEqual(['c', 'a']);
    expect(done.map((item) => item.id)).toEqual(['b', 'd']);
  });
});

describe('assistantPatch', () => {
  const base = channel();
  const same = {
    name: 'Mail desk',
    job: 'Sort my inbox.',
    avatar: { type: 'pebble' as const, color: 0, seed: 0.5 },
    folders: [],
  };

  it('没变时不发', () => {
    expect(assistantPatch(base, same)).toBeUndefined();
    expect(assistantPatch(base, { ...same, name: '  Mail desk ', job: ' Sort my inbox. ' })).toBe(
      undefined,
    );
  });

  it('只带变了的字段，空名字不改名', () => {
    expect(
      assistantPatch(base, {
        ...same,
        name: ' ',
        job: 'Watch the calendar.',
        avatar: { type: 'drop', color: 3, seed: 0.1 },
        folders: ['/Users/me/Notes'],
      }),
    ).toEqual({
      description: 'Watch the calendar.',
      avatar: { type: 'drop', color: 3, seed: 0.1 },
      folders: ['/Users/me/Notes'],
    });
    expect(assistantPatch(base, { ...same, name: 'Inbox' })).toEqual({ name: 'Inbox' });
  });

  it('换模型时三项一起给，没有的推理强度清掉', () => {
    const current = channel({
      coordinator: {
        providerId: 'mock' as never,
        modelId: 'a',
        reasoningEffort: 'high',
        mode: 'act',
        generation: 1,
      },
    });
    expect(
      assistantPatch(current, {
        ...same,
        model: { providerId: 'mock', modelId: 'a', reasoningEffort: 'high' },
      }),
    ).toBeUndefined();
    expect(
      assistantPatch(current, { ...same, model: { providerId: 'mock', modelId: 'b' } }),
    ).toEqual({ coordinator: { providerId: 'mock', modelId: 'b', reasoningEffort: null } });
  });
});

describe('群', () => {
  const ann = channel({ id: 'chn_ann' as never, title: 'Ann' });
  const bob = channel({ id: 'chn_bob' as never, title: 'Bob Lee' });
  const group = channel({
    id: 'chn_grp' as never,
    kind: 'group',
    title: 'Weekly',
    group: { members: ['chn_ann' as never, 'chn_gone' as never, 'chn_bob' as never] },
    lastPost: {
      seq: 3,
      author: 'assistant',
      assistantId: 'chn_bob' as never,
      preview: 'Done',
      at: AT,
    },
  });

  it('列表里有群；成员按顺序，已删的跳过；摘要带作者名', () => {
    expect(sortAssistants([ann, group]).map((item) => item.id)).toContain('chn_grp');
    const byId = assistantsById([ann, bob, group]);
    expect([...byId.keys()]).toEqual(['chn_ann', 'chn_bob']);
    expect(groupMembers(group, byId).map((member) => member.title)).toEqual(['Ann', 'Bob Lee']);
    expect(previewLine(group, byId)).toBe('Bob Lee: Done');
  });

  it('@ 的输入与认人', () => {
    expect(mentionQuery('hi @An', 6)).toEqual({ start: 3, query: 'An' });
    expect(mentionQuery('mail@host', 9)).toBeUndefined();
    expect(mentionQuery('@Ann done', 9)).toBeUndefined();
    expect(mentionedIn('@bob lee and @Annie', [ann, bob])).toEqual(['chn_bob']);
    expect(mentionedIn('@Ann, please', [ann, bob])).toEqual(['chn_ann']);
  });
});
