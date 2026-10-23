// 频道与助理（0.120.0，Host 功能 `channels`，ADR-0020，domain-model §3.53）：一条时间线 + 一个常驻的协调者 + 一组线程。
// 用户在时间线上发帖，Host 把帖子装进唤醒信封交给协调者会话；协调者回合的最后一段回答就是它的帖子（以 `NOTHING_TO_REPORT`
// 结尾表示不开口）。协调者会话到阈值换班（`generation + 1`），时间线存在 Host 里，换班用户看不出来。
//
// 助理（`kind: 'assistant'`）是不绑定项目、带身份与规矩的频道：隐藏工作区 `<数据目录>/assistants/<频道 ID>`（`Workspace.kind:
// 'assistant'`），记忆用它的 `project` 作用域，协调者默认 `act`（自己做小事）。现在只开放建助理；项目频道（`project`）以后开放。

import { z } from 'zod';
import {
  ChannelIdSchema,
  ChannelPostIdSchema,
  IsoTimeSchema,
  ProviderIdSchema,
  SessionIdSchema,
  SubscriptionIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  ApprovalRequestSchema,
  BoardTaskSchema,
  BoardTaskStatusSchema,
  SharedFileSchema,
  UserContentPartSchema,
} from './entities.js';

/** 协调者回合的回答以这一行结尾（或只有这一行）时不开口：Host 去掉这行，没有别的字就不发帖（同自动化）。 */
export const CHANNEL_QUIET_MARKER = 'NOTHING_TO_REPORT';

/** 助理名字、说明与帖子摘要的长度上限（按码点）。 */
export const ASSISTANT_NAME_MAX_LENGTH = 40;
export const ASSISTANT_DESCRIPTION_MAX_LENGTH = 500;
export const CHANNEL_POST_PREVIEW_MAX_LENGTH = 200;
/** 一条帖子的文字最多多少字符（超出的截断）。 */
export const CHANNEL_POST_TEXT_MAX_LENGTH = 20_000;
/** `channel.posts` 一页最多几条。 */
export const CHANNEL_POSTS_PAGE_MAX = 200;
/** 助理能访问的文件夹（除隐藏工作区外）最多几个。 */
export const ASSISTANT_FOLDERS_MAX = 7;

/**
 * 助理头像的形状（与子会话同一套 bot-avatars：桌面 `session/avatar.ts` 的 `AVATAR_TYPES`）。建助理时 Host 从形状 × 颜色里随机抽一个，
 * 客户端可以换一个再建；存进身份，桌面与手机画同一个。
 */
export const ASSISTANT_AVATAR_TYPES = [
  'pebble',
  'clover',
  'drop',
  'pill',
  'circle',
  'cloud',
] as const;
/** 头像颜色的个数：`color` 是桌面 `AVATAR_COLORS` 浅色、深色两组里的序号。 */
export const ASSISTANT_AVATAR_COLOR_COUNT = 6;

export const AssistantAvatarSchema = z.object({
  type: z.enum(ASSISTANT_AVATAR_TYPES),
  color: z
    .int()
    .min(0)
    .max(ASSISTANT_AVATAR_COLOR_COUNT - 1),
  /** bot-avatars 的 seed（0–1）：错开眨眼与张望。 */
  seed: z.number().min(0).max(1),
});
export type AssistantAvatar = z.infer<typeof AssistantAvatarSchema>;

/**
 * 助理一类动作的规矩：`do` 直接做；`tell` 做完告诉用户；`ask` 先展示要做的事（对外动作是将要发出的原文）、等用户批准；`hand_off`
 * 交给用户做（只准备好内容）。转账、交易、证券操作是硬禁止，不在这里，任何档都不做。
 */
export const AssistantRuleTierSchema = z.enum(['do', 'tell', 'ask', 'hand_off']);
export type AssistantRuleTier = z.infer<typeof AssistantRuleTierSchema>;

/**
 * 动作的种类：`messages` 发消息与邮件；`publishing` 发帖、公开发布；`purchases` 下单付款；`deletions` 删除（文件、邮件、记录）；
 * `shared_edits` 改共享的文档与日历；`local_files` 改本机文件（助理工作区与授权的文件夹）。
 */
