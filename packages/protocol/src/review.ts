// 行级批注（0.67.0，Host 功能 `review_comments`，ADR-0009）。
//
// 用户在“变更”窗格的 diff 上给某一侧的几行写意见，攒成一组后一次发给指定的会话（一条用户消息，标明是审阅意见、带文件、行与
// 原文片段）。批注存在 Host，绑定目录（仓库或会话的 worktree）、文件、左右侧、行范围、diff 的范围与基线，以及 Host 自己从那一侧
// 读出的原文片段。文件后来变了，Host 按片段重新定位；找不到或不唯一时标为过期，不会悄悄指向另一段代码。只是本地反馈，不发布到
// GitHub。

import { z } from 'zod';
import {
  ClientTokenSchema,
  IsoTimeSchema,
  PendingMessageIdSchema,
  ReviewCommentIdSchema,
  SeqSchema,
  SessionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { PendingDeliverySchema } from './entities.js';
import { DiffSourceSchema, GitObjectIdSchema } from './git.js';

/** 批注正文的上限（字符）。 */
export const REVIEW_COMMENT_BODY_MAX_LENGTH = 8000;
/** 一条批注最多覆盖的行数。 */
export const REVIEW_COMMENT_MAX_LINES = 500;
/** 原文片段的上限（字符）；超过时片段截断，重新定位只看行数与上下文。 */
export const REVIEW_SNIPPET_MAX_LENGTH = 16_000;
/** 一个目录里最多存的批注（含已发送的）。 */
export const REVIEW_COMMENTS_MAX_PER_DIRECTORY = 500;
/** `review.send` / `review.remove` 一次最多几条。 */
export const REVIEW_BATCH_MAX = 100;

/** diff 的哪一侧：`old` 改动前（左侧、删除的行），`new` 改动后（右侧、新增与上下文的行）。 */
export const ReviewSideSchema = z.enum(['old', 'new']);
export type ReviewSide = z.infer<typeof ReviewSideSchema>;

/**
 * 批注此刻指向哪里（Host 每次读批注时现算）：`current` 原来的行仍是原文；`relocated` 原文挪到了 `startLine`–`endLine`；`outdated`
 * 过期，`reason`：`changed`（文件里找不到原文）、`ambiguous`（原文出现不止一处）、`file_missing`、`unreadable`（太大或二进制）；
 * 开放字符串。`new` 一侧对着磁盘上的文件定位；`old` 一侧绑定基线提交里的内容，不会变。
 */
export const ReviewAnchorSchema = z.object({
  state: z.enum(['current', 'relocated', 'outdated']),
  startLine: z.int().min(1).optional(),
  endLine: z.int().min(1).optional(),
  reason: z.string().min(1).optional(),
});
export type ReviewAnchor = z.infer<typeof ReviewAnchorSchema>;

/** 批注发到了哪个会话：成为回合时有 `turnId`，排队时有 `pendingId`。 */
export const ReviewSentSchema = z.object({
  sessionId: SessionIdSchema,
  at: IsoTimeSchema,
  turnId: TurnIdSchema.optional(),
  pendingId: PendingMessageIdSchema.optional(),
});
export type ReviewSent = z.infer<typeof ReviewSentSchema>;

export const ReviewCommentSchema = z.object({
  id: ReviewCommentIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 在哪个会话的“变更”窗格写的；目录相同的会话看到同一组批注。 */
  sessionId: SessionIdSchema.optional(),
  /** 相对目录，`/` 分隔。 */
  path: z.string().min(1),
  /** 重命名前的路径。 */
  previousPath: z.string().min(1).optional(),
  side: ReviewSideSchema,
  /** 写批注时那一侧的行（从 1 起，含两端）。 */
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  /** 写批注时看的那段 diff。 */
  source: DiffSourceSchema,
  /** diff 的旧的一侧（`workspace.diff` 的 `base`）。 */
  base: GitObjectIdSchema,
  /** diff 的新的一侧是回合后快照时的提交；省略时新的一侧是磁盘上的工作树。 */
  head: GitObjectIdSchema.optional(),
  /** 写批注时的分支；分离头指针时省略。 */
  branch: z.string().min(1).optional(),
  /** 写批注时那几行的原文（Host 自己读的，不信客户端）。 */
  snippet: z.string().max(REVIEW_SNIPPET_MAX_LENGTH),
  body: z.string().min(1).max(REVIEW_COMMENT_BODY_MAX_LENGTH),
  /** `pending` 还没发；`sent` 已发给会话（`sent`）。 */
  status: z.enum(['pending', 'sent']),
  sent: ReviewSentSchema.optional(),
  anchor: ReviewAnchorSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

// ── 方法 ───────────────────────────────────────────────────────

/** 目录的选法同 `workspace.diff`：给了会话是会话的目录（worktree），否则是工作区目录。 */
const ReviewDirectorySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
});

/** `review.list`：目录里的批注，按写的先后；省略 `status` 是全部。 */
export const ReviewListParamsSchema = ReviewDirectorySchema.extend({
  status: z.enum(['pending', 'sent']).optional(),
});
export const ReviewListResultSchema = z.object({ comments: z.array(ReviewCommentSchema) });

/** `review.add`：Host 从 `side` 那一侧（`old` 读 `base`，`new` 读 `head` 或磁盘）取出这几行作为原文片段。 */
export const ReviewAddParamsSchema = ReviewDirectorySchema.extend({
  source: DiffSourceSchema,
  base: GitObjectIdSchema,
  head: GitObjectIdSchema.optional(),
  path: z.string().min(1),
  previousPath: z.string().min(1).optional(),
  side: ReviewSideSchema,
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  body: z.string().trim().min(1).max(REVIEW_COMMENT_BODY_MAX_LENGTH),
});
export const ReviewCommentResultSchema = z.object({ comment: ReviewCommentSchema });

/** `review.update`：改正文（只有还没发的能改）。 */
export const ReviewUpdateParamsSchema = z.object({
  commentId: ReviewCommentIdSchema,
  body: z.string().trim().min(1).max(REVIEW_COMMENT_BODY_MAX_LENGTH),
});

export const ReviewRemoveParamsSchema = z.object({
  commentIds: z.array(ReviewCommentIdSchema).min(1).max(REVIEW_BATCH_MAX),
});
export const ReviewRemoveResultSchema = z.object({ removed: z.int().min(0) });

/**
 * `review.send`：把目录里还没发的这几条批注拼成一条用户消息发给 `targetSessionId`（同一工作区的会话），之后标为已发送。`delivery` 与
 * `clientMessageId` 同 `session.send`。
 */
export const ReviewSendParamsSchema = ReviewDirectorySchema.extend({
  commentIds: z.array(ReviewCommentIdSchema).min(1).max(REVIEW_BATCH_MAX),
  targetSessionId: SessionIdSchema,
  delivery: PendingDeliverySchema.optional(),
  clientMessageId: ClientTokenSchema.optional(),
});
export const ReviewSendResultSchema = z.object({
  comments: z.array(ReviewCommentSchema),
  turnId: TurnIdSchema.optional(),
  pendingId: PendingMessageIdSchema.optional(),
  seq: SeqSchema,
});
