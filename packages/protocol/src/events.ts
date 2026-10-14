import { z } from 'zod';
import {
  ApprovalIdSchema,
  ClientIdentitySchema,
  IsoTimeSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqSchema,
  SessionIdSchema,
  StreamIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  EngineErrorCategorySchema,
  PendingMessageSchema,
  QuestionRequestSchema,
  QuestionResolutionSchema,
  ResolvedApprovalStatusSchema,
  SessionReadOnlyReasonSchema,
  SessionStateSchema,
  StreamBlockRefSchema,
  SubagentSummarySchema,
  TitleSourceSchema,
  TodoItemSchema,
  ToolDisplaySchema,
  ToolOutputSchema,
  UserContentPartSchema,
} from './entities.js';

// 会话事件目录 v0，含义与来源见 docs/architecture/domain-model.md §6。

export const EventSourceSchema = z.enum(['host', 'engine']);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const StateChangeReasonSchema = z.enum([
  'turn_started',
  'approval_requested',
  'approvals_settled',
  'cancel_requested',
  'turn_finished',
  'cancel_unconfirmed',
  'engine_exited',
  'resume_failed',
  'resumed',
  'closed',
  'host_restarted',
]);
export type StateChangeReason = z.infer<typeof StateChangeReasonSchema>;

export const TurnOutcomeSchema = z.enum(['completed', 'cancelled', 'failed', 'interrupted']);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

export const ToolFinishStatusSchema = z.enum(['completed', 'failed', 'cancelled', 'unknown']);
export type ToolFinishStatus = z.infer<typeof ToolFinishStatusSchema>;

