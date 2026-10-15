import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as protocol from './index.js';
import {
  AccountKindSchema,
  AccountLoginMethodSchema,
  AccountLoginSchema,
  AccountRateLimitWindowSchema,
  AccountStateSchema,
  ActiveTurnSchema,
  ApprovalDetailSchema,
  ApprovalIdSchema,
  ApprovalOptionSchema,
  ApprovalRequestSchema,
  ApprovalResolutionReasonSchema,
  ApprovalResolutionSchema,
  ApprovalStatusSchema,
  ClientCapabilitiesSchema,
  ClientFrameSchema,
  ClientIdentitySchema,
  ClientKindSchema,
  ClientTokenSchema,
  EngineErrorCategorySchema,
  EngineErrorInfoSchema,
  ErrorDataSchemas,
  EventPayloadSchemas,
  EventSourceSchema,
  HostFeaturesSchema,
  HostFrameSchema,
  HostIdSchema,
  HostSettingsSchema,
  HttpUrlSchema,
  IsoTimeSchema,
  JsonRpcErrorObjectSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcIdSchema,
  JsonRpcNotificationSchema,
  JsonRpcParamsSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcSuccessResponseSchema,
  MethodSchemas,
  NotificationSchemas,
  PendingDeliverySchema,
  PendingFallbackReasonSchema,
  PendingMessageIdSchema,
  PendingMessageSchema,
  PendingStatusSchema,
  PermissionModeSchema,
  PermissionsSchema,
  ProtocolVersionSchema,
  ProviderApiSchema,
  ProviderCompatSchema,
  ProviderIdSchema,
  ProviderKindSchema,
  ProviderModelSchema,
  ProviderProfileSchema,
  ProviderReasoningLevelSchema,
  ProviderTestFailureSchema,
  QuestionAnswerSchema,
  QuestionIdSchema,
  QuestionRequestSchema,
  QuestionResolutionSchema,
  QuestionStatusSchema,
  ResolvedApprovalStatusSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionIdSchema,
  SessionReadOnlyReasonSchema,
  SessionReadOnlySchema,
  SessionSchema,
  SessionSnapshotSchema,
  SessionStateSchema,
  StateChangeReasonSchema,
  StreamBlockRefSchema,
  StreamIdSchema,
  SubagentInfoSchema,
  SubagentStatusSchema,
  SubagentSummarySchema,
  SubscriptionIdSchema,
  TitleSourceSchema,
  TodoItemSchema,
  ToolDisplayKindSchema,
  ToolDisplaySchema,
  ToolFinishStatusSchema,
  ToolOutputSchema,
  TruncatedJsonSchema,
  TurnIdSchema,
  TurnOutcomeSchema,
  UsageSchema,
  UserContentPartSchema,
  UserQuestionOptionSchema,
  UserQuestionSchema,
  WEVIR_EVENT_TYPES,
  WevirEventEnvelopeSchema,
  WevirEventSchema,
  type WevirEventType,
  WorkspaceIdSchema,
  WorkspaceSchema,
} from './index.js';
import {
  childSession,
  compatibleProvider,
  deepseekProvider,
  errorDataSamples,
  eventOf,
  eventPayloads,
  identity,
  ids,
  methodSamples,
  notificationSamples,
  pendingApproval,
  pendingHeld,
  pendingQuestion,
  pendingSteer,
  readOnlySession,
  session,
  signedInAccount,
  signingInAccount,
  snapshot,
  subagentSummary,
  TS,
  toolDisplay,
  ULID,
  userResolution,
  workspace,
} from './test-samples.js';

const { payload: _payload, ...withoutPayload } = eventOf('turn.started');

interface Case {
  name: string;
  schema: z.ZodType;
  valid: unknown[];
  invalid: unknown[];
}

