// 样例数据：电脑上的助理接口合入之前，助理页签从这里读。两台电脑、四个助理，第一个助理的时间线有全部六种卡片和几天的旧消息
// （往上翻能加载）。接口合入后换成各台电脑的连接，删掉本文件。

import { randomAvatar } from '../lib/bot-avatar';
import type { BotEvent, BotSource, NewBot } from '../lib/bot-store';
import { type Bot, type BotCard, type BotPost, botKey, postPreview } from '../lib/bots';

const MINUTE = 60_000;

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Draft = { author: BotPost['author']; minutesAgo: number; card: BotCard };

const text = (author: BotPost['author'], minutesAgo: number, value: string): Draft => ({
  author,
  minutesAgo,
  card: { kind: 'text', text: value },
});

/** 前几天的来回，凑够几页旧消息。 */
function history(days: number): Draft[] {
  const pairs: [string, string][] = [
    ['明天上午有什么安排？', '9:30 站会，11:00 与 Lena 对发布清单，下午空着。'],
    ['把上周的会议纪要发给我', '已整理成一份文档，放在产物里了。'],
    ['帮我盯一下 PR #471 的 CI', '好的，跑完会告诉你结果。'],
    ['CI 怎么样了？', '全部通过，已经可以合并。'],
    ['周末天气如何？', '周六晴，周日下午有雨。'],
    ['提醒我周五交报销', '已记下，周五上午 10 点提醒。'],
  ];
  const drafts: Draft[] = [];
  for (let day = days; day >= 1; day--) {
    pairs.forEach(([ask, answer], i) => {
      const at = day * 24 * 60 - i * 40;
      drafts.push(text('user', at, ask), text('bot', at - 2, answer));
    });
  }
  return drafts;
}

const BUTLER: Draft[] = [
  ...history(3),
  {
    author: 'bot',
    minutesAgo: 190,
    card: {
      kind: 'brief',
      todo: ['10:00 移动端改版评审', '回复 Lena 关于发布日期的邮件', '15:00 前提交报销'],
      done: ['Codex 跑完依赖升级，测试全部通过', '整理了昨晚的 12 封未读邮件'],
      decide: ['是否接受周四 14:00 的会议邀请'],
    },
  },
  text('user', 52, '帮我回一下 Lena，发布定在下周二。'),
  text('bot', 51, '草拟好了，发出前过目一下：'),
  {
    author: 'bot',
    minutesAgo: 51,
    card: {
      kind: 'approval',
      action: 'email',
      target: 'lena@studio.example',
      subject: 'Re: 发布日期',
      text: 'Lena 你好，\n\n发布定在下周二（10 月 28 日）。周一下午会把候选版本发给测试组，有问题随时联系。\n\n谢谢！',
      decision: 'pending',
    },
  },
  text('user', 30, '顺便看看昨晚的迁移为什么失败'),
  text('bot', 29, '开了一个线程让 Codex 去查，结论出来后告诉你。'),
  {
    author: 'bot',
    minutesAgo: 29,
    card: {
      kind: 'thread',
      sessionId: 'ses_fixture_migration',
      title: '排查数据库迁移失败',
      project: 'wevir',
      status: 'working',
      line: '正在读 0026_channels 的迁移日志',
    },
  },
  {
    author: 'bot',
    minutesAgo: 12,
    card: {
      kind: 'artifact',
      artifact: 'file',
      title: '周报 · 第 43 周.md',
      detail: 'wevir · 2.4 KB',
    },
  },
  {
    author: 'bot',
    minutesAgo: 11,
    card: {
      kind: 'artifact',
      artifact: 'pr',
      title: 'Fix migration ordering',
      detail: 'marvinli001/wevir #482',
      url: 'https://github.com/marvinli001/wevir/pull/482',
    },
  },
  {
    author: 'bot',
    minutesAgo: 4,
    card: {
      kind: 'suggestion',
      text: '周四下午没有安排，要不要把评审的准备材料整理成一页？',
      decision: 'pending',
    },
  },
];