/** 每种事件的 payload。键就是事件的 `type`。 */
export const EventPayloadSchemas = {
  'session.created': z.object({
    workspaceId: WorkspaceIdSchema,
    cwd: z.string().min(1),
    providerId: ProviderIdSchema,
    modelId: z.string().min(1),
    reasoningEffort: z.string().optional(),
    /** 建立引擎会话的引擎版本（0.3.0；dsh：`@deepseek-ai/dsh` 的包版本）。适配器不报时省略。 */
    engineVersion: z.string().optional(),
    /** 只有子会话有（0.6.0，domain-model §3.3.1）：父会话与派出它的工具调用。 */
    parent: z
      .object({
        sessionId: SessionIdSchema,
        /** 父会话里派出它的工具调用。 */
        toolCallId: z.string().min(1),
        /** 认出它时父会话进行中的回合。 */
        turnId: TurnIdSchema.optional(),
      })
      .optional(),
  }),
  /**
   * 引擎会话重新挂上（0.3.0）：`session.resume`，或 send 前的自动 resume。引擎不回放历史，这条事件之前的
   * 历史都来自事件库。
   */
  'session.resumed': z.object({
    /** 恢复引擎会话的引擎版本，与 `session.created` 的对比可看出是否跨了版本。适配器不报时省略。 */
    engineVersion: z.string().optional(),
  }),
  /** 引擎会话恢复不了，会话只读（0.3.0）。之后的 `session.resumed` 解除。 */
  'session.read_only': z.object({
    reason: SessionReadOnlyReasonSchema,
    /** 引擎原文。 */
    message: z.string(),
  }),
  'session.title_changed': z.object({
    title: z.string(),
    source: TitleSourceSchema,
    /** 模型生成标题时一并给出的检索摘要（0.5.0）；留给以后的会话搜索。 */
    description: z.string().optional(),
  }),
  /**
   * 会话的模型或推理档位改了（0.9.0，`session.configure`），带改后的全部值；从下一个回合起生效。没有 `reasoningEffort`
   * 表示用模型的默认档位。
   */
  'session.configured': z.object({
    modelId: z.string().min(1),
    reasoningEffort: z.string().optional(),
  }),
  'session.state_changed': z.object({
    from: SessionStateSchema,
    to: SessionStateSchema,
    reason: StateChangeReasonSchema,
  }),
  'user.message': z.object({
    turnId: TurnIdSchema,
    clientMessageId: z.string().optional(),
    content: z.array(UserContentPartSchema).min(1),
    sentBy: ClientIdentitySchema,
    /** 这个回合由一条排队的待发消息开始（0.8.0，domain-model §4.6）。 */
    pendingId: PendingMessageIdSchema.optional(),
  }),
  'turn.started': z.object({
    turnId: TurnIdSchema,
    /**
     * 子会话（0.6.0）：回合由引擎开始，这是父 agent 给它的输入（任务描述，或 `send_input` 发来的消息）。普通会话的
     * 输入在同一回合的 `user.message`。
     */
    input: z.array(UserContentPartSchema).min(1).optional(),
  }),
  'turn.finished': z.object({
    turnId: TurnIdSchema,
    outcome: TurnOutcomeSchema,
    /** 引擎原值。 */
    engineStopReason: z.string().optional(),
    durationMs: z.int().min(0),
  }),
  'assistant.delta': z.object({
    turnId: TurnIdSchema,
    streamId: StreamIdSchema,
    blockIndex: z.int().min(0),
    kind: z.enum(['text', 'reasoning']),
    /** Host 按 60 ms 合并后的片段。 */
    text: z.string(),
  }),
  'assistant.stream_ended': z.object({
    turnId: TurnIdSchema,
    streamId: StreamIdSchema,
    outcome: z.enum(['committed', 'abandoned']),
  }),
  'assistant.message': z.object({
    turnId: TurnIdSchema,
    /** 引擎原值。 */
    messageId: z.string(),
    text: z.string(),
    /** 本条替换的增量块；没有旁路或对不上时为空。 */
    replaces: z.array(StreamBlockRefSchema),
  }),
  'assistant.thought': z.object({
    turnId: TurnIdSchema,
    messageId: z.string(),
    text: z.string(),
    replaces: z.array(StreamBlockRefSchema),
  }),
  'tool.started': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    /** ACP `tool_call.title`，dsh 里就是工具名。 */
    toolName: z.string(),
    display: ToolDisplaySchema,
    /** `rawInput` 原样（截断后）；引擎没给时省略。 */
    input: z.unknown().optional(),
  }),
  'tool.updated': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    display: ToolDisplaySchema.optional(),
    input: z.unknown().optional(),
    output: ToolOutputSchema.optional(),
  }),
  'tool.finished': z.object({
    turnId: TurnIdSchema,
    toolCallId: z.string(),
    status: ToolFinishStatusSchema,
    /** Host 收尾补写（`unknown`）时没有。 */
    output: ToolOutputSchema.optional(),
  }),
  'todo.updated': z.object({
    turnId: TurnIdSchema,
    /** 来源 `todo_write` 调用。 */
    toolCallId: z.string(),
    items: z.array(TodoItemSchema),
  }),
  'approval.requested': z.object({
    /** `status` 恒为 `pending`。 */
    approval: ApprovalRequestSchema,
  }),
  'approval.resolved': z.object({
    approvalId: ApprovalIdSchema,
    status: ResolvedApprovalStatusSchema,
    resolution: ApprovalResolutionSchema,
  }),
  /** 引擎向用户提了一组问题（0.10.0），回合等回答。`status` 恒为 `pending`。 */
  'question.requested': z.object({
    question: QuestionRequestSchema,
  }),
  /** 这组问题结束了（0.10.0）：用户回答了，或随回合、会话等取消。 */
  'question.resolved': z.object({
    questionId: QuestionIdSchema,
    status: z.enum(['answered', 'cancelled']),
    resolution: QuestionResolutionSchema,
  }),
  'usage.updated': z.object({
    /** ACP `usage_update.used`。 */
    contextUsed: z.int().min(0),
    /** ACP `usage_update.size`（模型未声明 contextWindow 时是猜测值）。 */
    contextSize: z.int().min(0),
  }),
  'engine.error': z.object({
    category: EngineErrorCategorySchema,
    /** 引擎原文，始终保留。 */
    message: z.string(),
    /** JSON-RPC 错误码。 */
    code: z.int().optional(),
    turnId: TurnIdSchema.optional(),
    /** true：会话因此进入 `error`。 */
    fatal: z.boolean(),
  }),
  'engine.raw': z.object({
    /**
     * 引擎协议：`acp`（dsh 等），`codex-app-server`（0.5.0 起；之前只有 `acp`）。只是调试信息，开放的字符串，
     * 旧客户端的 schema 只认 `acp`，按 host-api.md §4 跳过它认不出的那几条。
     */
    protocol: z.string().min(1),
    /** 如 `session/update`、`turn/diff/updated`。 */
    method: z.string(),
    /** ACP：`session/update` 的 `sessionUpdate` 值；Codex：item 的类型等。 */
    kind: z.string().optional(),
    /** 原样（截断后）。 */
    params: z.unknown().optional(),
  }),
  /** 父会话派出了一个子 agent（0.6.0，domain-model §3.3.1），写在父会话的事件流。 */
  'subagent.started': z.object({
    subagent: SubagentSummarySchema,
  }),
  /** 子会话的摘要变了（0.6.0）：标题、状态、未决审批、昵称或角色。完整摘要，替换同一 `sessionId` 的上一份。 */
  'subagent.updated': z.object({
    subagent: SubagentSummarySchema,
  }),
  /** 一条待发消息加入（0.8.0，domain-model §3.3.2）；`status` 恒为 `waiting`。 */
  'pending.added': z.object({
    pending: PendingMessageSchema,
  }),
  /** 待发消息变了（内容、方式、状态，含到终态），完整的消息，替换同一 `id` 的上一份。 */
  'pending.updated': z.object({
    pending: PendingMessageSchema,
  }),
  /** 一条插话进了回合 `turnId`（0.8.0）；事件的位置就是模型看到它的位置。 */
  'user.steered': z.object({
    turnId: TurnIdSchema,
    pendingId: PendingMessageIdSchema,
    clientMessageId: z.string().optional(),
    content: z.array(UserContentPartSchema).min(1),
    sentBy: ClientIdentitySchema,
  }),
} as const;