const standaloneCases: Case[] = [
  // version / common
  {
    name: 'ProtocolVersion',
    schema: ProtocolVersionSchema,
    valid: ['0.1.0', '12.0.3'],
    invalid: ['0.1', 'v0.1.0', '0.1.0-beta.1', '01.0.0'],
  },
  {
    name: 'WorkspaceId',
    schema: WorkspaceIdSchema,
    valid: [ids.workspace],
    invalid: ['ws_', `ses_${ULID}`, 'ws_a-b'],
  },
  {
    name: 'SessionId',
    schema: SessionIdSchema,
    valid: [ids.session],
    invalid: [`ws_${ULID}`, 'ses_'],
  },
  { name: 'TurnId', schema: TurnIdSchema, valid: [ids.turn], invalid: ['turn_1'] },
  { name: 'ApprovalId', schema: ApprovalIdSchema, valid: [ids.approval], invalid: ['apr_x y'] },
  {
    name: 'StreamId',
    schema: StreamIdSchema,
    valid: [ids.stream],
    invalid: [`stm_${'a'.repeat(65)}`],
  },
  { name: 'SubscriptionId', schema: SubscriptionIdSchema, valid: [ids.subscription], invalid: [1] },
  { name: 'HostId', schema: HostIdSchema, valid: [ids.host], invalid: ['host_1'] },
  {
    name: 'PendingMessageId',
    schema: PendingMessageIdSchema,
    valid: [ids.pending],
    invalid: ['pnd_', ids.turn],
  },
  {
    name: 'QuestionId',
    schema: QuestionIdSchema,
    valid: [ids.question],
    invalid: ['qst_', ids.approval],
  },
  {
    name: 'ProviderId',
    schema: ProviderIdSchema,
    valid: ['deepseek-official', 'a', 'local-ollama-2'],
    invalid: ['DeepSeek', '1abc', 'a_b', `a${'b'.repeat(32)}`],
  },
  {
    name: 'IsoTime',
    schema: IsoTimeSchema,
    valid: [TS],
    invalid: ['2026-10-12T08:00:00Z', '2026-10-12T16:00:00.000+08:00', '2026-10-12'],
  },
  { name: 'Seq', schema: SeqSchema, valid: [1, 42], invalid: [0, -1, 1.5] },
  { name: 'SeqCursor', schema: SeqCursorSchema, valid: [0, 42], invalid: [-1, '3'] },
  {
    name: 'ClientToken',
    schema: ClientTokenSchema,
    valid: ['dev-1'],
    invalid: ['', 'x'.repeat(129)],
  },
  {
    name: 'ClientKind',
    schema: ClientKindSchema,
    valid: ['desktop', 'cli', 'mobile'],
    invalid: ['browser'],
  },
  {
    name: 'ClientIdentity',
    schema: ClientIdentitySchema,
    valid: [identity],
    invalid: [{ deviceId: 'd', clientKind: 'cli' }],
  },
  // capabilities
  {
    name: 'ClientCapabilities',
    schema: ClientCapabilitiesSchema,
    valid: [{}, { futureCap: true }, { title_source_generated: true }],
    invalid: [null, ['a'], { title_source_generated: 'yes' }],
  },
  {
    name: 'HostFeatures',
    schema: HostFeaturesSchema,
    valid: [{}, { futureFeature: { level: 2 } }],
    invalid: ['all'],
  },
  {
    name: 'Permissions',
    schema: PermissionsSchema,
    valid: [[], [...protocol.PERMISSIONS], ['device.future']],
    invalid: [[''], 'all'],
  },
  // entities
  {
    name: 'Workspace',
    schema: WorkspaceSchema,
    valid: [workspace],
    invalid: [{ ...workspace, rootPath: '' }],
  },
  {
    name: 'ProviderKind',
    schema: ProviderKindSchema,
    valid: ['openai-compatible'],
    invalid: ['anthropic'],
  },
  {
    name: 'ProviderApi',
    schema: ProviderApiSchema,
    valid: ['anthropic-messages'],
    invalid: ['openai'],
  },
  {
    name: 'ProviderReasoningLevel',
    schema: ProviderReasoningLevelSchema,
    valid: ['off', 'xhigh'],
    invalid: ['none', 'High'],
  },
  {
    name: 'ProviderModel',
    schema: ProviderModelSchema,
    valid: [
      { id: 'm' },
      { id: 'm', contextWindow: 8192 },
      { id: 'm', maxTokens: 4096, supportsImages: true, reasoningEfforts: ['off', 'high'] },
      { id: 'm', reasoningEfforts: [] },
    ],
    invalid: [
      { id: '' },
      { id: 'm', contextWindow: 0 },
      { id: 'm', maxTokens: 0 },
      { id: 'm', reasoningEfforts: ['turbo'] },
    ],
  },
  {
    name: 'ProviderCompat',
    schema: ProviderCompatSchema,
    valid: [
      {},
      { maxTokensField: 'max_completion_tokens' },
      // 0.4.0：只有模型网关用的两个开关。
      { supportsCustomTools: false, systemMessageMode: 'merge' },
    ],
    invalid: [
      { maxTokensField: 'tokens' },
      { systemMessageMode: 'top' },
      { supportsCustomTools: 'no' },
    ],
  },
  {
    name: 'HttpUrl',
    schema: HttpUrlSchema,
    valid: ['https://api.deepseek.com', 'http://localhost:11434/v1'],
    invalid: ['localhost:11434', 'ftp://x.y'],
  },
  {
    name: 'ProviderProfile',
    schema: ProviderProfileSchema,
    valid: [deepseekProvider, compatibleProvider],
    invalid: [{ ...deepseekProvider, kind: 'deepseek' }],
  },
  {
    name: 'ProviderTestFailure',
    schema: ProviderTestFailureSchema,
    valid: ['auth', 'model_not_found'],
    invalid: ['401', ''],
  },
  {
    name: 'EngineErrorCategory',
    schema: EngineErrorCategorySchema,
    valid: ['provider'],
    invalid: ['network'],
  },
  {
    name: 'EngineErrorInfo',
    schema: EngineErrorInfoSchema,
    valid: [{ category: 'unknown', message: '' }],
    invalid: [{ category: 'unknown' }],
  },
  {
    name: 'ToolDisplayKind',
    schema: ToolDisplayKindSchema,
    valid: ['sub_agent'],
    invalid: ['subagent'],
  },
  {
    name: 'ToolDisplay',
    schema: ToolDisplaySchema,
    valid: [toolDisplay, { kind: 'unknown', mcpServer: 'github' }],
    invalid: [{ summary: 'x' }],
  },
  {
    name: 'ToolOutput',
    schema: ToolOutputSchema,
    valid: [{ text: '', truncated: false }],
    invalid: [{ text: 'x', truncated: true, originalLength: -1 }],
  },
  {
    name: 'TruncatedJson',
    schema: TruncatedJsonSchema,
    valid: [{ $truncated: true, originalLength: 300000, preview: '{"a":' }],
    invalid: [{ $truncated: false, originalLength: 1, preview: '' }],
  },
  {
    name: 'TodoItem',
    schema: TodoItemSchema,
    valid: [{ content: 'x', status: 'blocked' }],
    invalid: [{ status: 'pending' }],
  },
  {
    name: 'Usage',
    schema: UsageSchema,
    valid: [{ contextUsed: 0, contextSize: 0 }],
    invalid: [{ contextUsed: 1 }],
  },
  {
    name: 'StreamBlockRef',
    schema: StreamBlockRefSchema,
    valid: [{ streamId: ids.stream, blockIndex: 3 }],
    invalid: [{ streamId: ids.turn, blockIndex: 3 }],
  },
  {
    name: 'UserContentPart',
    schema: UserContentPartSchema,
    valid: [{ type: 'text', text: '' }],
    invalid: [{ type: 'image', url: 'x' }, { type: 'text' }],
  },
  {
    name: 'ApprovalStatus',
    schema: ApprovalStatusSchema,
    valid: ['expired'],
    invalid: ['rejected'],
  },
  {
    name: 'ApprovalOption',
    schema: ApprovalOptionSchema,
    valid: [pendingApproval.options[0]],
    invalid: [{ optionId: 'x', label: 'x', kind: 'allow_once', category: 'maybe' }],
  },
  {
    name: 'ApprovalDetail',
    schema: ApprovalDetailSchema,
    valid: [pendingApproval.detail, { toolName: 'bash', display: { kind: 'shell' } }],
    invalid: [{ toolName: 'bash' }],
  },
  {
    name: 'ApprovalResolutionReason',
    schema: ApprovalResolutionReasonSchema,
    valid: ['host_restarted'],
    invalid: ['timeout'],
  },
  {
    name: 'ApprovalResolution',
    schema: ApprovalResolutionSchema,
    valid: [userResolution, { reason: 'engine_exited' }],
    invalid: [{ optionId: 'allow-once' }],
  },
  {
    name: 'ResolvedApprovalStatus',
    schema: ResolvedApprovalStatusSchema,
    valid: ['denied'],
    invalid: ['pending'],
  },
  {
    name: 'ApprovalRequest',
    schema: ApprovalRequestSchema,
    valid: [pendingApproval, { ...pendingApproval, detail: null }],
    invalid: [{ ...pendingApproval, detail: undefined }],
  },
  { name: 'SessionState', schema: SessionStateSchema, valid: ['cancelling'], invalid: ['stopped'] },
  {
    name: 'ActiveTurn',
    schema: ActiveTurnSchema,
    valid: [{ turnId: ids.turn, startedAt: TS }],
    invalid: [{ turnId: ids.turn }],
  },
  {
    name: 'TitleSource',
    schema: TitleSourceSchema,
    valid: ['user', 'generated'],
    invalid: ['engine'],
  },
  {
    name: 'SessionReadOnlyReason',
    schema: SessionReadOnlyReasonSchema,
    valid: ['engine_session_corrupted'],
    invalid: ['engine_session_missing'],
  },
  {
    name: 'SessionReadOnly',
    schema: SessionReadOnlySchema,
    valid: [readOnlySession.readOnly],
    invalid: [{ reason: 'engine_session_not_found', message: 'x' }],
  },
  {
    name: 'Session',
    schema: SessionSchema,
    valid: [
      session,
      { ...session, engine: { kind: 'future-engine', sessionId: 'x' } },
      readOnlySession,
      childSession,
    ],
    invalid: [
      { ...session, workspaceId: ids.session },
      { ...childSession, parentSessionId: ids.workspace },
    ],
  },
  {
    name: 'SubagentStatus',
    schema: SubagentStatusSchema,
    valid: ['running', 'closed'],
    invalid: ['pendingInit'],
  },
  {
    name: 'SubagentInfo',
    schema: SubagentInfoSchema,
    valid: [childSession.subagent, { ...childSession.subagent, endedAt: TS }],
    invalid: [{ ...childSession.subagent, parentToolCallId: '' }],
  },
  {
    name: 'SubagentSummary',
    schema: SubagentSummarySchema,
    valid: [subagentSummary],
    invalid: [{ ...subagentSummary, modelId: '' }],
  },
  // 账号（0.7.0）
  { name: 'AccountKind', schema: AccountKindSchema, valid: ['chatgpt'], invalid: ['ChatGPT'] },
  {
    name: 'AccountLoginMethod',
    schema: AccountLoginMethodSchema,
    valid: ['browser', 'device_code'],
    invalid: ['deviceCode'],
  },
  {
    name: 'AccountLogin',
    schema: AccountLoginSchema,
    valid: [signingInAccount.login],
    invalid: [{ ...signingInAccount.login, startedAt: 'yesterday' }],
  },
  {
    name: 'AccountRateLimitWindow',
    schema: AccountRateLimitWindowSchema,
    valid: [{ usedPercent: 0 }, { usedPercent: 99.5, windowMinutes: 300, resetsAt: TS }],
    invalid: [{ usedPercent: 10, windowMinutes: 0 }],
  },
  {
    name: 'AccountState',
    schema: AccountStateSchema,
    valid: [signedInAccount, signingInAccount, { kind: 'chatgpt', status: 'signed_out' }],
    invalid: [{ kind: 'chatgpt', status: 'signed_in', rateLimits: { primary: {} } }],
  },
  { name: 'PendingDelivery', schema: PendingDeliverySchema, valid: ['queue'], invalid: ['now'] },
  {
    name: 'PermissionMode',
    schema: PermissionModeSchema,
    valid: ['on_request', 'auto_review', 'full_access'],
    invalid: ['never', ''],
  },
  { name: 'PendingStatus', schema: PendingStatusSchema, valid: ['held'], invalid: ['paused'] },
  {
    name: 'PendingFallbackReason',
    schema: PendingFallbackReasonSchema,
    valid: ['unsupported'],
    invalid: ['busy'],
  },
  {
    name: 'PendingMessage',
    schema: PendingMessageSchema,
    valid: [pendingSteer, pendingHeld, { ...pendingSteer, status: 'inserted', turnId: ids.turn }],
    invalid: [
      { ...pendingSteer, content: [] },
      { ...pendingHeld, fallback: {} },
    ],
  },
  {
    name: 'UserQuestionOption',
    schema: UserQuestionOptionSchema,
    valid: [{ label: '全链路' }, { label: '全链路', description: '协议、Host 与界面' }],
    invalid: [{ label: '' }, { description: 'x' }],
  },
  {
    name: 'UserQuestion',
    schema: UserQuestionSchema,
    valid: pendingQuestion.questions,
    invalid: [
      { id: 'a', question: '', options: [] },
      { question: 'q', options: [] },
    ],
  },
  {
    name: 'QuestionAnswer',
    schema: QuestionAnswerSchema,
    valid: [{ answers: [] }, { answers: ['macOS', 'Linux'] }],
    invalid: [{}, { answers: 'x' }],
  },
  {
    name: 'QuestionStatus',
    schema: QuestionStatusSchema,
    valid: ['pending', 'answered', 'cancelled'],
    invalid: ['skipped'],
  },
  {
    name: 'QuestionResolution',
    schema: QuestionResolutionSchema,
    valid: [
      { reason: 'user', answers: { scope: { answers: ['全链路'] } }, answeredBy: identity },
      { reason: 'turn_cancelled' },
    ],
    invalid: [{}, { reason: 'timeout' }],
  },
  {
    name: 'QuestionRequest',
    schema: QuestionRequestSchema,
    valid: [pendingQuestion],
    invalid: [
      { ...pendingQuestion, questions: [] },
      { ...pendingQuestion, id: ids.approval },
    ],
  },
  {
    name: 'HostSettings',
    schema: HostSettingsSchema,
    valid: [{ sendWhileBusy: 'steer' }],
    invalid: [{}, { sendWhileBusy: 'later' }],
  },
  {
    name: 'SessionSnapshot',
    schema: SessionSnapshotSchema,
    valid: [snapshot, { ...snapshot, pendingMessages: [pendingSteer, pendingHeld] }],
    invalid: [{ ...snapshot, pendingApprovals: undefined }],
  },
  // events
  { name: 'EventSource', schema: EventSourceSchema, valid: ['engine'], invalid: ['client'] },
  {
    name: 'StateChangeReason',
    schema: StateChangeReasonSchema,
    valid: ['resumed'],
    invalid: ['restarted'],
  },
  { name: 'TurnOutcome', schema: TurnOutcomeSchema, valid: ['interrupted'], invalid: ['aborted'] },
  {
    name: 'ToolFinishStatus',
    schema: ToolFinishStatusSchema,
    valid: ['unknown'],
    invalid: ['in_progress'],
  },
  {
    name: 'WevirEventEnvelope',
    schema: WevirEventEnvelopeSchema,
    valid: [
      eventOf('turn.started'),
      { ...eventOf('turn.started'), type: 'future.event', payload: { x: 1 } },
    ],
    invalid: [{ ...eventOf('turn.started'), seq: 0 }, withoutPayload],
  },
  {
    name: 'WevirEvent',
    schema: WevirEventSchema,
    valid: WEVIR_EVENT_TYPES.map((type) => eventOf(type)),
    invalid: [
      { ...eventOf('turn.started'), type: 'future.event' },
      { ...eventOf('turn.started'), source: 'client' },
    ],
  },
  // jsonrpc
  { name: 'JsonRpcId', schema: JsonRpcIdSchema, valid: [1, 'req-1'], invalid: [null, 1.5, ''] },
  {
    name: 'JsonRpcParams',
    schema: JsonRpcParamsSchema,
    valid: [{}, { a: 1 }],
    invalid: [[1, 2], 'x'],
  },
  {
    name: 'JsonRpcRequest',
    schema: JsonRpcRequestSchema,
    valid: [
      { jsonrpc: '2.0', id: 1, method: 'host.ping', params: {} },
      { jsonrpc: '2.0', id: 'a', method: 'host.ping' },
    ],
    invalid: [
      { jsonrpc: '1.0', id: 1, method: 'host.ping' },
      { jsonrpc: '2.0', method: 'host.ping' },
      { jsonrpc: '2.0', id: 1, method: 'x', params: [1] },
    ],
  },
  {
    name: 'ClientFrame',
    schema: ClientFrameSchema,
    valid: [{ jsonrpc: '2.0', id: 2, method: 'session.get', params: { sessionId: ids.session } }],
    invalid: [[{ jsonrpc: '2.0', id: 1, method: 'host.ping' }]],
  },
  {
    name: 'JsonRpcNotification',
    schema: JsonRpcNotificationSchema,
    valid: [
      {
        jsonrpc: '2.0',
        method: 'events.event',
        params: notificationSamples['events.event'].valid[0],
      },
    ],
    invalid: [{ jsonrpc: '2.0', id: 1, method: 'events.event' }],
  },
  {
    name: 'JsonRpcErrorObject',
    schema: JsonRpcErrorObjectSchema,
    valid: [{ code: -32021, message: 'session is busy', data: { state: 'running' } }],
    invalid: [{ code: '-32021', message: 'x' }],
  },
  {
    name: 'JsonRpcSuccessResponse',
    schema: JsonRpcSuccessResponseSchema,
    valid: [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 1, result: null },
    ],
    invalid: [{ jsonrpc: '2.0', id: 1 }],
  },
  {
    name: 'JsonRpcErrorResponse',
    schema: JsonRpcErrorResponseSchema,
    valid: [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }],
    invalid: [{ jsonrpc: '2.0', id: 1, error: { message: 'x' } }],
  },
  {
    name: 'JsonRpcResponse',
    schema: JsonRpcResponseSchema,
    valid: [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    ],
    invalid: [{ jsonrpc: '2.0', id: 1 }],
  },
  {
    name: 'HostFrame',
    schema: HostFrameSchema,
    valid: [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'events.event', params: {} },
    ],
    invalid: [{ jsonrpc: '2.0', id: 1, method: 'host.ping' }],
  },
];