export const ASSISTANT_RULE_CATEGORIES = [
  'messages',
  'publishing',
  'purchases',
  'deletions',
  'shared_edits',
  'local_files',
] as const;
export const AssistantRuleCategorySchema = z.enum(ASSISTANT_RULE_CATEGORIES);
export type AssistantRuleCategory = z.infer<typeof AssistantRuleCategorySchema>;

/** 每类动作一档；线缆上是开放的键，认不出的种类原样保留。 */
export const AssistantRulesSchema = z.record(z.string().min(1).max(40), AssistantRuleTierSchema);
export type AssistantRules = z.infer<typeof AssistantRulesSchema>;

/** 新助理的规矩：对外的一律先问，本机文件做完告诉。 */
export const DEFAULT_ASSISTANT_RULES: Readonly<Record<AssistantRuleCategory, AssistantRuleTier>> = {
  messages: 'ask',
  publishing: 'ask',
  purchases: 'hand_off',
  deletions: 'ask',
  shared_edits: 'ask',
  local_files: 'tell',
};

/** 助理的身份与规矩（`Channel.assistant`）。名字就是频道的 `title`。 */
export const AssistantSchema = z.object({
  /** 它负责什么，一两句话；也是它第一步“我需要什么”的依据。 */
  description: z.string().max(ASSISTANT_DESCRIPTION_MAX_LENGTH),
  avatar: AssistantAvatarSchema,
  rules: AssistantRulesSchema,
  /** 用户授权它访问的文件夹（realpath），即隐藏工作区的 `extraFolders`。 */
  folders: z.array(z.string().min(1)).max(ASSISTANT_FOLDERS_MAX),
});
export type Assistant = z.infer<typeof AssistantSchema>;

export const ChannelKindSchema = z.enum(['project', 'assistant']);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** 协调者能不能自己动手：`route` 只分诊、开线程（项目频道默认）；`act` 小事自己做，大事开线程（助理默认）。 */
export const ChannelModeSchema = z.enum(['route', 'act']);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const ChannelCoordinatorSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  mode: ChannelModeSchema,
  /** 当前这一班的协调者会话；还没唤醒过时没有。 */
  sessionId: SessionIdSchema.optional(),
  /** 第几班，从 1 起；换班加一。 */
  generation: z.int().min(1),
});
export type ChannelCoordinator = z.infer<typeof ChannelCoordinatorSchema>;

/** 协调者每天的预算（按本机时区的自然日）；线程的花费不算在内。 */
export const ChannelBudgetSchema = z.object({
  dailyWakes: z.int().min(1).max(1000),
  dailyTokens: z.int().min(1000).max(100_000_000),
});
export type ChannelBudget = z.infer<typeof ChannelBudgetSchema>;

/** 助理的默认预算。 */
export const DEFAULT_ASSISTANT_BUDGET: ChannelBudget = { dailyWakes: 20, dailyTokens: 200_000 };

/** 今天协调者用了多少（`day` 是本机时区的 `YYYY-MM-DD`）。 */
export const ChannelUsageSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  wakes: z.int().min(0),
  tokens: z.int().min(0),
});
export type ChannelUsage = z.infer<typeof ChannelUsageSchema>;

/**
 * 频道此刻的状态（列表行的状态点）：`paused` 暂停了（用户或预算）；`waiting` 有等用户处理的事（协调者或线程的审批、提问）；
 * `working` 协调者或某个线程的回合在跑；其余 `idle`。顺序即优先级。
 */
export const ChannelStateSchema = z.enum(['idle', 'working', 'waiting', 'paused']);
export type ChannelState = z.infer<typeof ChannelStateSchema>;

/** 最后一条帖子的摘要（列表行）：文字的第一段，打码后截断；只有图片时是 `[image]`。 */
export const ChannelLastPostSchema = z.object({
  seq: z.int().min(1),
  author: z.enum(['user', 'coordinator', 'host']),
  preview: z.string().max(CHANNEL_POST_PREVIEW_MAX_LENGTH),
  at: IsoTimeSchema,
});
export type ChannelLastPost = z.infer<typeof ChannelLastPostSchema>;

