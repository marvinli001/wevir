// 频道交给协调者与线程的文字（ADR-0020 §4–§6、§9）：唤醒信封、换班的交接材料、转给线程的帖子。都是 Host 写的、给模型看的，
// 用英文；用户的原话由 Host 原样抄进来（尖括号转义，文件或命令输出里照抄的标签冒充不了）。开闭标签带同一个随机 id。
//
// 这些文字会原样进 echo 引擎的回答（测试里），所以 Host 自己写的部分避开 echo 认的触发词（见 runtime-adapter/src/echo.ts）。

import { randomBytes } from 'node:crypto';
import type {
  AssistantRuleTier,
  Channel,
  ChannelPost,
  ChannelThread,
  UserContentPart,
} from '@wevir/protocol';

/** `message` 别的助理发来消息，`reply` 别的助理回了这个助理发出的消息（0.133.0）。 */
export type WakeReason = 'setup' | 'post' | 'schedule' | 'digest' | 'manual' | 'message' | 'reply';

/** 换班的交接材料带最近多少条帖子。 */
export const HANDOVER_POSTS = 30;
/** 信封里的线程概况最多几行。 */
export const ENVELOPE_THREADS_MAX = 10;

export function envelopeId(): string {
  return randomBytes(6).toString('hex');
}