const registryCases: Case[] = [
  ...Object.entries(MethodSchemas).flatMap(([method, spec]) => {
    const samples = methodSamples[method as protocol.MethodName];
    return [
      { name: `${method} params`, schema: spec.params, ...samples.params },
      { name: `${method} result`, schema: spec.result, ...samples.result },
    ];
  }),
  ...Object.entries(NotificationSchemas).map(([name, spec]) => ({
    name: `${name} params`,
    schema: spec.params,
    ...notificationSamples[name as protocol.NotificationName],
  })),
  ...Object.entries(EventPayloadSchemas).map(([type, schema]) => {
    const sample = eventPayloads[type as WevirEventType];
    return { name: `${type} payload`, schema, valid: [sample.valid], invalid: [sample.invalid] };
  }),
  ...WEVIR_EVENT_TYPES.map((type) => ({
    name: `${type} event`,
    schema: WevirEventSchema.options.find((option) =>
      (option.shape.type.values as Set<string>).has(type),
    ) as z.ZodType,
    valid: [eventOf(type)],
    invalid: [{ ...eventOf(type), payload: eventPayloads[type].invalid }],
  })),
  ...Object.entries(ErrorDataSchemas).map(([name, schema]) => {
    const sample = errorDataSamples[name as keyof typeof ErrorDataSchemas];
    return { name: `${name} error data`, schema, valid: [sample.valid], invalid: [sample.invalid] };
  }),
];