export const ChannelSchema = z.object({
  id: ChannelIdSchema,
  kind: ChannelKindSchema,
  /** `project`：那个项目；`assistant`：助理自己的隐藏工作区。 */
  workspaceId: WorkspaceIdSchema,
  /** 频道名；助理是它的名字。 */
  title: z.string().min(1).max(80),
  /** 只有助理有。 */
  assistant: AssistantSchema.optional(),
  coordinator: ChannelCoordinatorSchema,
  budget: ChannelBudgetSchema,
  /** 今天的用量；今天还没唤醒过时省略。 */
  usage: ChannelUsageSchema.optional(),
  pausedAt: IsoTimeSchema.optional(),
  /** `user` 用户暂停；`budget` 预算用完，次日自动恢复。 */
  pauseReason: z.enum(['user', 'budget']).optional(),
  state: ChannelStateSchema,
  /** 等用户处理的审批与提问数（协调者与线程合计），0 时省略。 */
  pendingCount: z.int().min(1).optional(),
  /** 时间线上最后一条帖子的 `seq`；没有帖子时 0。 */
  lastPostSeq: z.int().min(0),
  lastPost: ChannelLastPostSchema.optional(),
  /** 还没被任何读者看过的协调者与 Host 帖子数（读过取各读者的最大值），0 时省略。 */
  unreadCount: z.int().min(1).optional(),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type Channel = z.infer<typeof ChannelSchema>;

export const ChannelPostAuthorSchema = z.discriminatedUnion('kind', [
  /** 本机客户端没有 `deviceId`；远程设备是设备的客户端 ID。 */
  z.object({ kind: z.literal('user'), deviceId: z.string().min(1).optional() }),
  z.object({
    kind: z.literal('coordinator'),
    sessionId: SessionIdSchema,
    generation: z.int().min(1),
  }),
  /** Host 写的：说明、预算用完、协调者出错。 */
  z.object({ kind: z.literal('host') }),
]);
export type ChannelPostAuthor = z.infer<typeof ChannelPostAuthorSchema>;

/** “我需要什么”卡片里的一项：要用的连接器、文件夹、浏览器登录或别的；`ready` 已经有了。 */
export const ChannelNeedSchema = z.object({
  kind: z.enum(['connector', 'folder', 'login', 'other']),
  label: z.string().min(1).max(120),
  ready: z.boolean(),
  detail: z.string().max(300).optional(),
});
export type ChannelNeed = z.infer<typeof ChannelNeedSchema>;

/** 简报里的一行；有会话时点开它。 */
export const ChannelBriefItemSchema = z.object({
  title: z.string().min(1).max(200),
  sessionId: SessionIdSchema.optional(),
});
export type ChannelBriefItem = z.infer<typeof ChannelBriefItemSchema>;

/**
 * 帖子带的卡片（时间线上画成卡片，开放的 `kind`，认不出的按普通帖子显示）：
 * - `needs`：助理建好后的第一条，“我需要什么”（`wevir_channel_needs`）。
 * - `suggestion`：助理主动提的建议（`wevir_channel_suggest`），用户采纳或忽略（`channel.respondSuggestion`）。
 * - `brief`：晨间简报（0.121.0 起由日程发出）：今天的待办、昨晚完成的、等用户决定的。
 * - `notice`：Host 的说明：`budget` 预算用完已暂停、`resumed` 恢复、`failed` 协调者这回合出错（附重试，`channel.wake`）。
 */
export const ChannelCardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('needs'), items: z.array(ChannelNeedSchema).min(1).max(12) }),
  z.object({
    kind: z.literal('suggestion'),
    text: z.string().min(1).max(500),
    status: z.enum(['open', 'accepted', 'dismissed']),
  }),
  z.object({
    kind: z.literal('brief'),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    todo: z.array(ChannelBriefItemSchema).max(20),
    done: z.array(ChannelBriefItemSchema).max(20),
    decisions: z.array(ChannelBriefItemSchema).max(20),
  }),
  z.object({ kind: z.literal('notice'), reason: z.enum(['budget', 'resumed', 'failed']) }),
]);
export type ChannelCard = z.infer<typeof ChannelCardSchema>;

