import { z } from 'zod';
import {
  ApprovalIdSchema,
  ClientIdentitySchema,
  IsoTimeSchema,
  ProviderIdSchema,
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
  ResolvedApprovalStatusSchema,
  SessionStateSchema,
  StreamBlockRefSchema,
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
  }),
  'session.title_changed': z.object({
    title: z.string(),
    source: TitleSourceSchema,
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
  }),
  'turn.started': z.object({
    turnId: TurnIdSchema,
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
    protocol: z.literal('acp'),
    /** 如 `session/update`。 */
    method: z.string(),
    /** `session/update` 的 `sessionUpdate` 值。 */
    kind: z.string().optional(),
    /** 原样（截断后）。 */
    params: z.unknown().optional(),
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
export const SessionTitleChangedEventSchema = eventSchema('session.title_changed');
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
export const UsageUpdatedEventSchema = eventSchema('usage.updated');
export const EngineErrorEventSchema = eventSchema('engine.error');
export const EngineRawEventSchema = eventSchema('engine.raw');

/** 已知事件的判别联合，按 `type` 区分 `payload`。 */
export const WevirEventSchema = z.discriminatedUnion('type', [
  SessionCreatedEventSchema,
  SessionTitleChangedEventSchema,
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
  UsageUpdatedEventSchema,
  EngineErrorEventSchema,
  EngineRawEventSchema,
]);
export type WevirEvent = z.infer<typeof WevirEventSchema>;
export type WevirEventOf<T extends WevirEventType> = Extract<WevirEvent, { type: T }>;

export function isKnownEventType(type: string): type is WevirEventType {
  return Object.hasOwn(EventPayloadSchemas, type);
}