const allCases = [...standaloneCases, ...registryCases];

describe('每个 schema 的合法与非法样例', () => {
  for (const { name, schema, valid, invalid } of allCases) {
    it(name, () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
      for (const sample of valid) {
        const result = schema.safeParse(sample);
        expect(result.error?.issues, `合法样例被拒：${JSON.stringify(sample)}`).toBeUndefined();
      }
      for (const sample of invalid) {
        expect(schema.safeParse(sample).success, `非法样例被接受：${JSON.stringify(sample)}`).toBe(
          false,
        );
      }
    });
  }

  it('覆盖了包导出的全部 schema 和注册表里的全部 schema', () => {
    const covered = new Set<z.ZodType>(allCases.map((c) => c.schema));
    const exported = Object.entries(protocol as Record<string, unknown>).filter(
      (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
    );
    const registries: [string, z.ZodType][] = [
      ...Object.entries(MethodSchemas).flatMap(([m, s]): [string, z.ZodType][] => [
        [`${m} params`, s.params],
        [`${m} result`, s.result],
      ]),
      ...Object.entries(NotificationSchemas).map(([n, s]): [string, z.ZodType] => [n, s.params]),
      ...Object.entries(EventPayloadSchemas),
      ...Object.entries(ErrorDataSchemas),
    ];
    const missing = [...exported, ...registries]
      .filter(([, schema]) => !covered.has(schema))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});

describe('schema 只做结构声明', () => {
  // transform / preprocess / catch 会让 schema 的输入与输出不同，也无法被 zod-aot 一类的生成器编译
  // （ADR-0002 §2）；default 只允许放在原始类型叶子上。
  function walk(schema: z.core.$ZodType, path: string, seen: Set<unknown>, found: string[]) {
    if (seen.has(schema)) return;
    seen.add(schema);
    const def = schema._zod.def as z.core.$ZodTypeDef & Record<string, unknown>;
    if (def.type === 'pipe' || def.type === 'transform' || def.type === 'catch') {
      found.push(`${path}: ${def.type}`);
    }
    if (def.type === 'default' || def.type === 'prefault') {
      const inner = (def.innerType as z.core.$ZodType)._zod.def.type;
      if (!['string', 'number', 'int', 'boolean', 'bigint', 'literal', 'enum'].includes(inner)) {
        found.push(`${path}: default on ${inner}`);
      }
    }
    for (const [key, value] of Object.entries(def)) {
      if (value instanceof z.core.$ZodType) walk(value, `${path}.${key}`, seen, found);
      else if (Array.isArray(value)) {
        value.forEach((v, i) => {
          if (v instanceof z.core.$ZodType) walk(v, `${path}.${key}[${i}]`, seen, found);
        });
      } else if (key === 'shape' && value && typeof value === 'object') {
        for (const [field, v] of Object.entries(value)) {
          if (v instanceof z.core.$ZodType) walk(v, `${path}.${field}`, seen, found);
        }
      }
    }
  }

  it('没有 transform / preprocess / catch，default 只在原始类型上', () => {
    const found: string[] = [];
    const seen = new Set<unknown>();
    for (const c of allCases) walk(c.schema, c.name, seen, found);
    expect(found).toEqual([]);
  });

  it('检查器能发现违规（自测）', () => {
    const found: string[] = [];
    const bad = z.object({
      a: z.string().transform((s) => s.length),
      b: z.object({ c: z.string() }).default({ c: '' }),
    });
    walk(bad, 'bad', new Set(), found);
    expect(found).toContain('bad.a: pipe');
    expect(found).toContain('bad.b: default on object');
  });
});

describe('ProviderCompat 的通用工具方言（0.12.0）', () => {
  it('新字段 optional；false 与 auto_only 原样保留，省略时不补默认值', () => {
    expect(ProviderCompatSchema.parse({})).toEqual({});
    for (const supportsNamespaceTools of [false, true]) {
      for (const toolChoice of ['any', 'auto_only']) {
        expect(ProviderCompatSchema.parse({ supportsNamespaceTools, toolChoice })).toEqual({
          supportsNamespaceTools,
          toolChoice,
        });
      }
    }
  });

  it('不接受非布尔的 namespace 开关或不认识的工具选择策略', () => {
    expect(ProviderCompatSchema.safeParse({ supportsNamespaceTools: 'false' }).success).toBe(false);
    expect(ProviderCompatSchema.safeParse({ toolChoice: 'required' }).success).toBe(false);
  });
});