export const ChannelPostSchema = z.object({
  id: ChannelPostIdSchema,
  channelId: ChannelIdSchema,
  /** 频道内从 1 递增。 */
  seq: z.int().min(1),
  author: ChannelPostAuthorSchema,
  /** 文字与图片，同 `session.send`；只有卡片的 Host 帖子可以是一段空文字。 */
  content: z.array(UserContentPartSchema).min(1),
  /** 协调者回答的是哪条用户帖子。 */
  replyTo: ChannelPostIdSchema.optional(),
  /** 用户的这条被转给了哪些线程（Host 填，显示“已转给 …”）。 */
  routedTo: z.array(SessionIdSchema).optional(),
  card: ChannelCardSchema.optional(),
  /** 协调者在那个回合里交给用户的文件（`wevir_share_file`），路径相对协调者会话的目录。 */
  files: z.array(SharedFileSchema).optional(),
  clientPostId: z.string().min(1).max(128).optional(),
  createdAt: IsoTimeSchema,
});
export type ChannelPost = z.infer<typeof ChannelPostSchema>;

/** 线程的状态，由会话推导，顺序即优先级：已解决、等用户、在跑、失败、有新回答没看过、其余。 */
export const ChannelThreadStatusSchema = z.enum([
  'resolved',
  'waiting',
  'working',
  'failed',
  'replied',
  'idle',
]);
export type ChannelThreadStatus = z.infer<typeof ChannelThreadStatusSchema>;

/** 线程就是一个顶层会话（`Session.channel.role: 'thread'`）；这里是频道附加的部分。 */
export const ChannelThreadSchema = z.object({
  sessionId: SessionIdSchema,
  channelId: ChannelIdSchema,
  /** 卡片挂在哪条帖子下面。 */
  rootPostId: ChannelPostIdSchema,
  title: z.string(),
  status: ChannelThreadStatusSchema,
  /** `working` 时：清单里进行中的那项。 */
  doing: z.string().max(200).optional(),
  /** 线程里完成的回合数。 */
  replyCount: z.int().min(0),
  lastReply: z.object({ at: IsoTimeSchema, firstLine: z.string().max(200) }).optional(),
  openedBy: z.enum(['coordinator', 'user']),
  resolvedAt: IsoTimeSchema.optional(),
  resolvedBy: z.enum(['user', 'coordinator', 'thread']).optional(),
  createdAt: IsoTimeSchema,
});
export type ChannelThread = z.infer<typeof ChannelThreadSchema>;

/** 频道视图要的全部（`channel.get` 的结果，`channel.updated` 带其中变了的部分）。 */
const ChannelViewFields = {
  /** 未解决的线程全部，已解决的最近 50 个，新的在前。 */
  threads: z.array(ChannelThreadSchema),
  /** 协调者会话里等用户批准的审批（对外动作展示的就是将要发出的内容），按提出的先后。 */
  approvals: z.array(ApprovalRequestSchema),
  /** 频道的共享任务清单（助理的“任务”页签）；助理的任务只有用户能标完成。 */
  tasks: z.array(BoardTaskSchema),
};

// ── 方法 ──────────────────────────────────────────────────────────────

/** `channel.list`：全部频道（可按种类），之后这条连接收 `channels.changed`。 */
export const ChannelListParamsSchema = z.object({ kind: ChannelKindSchema.optional() });
export const ChannelListResultSchema = z.object({
  channels: z.array(ChannelSchema),
  listVersion: z.number().int().nonnegative(),
});

export const ChannelIdParamsSchema = z.object({ channelId: ChannelIdSchema });

export const ChannelGetResultSchema = z.object({ channel: ChannelSchema, ...ChannelViewFields });

/**
 * `channel.create`：现在只能建助理。名字与一句话的职责必填；不给头像时 Host 随机抽一个；协调者的 Provider 必选（要能挂 Wevir 工具）。
 * 建好后 Host 马上唤醒协调者做第一步：按职责检查要用的连接器、文件夹与浏览器登录，缺的列成“我需要什么”卡片。
 */
