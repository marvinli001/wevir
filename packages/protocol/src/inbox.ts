// 收件箱（0.105.0，Host 功能 `inbox`，domain-model §3.47）：跨所有会话等用户处理的事——未决审批、等回答的问题、失败的回合、要关注的
// 自动化运行。Host 从事件、审批表与自动化的运行算出来，不单独存；只有“收起”落库。

import { z } from 'zod';
import {
  ApprovalIdSchema,
  AutomationIdSchema,
  AutomationRunIdSchema,
  ChannelIdSchema,
  IsoTimeSchema,
  QuestionIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { ApprovalOptionSchema, ApprovalRiskSchema, UserQuestionOptionSchema } from './entities.js';

/** 项的 `title` 最多多少字符（按 UTF-16 code unit）。 */
export const INBOX_TITLE_MAX_LENGTH = 200;
/** 项的 `summary` 与提问的问题文本最多多少字符；Host 打码后截断。 */
export const INBOX_SUMMARY_MAX_LENGTH = 300;
/** 失败回合与自动化项多少天之后不再列出。 */
export const INBOX_ATTENTION_MAX_AGE_DAYS = 7;

export const InboxItemKindSchema = z.enum(['approval', 'question', 'turn_failed', 'automation']);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

/** `<kind>:<所指对象的 ID>`，例如 `approval:apr_…`、`turn_failed:trn_…`、`automation:arn_…`：可推导、稳定。 */
export const InboxItemIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z_]+:[A-Za-z0-9_-]+$/);
export type InboxItemId = z.infer<typeof InboxItemIdSchema>;

/** 收件箱里的一个问题：手机据此直接 `question.respond`。`question` 同 `summary` 打码、截断。 */
export const InboxQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(UserQuestionOptionSchema.pick({ label: true })),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export type InboxQuestion = z.infer<typeof InboxQuestionSchema>;

const InboxItemFields = {
  id: InboxItemIdSchema,
  /** 所在的会话；自动化项是运行的会话（没建出会话时省略）。 */
  sessionId: SessionIdSchema.optional(),
  /** 会话所在的工作区；没建出会话、也不在项目里的自动化运行省略。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /** 子会话的父会话；支线是分出它的会话。 */
  parentSessionId: SessionIdSchema.optional(),
  /** 会话在助理里（0.121.0）：点开去助理页；标题是助理的名字。 */
  channelId: ChannelIdSchema.optional(),
  /** 会话标题（自动化项是自动化的标题）。 */
  title: z.string().max(INBOX_TITLE_MAX_LENGTH),
  /** 一句说明：审批是工具的一行摘要，提问是第一个问题，失败回合是会话的 `lastError`，自动化是运行的错误或回答开头。不含密钥。 */
  summary: z.string().max(INBOX_SUMMARY_MAX_LENGTH),
  createdAt: IsoTimeSchema,
  /** 审批的 `expiresAt`、提问的 `autoAnswerAt`；没有时一直等。 */
  expiresAt: IsoTimeSchema.optional(),
};

/** 一项等用户处理的事。`ref` 按 `kind` 指向审批、提问、回合或自动化运行。 */
export const InboxItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...InboxItemFields,
    kind: z.literal('approval'),
    ref: z.object({
      approvalId: ApprovalIdSchema,
      turnId: TurnIdSchema,
      options: z.array(ApprovalOptionSchema).min(1),
      /** 审批的 `risk`（0.131.0）：有它就是高风险。 */
      risk: ApprovalRiskSchema.optional(),
    }),
  }),
  z.object({
    ...InboxItemFields,
    kind: z.literal('question'),
    ref: z.object({
      questionId: QuestionIdSchema,
      turnId: TurnIdSchema,
      questions: z.array(InboxQuestionSchema).min(1),
    }),
  }),
  z.object({
    ...InboxItemFields,
    kind: z.literal('turn_failed'),
    ref: z.object({ turnId: TurnIdSchema }),
  }),
  z.object({
    ...InboxItemFields,
    kind: z.literal('automation'),
    ref: z.object({
      automationId: AutomationIdSchema,
      runId: AutomationRunIdSchema,
      status: z.enum(['failed', 'completed']),
    }),
  }),
]);
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** 收件箱的版本：每批变化加一，Host 每次启动从新的起点开始（同 `session.list` 的 `listVersion`）。 */
const InboxVersionSchema = z.number().int().nonnegative();

/** `inbox.list`：当前全部项，新的在前；之后这条连接收 `inbox.changed`。 */
export const InboxListParamsSchema = z.object({});
export const InboxListResultSchema = z.object({
  items: z.array(InboxItemSchema),
  inboxVersion: InboxVersionSchema,
});

/** `inbox.dismiss`：收起一个失败回合或自动化项（审批与提问回 `INVALID_PARAMS`）；项已不在收件箱时成功、无操作。 */
export const InboxDismissParamsSchema = z.object({ itemId: InboxItemIdSchema });
export const InboxDismissResultSchema = z.object({});

/** `inbox.changed`：一批收件箱的变化，发给调用过 `inbox.*` 的连接；版本不等于上次加一就重读。 */
export const InboxChangedParamsSchema = z.object({
  inboxVersion: InboxVersionSchema,
  upserted: z.array(InboxItemSchema),
  removed: z.array(InboxItemIdSchema),
});