const WATCHER: Draft[] = [
  text('bot', 300, '依赖检查：3 个包有新版本，其中 expo 是补丁更新。'),
  text('user', 280, '升级 expo，跑一遍测试'),
  {
    author: 'bot',
    minutesAgo: 279,
    card: {
      kind: 'thread',
      sessionId: 'ses_fixture_expo',
      title: '升级 expo 到 58.0.18',
      project: 'wevir',
      status: 'working',
      line: '正在跑 pnpm test',
    },
  },
  text('bot', 3, 'CI 第 2 次重跑中，上一次是网络超时。'),
];

const READER: Draft[] = [
  text('user', 3000, '每周日晚上把读过的文章整理一下'),
  text('bot', 2990, '好的，每周日 21:00 整理一份摘要。'),
  {
    author: 'bot',
    minutesAgo: 1440,
    card: { kind: 'artifact', artifact: 'file', title: '本周摘要.md', detail: '7 篇 · 3.1 KB' },
  },
  text('bot', 1439, '本周摘要好了：7 篇，重点是两篇关于本地优先同步的文章。'),
];

const TRAVEL: Draft[] = [
  text('bot', 4400, '上海往返东京的机票降到 2,180 元，比上周低 12%。'),
  {
    author: 'bot',
    minutesAgo: 4390,
    card: { kind: 'suggestion', text: '要不要设一个 2,000 元以下的提醒？', decision: 'approved' },
  },
  text('host', 4300, '已暂停：今日预算用完'),
];

interface FixtureBot {
  bot: Omit<Bot, 'key' | 'lastPost'>;
  drafts: Draft[];
}

const FIXTURES: FixtureBot[] = [
  {
    bot: {
      id: 'chn_fixture_butler',
      computer: 'fixture-macbook',
      computerName: 'MacBook Pro',
      name: '小管家',
      description: '邮件、日程与每天的晨间简报',
      avatar: { type: 'pebble', color: 0, seed: 0.12 },
      state: 'waiting',
      unreadCount: 2,
      createdAt: ago(10 * 24 * 60),
    },
    drafts: BUTLER,
  },
  {
    bot: {
      id: 'chn_fixture_watcher',
      computer: 'fixture-macbook',
      computerName: 'MacBook Pro',
      name: '代码巡检',
      description: '盯着仓库的 CI 与依赖更新',
      avatar: { type: 'drop', color: 2, seed: 0.47 },
      state: 'working',
      unreadCount: 1,
      createdAt: ago(8 * 24 * 60),
    },
    drafts: WATCHER,
  },
  {
    bot: {
      id: 'chn_fixture_reader',
      computer: 'fixture-studio',
      computerName: 'Mac Studio',
      name: '读书笔记',
      description: '整理读过的文章，每周一份摘要',
      avatar: { type: 'cloud', color: 4, seed: 0.81 },
      state: 'idle',
      unreadCount: 0,
      createdAt: ago(20 * 24 * 60),
    },
    drafts: READER,
  },
  {
    bot: {
      id: 'chn_fixture_travel',
      computer: 'fixture-studio',
      computerName: 'Mac Studio',
      name: '旅行规划',
      description: '机票价格提醒与行程安排',
      avatar: { type: 'pill', color: 5, seed: 0.33 },
      state: 'paused',
      unreadCount: 0,
      createdAt: ago(30 * 24 * 60),
    },
    drafts: TRAVEL,
  },
];