export const ChannelCreateParamsSchema = z.object({
  kind: z.literal('assistant'),
  name: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_LENGTH),
  description: z.string().trim().max(ASSISTANT_DESCRIPTION_MAX_LENGTH),
  avatar: AssistantAvatarSchema.optional(),
  coordinator: z.object({
    providerId: ProviderIdSchema,
    modelId: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  }),
  /** 授权访问的文件夹（绝对路径）。 */
  folders: z.array(z.string().min(1)).max(ASSISTANT_FOLDERS_MAX).optional(),
  rules: AssistantRulesSchema.optional(),
  budget: ChannelBudgetSchema.optional(),
});
export const ChannelResultSchema = z.object({ channel: ChannelSchema });

/** `channel.update`：都可选；换 Provider 从下一班起（立即换班用 `channel.rotate`）；`paused` 暂停或恢复协调者。 */
export const ChannelUpdateParamsSchema = z.object({
  channelId: ChannelIdSchema,
  name: z.string().trim().min(1).max(ASSISTANT_NAME_MAX_LENGTH).optional(),
  description: z.string().trim().max(ASSISTANT_DESCRIPTION_MAX_LENGTH).optional(),
  avatar: AssistantAvatarSchema.optional(),
  coordinator: z
    .object({
      providerId: ProviderIdSchema.optional(),
      modelId: z.string().min(1).nullable().optional(),
      reasoningEffort: z.string().min(1).nullable().optional(),
    })
    .optional(),
  folders: z.array(z.string().min(1)).max(ASSISTANT_FOLDERS_MAX).optional(),
  rules: AssistantRulesSchema.optional(),
  budget: ChannelBudgetSchema.optional(),
  paused: z.boolean().optional(),
});

/** `channel.posts`：按 `seq` 翻页，`beforeSeq` 往前、`afterSeq` 往后，都不给时是最近的一页；结果按 `seq` 升序。 */
export const ChannelPostsParamsSchema = z.object({
  channelId: ChannelIdSchema,
  beforeSeq: z.int().min(1).optional(),
  afterSeq: z.int().min(0).optional(),
  limit: z.int().min(1).max(CHANNEL_POSTS_PAGE_MAX).optional(),
});
export const ChannelPostsResultSchema = z.object({
  posts: z.array(ChannelPostSchema),
  lastSeq: z.int().min(0),
});

/** `channel.subscribe`：先补发 `afterSeq` 之后的帖子（`channel.posted`），之后收新帖与 `channel.updated`。 */
export const ChannelSubscribeParamsSchema = z.object({
  channelId: ChannelIdSchema,
  afterSeq: z.int().min(0).optional(),
});
export const ChannelSubscribeResultSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  lastSeq: z.int().min(0),
});
export const ChannelUnsubscribeParamsSchema = z.object({ subscriptionId: SubscriptionIdSchema });

/** `channel.post`：用户在时间线上发帖；同一个 `clientPostId` 重发返回原来那条。 */
export const ChannelPostParamsSchema = z.object({
  channelId: ChannelIdSchema,
  content: z.array(UserContentPartSchema).min(1),
  clientPostId: z.string().min(1).max(128).optional(),
});
export const ChannelPostResultSchema = z.object({ post: ChannelPostSchema });

/** `channel.markRead`：这条连接的读者看到了 `seq` 为止。 */
export const ChannelMarkReadParamsSchema = z.object({
  channelId: ChannelIdSchema,
  seq: z.int().min(0),
});

/** `channel.startThread`：用户直接在一条自己的帖子上开线程，不经协调者。 */
export const ChannelStartThreadParamsSchema = z.object({
  channelId: ChannelIdSchema,
  rootPostId: ChannelPostIdSchema,
  title: z.string().trim().min(1).max(80).optional(),
});
export const ChannelThreadResultSchema = z.object({ thread: ChannelThreadSchema });

export const ChannelResolveThreadParamsSchema = z.object({
  channelId: ChannelIdSchema,
  sessionId: SessionIdSchema,
  resolved: z.boolean(),
});

/** `channel.respondSuggestion`：采纳时 Host 以用户的名义发一条帖子（引用建议）并唤醒协调者。 */
export const ChannelRespondSuggestionParamsSchema = z.object({
  channelId: ChannelIdSchema,
  postId: ChannelPostIdSchema,
  accept: z.boolean(),
});

