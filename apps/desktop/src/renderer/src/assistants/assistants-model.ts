// 助理页的纯逻辑（0.120.0，Host 功能 `channels`；日程 0.121.0，`channel_schedules`；群 0.132.0，`channel_groups`）：功能门控、列表行的
// 状态与排序、头像的随机与换一个、时间线的合并（新帖、改了的帖子、翻页）、`channels.changed` 与 `channel.updated` 的套用、审批要发出的
// 原文、群里的 @。不碰 DOM 与 Host。

import type { ChannelsChange, ChannelUpdate } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import {
  type ApprovalRequest,
  ASSISTANT_AVATAR_COLOR_COUNT,
  ASSISTANT_AVATAR_TYPES,
  type AssistantAvatar,
  type BoardTask,
  type Channel,
  type ChannelPost,
  type ChannelThread,
  type HostFeatures,
  type MethodParams,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';
import { formatJson } from '@/session/format';

// ---- 编辑 ----

/** 编辑框里的值；`model` 只在用户换过模型时有。 */
export interface AssistantEdit {
  name: string;
  job: string;
  avatar: AssistantAvatar;
  folders: readonly string[];
  model?: { providerId: string; modelId: string; reasoningEffort?: string };
}

/**
 * 编辑助理时发给 `channel.update` 的改动：只带变了的字段；名字为空时不改名。模型换了时三项一起给（没有的推理强度用 `null` 清掉）。
 * 什么都没变时返回 undefined。
 */
export function assistantPatch(
  channel: Channel,
  edit: AssistantEdit,
): Omit<MethodParams<'channel.update'>, 'channelId'> | undefined {
  const assistant = channel.assistant;
  const name = edit.name.trim();
  const job = edit.job.trim();
  const patch: Omit<MethodParams<'channel.update'>, 'channelId'> = {};
  if (name !== '' && name !== channel.title) patch.name = name;
  if (assistant !== undefined) {
    if (job !== assistant.description) patch.description = job;
    const avatar = assistant.avatar;
    if (
      avatar.type !== edit.avatar.type ||
      avatar.color !== edit.avatar.color ||
      avatar.seed !== edit.avatar.seed
    )
      patch.avatar = edit.avatar;
    if (
      edit.folders.length !== assistant.folders.length ||
      edit.folders.some((folder, index) => folder !== assistant.folders[index])
    )
      patch.folders = [...edit.folders];
  }
  const model = edit.model;
  const coordinator = channel.coordinator;
  if (
    model !== undefined &&
    coordinator !== undefined &&
    (model.providerId !== coordinator.providerId ||
      model.modelId !== coordinator.modelId ||
      model.reasoningEffort !== coordinator.reasoningEffort)
  ) {
    patch.coordinator = {
      providerId: model.providerId,
      modelId: model.modelId,
      reasoningEffort: model.reasoningEffort ?? null,
    };
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

// ---- 功能门控 ----

export type AssistantsAvailability = 'pending' | 'unsupported' | 'ready';

export function assistantsAvailability(features: HostFeatures | undefined): AssistantsAvailability {
  if (features === undefined) return 'pending';
  return hostSupports(features, 'channels') ? 'ready' : 'unsupported';
}

/** 助理之间与助理群（0.132.0）。 */
export function groupsSupported(features: HostFeatures | undefined): boolean {
  return features !== undefined && hostSupports(features, 'channel_groups');
}

/** 助理的日程与晨间简报（0.121.0）。 */
export function schedulesSupported(features: HostFeatures | undefined): boolean {
  return features !== undefined && hostSupports(features, 'channel_schedules');
}

// ---- 列表 ----

/** 列表行的状态：Host 的 `waiting` 在界面上是“待处理”（有审批或提问等用户）。 */
export type AssistantRowState = 'idle' | 'working' | 'needsYou' | 'paused';

export function rowState(channel: Pick<Channel, 'state'>): AssistantRowState {
  return channel.state === 'waiting' ? 'needsYou' : channel.state;
}

export const ROW_STATE_LABEL: Record<AssistantRowState, PlainMessageKey> = {
  idle: 'assistants.state.idle',
  working: 'assistants.state.working',
  needsYou: 'assistants.state.needsYou',
  paused: 'assistants.state.paused',
};

/** 助理与群，最近有动静的在前：最后一条帖子的时刻，没有帖子时用更新时刻。 */
export function sortAssistants(channels: readonly Channel[]): Channel[] {
  const at = (channel: Channel) => channel.lastPost?.at ?? channel.updatedAt;
  return [...channels]
    .filter((channel) => channel.kind === 'assistant' || channel.kind === 'group')
    .sort((a, b) => at(b).localeCompare(at(a)) || a.title.localeCompare(b.title));
}

/** 套用一条 `channels.changed`；版本不是上次加一时返回 undefined（要重读）。 */
export function applyListChange(
  current: { channels: Channel[]; listVersion: number },
  change: ChannelsChange,
): { channels: Channel[]; listVersion: number } | undefined {
  if (change.listVersion !== current.listVersion + 1) return undefined;
  const removed = new Set<string>([...change.removed, ...change.upserted.map((item) => item.id)]);
  return {
    channels: [...current.channels.filter((item) => !removed.has(item.id)), ...change.upserted],
    listVersion: change.listVersion,
  };
}

// ---- 群 ----

/** 按 ID 找助理（群里帖子的头像与名字、成员表）。 */
export function assistantsById(channels: readonly Channel[] | undefined): Map<string, Channel> {
  return new Map(
    (channels ?? [])
      .filter((channel) => channel.kind === 'assistant')
      .map((channel) => [channel.id, channel]),
  );
}

/** 群的成员（列表里还在的助理，按成员顺序）。 */
export function groupMembers(group: Channel, assistants: ReadonlyMap<string, Channel>): Channel[] {
  return (group.group?.members ?? []).flatMap((id) => {
    const member = assistants.get(id);
    return member === undefined ? [] : [member];
  });
}

/** 列表行的摘要：别的助理写的前面带它的名字。 */
export function previewLine(channel: Channel, assistants: ReadonlyMap<string, Channel>): string {
  const last = channel.lastPost;
  if (last === undefined) return '';
  if (last.author !== 'assistant' || last.assistantId === undefined) return last.preview;
  const name = assistants.get(last.assistantId)?.title;
  return name === undefined ? last.preview : `${name}: ${last.preview}`;
}

/** 输入框里光标前正在打的 `@名字`：返回 `@` 的位置与已打的部分；不在 @ 里时 undefined。 */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return undefined;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return undefined;
  const query = before.slice(at + 1);
  if (/\s/.test(query) || query.length > 40) return undefined;
  return { start: at, query };
}

/** 正文里 `@名字` 提到的成员（同 Host 的认法：不分大小写，名字后面不能紧跟字母或数字）。 */
export function mentionedIn(text: string, members: readonly Channel[]): Channel['id'][] {
  return members
    .filter((member) => {
      const escaped = member.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
    })
    .map((member) => member.id);
}

// ---- 头像 ----

export function randomAvatar(random: () => number = Math.random): AssistantAvatar {
  const type =
    ASSISTANT_AVATAR_TYPES[Math.floor(random() * ASSISTANT_AVATAR_TYPES.length)] ?? 'pebble';
  return {
    type,
    color: Math.min(
      ASSISTANT_AVATAR_COLOR_COUNT - 1,
      Math.floor(random() * ASSISTANT_AVATAR_COLOR_COUNT),
    ),
    seed: Math.round(random() * 1000) / 1000,
  };
}

/** 换一个：形状或颜色至少变一样。 */
export function rerollAvatar(
  current: AssistantAvatar,
  random: () => number = Math.random,
): AssistantAvatar {
  for (let i = 0; i < 8; i++) {
    const next = randomAvatar(random);
    if (next.type !== current.type || next.color !== current.color) return next;
  }
  return { ...current, color: (current.color + 1) % ASSISTANT_AVATAR_COLOR_COUNT };
}

// ---- 时间线 ----

export function postText(post: Pick<ChannelPost, 'content'>): string {
  return post.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim();
}

/** 并进新帖或改了的帖子（同一个 `id` 换掉），按 `seq` 升序。 */
export function mergePosts(
  current: readonly ChannelPost[],
  incoming: readonly ChannelPost[],
): ChannelPost[] {
  if (incoming.length === 0) return current as ChannelPost[];
  const byId = new Map(current.map((post) => [post.id, post]));
  for (const post of incoming) byId.set(post.id, post);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** 助理视图的数据（`channel.get` 加时间线）。 */
export interface AssistantView {
  channel: Channel;
  threads: ChannelThread[];
  approvals: ApprovalRequest[];
  tasks: BoardTask[];
  posts: ChannelPost[];
  /** 更早的帖子还有没有（往前翻页）。 */
  hasOlder: boolean;
}

export function applyUpdate(view: AssistantView, update: ChannelUpdate): AssistantView {
  return {
    ...view,
    ...(update.channel !== undefined && { channel: update.channel }),
    ...(update.threads !== undefined && { threads: update.threads }),
    ...(update.approvals !== undefined && { approvals: update.approvals }),
    ...(update.tasks !== undefined && { tasks: update.tasks }),
    ...(update.posts !== undefined && { posts: mergePosts(view.posts, update.posts) }),
  };
}

/** 线程挂在哪条帖子下面：根帖 ID → 线程（新的在前）。 */
export function threadsByRoot(threads: readonly ChannelThread[]): Map<string, ChannelThread[]> {
  const map = new Map<string, ChannelThread[]>();
  for (const thread of threads) {
    const list = map.get(thread.rootPostId) ?? [];
    list.push(thread);
    map.set(thread.rootPostId, list);
  }
  return map;
}

/** 时间线上最后一条协调者或 Host 的帖子（标已读用）。 */
export function lastReadable(posts: readonly ChannelPost[]): number {
  return posts.at(-1)?.seq ?? 0;
}

// ---- 审批 ----

/** 常见的“要发出的正文”字段（发消息、发帖、写邮件的工具）。 */
const OUTGOING_FIELDS = ['text', 'message', 'body', 'content', 'subject', 'to', 'channel'] as const;

/**
 * 审批卡片上要发出的原文：工具输入里的正文字段原样列出（字段名加冒号，正文不改一个字）；认不出时是整个输入的 JSON。没有输入时
 * 用引擎给的命令或摘要。
 */
export function outgoingText(approval: Pick<ApprovalRequest, 'detail'>): string {
  const detail = approval.detail;
  if (detail === null) return '';
  const input = detail.input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const fields = OUTGOING_FIELDS.filter((field) => typeof record[field] === 'string');
    if (fields.length > 0 && fields.some((field) => field !== 'to' && field !== 'channel')) {
      return fields.map((field) => `${field}: ${record[field] as string}`).join('\n');
    }
  }
  if (input !== undefined) return formatJson(input).text;
  return (detail.display.command ?? detail.display.summary ?? '').trim();
}

// ---- 任务 ----

/** 任务页签的分组：进行中与待办在上，完成与取消的在下。 */
export function groupTasks(tasks: readonly BoardTask[]): {
  open: BoardTask[];
  done: BoardTask[];
} {
  const order: Record<BoardTask['status'], number> = {
    in_progress: 0,
    pending: 1,
    completed: 2,
    cancelled: 3,
  };
  const sorted = [...tasks].sort(
    (a, b) => order[a.status] - order[b.status] || a.createdAt.localeCompare(b.createdAt),
  );
  return {
    open: sorted.filter((task) => task.status === 'pending' || task.status === 'in_progress'),
    done: sorted.filter((task) => task.status === 'completed' || task.status === 'cancelled'),
  };
}
