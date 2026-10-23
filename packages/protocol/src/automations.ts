// 自动化（0.66.0，Host 功能 `automations`）：按计划反复交给 Agent 的一段指令。
//
// Host 存下自动化并自己计时，到点时照它的设置开一个会话（或发进它沿用的会话）并发出指令，每次运行记一条 `AutomationRun`。
// 只在 Host 运行时执行：电脑睡眠或 Wevir 退出期间错过的，醒来后只补跑最近的一次（`catch_up`），更早的不补。
// 用户在客户端里建，或会话里的 Agent 用应用级工具 `wevir_automation_*` 建（要用户批准）。
//
// 0.73.0：可以指定一个已有会话（`sessionId`），到点时往它里面发一条消息接着聊；可以带检查脚本（`check`），Host 先跑脚本，
// 按退出码或输出有没有变决定这次唤不唤醒 Agent，不唤醒就不开回合、不耗 token；通知加 `changes`（结果与上次相同不提醒）；
// 连着失败 `AUTOMATION_MAX_CONSECUTIVE_FAILURES` 次自动停用。
//
// 0.121.0：可以发给助理（`channelId`）：到点时唤醒助理的协调者（`<schedule>` 进唤醒信封），回答写在助理的时间线上，不开会话；
// `brief` 的回答带晨间简报卡片（今天的待办、昨晚完成的、等用户决定的，由 Host 组装）。建助理时 Host 给它建一个每天 08:00 的简报。

