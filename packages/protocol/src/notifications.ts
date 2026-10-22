// 通知意图与在场（0.106.0，Host 功能 `notification_intents`，domain-model §3.48）：“这件事该不该提醒”由 Host 判定，发给订阅了的连接；
// 怎样提醒（正看着这个会话就不提醒、系统通知、提示音、角标）由客户端按自己的显示偏好决定。客户端报告在场，Host 知道有没有人在电脑前。
// entities.ts 的 Host 设置引用这里的种类开关，所以这里只引用 common.ts。

import { z } from 'zod';
import { AutomationIdSchema, IsoTimeSchema, SessionIdSchema, WorkspaceIdSchema } from './common.js';

/** 意图的 `title` 最多多少字符（按 UTF-16 code unit），同收件箱的 `INBOX_TITLE_MAX_LENGTH`。 */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
/** 意图的 `body` 最多多少字符；Host 打码后截断，同收件箱的 `INBOX_SUMMARY_MAX_LENGTH`。 */
export const NOTIFICATION_BODY_MAX_LENGTH = 300;
/** 事发超过这么久的不提醒（断线、取消归档后重新出现的旧事）。 */
export const NOTIFICATION_MAX_AGE_MS = 2 * 60_000;

export const NOTIFICATION_KINDS = [
  'approval',
  'question',
  'completed',
  'failed',
  'automation',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** 自动化的运行到了哪一步：等审批或回答、失败、完成。 */
export const NotificationAutomationStatusSchema = z.enum(['waiting', 'failed', 'completed']);
export type NotificationAutomationStatus = z.infer<typeof NotificationAutomationStatusSchema>;

/**
 * 一条通知意图。`id` 稳定、同一件事只发一次：`approval:<ApprovalId>`、`question:<QuestionId>`、`turn_failed:<TurnId>`、
 * `completed:<TurnId>`、`automation:<AutomationRunId>:<状态>`。
 */
export const NotificationIntentSchema = z.object({
  id: z
    .string()
    .max(160)
    .regex(/^[a-z_]+:[A-Za-z0-9_:-]+$/),
  kind: NotificationKindSchema,
  /** 所在的会话；自动化的运行没建出会话时省略。 */
  sessionId: SessionIdSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  /** 只在 `automation`。 */
  automationId: AutomationIdSchema.optional(),
  automationStatus: NotificationAutomationStatusSchema.optional(),
  /** 会话标题（自动化是自动化的标题）；会话没标题时是空串。 */
  title: z.string().max(NOTIFICATION_TITLE_MAX_LENGTH),
  /** 一句说明，同收件箱的 `summary`（打码、截断）；回合完成是空串。不含密钥。 */
  body: z.string().max(NOTIFICATION_BODY_MAX_LENGTH),
  createdAt: IsoTimeSchema,
  /** `session:<SessionId>`，没有会话时 `automation:<AutomationId>`：同一个键客户端只留最新的一条。 */
  collapseKey: z.string().min(1).max(128),
});
export type NotificationIntent = z.infer<typeof NotificationIntentSchema>;

/** Host 设置 `notifications`：哪几类产生意图。缺省或缺某一项按开。 */
export const NotificationKindSettingsSchema = z.object({
  completed: z.boolean().optional(),
  approval: z.boolean().optional(),
  question: z.boolean().optional(),
  failed: z.boolean().optional(),
  automation: z.boolean().optional(),
});
export type NotificationKindSettings = z.infer<typeof NotificationKindSettingsSchema>;

/** `notification.subscribe`：之后这条连接收 `notification.intent`，连接关闭即止。 */
export const NotificationSubscribeParamsSchema = z.object({});
export const NotificationSubscribeResultSchema = z.object({});

/** `notification.intent` 的参数就是意图。 */
export const NotificationIntentParamsSchema = NotificationIntentSchema;

/** `presence.update`：这条连接背后有没有人在用它。 */
export const PresenceUpdateParamsSchema = z.object({ active: z.boolean() });
export const PresenceUpdateResultSchema = z.object({});
