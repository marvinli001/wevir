import { describe, expect, it } from 'vitest';
import { approval, at, CHANNEL_A, channel, post, thread } from './bot-test-utils';
import {
  approvalView,
  botFromChannel,
  botPatch,
  brainLimit,
  folderParts,
  postViews,
  sortBots,
  timelineViews,
} from './bots';

describe('bots', () => {
  it('频道换成列表行', () => {
    const bot = botFromChannel(
      'mac',
      'MacBook',
      channel(CHANNEL_A, {
        unreadCount: 3,
        lastPost: { seq: 4, author: 'coordinator', preview: '日程已排好', at: at(4) },
      }),
    );
    expect(bot).toMatchObject({
      key: `mac/${CHANNEL_A}`,
      name: '小管家',
      description: '邮件与日程',
      avatar: { type: 'cloud', color: 2, seed: 0.4 },
      unreadCount: 3,
      lastPost: { text: '日程已排好', at: at(4) },
    });
  });

  it('列表：等用户决定的在前，其余按最后动静', () => {
    const make = (id: string, minute: number, state: 'idle' | 'waiting' = 'idle') =>
      botFromChannel('mac', 'Mac', channel(CHANNEL_A, { title: id, state, createdAt: at(minute) }));
    const sorted = sortBots([make('a', 1), make('b', 5), make('c', 0, 'waiting')]);
    expect(sorted.map((b) => b.name)).toEqual(['c', 'b', 'a']);
  });

  it('一条帖子拆成文字、卡片与文件', () => {
    const views = postViews(
      post(CHANNEL_A, 1, {
        content: [
          { type: 'text', text: '需要这些：' },
          {
            type: 'image',
            imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR',
            mimeType: 'image/png',
            size: 10,
          },
        ],
        card: { kind: 'needs', items: [{ kind: 'folder', label: '文稿', ready: false }] },
        files: [{ path: 'out/plan.md', name: 'plan.md', size: 2048 }],
      }),
      '图片',
    );
    expect(views.map((v) => [v.author, v.card.kind])).toEqual([
      ['bot', 'text'],
      ['bot', 'needs'],
      ['bot', 'file'],
    ]);
    expect(views[0]?.card).toEqual({ kind: 'text', text: '需要这些：\n\n[图片]' });
    expect(views[2]?.card).toEqual({ kind: 'file', name: 'plan.md', size: 2048 });

    const notice = postViews(
      post(CHANNEL_A, 2, {
        author: { kind: 'host' },
        content: [{ type: 'text', text: '' }],
        card: { kind: 'notice', reason: 'failed' },
      }),
      '图片',
    );
    expect(notice).toEqual([
      expect.objectContaining({ author: 'host', card: { kind: 'notice', reason: 'failed' } }),
    ]);
    const brief = postViews(
      post(CHANNEL_A, 3, {
        content: [{ type: 'text', text: '' }],
        card: {
          kind: 'brief',
          day: '2026-10-23',
          todo: [{ title: '回林的邮件' }],
          done: [],
          decisions: [{ title: '周五的会' }],
        },
      }),
      '图片',
    );
    expect(brief[0]?.card).toEqual({
      kind: 'brief',
      todo: ['回林的邮件'],
      done: [],
      decide: ['周五的会'],
    });
    const suggestion = postViews(
      post(CHANNEL_A, 4, {
        content: [{ type: 'text', text: '订机票' }],
        card: { kind: 'suggestion', text: '订机票', status: 'dismissed' },
      }),
      '图片',
    );
    expect(suggestion).toHaveLength(1);
    expect(suggestion[0]?.card).toEqual({
      kind: 'suggestion',
      text: '订机票',
      decision: 'rejected',
    });
  });

  it('审批：对外动作取收件人、主题与原文，认不出的参数原样列出', () => {
    expect(approvalView(approval(), 'pending').card).toEqual({
      kind: 'approval',
      tool: 'gmail · send_email',
      target: 'lin@example.com',
      subject: '周五的会',
      text: '改到下午三点，可以吗？',
      decision: 'pending',
    });
    const shell = approvalView(
      approval({
        detail: {
          toolName: 'Bash',
          display: { kind: 'shell', command: 'rm -rf dist' },
          input: { command: 'rm -rf dist' },
        },
      }),
      'approved',
    ).card;
    expect(shell).toEqual({
      kind: 'approval',
      tool: 'Bash',
      text: 'rm -rf dist',
      decision: 'approved',
    });
    const odd = approvalView(
      approval({ detail: { toolName: 'x', display: { kind: 'unknown' }, input: { n: 1 } } }),
      'pending',
    ).card;
    expect(odd).toMatchObject({ text: '{\n  "n": 1\n}' });
    expect(approvalView(approval({ detail: null }), 'pending').card).toMatchObject({
      tool: '',
      text: '',
    });
  });

  it('时间线：线程挂在开它的帖子后面，审批按时间插入', () => {
    const posts = [post(CHANNEL_A, 1), post(CHANNEL_A, 2), post(CHANNEL_A, 3)];
    const elsewhere = post(CHANNEL_A, 99).id;
    const views = timelineViews(
      {
        posts,
        threads: [
          thread(posts[0]?.id ?? elsewhere, { title: '挂在第一条' }),
          thread(elsewhere, { title: '根不在这页', createdAt: at(2) }),
        ],
        approvals: [approval(), approval({ id: 'apr_01JA2B3C4D5E6F7G8H9JKMNPQS' })],
        decided: [{ request: approval(), decision: 'approved' }],
        hasMore: false,
      },
      '图片',
    );
    expect(views.map((v) => (v.card.kind === 'text' ? v.card.text : v.card.kind))).toEqual([
      '#1',
      'thread',
      '#2',
      'thread',
      '#3',
      'approval',
      'approval',
    ]);
    expect(views.at(-2)?.card).toMatchObject({ decision: 'approved' });
    expect(views.at(-1)?.card).toMatchObject({ decision: 'pending' });
  });

  it('结掉的审批留在它提出时的位置，之后的帖子排在后面', () => {
    const posts = [post(CHANNEL_A, 1), post(CHANNEL_A, 5)];
    const views = timelineViews(
      {
        posts,
        threads: [],
        approvals: [],
        decided: [{ request: approval({ createdAt: at(3) }), decision: 'rejected' }],
        hasMore: false,
      },
      '图片',
    );
    expect(views.map((v) => v.card.kind)).toEqual(['text', 'approval', 'text']);
  });

  it('编辑：只带变了的字段，换模型时清掉推理强度', () => {
    const current = channel(CHANNEL_A, {
      coordinator: { providerId: 'prov_1' as never, modelId: 'a', mode: 'act', generation: 1 },
    });
    const same = {
      name: '小管家',
      description: '邮件与日程',
      avatar: { type: 'cloud' as const, color: 2, seed: 0.4 },
      folders: [],
    };
    expect(botPatch(current, same)).toBeUndefined();
    expect(
      botPatch(current, { ...same, name: ' ', model: { providerId: 'prov_1', modelId: 'a' } }),
    ).toBe(undefined);
    expect(
      botPatch(current, {
        ...same,
        name: '大管家 ',
        avatar: { type: 'drop', color: 1, seed: 0.2 },
        folders: ['/Users/me/web'],
        model: { providerId: 'prov_1', modelId: 'b' },
      }),
    ).toEqual({
      name: '大管家',
      avatar: { type: 'drop', color: 1, seed: 0.2 },
      folders: ['/Users/me/web'],
      coordinator: { providerId: 'prov_1', modelId: 'b', reasoningEffort: null },
    });
  });

  it('文件夹的名字与上一级目录', () => {
    expect(folderParts('/Users/me/code/web/')).toEqual({ name: 'web', parent: '~/code' });
    expect(folderParts('/srv/data')).toEqual({ name: 'data', parent: '/srv' });
    expect(folderParts('/data')).toEqual({ name: 'data', parent: '' });
    expect(folderParts('C:\\work\\api')).toEqual({ name: 'api', parent: 'C:\\work' });
  });

  it('群：成员取同一台电脑上的助理，摘要与帖子带说话的助理', () => {
    const ann = channel(CHANNEL_A, { title: 'Ann' });
    const group = channel('chn_01JA2B3C4D5E6F7G8H9JKMNPG1' as never, {
      kind: 'group',
      title: '周会',
      group: { members: [CHANNEL_A, 'chn_01JA2B3C4D5E6F7G8H9JKMNPZZ' as never] },
      lastPost: { seq: 2, author: 'assistant', assistantId: CHANNEL_A, preview: '好了', at: at(2) },
    });
    const directory = new Map([
      [ann.id, ann],
      [group.id, group],
    ]);
    const bot = botFromChannel('mac', 'Mac', group, directory);
    expect(bot.kind).toBe('group');
    expect(bot.members.map((member) => member.name)).toEqual(['Ann']);
    expect(bot.lastPost?.text).toBe('Ann: 好了');
    const [view] = postViews(
      post(group.id, 2, {
        author: { kind: 'assistant', channelId: CHANNEL_A, name: 'Old name' },
        content: [{ type: 'text', text: '好了' }],
      }),
      'Image',
      directory,
    );
    expect(view).toMatchObject({ author: 'bot', speaker: { id: CHANNEL_A, name: 'Ann' } });
  });
});

describe('brainLimit', () => {
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
    expect(brainLimit({ grok: plain }, 'grok')).toBe('plugins');
  });
});