/** 正文里的 `&`、`<`、`>` 转义，属性值另外转义引号。 */
export function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function attr(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

/** 帖子的文字（图片记作 `[image]`）。 */
export function postText(post: Pick<ChannelPost, 'content'>): string {
  return post.content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
    .trim();
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const chars = Array.from(line.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

const TIER_WORDS: Record<AssistantRuleTier, string> = {
  do: 'go ahead',
  tell: 'go ahead; Wevir tells the user afterwards',
  ask: 'confirm first: Wevir asks the user before it runs',
  hand_off: 'prepare it only; Wevir declines it and the user does it',
};

/** 线程概况：每次唤醒都带，≤ `ENVELOPE_THREADS_MAX` 行。 */
export function threadsBlock(threads: readonly ChannelThread[]): string {
  const open = threads.filter((thread) => thread.status !== 'resolved');
  const waiting = open.filter((thread) => thread.status === 'waiting').length;
  const lines = open.slice(0, ENVELOPE_THREADS_MAX).map((thread) => {
    const detail =
      thread.status === 'working'
        ? thread.doing
        : thread.status === 'replied' || thread.status === 'idle'
          ? thread.lastReply?.firstLine
          : undefined;
    return `- [${escapeText(thread.title || 'Untitled')}](wevir://session/${thread.sessionId}) ${thread.status}${
      detail === undefined || detail === '' ? '' : `: ${escapeText(detail)}`
    }`;
  });
  if (open.length > lines.length) lines.push(`- (${open.length - lines.length} more)`);
  return `<threads open="${open.length}" waiting="${waiting}">${lines.length > 0 ? `\n${lines.join('\n')}\n` : ''}</threads>`;
}

function postBlock(post: ChannelPost): string {
  const author = post.author.kind;
  const from = post.author.kind === 'assistant' ? ` from="${attr(post.author.name)}"` : '';
  return `<post id="${post.id}" author="${author}"${from} at="${post.createdAt}">${escapeText(postText(post))}</post>`;
}

/** 协调者能用的：它的引擎注入的连接器与 skills、有没有内置浏览器。 */
export interface WakeInventory {
  connectors: readonly string[];
  skills: readonly string[];
  browser: boolean;
  /** 本机启用了、协调者的引擎却不注入的连接器与 skills（OpenCode 等没有 `mcpServers` / `skills`）。 */
  unavailable?: { engine: string; connectors: readonly string[]; skills: readonly string[] };
}

function names(list: readonly string[]): string {
  return attr(list.join(', ') || 'none');
}

/** 清单之后的一句与 `<unavailable>`：引擎不支持的不算就绪。 */
function unavailableBlock(inventory: WakeInventory): string {
  const missing = inventory.unavailable;
  if (missing === undefined) return '';
  return `\nYour engine (${attr(missing.engine)}) cannot use the unavailable connectors and skills below: do not count them as ready or plan on them, and list them as unavailable with this brain.\n<unavailable engine="${attr(missing.engine)}" connectors="${names(missing.connectors)}" skills="${names(missing.skills)}"/>`;
}

export interface WakeInput {
  channel: Channel;
  reasons: ReadonlySet<WakeReason>;
  posts: readonly ChannelPost[];
  threads: readonly ChannelThread[];
  at: string;
  /** 建好后的第一次：协调者能用的、授权的文件夹，助理自己的工作文件夹。 */
  setup?: WakeInventory & {
    folders: readonly string[];
    workspace?: string;
  };
  /** 换了大脑（Provider）之后的第一次：新的引擎能用的。 */
  brain?: WakeInventory;
  /** 定时唤醒：自动化的标题与指令。 */
  schedules?: readonly { title: string; prompt: string; brief?: boolean }[];
  /** 线程动态的汇总。 */
  digest?: string;
  /** 自上一次唤醒以来用户改了的设置（身份、规矩、文件夹）。 */
  changed?: string;
  /** 晨间简报（0.121.0）：Host 组装的卡片内容，协调者的回答接在卡片上面。 */
  brief?: {
    todo: readonly BriefLine[];
    done: readonly BriefLine[];
    decisions: readonly BriefLine[];
  };
}

type BriefLine = { title: string };

function briefBlock(brief: NonNullable<WakeInput['brief']>): string {
  const list = (name: string, items: readonly BriefLine[]) =>
    items.length === 0
      ? `<${name}/>`
      : `<${name}>\n${items.map((item) => `- ${escapeText(item.title)}`).join('\n')}\n</${name}>`;
  return [
    '<brief>',
    'Wevir shows these lists as a card under your answer. Write two or three lines on what matters today; do not repeat the lists.',
    list('todo', brief.todo),
    list('done_last_24h', brief.done),
    list('waiting_on_user', brief.decisions),
    '</brief>',
  ].join('\n');
}

/** 唤醒信封（ADR-0020 §6）：只带新事件，图片随后附上。 */
export function wakeEnvelope(input: WakeInput, id = envelopeId()): UserContentPart[] {
  const reason = [...input.reasons].join(' ');
  const parts: string[] = [
    `<channel_wake id="${id}" reason="${reason}" channel="${attr(input.channel.title)}" at="${input.at}">`,
  ];
  if (input.changed !== undefined) parts.push(input.changed);
  if (input.setup !== undefined) {
    const { connectors, skills, folders, browser, workspace } = input.setup;
    const own =
      workspace === undefined
        ? ''
        : `\nYour working folder ${workspace} is already set up and is where your sessions run: keep your files there and count it as ready; only extra folders of the user's need granting.`;
    parts.push(
      `<setup>\nThis ${input.channel.kind} was just created. Work out what its job needs (connectors, folders, browser logins) and list what is missing.${own}\n<inventory connectors="${names(connectors)}" skills="${names(skills)}"${workspace === undefined ? '' : ` working_folder="${attr(workspace)}"`} folders="${names(folders)}" browser="${browser ? 'yes' : 'no'}"/>${unavailableBlock(input.setup)}\n</setup>`,
    );
  } else if (input.brain !== undefined) {
    const { connectors, skills, browser } = input.brain;
    parts.push(
      `<brain_changed>\nThe user switched you to another model provider. This is what you can use now; if it changes what you listed as ready or missing, say so.\n<inventory connectors="${names(connectors)}" skills="${names(skills)}" browser="${browser ? 'yes' : 'no'}"/>${unavailableBlock(input.brain)}\n</brain_changed>`,
    );
  }
  for (const schedule of input.schedules ?? []) {
    parts.push(
      `<schedule title="${attr(schedule.title)}"${schedule.brief === true ? ' brief="true"' : ''}>${escapeText(schedule.prompt)}</schedule>`,
    );
  }
  if (input.brief !== undefined) parts.push(briefBlock(input.brief));
  for (const post of input.posts) parts.push(postBlock(post));
  parts.push(threadsBlock(input.threads));
  if (input.digest !== undefined && input.digest !== '') parts.push(input.digest);
  parts.push(`</channel_wake id="${id}">`);
  const images = input.posts.flatMap((post) =>
    post.content.filter((part) => part.type === 'image'),
  );
  return [{ type: 'text', text: parts.join('\n') }, ...images];
}

/** 助理的身份与规矩，交接材料与设置改动用；`workspace` 是助理自己的工作文件夹。 */
export function identityBlock(channel: Channel, workspace?: string): string {
  const assistant = channel.assistant;
  if (assistant === undefined) return `<channel name="${attr(channel.title)}"/>`;
  const rules = Object.entries(assistant.rules)
    .map(([category, tier]) => `- ${category}: ${TIER_WORDS[tier] ?? tier}`)
    .join('\n');
  const folders = assistant.folders.length > 0 ? assistant.folders.join(', ') : 'none';
  return [
    `<assistant name="${attr(channel.title)}">`,
    escapeText(assistant.description || '(no job description yet)'),
    '</assistant>',
    `<rules>\n${rules}\n- money transfers, trading, securities: never, even if the user agrees; Wevir declines them\n</rules>`,
    ...(workspace === undefined
      ? []
      : [`<working_folder>${escapeText(workspace)}</working_folder>`]),
    `<folders>${escapeText(folders)}</folders>`,
  ].join('\n');
}

/** 换班的交接材料（ADR-0020 §9）：每一班的第一条消息，后面紧跟这次的唤醒信封。 */
export function handover(
  channel: Channel,
  recent: readonly ChannelPost[],
  generation: number,
  workspace?: string,
): string {
  const lines = recent.map(
    (post) =>
      `- #${post.seq} ${post.author.kind} ${post.createdAt.slice(0, 16)}: ${escapeText(firstLine(postText(post)) || '(card)')}`,
  );
  return [
    `<channel_handover channel="${attr(channel.title)}" kind="${channel.kind}" generation="${generation}">`,
    identityBlock(channel, workspace),
    lines.length > 0
      ? `<recent_posts count="${lines.length}">\n${lines.join('\n')}\n</recent_posts>`
      : '<recent_posts count="0"/>',
    '</channel_handover>',
  ].join('\n');
}

/** 转给线程的帖子（ADR-0020 §4）：只有 `cited author="user"` 是用户的话，`note` 是协调者的说明。 */
export function relayEnvelope(
  cited: readonly ChannelPost[],
  note: string | undefined,
  id = envelopeId(),
): UserContentPart[] {
  const parts = [`<channel_relay id="${id}" trust="relay">`];
  for (const post of cited) {
    parts.push(
      `<cited author="user" post="${post.id}" at="${post.createdAt}">${escapeText(postText(post))}</cited>`,
    );
  }
  if (note !== undefined && note.trim() !== '') {
    parts.push(`<note author="coordinator">${escapeText(note.trim())}</note>`);
  }
  parts.push(`</channel_relay id="${id}">`);
  const images = cited.flatMap((post) => post.content.filter((part) => part.type === 'image'));
  return [{ type: 'text', text: parts.join('\n') }, ...images];
}

/** 群里的一个成员（信封的成员表）。 */
export interface GroupMemberLine {
  id: string;
  name: string;
  job: string;
  self: boolean;
}

/**
 * 群的唤醒信封（0.133.0）：群名、成员表（带职责，`self` 是收信的这个助理）与它上次看过之后的新帖。回答发进群，所以只带群里的事，
 * 不带这个助理自己的线程概况。成员表的名字前不加 `@`：echo 会原样复述信封，加了就等于每条回答都 @ 了全体。
 */
export function groupWakeEnvelope(
  input: {
    group: Pick<Channel, 'id' | 'title'>;
    members: readonly GroupMemberLine[];
    posts: readonly ChannelPost[];
    /** 这次是被 @ 了（还是群里的新发言）。 */
    mentioned: boolean;
    at: string;
  },
  id = envelopeId(),
): UserContentPart[] {
  const members = input.members.map(
    (member) =>
      `- ${escapeText(member.name)}${member.self ? ' (you)' : ''}: ${escapeText(firstLine(member.job) || 'no job description')}`,
  );
  const parts = [
    `<group_wake id="${id}" group="${attr(input.group.title)}" reason="${input.mentioned ? 'mentioned' : 'new_post'}" at="${input.at}">`,
    `<members>\n${members.join('\n')}\n</members>`,
    ...input.posts.map(postBlock),
    `</group_wake id="${id}">`,
  ];
  const images = input.posts.flatMap((post) =>
    post.content.filter((part) => part.type === 'image'),
  );
  return [{ type: 'text', text: parts.join('\n') }, ...images];
}