/** `channel.updateTask`：用户改任务的状态（助理的任务只有用户能标完成）。 */
export const ChannelUpdateTaskParamsSchema = z.object({
  channelId: ChannelIdSchema,
  taskId: z.string().min(1),
  status: BoardTaskStatusSchema,
});
export const ChannelUpdateTaskResultSchema = z.object({ tasks: z.array(BoardTaskSchema) });

// ── 通知 ──────────────────────────────────────────────────────────────

/** `channels.changed`：发给调过 `channel.list` 的连接，同 `sessions.changed`；版本不连续时重读。 */
export const ChannelsChangedParamsSchema = z.object({
  listVersion: z.number().int().nonnegative(),
  upserted: z.array(ChannelSchema),
  removed: z.array(ChannelIdSchema),
});

/** `channel.posted`：订阅的频道有了新帖（含订阅时补发的）。 */
export const ChannelPostedParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  post: ChannelPostSchema,
});

/** `channel.updated`：订阅的频道里变了的部分（线程 1 秒合一批；帖子是 `routedTo` 或卡片状态变了的）。 */
export const ChannelUpdatedParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  channel: ChannelSchema.optional(),
  posts: z.array(ChannelPostSchema).optional(),
  threads: ChannelViewFields.threads.optional(),
  approvals: ChannelViewFields.approvals.optional(),
  tasks: ChannelViewFields.tasks.optional(),
});

const EmptySchema = z.object({});

/** 频道的方法（Host 功能 `channels`）。读是 `session.read`、发帖与处理是 `session.write`（手机默认都有）；建、改、删是电脑上的设置。 */
export const ChannelMethodSchemas = {
  'channel.list': {
    params: ChannelListParamsSchema,
    result: ChannelListResultSchema,
    permission: 'session.read',
  },
  'channel.get': {
    params: ChannelIdParamsSchema,
    result: ChannelGetResultSchema,
    permission: 'session.read',
  },
  'channel.create': {
    params: ChannelCreateParamsSchema,
    result: ChannelResultSchema,
    permission: 'workspace.write',
  },
  'channel.update': {
    params: ChannelUpdateParamsSchema,
    result: ChannelResultSchema,
    permission: 'workspace.write',
  },
  'channel.delete': {
    params: ChannelIdParamsSchema,
    result: EmptySchema,
    permission: 'workspace.write',
  },
  'channel.posts': {
    params: ChannelPostsParamsSchema,
    result: ChannelPostsResultSchema,
    permission: 'session.read',
  },
  'channel.subscribe': {
    params: ChannelSubscribeParamsSchema,
    result: ChannelSubscribeResultSchema,
    permission: 'session.read',
  },
  'channel.unsubscribe': {
    params: ChannelUnsubscribeParamsSchema,
    result: EmptySchema,
    permission: 'session.read',
  },
  'channel.post': {
    params: ChannelPostParamsSchema,
    result: ChannelPostResultSchema,
    permission: 'session.write',
  },
  'channel.markRead': {
    params: ChannelMarkReadParamsSchema,
    result: EmptySchema,
    permission: 'session.read',
  },
  'channel.startThread': {
    params: ChannelStartThreadParamsSchema,
    result: ChannelThreadResultSchema,
    permission: 'session.write',
  },
  'channel.resolveThread': {
    params: ChannelResolveThreadParamsSchema,
    result: ChannelThreadResultSchema,
    permission: 'session.write',
  },
  'channel.respondSuggestion': {
    params: ChannelRespondSuggestionParamsSchema,
    result: ChannelPostResultSchema,
    permission: 'session.write',
  },
  'channel.updateTask': {
    params: ChannelUpdateTaskParamsSchema,
    result: ChannelUpdateTaskResultSchema,
    permission: 'session.write',
  },
  'channel.wake': {
    params: ChannelIdParamsSchema,
    result: EmptySchema,
    permission: 'session.write',
  },
  'channel.rotate': {
    params: ChannelIdParamsSchema,
    result: ChannelResultSchema,
    permission: 'session.write',
  },
} as const;
