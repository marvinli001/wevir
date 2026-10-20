// 自动化（0.66.0，Host 功能 `automations`）：按计划反复交给 Agent 的一段指令。
//
// Host 存下自动化并自己计时，到点时照它的设置开一个会话（或发进它沿用的会话）并发出指令，每次运行记一条 `AutomationRun`。
// 只在 Host 运行时执行：电脑睡眠或 Wevir 退出期间错过的，醒来后只补跑最近的一次（`catch_up`），更早的不补。
// 用户在客户端里建，或会话里的 Agent 用应用级工具 `wevir_automation_*` 建（要用户批准）。

import { z } from 'zod';
import {
  AutomationIdSchema,
  AutomationRunIdSchema,
  IsoTimeSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { PermissionModeSchema } from './entities.js';

/**
 * 运行的回答以这一行结尾（或只有这一行）时表示这次没有要报告的：Host 记 `quiet`、从 `summary` 里去掉它。运行会话的说明里告诉
 * Agent 这样做。
 */
export const AUTOMATION_QUIET_MARKER = 'NOTHING_TO_REPORT';

import {
  AUTOMATION_MIN_INTERVAL_MINUTES,
  AUTOMATION_PROMPT_MAX_LENGTH,
  AUTOMATION_TITLE_MAX_LENGTH,
} from './limits.js';

/** 一天里的时刻，24 小时制 `HH:MM`。 */
export const AutomationTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** 星期几：0 是星期日，6 是星期六。 */
export const AutomationWeekdaySchema = z.int().min(0).max(6);

/**
 * 什么时候运行。`daily` 与 `monthly` 的时刻按自动化的 `timezone` 算。
 * - `manual`：只在 `automation.run` 时运行。
 * - `once`：在 `at` 运行一次，之后自动停用。
 * - `interval`：每隔 `minutes` 分钟（从上次开始算），至少 `AUTOMATION_MIN_INTERVAL_MINUTES`。
 * - `daily`：每天 `time`；带 `weekdays` 时只在这几天（工作日是 `[1,2,3,4,5]`，每周一次是一个元素）。
 * - `monthly`：每月 `day` 号的 `time`；这个月没有这一天时在月末那天。
 */
export const AutomationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('once'), at: IsoTimeSchema }),
  z.object({
    kind: z.literal('interval'),
    minutes: z
      .int()
      .min(AUTOMATION_MIN_INTERVAL_MINUTES)
      .max(31 * 24 * 60),
  }),
  z.object({
    kind: z.literal('daily'),
    time: AutomationTimeOfDaySchema,
    weekdays: z.array(AutomationWeekdaySchema).min(1).max(7).optional(),
  }),
  z.object({
    kind: z.literal('monthly'),
    time: AutomationTimeOfDaySchema,
    day: z.int().min(1).max(31),
  }),
]);
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;
export type AutomationScheduleKind = AutomationSchedule['kind'];

/**
 * 运行结束后客户端要不要提醒：`always` 每次；`important` 有要紧的结果时（Agent 没说“没有要报告的”，即运行不是 `quiet`），
 * 以及失败或等用户处理时；`failures` 只在失败或等用户处理时；`never` 不提醒。
 */
export const AutomationNotifySchema = z.enum(['always', 'important', 'failures', 'never']);
export type AutomationNotify = z.infer<typeof AutomationNotifySchema>;

/** 谁建的：用户在客户端里，或某个会话里的 Agent（经 `wevir_automation_create`）。 */
export const AutomationCreatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('agent'), sessionId: SessionIdSchema }),
]);
export type AutomationCreator = z.infer<typeof AutomationCreatorSchema>;

/** 这次运行怎么开始的：`schedule` 到点，`manual` 手动（`automation.run`），`catch_up` 补跑 Host 没运行时错过的那次。 */
export const AutomationRunTriggerSchema = z.enum(['schedule', 'manual', 'catch_up']);
export type AutomationRunTrigger = z.infer<typeof AutomationRunTriggerSchema>;

/**
 * 运行的状态：`running` 回合进行中；`waiting` 回合在等用户批准或回答；`completed` 回合正常结束；`failed` 没能开始或回合
 * 出错；`cancelled` 回合被取消或被 Host 重启打断；`skipped` 到点时上一次运行还没结束，这次没有运行。
 */
