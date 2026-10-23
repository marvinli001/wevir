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

export type WakeReason = 'setup' | 'post' | 'schedule' | 'digest' | 'manual';

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
  tell: 'go ahead, then report it',
  ask: 'confirm first, showing the exact outgoing content',
  hand_off: 'prepare it only; the user does it',
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
  return `<post id="${post.id}" author="${author}" at="${post.createdAt}">${escapeText(postText(post))}</post>`;
}

export interface WakeInput {
  channel: Channel;
  reasons: ReadonlySet<WakeReason>;
  posts: readonly ChannelPost[];
  threads: readonly ChannelThread[];
  at: string;
  /** 建好后的第一次：本机有的连接器、授权的文件夹、有没有内置浏览器。 */
  setup?: { connectors: readonly string[]; folders: readonly string[]; browser: boolean };
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
    const { connectors, folders, browser } = input.setup;
    parts.push(
      `<setup>\nThis ${input.channel.kind} was just created. Work out what its job needs (connectors, folders, browser logins) and list what is missing.\n<inventory connectors="${attr(
        connectors.join(', ') || 'none',
      )}" folders="${attr(folders.join(', ') || 'none')}" browser="${browser ? 'yes' : 'no'}"/>\n</setup>`,
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

/** 助理的身份与规矩，交接材料与设置改动用。 */
export function identityBlock(channel: Channel): string {
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
    `<rules>\n${rules}\n- money transfers, trading, securities: never, even if the user agrees\n</rules>`,
    `<folders>${escapeText(folders)}</folders>`,
  ].join('\n');
}

/** 换班的交接材料（ADR-0020 §9）：每一班的第一条消息，后面紧跟这次的唤醒信封。 */
export function handover(
  channel: Channel,
  recent: readonly ChannelPost[],
  generation: number,
): string {
  const lines = recent.map(
    (post) =>
      `- #${post.seq} ${post.author.kind} ${post.createdAt.slice(0, 16)}: ${escapeText(firstLine(postText(post)) || '(card)')}`,
  );
  return [
    `<channel_handover channel="${attr(channel.title)}" kind="${channel.kind}" generation="${generation}">`,
    identityBlock(channel),
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