export function createFixtureSource(): BotSource {
  const bots = new Map<string, Bot>();
  const posts = new Map<string, BotPost[]>();
  const listeners = new Set<(event: BotEvent) => void>();
  let ids = 0;
  const emit = (event: BotEvent) => {
    for (const listener of listeners) listener(event);
  };

  const add = (key: string, author: BotPost['author'], card: BotCard, createdAt: string) => {
    const list = posts.get(key) ?? [];
    const post: BotPost = {
      id: `cpo_fixture_${++ids}`,
      seq: (list[list.length - 1]?.seq ?? 0) + 1,
      author,
      createdAt,
      card,
    };
    posts.set(key, [...list, post]);
    return post;
  };

  for (const { bot, drafts } of FIXTURES) {
    const key = botKey(bot.computer, bot.id);
    for (const draft of drafts) add(key, draft.author, draft.card, ago(draft.minutesAgo));
    const last = posts.get(key)?.at(-1);
    bots.set(key, {
      ...bot,
      key,
      lastPost: last && { text: postPreview(last.card), at: last.createdAt },
    });
  }

  const need = (key: string) => {
    const list = posts.get(key);
    if (list === undefined) throw new Error(`no bot ${key}`);
    return list;
  };

  return {
    async list() {
      await delay(150);
      return [...bots.values()];
    },
    async posts(key, beforeSeq, limit) {
      await delay(beforeSeq === undefined ? 120 : 600);
      const list = need(key).filter((p) => beforeSeq === undefined || p.seq < beforeSeq);
      return { posts: list.slice(-limit), hasMore: list.length > limit };
    },
    async post(key, value) {
      await delay(120);
      const post = add(key, 'user', { kind: 'text', text: value }, new Date().toISOString());
      const bot = bots.get(key);
      if (bot !== undefined && bot.state !== 'paused') {
        const working = { ...bot, state: 'working' as const };
        bots.set(key, working);
        setTimeout(() => emit({ kind: 'bot', bot: working }), 300);
        setTimeout(() => {
          const reply = add(key, 'bot', { kind: 'text', text: '收到。' }, new Date().toISOString());
          bots.set(key, { ...working, state: 'idle' });
          emit({ kind: 'post', key, post: reply });
          emit({ kind: 'bot', bot: { ...(bots.get(key) as Bot) } });
        }, 2000);
      }
      return post;
    },
    async decide(key, postId, decision) {
      await delay(200);
      const list = need(key);
      const index = list.findIndex((p) => p.id === postId);
      const post = list[index];
      if (
        post === undefined ||
        (post.card.kind !== 'approval' && post.card.kind !== 'suggestion')
      ) {
        throw new Error(`no decision on ${postId}`);
      }
      const updated: BotPost = { ...post, card: { ...post.card, decision } };
      posts.set(
        key,
        list.map((p) => (p.id === postId ? updated : p)),
      );
      const bot = bots.get(key);
      if (bot?.state === 'waiting') {
        bots.set(key, { ...bot, state: 'idle' });
        emit({ kind: 'bot', bot: { ...bot, state: 'idle' } });
      }
      return updated;
    },
    async markRead(key) {
      const bot = bots.get(key);
      if (bot !== undefined) bots.set(key, { ...bot, unreadCount: 0 });
    },
    async create(input: NewBot) {
      await delay(300);
      const computerName =
        [...bots.values()].find((b) => b.computer === input.computer)?.computerName ??
        input.computer;
      const id = `chn_fixture_${Date.now().toString(36)}`;
      const key = botKey(input.computer, id);
      posts.set(key, []);
      add(
        key,
        'bot',
        { kind: 'text', text: `${input.name}已就绪。开始之前需要这些：` },
        new Date().toISOString(),
      );
      const first = add(
        key,
        'bot',
        {
          kind: 'needs',
          items: [
            { kind: 'folder', label: '可访问的文件夹', ready: false, detail: '至少一个' },
            { kind: 'connector', label: '邮箱连接器', ready: false },
            { kind: 'login', label: '浏览器登录', ready: true },
          ],
        },
        new Date().toISOString(),
      );
      const bot: Bot = {
        key,
        id,
        computer: input.computer,
        computerName,
        name: input.name,
        description: input.description,
        avatar: input.avatar ?? randomAvatar(),
        state: 'idle',
        unreadCount: 2,
        lastPost: { text: postPreview(first.card), at: first.createdAt },
        createdAt: first.createdAt,
      };
      bots.set(key, bot);
      return bot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
