import { describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { approval, at, CHANNEL_A, channel, post, thread } from './bot-test-utils';
import {
  approvalView,
  type BotPost,
  botFromChannel,
  botPatch,
  botPostQuote,
  botProactivity,
  botReplyCount,
  botRoutineStatus,
  botTimeLabel,
  botTimelineRows,
  brainLimit,
  folderParts,
  groupPatch,
  postViews,
  showsBotQuote,
  sortBots,
  timelineViews,
} from './bots';

describe('助理聊天', () => {
  it('同作者不足五分钟成组，半小时或跨天分隔，卡片与不同说话者断组', () => {
    const views = [0, 1, 6, 36].flatMap((minute, i) =>
      postViews(post(CHANNEL_A, i + 1, { createdAt: at(minute) })),
    );
    expect(
      botTimelineRows(views).map(({ first, last, separator }) => [first, last, separator]),
    ).toEqual([
      [true, false, true],
      [false, true, false],
      [true, true, false],
      [true, true, true],
    ]);
    const midnight = [
      postViews(
        post(CHANNEL_A, 1, { createdAt: new Date(2026, 10, 16, 23, 59).toISOString() }),
      )[0] as BotPost,
      postViews(
        post(CHANNEL_A, 2, { createdAt: new Date(2026, 10, 17, 0, 1).toISOString() }),
      )[0] as BotPost,
    ];
    expect(botTimelineRows(midnight)[1]).toMatchObject({ first: true, separator: true });
    const speaker = {
      id: 'other',
      name: 'Other',
      avatar: { type: 'cloud' as const, color: 0, seed: 0 },
    };
    expect(
      botTimelineRows([views[0] as BotPost, { ...(views[1] as BotPost), speaker }])[1]?.first,
    ).toBe(true);
  });

  it('拆分帖子只显示一份引用与表情，并隐藏协调者默认的最近用户引用', () => {
    const root = post(CHANNEL_A, 1, {
      author: { kind: 'user' },
      content: [{ type: 'text', text: '原话\n下一行' }],
    });
    const answer = post(CHANNEL_A, 2, {
      replyTo: root.id,
      replyCount: 3,
      reactions: [{ emoji: '👀', by: 'user' }],
      files: [{ name: 'a', path: 'a', size: 1 }],
    });
    const views = postViews(answer);
    expect(views[0]).toMatchObject({
      sourceId: answer.id,
      seq: 2,
      replyTo: root.id,
      replyCount: 3,
    });
    expect(views[1]?.replyTo).toBeUndefined();
    expect(botPostQuote(root)).toBe('原话');
    expect(showsBotQuote(views[0] as BotPost, [root, answer])).toBe(false);
    expect(showsBotQuote({ ...(views[0] as BotPost), sourceId: root.id }, [root, answer])).toBe(
      true,
    );
  });

  it('时间分隔使用今天、昨天与跨年日期', () => {
    setLocale('en');
    expect(botReplyCount(1)).toBe('1 reply');
    expect(botReplyCount(2)).toBe('2 replies');
    setLocale('ru');
    expect(botReplyCount(2)).toBe('2 ответа');
    expect(botReplyCount(21)).toBe('21 ответ');
    expect(botReplyCount(12)).toBe('12 ответов');
    setLocale('zh-CN');
    const now = new Date(2026, 10, 17, 12);
    expect(botTimeLabel(new Date(2026, 10, 17, 9, 30).toISOString(), now)).toMatch(/^今天 .*9:30$/);
    expect(botTimeLabel(new Date(2026, 10, 16, 9, 30).toISOString(), now)).toMatch(/^昨天 /);
    expect(botTimeLabel(new Date(2025, 10, 16).toISOString(), now)).toContain('2025');
  });

  it('近期活动按事务时区推出日程、暂停、跨天与跨年', () => {
    setLocale('zh-CN');
    const base = { enabled: true, timezone: 'Pacific/Auckland' };
    const now = new Date('2026-11-16T23:00:00Z');
    const status = (schedule: Parameters<typeof botRoutineStatus>[0]['schedule']) =>
      botRoutineStatus({ ...base, schedule }, now);
    expect(status({ kind: 'daily', time: '09:30' })).toBe('每天 9:30');
    expect(status({ kind: 'daily', time: '09:30', weekdays: [5, 4, 3, 2, 1] })).toBe('工作日 9:30');
    expect(status({ kind: 'daily', time: '09:30', weekdays: [1] })).toContain('周一');
    expect(status({ kind: 'monthly', time: '09:30', day: 1 })).toBe('每月 1 日 9:30');
    expect(status({ kind: 'interval', minutes: 60 })).toBe('监控中');
    expect(status({ kind: 'once', at: '2026-11-17T03:00:00Z' })).toBe('今天 16:00');
    expect(status({ kind: 'once', at: '2026-11-17T20:00:00Z' })).toBe('明天 9:00');
    expect(status({ kind: 'once', at: '2027-01-01T03:00:00Z' })).toContain('2027');
    expect(botRoutineStatus({ ...base, enabled: false, schedule: { kind: 'manual' } }, now)).toBe(
      '已暂停',
    );
    expect(
      botRoutineStatus(
        { ...base, autoPausedAt: now.toISOString(), schedule: { kind: 'manual' } },
        now,
      ),
    ).toBe('已暂停');
    expect(botProactivity({ dailyWakes: 20, dailyTokens: 400_000 })).toBe('balanced');
    expect(botProactivity({ dailyWakes: 21, dailyTokens: 400_000 })).toBeUndefined();
  });
});

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
      answering: false,
    });
    expect(
      botFromChannel('mac', 'MacBook', channel(CHANNEL_A, { answering: true })).answering,
    ).toBe(true);
  });

  it('列表：等用户决定的在前，其余按最后动静', () => {
    const make = (id: string, minute: number, state: 'idle' | 'waiting' = 'idle') =>
      botFromChannel('mac', 'Mac', channel(CHANNEL_A, { title: id, state, createdAt: at(minute) }));
    const sorted = sortBots([make('a', 1), make('b', 5), make('c', 0, 'waiting')]);
    expect(sorted.map((b) => b.name)).toEqual(['c', 'b', 'a']);
  });

  it('opens deliveries against the posting coordinator or the author’s workspace in a group', () => {
    const files = [{ name: 'same.md', path: 'out/same.md', size: 20 }];
    const direct = post(CHANNEL_A, 1, { files });
    expect(postViews(direct).at(-1)?.card).toMatchObject({
      path: 'out/same.md',
      sessionId: direct.author.kind === 'coordinator' && direct.author.sessionId,
    });
    const member = channel(CHANNEL_A, { workspaceId: 'ws_member' });
    const groupPost = post(CHANNEL_A, 2, {
      author: { kind: 'assistant', channelId: member.id, name: member.title },
      files,
    });
    expect(postViews(groupPost, new Map([[member.id, member]])).at(-1)?.card).toMatchObject({
      path: 'out/same.md',
      workspaceId: 'ws_member',
    });
    expect(postViews(groupPost).at(-1)?.card).not.toHaveProperty('sessionId');
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
    );
    expect(views.map((v) => [v.author, v.card.kind])).toEqual([
      ['bot', 'images'],
      ['bot', 'text'],
      ['bot', 'needs'],
      ['bot', 'file'],
    ]);
    expect(views[0]?.card).toMatchObject({
      kind: 'images',
      images: [{ imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR', mimeType: 'image/png' }],
    });
    expect(views[1]?.card).toEqual({ kind: 'text', text: '需要这些：' });
    expect(views[3]?.card).toMatchObject({
      kind: 'file',
      path: 'out/plan.md',
      name: 'plan.md',
      size: 2048,
    });

    const notice = postViews(
      post(CHANNEL_A, 2, {
        author: { kind: 'host' },
        content: [{ type: 'text', text: '' }],
        card: { kind: 'notice', reason: 'failed' },
      }),
    );
    expect(notice).toEqual([
      expect.objectContaining({ author: 'host', card: { kind: 'notice', reason: 'failed' } }),
    ]);
    // 按规矩的说明：文字（做了或拦下的动作）并进说明，认不出的种类不带。
    const acted = postViews(
      post(CHANNEL_A, 5, {
        author: { kind: 'host' },
        content: [{ type: 'text', text: 'gmail · send_email\nslack · post' }],
        card: { kind: 'notice', reason: 'acted', category: 'messages' },
      }),
    );
    expect(acted).toEqual([
      expect.objectContaining({
        author: 'host',
        card: {
          kind: 'notice',
          reason: 'acted',
          category: 'messages',
          text: 'gmail · send_email\nslack · post',
        },
      }),
    ]);
    const unknown = postViews(
      post(CHANNEL_A, 6, {
        author: { kind: 'host' },
        content: [{ type: 'text', text: 'x' }],
        card: { kind: 'notice', reason: 'handed_off', category: 'teleport' },
      }),
    );
    expect(unknown[0]?.card).toEqual({ kind: 'notice', reason: 'handed_off', text: 'x' });
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
      options: approval().options,
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
        risk: { level: 'high', reasons: ['destructive_command'] },
      }),
      'approved',
    ).card;
    expect(shell).toEqual({
      kind: 'approval',
      options: approval().options,
      tool: 'Bash',
      text: 'rm -rf dist',
      risky: true,
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

  it.each([
    {
      cwd: '/Users/me/project',
      projectName: '控制台',
      project: '控制台',
      directory: '~/project',
    },
    {
      cwd: '/home/me/project/subdir',
      actualCwd: '/home/me/other',
      projectName: '控制台',
      project: '控制台',
      directory: '~/other',
    },
    {
      cwd: '/home/me/project',
      actualCwd: '/tmp/subdir',
      project: 'subdir',
      directory: '/tmp/subdir',
    },
    {
      cwd: 'C:\\Users\\me\\project',
      project: 'project',
      directory: '~\\project',
    },
  ])('审批元信息：$directory', ({ cwd, actualCwd, projectName, project, directory }) => {
    const request = approval({
      detail: {
        toolName: 'shell',
        display: {
          kind: 'shell',
          command: 'pwd',
          ...(actualCwd !== undefined && { cwd: actualCwd }),
        },
      },
    });
    expect(
      approvalView(request, 'pending', {
        cwd,
        ...(projectName !== undefined && { projectName }),
      }).card,
    ).toMatchObject({ location: { project, cwd: actualCwd ?? cwd, directory } });
  });

  it('截断的命令保留完整原文，未截断的命令不需要展开', () => {
    const command = `${'x'.repeat(4_000)}\nrm -rf dist`;
    const request = (text: string) =>
      approval({ detail: { toolName: 'shell', display: { kind: 'shell', command: text } } });
    expect(approvalView(request(command), 'pending').card).toMatchObject({
      text: `${command.slice(0, 4_000)}…`,
      fullText: command,
    });
    const short = command.slice(0, 4_000);
    const card = approvalView(request(short), 'pending').card;
    expect(card).toMatchObject({ text: short });
    expect(card).not.toHaveProperty('fullText');
  });

  it('时间线：线程挂在开它的帖子后面，审批按时间插入', () => {
    const posts = [post(CHANNEL_A, 1), post(CHANNEL_A, 2), post(CHANNEL_A, 3)];
    const elsewhere = post(CHANNEL_A, 99).id;
    const views = timelineViews({
      posts,
      threads: [
        thread(posts[0]?.id ?? elsewhere, { title: '挂在第一条' }),
        thread(elsewhere, { title: '根不在这页', createdAt: at(2) }),
      ],
      approvals: [approval(), approval({ id: 'apr_01JA2B3C4D5E6F7G8H9JKMNPQS' })],
      decided: [{ request: approval(), decision: 'approved' }],
      hasMore: false,
    });
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

  it('开在用户项目里的线程带项目名，项目不认识时不写', () => {
    const root = post(CHANNEL_A, 1);
    const views = timelineViews(
      {
        posts: [root],
        threads: [
          thread(root.id, { workspaceId: 'ws_site' as never }),
          thread(root.id, { workspaceId: 'ws_gone' as never, sessionId: 'ses_other' as never }),
        ],
        approvals: [],
        decided: [],
        hasMore: false,
      },
      new Map(),
      new Map([['ws_site', 'site']]),
    );
    expect(views.slice(1).map((v) => (v.card.kind === 'thread' ? v.card.project : null))).toEqual([
      'site',
      undefined,
    ]);
  });

  it('结掉的审批留在它提出时的位置，之后的帖子排在后面', () => {
    const posts = [post(CHANNEL_A, 1), post(CHANNEL_A, 5)];
    const views = timelineViews({
      posts,
      threads: [],
      approvals: [],
      decided: [{ request: approval({ createdAt: at(3) }), decision: 'rejected' }],
      hasMore: false,
    });
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

  it('规矩：改了档的交整份，认不出的种类原样留着；改回原来的档不算改', () => {
    const current = channel(CHANNEL_A, {
      assistant: {
        description: '邮件与日程',
        avatar: { type: 'cloud', color: 2, seed: 0.4 },
        rules: { messages: 'do', teleport: 'ask' },
        folders: [],
      },
    });
    const same = {
      name: '小管家',
      description: '邮件与日程',
      avatar: { type: 'cloud' as const, color: 2, seed: 0.4 },
      folders: [],
    };
    // publishing 没设过，默认是 ask。
    expect(botPatch(current, { ...same, rules: { messages: 'do', publishing: 'ask' } })).toBe(
      undefined,
    );
    expect(botPatch(current, { ...same, rules: { publishing: 'do', local_files: 'ask' } })).toEqual(
      { rules: { messages: 'do', teleport: 'ask', publishing: 'do', local_files: 'ask' } },
    );
  });

  it('群：名字与 2 到 8 个成员，改群只带变了的名字与整份成员', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(groupPatch(undefined, ' 周会 ', ['a', 'b'])).toEqual({
      name: '周会',
      members: ['a', 'b'],
    });
    expect(groupPatch(undefined, ' ', ['a', 'b'])).toBeUndefined();
    expect(groupPatch(undefined, '周会', ['a'])).toBeUndefined();
    expect(groupPatch(undefined, '周会', ids)).toBeUndefined();
    const group = channel(CHANNEL_A, {
      kind: 'group',
      title: '周会',
      group: { members: ['a', 'b'] as never },
    });
    expect(groupPatch(group, '周会', ['a', 'b'])).toBeUndefined();
    expect(groupPatch(group, '周会', ['b', 'a'])).toEqual({ members: ['b', 'a'] });
    expect(groupPatch(group, '例会', ['a', 'b', 'c'])).toEqual({
      name: '例会',
      members: ['a', 'b', 'c'],
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