export const AutomationRunStatusSchema = z.enum([
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;

/** 一次运行。 */
export const AutomationRunSchema = z.object({
  id: AutomationRunIdSchema,
  automationId: AutomationIdSchema,
  trigger: AutomationRunTriggerSchema,
  status: AutomationRunStatusSchema,
  startedAt: IsoTimeSchema,
  /** 状态不再是 `running` / `waiting` 的时刻。 */
  finishedAt: IsoTimeSchema.optional(),
  /** 运行所在的会话；没能建出会话（或 `skipped`）时省略。会话之后可能被删除。 */
  sessionId: SessionIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  /** `failed` / `skipped` / `cancelled` 的原因，给人看。 */
  error: z.string().optional(),
  /** 回合最后一条 Agent 回答的开头（最多 `AUTOMATION_RUN_SUMMARY_MAX_LENGTH`），去掉了 `AUTOMATION_QUIET_MARKER`。 */
  summary: z.string().optional(),
  /** Agent 用 `AUTOMATION_QUIET_MARKER` 表示这次没有要报告的（`notify: "important"` 时不提醒）。 */
  quiet: z.literal(true).optional(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;

/** 自动化的可写字段。 */
const AutomationFields = {
  title: z.string().trim().min(1).max(AUTOMATION_TITLE_MAX_LENGTH),
  /** 每次运行发给 Agent 的指令。 */
  prompt: z.string().trim().min(1).max(AUTOMATION_PROMPT_MAX_LENGTH),
  schedule: AutomationScheduleSchema,
  /** IANA 时区（`Asia/Shanghai`），`daily` / `monthly` 的时刻按它算。 */
  timezone: z.string().min(1).max(64),
  enabled: z.boolean(),
  /** 在哪个项目里运行；省略表示不在项目中（每次是新的空文件夹，Host 有 `chat_sessions` 时）。 */
  workspaceId: WorkspaceIdSchema.optional(),
  providerId: ProviderIdSchema,
  /** 省略时用 Provider 的默认模型。 */
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  /** 运行会话的权限模式；`on_request` 的运行遇到审批会停下等用户（`waiting`）。 */
  permissionMode: PermissionModeSchema,
  /** `true` 每次运行开一个新会话；`false` 一直发进同一个会话（`sessionId`，第一次运行时建）。 */
  newSessionEachRun: z.boolean(),
  notify: AutomationNotifySchema,
};

export const AutomationSchema = z.object({
  id: AutomationIdSchema,
  ...AutomationFields,
  /**
   * 运行发进的会话：`newSessionEachRun` 为 `false` 时第一次运行建的会话，或 Agent 建时选了“发回这个会话”的那个会话。
   * 这个会话删除或归档后，下一次运行另开一个并换成它。
   */
  sessionId: SessionIdSchema.optional(),
  createdBy: AutomationCreatorSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  /** 下一次按计划运行的时刻；停用、`manual` 或 `once` 已运行过时省略。 */
  nextRunAt: IsoTimeSchema.optional(),
  /** 最近一次运行。 */
  lastRun: AutomationRunSchema.optional(),
  /** 一共运行过几次（含 `skipped`）。 */
  runCount: z.int().min(0),
});
export type Automation = z.infer<typeof AutomationSchema>;

/** `automation.list`：全部自动化，最近建的在前。 */
export const AutomationListParamsSchema = z.object({});
export const AutomationListResultSchema = z.object({
  automations: z.array(AutomationSchema),
});

/** `automation.get`：一个自动化与它最近的运行（新的在前，最多 `AUTOMATION_RUNS_KEPT` 条）。 */
export const AutomationGetParamsSchema = z.object({ automationId: AutomationIdSchema });
export const AutomationGetResultSchema = z.object({
  automation: AutomationSchema,
  runs: z.array(AutomationRunSchema),
});

/**
 * `automation.create`：`timezone` 省略时用 Host 所在电脑的时区；`enabled` 省略为 `true`；`permissionMode` 省略为
 * `on_request`；`newSessionEachRun` 省略为 `true`；`notify` 省略为 `important`。时区不认识、项目不在、Provider 不在时
 * `INVALID_PARAMS` / `WORKSPACE_NOT_FOUND` / `PROVIDER_NOT_FOUND`。
 */
export const AutomationCreateParamsSchema = z.object({
  title: AutomationFields.title,
  prompt: AutomationFields.prompt,
  schedule: AutomationFields.schedule,
  timezone: AutomationFields.timezone.optional(),
  enabled: z.boolean().optional(),
  workspaceId: AutomationFields.workspaceId,
  providerId: AutomationFields.providerId,
  modelId: AutomationFields.modelId,
  reasoningEffort: AutomationFields.reasoningEffort,
  permissionMode: PermissionModeSchema.optional(),
  newSessionEachRun: z.boolean().optional(),
  notify: AutomationNotifySchema.optional(),
});
export const AutomationResultSchema = z.object({ automation: AutomationSchema });

/**
 * `automation.update`：只改给出的字段。`workspaceId: null` 改成不在项目中，`modelId` / `reasoningEffort` 为 `null` 清除；
 * 改了计划、时区或启用时重新算 `nextRunAt`。
 */
export const AutomationUpdateParamsSchema = z.object({
  automationId: AutomationIdSchema,
  title: AutomationFields.title.optional(),
  prompt: AutomationFields.prompt.optional(),
  schedule: AutomationFields.schedule.optional(),
  timezone: AutomationFields.timezone.optional(),
  enabled: z.boolean().optional(),
  workspaceId: WorkspaceIdSchema.nullable().optional(),
  providerId: AutomationFields.providerId.optional(),
  modelId: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  permissionMode: PermissionModeSchema.optional(),
  newSessionEachRun: z.boolean().optional(),
  notify: AutomationNotifySchema.optional(),
});

/** `automation.delete`：删除自动化与它的运行记录；运行开出的会话留着。进行中的运行不取消。 */
export const AutomationDeleteParamsSchema = z.object({ automationId: AutomationIdSchema });
export const AutomationDeleteResultSchema = z.object({});

/**
 * `automation.run`：立即运行一次（停用的也可以），不改计划。上一次运行还没结束时 `INVALID_PARAMS`。结果是刚开始的运行；
 * 开会话或发送失败时运行的状态是 `failed`，方法本身不报错。
 */
export const AutomationRunParamsSchema = z.object({ automationId: AutomationIdSchema });
export const AutomationRunResultSchema = z.object({ run: AutomationRunSchema });

/**
 * `automation.changed` 通知：自动化建了、改了、删了，或一次运行开始、状态变了。发给调用过 `automation.*` 的连接。
 * `run` 是状态变了的那次运行（客户端据此提醒）；`deleted` 表示这个自动化删除了。
 */
export const AutomationChangedParamsSchema = z.object({
  automationId: AutomationIdSchema,
  run: AutomationRunSchema.optional(),
  deleted: z.literal(true).optional(),
});