import { z } from 'zod';
import {
  AutomationIdSchema,
  AutomationRunIdSchema,
  ChannelIdSchema,
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
  AUTOMATION_CHECK_COMMAND_MAX_LENGTH,
  AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS,
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
 * 以及失败或等用户处理时；`changes`（0.73.0）同 `important`，但结果与上一次相同（`unchanged`）时也不提醒；`failures` 只在
 * 失败或等用户处理时；`never` 不提醒。检查脚本没唤醒 Agent 的运行（`silent`）都不提醒。
 */
export const AutomationNotifySchema = z.enum([
  'always',
  'important',
  'changes',
  'failures',
  'never',
]);
export type AutomationNotify = z.infer<typeof AutomationNotifySchema>;

/**
 * 检查脚本的唤醒规则（0.73.0）：
 * - `exit_code`：退出码 0 唤醒 Agent，1 不唤醒，别的退出码、超时或起不来算失败。
 * - `output_changed`：输出连同退出码与上一次检查不同才唤醒；第一次检查只记下作基准、不唤醒。超时或起不来算失败。
 */
export const AutomationCheckWakeSchema = z.enum(['exit_code', 'output_changed']);
export type AutomationCheckWake = z.infer<typeof AutomationCheckWakeSchema>;

/**
 * 检查脚本（0.73.0）：每次运行前 Host 先在项目目录（不在项目中时是用户主目录）里用用户的 shell 跑它，按 `wake` 决定这次
 * 唤不唤醒 Agent。唤醒时把输出的末尾附在发给 Agent 的消息后面。
 */
export const AutomationCheckSchema = z.object({
  command: z.string().trim().min(1).max(AUTOMATION_CHECK_COMMAND_MAX_LENGTH),
  wake: AutomationCheckWakeSchema,
  /** 省略时 `AUTOMATION_CHECK_DEFAULT_TIMEOUT_SECONDS`。 */
  timeoutSeconds: z.int().min(1).max(AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS).optional(),
});
export type AutomationCheck = z.infer<typeof AutomationCheckSchema>;

/** 检查脚本这次的结论：`wake` 唤醒 Agent；`silent` 不唤醒（`output_changed` 的第一次也是它）；`failed` 脚本出错。 */
export const AutomationCheckDecisionSchema = z.enum(['wake', 'silent', 'failed']);
export type AutomationCheckDecision = z.infer<typeof AutomationCheckDecisionSchema>;

/** 跑一次检查脚本的结果（0.73.0）。 */
export const AutomationCheckResultSchema = z.object({
  decision: AutomationCheckDecisionSchema,
  /** 进程的退出码；超时、被信号结束或没起来时 `null`。 */
  exitCode: z.int().nullable(),
  timedOut: z.literal(true).optional(),
  durationMs: z.int().min(0),
  /** 输出（stdout 与 stderr 合在一起，去掉控制序列）的末尾，最多 `AUTOMATION_CHECK_OUTPUT_MAX_LENGTH` 字符。 */
  output: z.string(),
  /** 输出比留下的长，开头去掉了。 */
  truncated: z.literal(true).optional(),
  /** `failed` 的原因，或 `output_changed` 第一次检查的说明，给人看。 */
  error: z.string().optional(),
});
export type AutomationCheckResult = z.infer<typeof AutomationCheckResultSchema>;

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
 * 运行的状态：`checking` 在跑检查脚本（0.73.0）；`running` 回合进行中；`waiting` 回合在等用户批准或回答；`completed` 回合
 * 正常结束；`failed` 检查脚本出错、没能开始或回合出错；`cancelled` 回合被取消或被 Host 重启打断；`skipped` 到点时上一次运行
 * 还没结束，这次没有运行；`silent` 检查脚本判定这次不用唤醒 Agent（0.73.0），没开回合，连着的几次并成一条。
 */
export const AutomationRunStatusSchema = z.enum([
  'checking',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'silent',
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
  /** `summary` 与上一次完成的运行相同（0.73.0，`notify: "changes"` 时不提醒）。 */
  unchanged: z.literal(true).optional(),
  /** 检查脚本的结果（0.73.0）；自动化没有检查脚本时省略。 */
  check: AutomationCheckResultSchema.optional(),
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
  /** 检查脚本（0.73.0）；省略时每次到点都唤醒 Agent。 */
  check: AutomationCheckSchema.optional(),
};

export const AutomationSchema = z.object({
  id: AutomationIdSchema,
  ...AutomationFields,
  /**
   * 运行发进的会话：`newSessionEachRun` 为 `false` 时第一次运行建的会话，或建、改时指定的已有会话（0.73.0，Agent 选了
   * “发回这个会话”也是）。发进已有会话时用那个会话的项目与模型，它正忙时等它空下来。这个会话删除或归档后，下一次运行
   * 另开一个并换成它。
   */
  sessionId: SessionIdSchema.optional(),
  /**
   * 发给哪个助理（0.121.0）：到点时唤醒它的协调者，不开会话；`workspaceId`、`providerId`、`modelId` 是助理的，`sessionId` 与
   * `newSessionEachRun` 不用。运行在唤醒交出时就记 `completed`，结果看助理的时间线。助理删除时一起删。
   */
  channelId: ChannelIdSchema.optional(),
  /** 晨间简报（0.121.0，只在有 `channelId` 时）：协调者这次的回答带 `brief` 卡片，没有要说的也发。 */
  brief: z.literal(true).optional(),
  createdBy: AutomationCreatorSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  /** 下一次按计划运行的时刻；停用、`manual` 或 `once` 已运行过时省略。 */
  nextRunAt: IsoTimeSchema.optional(),
  /** 最近一次运行。 */
  lastRun: AutomationRunSchema.optional(),
  /** 一共运行过几次（含 `skipped`，`silent` 并成一条的也各算一次）。 */
  runCount: z.int().min(0),
  /**
   * 连着失败 `AUTOMATION_MAX_CONSECUTIVE_FAILURES` 次后 Host 自动停用它的时刻（0.73.0）；用户重新启用时清除。
   */
  autoPausedAt: IsoTimeSchema.optional(),
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
 *
 * `sessionId`（0.73.0）：每次运行发进这个已有会话，`newSessionEachRun` 视为 `false`，`workspaceId`、`providerId`、
 * `modelId`、`reasoningEffort` 取那个会话的（给了也不用）。会话不在时 `SESSION_NOT_FOUND`，归档了、已关闭或只读时
 * `INVALID_PARAMS`。没有 `sessionId` 时 `providerId` 必须给（`INVALID_PARAMS`）。
 */
export const AutomationCreateParamsSchema = z.object({
  title: AutomationFields.title,
  prompt: AutomationFields.prompt,
  schedule: AutomationFields.schedule,
  timezone: AutomationFields.timezone.optional(),
  enabled: z.boolean().optional(),
  workspaceId: AutomationFields.workspaceId,
  /** 0.73.0 起给了 `sessionId` 时可以省略。 */
  providerId: AutomationFields.providerId.optional(),
  modelId: AutomationFields.modelId,
  reasoningEffort: AutomationFields.reasoningEffort,
  permissionMode: PermissionModeSchema.optional(),
  newSessionEachRun: z.boolean().optional(),
  notify: AutomationNotifySchema.optional(),
  sessionId: SessionIdSchema.optional(),
  check: AutomationCheckSchema.optional(),
  /**
   * 0.121.0：发给这个助理（见 `Automation.channelId`）；`workspaceId`、`providerId`、`modelId`、`reasoningEffort`、`sessionId`、
   * `newSessionEachRun` 给了也不用，`notify` 省略为 `never`（提醒由助理的帖子代表）。助理不在时 `CHANNEL_NOT_FOUND`。
   */
  channelId: ChannelIdSchema.optional(),
  /** 晨间简报（只在有 `channelId` 时，否则 `INVALID_PARAMS`）。 */
  brief: z.boolean().optional(),
});
export const AutomationResultSchema = z.object({ automation: AutomationSchema });

/**
 * `automation.update`：只改给出的字段。`workspaceId: null` 改成不在项目中，`modelId` / `reasoningEffort` 为 `null` 清除；
 * 改了计划、时区或启用时重新算 `nextRunAt`。`sessionId`（0.73.0）改发进的已有会话（同 `automation.create`），`null` 不再
 * 沿用会话（`newSessionEachRun` 不变，没给时为 `true`）；`check: null` 去掉检查脚本；改了检查脚本时丢掉 `output_changed` 的
 * 基准。`enabled: true` 清除 `autoPausedAt`。
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
  sessionId: SessionIdSchema.nullable().optional(),
  check: AutomationCheckSchema.nullable().optional(),
  /** 0.121.0：只对发给助理的自动化。 */
  brief: z.boolean().optional(),
});

/** `automation.delete`：删除自动化与它的运行记录；运行开出的会话留着。进行中的运行不取消。 */
export const AutomationDeleteParamsSchema = z.object({ automationId: AutomationIdSchema });
export const AutomationDeleteResultSchema = z.object({});

/**
 * `automation.run`：立即运行一次（停用的也可以），不改计划。上一次运行还没结束、或发进的已有会话正忙时 `INVALID_PARAMS`。
 * 结果是刚开始的运行；有检查脚本时先跑脚本（状态 `checking`），按结论唤醒或记 `silent`；开会话或发送失败时运行的状态是
 * `failed`，方法本身不报错。
 */
export const AutomationRunParamsSchema = z.object({ automationId: AutomationIdSchema });
export const AutomationRunResultSchema = z.object({ run: AutomationRunSchema });

/**
 * `automation.testCheck`（0.73.0）：试跑一次检查脚本，看输出与结论，不唤醒 Agent、不记运行、不改基准。目录取 `sessionId`
 * 的会话的，或 `workspaceId` 的项目的；都省略时取 `automationId` 的自动化的（发进已有会话的取那个会话的），都没有时是用户
 * 主目录。带 `automationId` 时 `output_changed` 与它记下的基准比；没有基准时结论是 `silent`。
 */
export const AutomationTestCheckParamsSchema = z.object({
  check: AutomationCheckSchema,
  sessionId: SessionIdSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  automationId: AutomationIdSchema.optional(),
});
export const AutomationTestCheckResultSchema = z.object({ result: AutomationCheckResultSchema });

/**
 * `automation.changed` 通知：自动化建了、改了、删了，或一次运行开始、状态变了。发给调用过 `automation.*` 的连接。
 * `run` 是状态变了的那次运行（客户端据此提醒）；`deleted` 表示这个自动化删除了。
 */
export const AutomationChangedParamsSchema = z.object({
  automationId: AutomationIdSchema,
  run: AutomationRunSchema.optional(),
  deleted: z.literal(true).optional(),
});