export type WevirEventType = keyof typeof EventPayloadSchemas;
export type WevirEventPayload<T extends WevirEventType> = z.infer<(typeof EventPayloadSchemas)[T]>;

export const WEVIR_EVENT_TYPES = Object.keys(EventPayloadSchemas) as WevirEventType[];

/**
 * 信封，`payload` 不校验。客户端先用它解析：`type` 不在 `WEVIR_EVENT_TYPES` 里就忽略这条事件，
 * 但照常推进 `lastSeq`（host-api.md「订阅语义」）。
 */
export const WevirEventEnvelopeSchema = z.object({
  /** 会话内从 1 开始连续递增，无空洞。 */
  seq: SeqSchema,
  sessionId: SessionIdSchema,
  /** Host 追加时的时间。 */
  ts: IsoTimeSchema,
  type: z.string().min(1),
  /** `engine` = 引擎事实的投影；`host` = Host 自己的事实或推导。 */
  source: EventSourceSchema,
  payload: z.unknown(),
});
export type WevirEventEnvelope = z.infer<typeof WevirEventEnvelopeSchema>;

function eventSchema<T extends WevirEventType>(type: T) {
  return WevirEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: EventPayloadSchemas[type],
  });
}

export const SessionCreatedEventSchema = eventSchema('session.created');
export const SessionResumedEventSchema = eventSchema('session.resumed');
export const SessionReadOnlyEventSchema = eventSchema('session.read_only');
export const SessionTitleChangedEventSchema = eventSchema('session.title_changed');
export const SessionConfiguredEventSchema = eventSchema('session.configured');
export const SessionStateChangedEventSchema = eventSchema('session.state_changed');
export const UserMessageEventSchema = eventSchema('user.message');
export const TurnStartedEventSchema = eventSchema('turn.started');
export const TurnFinishedEventSchema = eventSchema('turn.finished');
export const AssistantDeltaEventSchema = eventSchema('assistant.delta');
export const AssistantStreamEndedEventSchema = eventSchema('assistant.stream_ended');
export const AssistantMessageEventSchema = eventSchema('assistant.message');
export const AssistantThoughtEventSchema = eventSchema('assistant.thought');
export const ToolStartedEventSchema = eventSchema('tool.started');
export const ToolUpdatedEventSchema = eventSchema('tool.updated');
export const ToolFinishedEventSchema = eventSchema('tool.finished');
export const TodoUpdatedEventSchema = eventSchema('todo.updated');
export const ApprovalRequestedEventSchema = eventSchema('approval.requested');
export const ApprovalResolvedEventSchema = eventSchema('approval.resolved');
export const QuestionRequestedEventSchema = eventSchema('question.requested');
export const QuestionResolvedEventSchema = eventSchema('question.resolved');
export const UsageUpdatedEventSchema = eventSchema('usage.updated');
export const EngineErrorEventSchema = eventSchema('engine.error');
export const EngineRawEventSchema = eventSchema('engine.raw');
export const SubagentStartedEventSchema = eventSchema('subagent.started');
export const SubagentUpdatedEventSchema = eventSchema('subagent.updated');
export const PendingAddedEventSchema = eventSchema('pending.added');
export const PendingUpdatedEventSchema = eventSchema('pending.updated');
export const UserSteeredEventSchema = eventSchema('user.steered');

/** 已知事件的判别联合，按 `type` 区分 `payload`。 */
export const WevirEventSchema = z.discriminatedUnion('type', [
  SessionCreatedEventSchema,
  SessionResumedEventSchema,
  SessionReadOnlyEventSchema,
  SessionTitleChangedEventSchema,
  SessionConfiguredEventSchema,
  SessionStateChangedEventSchema,
  UserMessageEventSchema,
  TurnStartedEventSchema,
  TurnFinishedEventSchema,
  AssistantDeltaEventSchema,
  AssistantStreamEndedEventSchema,
  AssistantMessageEventSchema,
  AssistantThoughtEventSchema,
  ToolStartedEventSchema,
  ToolUpdatedEventSchema,
  ToolFinishedEventSchema,
  TodoUpdatedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  UsageUpdatedEventSchema,
  EngineErrorEventSchema,
  EngineRawEventSchema,
  SubagentStartedEventSchema,
  SubagentUpdatedEventSchema,
  PendingAddedEventSchema,
  PendingUpdatedEventSchema,
  UserSteeredEventSchema,
]);
export type WevirEvent = z.infer<typeof WevirEventSchema>;
export type WevirEventOf<T extends WevirEventType> = Extract<WevirEvent, { type: T }>;

export function isKnownEventType(type: string): type is WevirEventType {
  return Object.hasOwn(EventPayloadSchemas, type);
}
