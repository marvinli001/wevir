// 助理（私人 bot）在手机上的数据形状。助理是电脑上的一个频道（kind: 'assistant'）：一条时间线、一个协调者、开出的线程与产物。
// 这里只留手机要画的部分；多台电脑的助理合并成一个列表，`key` 带电脑名区分。

import type { Avatar } from './bot-avatar';

/** 列表与详情里的状态：空闲、工作中、等用户决定、已暂停（用户暂停或预算用完）。 */
export type BotState = 'idle' | 'working' | 'waiting' | 'paused';

export interface Bot {
  /** `电脑名/助理 ID`，全 App 唯一。 */
  key: string;
  id: string;
  /** 所在电脑的配对记录名。 */
  computer: string;
  /** 所在电脑的显示名。 */
  computerName: string;
  name: string;
  /** 一句话：它负责什么。 */
  description: string;
  avatar: Avatar;
  state: BotState;
  unreadCount: number;
  lastPost?: { text: string; at: string };
  createdAt: string;
}

export type ThreadStatus = 'working' | 'waiting' | 'replied' | 'failed' | 'idle' | 'resolved';

export type ArtifactKind = 'file' | 'pr' | 'preview' | 'link';

export type NeedKind = 'connector' | 'folder' | 'login' | 'other';

export type ApprovalAction = 'email' | 'message' | 'post';

export type Decision = 'pending' | 'approved' | 'rejected';

/** 时间线上的一条：用户的话、助理的回答，或者一张卡片。 */
export type BotCard =
  | { kind: 'text'; text: string }
  | {
      kind: 'brief';
      /** 今日待办、昨晚完成、待决定。 */
      todo: readonly string[];
      done: readonly string[];
      decide: readonly string[];
    }
  | {
      kind: 'approval';
      action: ApprovalAction;
      /** 收件人、频道或平台。 */
      target: string;
      subject?: string;
      /** 将要发出的原文，原样展示。 */
      text: string;
      decision: Decision;
    }
  | {
      kind: 'thread';
      sessionId: string;
      title: string;
      project: string;
      status: ThreadStatus;
      /** 工作中时正在做的那项；回复后是最后一条回答的第一行。 */
      line?: string;
    }
  | { kind: 'artifact'; artifact: ArtifactKind; title: string; detail: string; url?: string }
  | {
      /** 建好后的第一条：要用的连接器、文件夹、浏览器登录，`ready` 已经有了。 */
      kind: 'needs';
      items: readonly { kind: NeedKind; label: string; ready: boolean; detail?: string }[];
    }
  | { kind: 'suggestion'; text: string; decision: Decision };

export interface BotPost {
  id: string;
  seq: number;
  author: 'user' | 'bot' | 'host';
  createdAt: string;
  card: BotCard;
}

export function botKey(computer: string, id: string): string {
  return `${computer}/${id}`;
}

/** 列表按最后动静排：等用户决定的在前，其余按最后一条的时间。 */
export function sortBots(bots: readonly Bot[]): Bot[] {
  const at = (bot: Bot) => Date.parse(bot.lastPost?.at ?? bot.createdAt) || 0;
  return [...bots].sort((a, b) => {
    const waiting = Number(b.state === 'waiting') - Number(a.state === 'waiting');
    return waiting !== 0 ? waiting : at(b) - at(a);
  });
}

/** 列表行的摘要：卡片取一句能看懂的话。 */
export function postPreview(card: BotCard): string {
  switch (card.kind) {
    case 'text':
    case 'suggestion':
      return card.text.replace(/\s+/g, ' ').trim();
    case 'brief':
      return card.todo[0] ?? card.decide[0] ?? card.done[0] ?? '';
    case 'approval':
      return card.subject ?? card.text.replace(/\s+/g, ' ').trim();
    case 'thread':
    case 'artifact':
      return card.title;
    case 'needs':
      return card.items.map((i) => i.label).join(' · ');
  }
}
