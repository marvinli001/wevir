import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as protocol from './index.js';
import {
  AccountKindSchema,
  AccountLabelSchema,
  AccountLoginMethodSchema,
  AccountLoginOptionSchema,
  AccountLoginSchema,
  AccountRateLimitWindowSchema,
  AccountStateSchema,
  AccountUpstreamMethodSchema,
  AccountUpstreamSchema,
  ActiveTurnSchema,
  ApprovalDetailSchema,
  ApprovalIdSchema,
  ApprovalOptionSchema,
  ApprovalRequestSchema,
  ApprovalResolutionReasonSchema,
  ApprovalResolutionSchema,
  ApprovalStatusSchema,
  BoardTaskNoteSchema,
  BoardTaskSchema,
  BoardTaskStatusSchema,
  ClientCapabilitiesSchema,
  ClientFrameSchema,
  ClientIdentitySchema,
  ClientKindSchema,
  ClientTokenSchema,
  CollaborationModeSchema,
  CompactionTriggerSchema,
  DiffFileSchema,
  DiffSourceSchema,
  DiscoveredProviderModelSchema,
  EngineErrorCategorySchema,
  EngineErrorInfoSchema,
  EngineFeaturesSchema,
  EnvironmentFolderSchema,
  EnvironmentIdSchema,
  EnvironmentSchema,
  ErrorDataSchemas,
  EventPayloadSchemas,
  EventSourceSchema,
  FilesRestoreSchema,
  GitFileChangeSchema,
  GitObjectIdSchema,
  GoalStatusSchema,
  HandoffBindingSchema,
  HandoffConfigureSchema,
  HandoffHashSchema,
  HandoffMaterialRequestSchema,
  HandoffNoteRefSchema,
  HandoffOmittedRangeSchema,
  HandoffPreviewSchema,
  HandoffStrategySchema,
  HostFeaturesSchema,
  HostFrameSchema,
  HostIdSchema,
  HostSettingsSchema,
  HttpUrlSchema,
  ImageIdSchema,
  IsoTimeSchema,
  JsonRpcErrorObjectSchema,
  JsonRpcErrorResponseSchema,
  JsonRpcIdSchema,
  JsonRpcNotificationSchema,
  JsonRpcParamsSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcSuccessResponseSchema,
  MemoryAuthorSchema,
  MemoryNameSchema,
  MemoryNoteSchema,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemorySourceStatusSchema,
  MemorySummarySchema,
  MemoryTypeSchema,
  MessageFromSchema,
  MethodSchemas,
  NotificationSchemas,
  PendingDeliverySchema,
  PendingFallbackReasonSchema,
  PendingMessageIdSchema,
  PendingMessageSchema,
  PendingStatusSchema,
  PermissionModeSchema,
  PermissionsSchema,
  PROMPT_SUGGESTION_MAX_LENGTH,
  PreviewImageMimeTypeSchema,
  PromptSuggestionSchema,
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
  QuestionResolutionReasonSchema,
  QuestionResolutionSchema,
  QuestionStatusSchema,
  ResolvedApprovalStatusSchema,
  ReviewTargetSchema,
  RuleDeliveryChannelSchema,
  RuleFileDeliverySchema,
  RuleFileKindSchema,
  RuleFileSchema,
  RuleFileScopeSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionCommandSchema,
  SessionEngineSchema,
  SessionForkedFromSchema,
  SessionGoalSchema,
  SessionIdSchema,
  SessionOpenedBySchema,
  SessionOriginSchema,
  SessionReadOnlyReasonSchema,
  SessionReadOnlySchema,
  SessionRecapSchema,
  SessionRulesSchema,
  SessionSchema,
  SessionSnapshotSchema,
  SessionStateSchema,
  SessionUsageSchema,
  SessionWorktreeSchema,
  SessionWorktreeUsageSchema,
  SharedFileSchema,
  StateChangeReasonSchema,
  StreamBlockRefSchema,
  StreamIdSchema,
  SubagentInfoSchema,
  SubagentStatusSchema,
  SubagentSummarySchema,
  SubscriptionIdSchema,
  SubscriptionKindSchema,
  SuggestedTaskSchema,
  TaskIdSchema,
  TitleSourceSchema,
  TodoItemSchema,
  ToolDisplayKindSchema,
  ToolDisplaySchema,
  ToolFinishStatusSchema,
  ToolGroupInfoSchema,
  ToolGroupSchema,
  ToolOutputSchema,
  ToolPresetIdSchema,
  ToolPresetInfoSchema,
  ToolPresetSchema,
  TruncatedJsonSchema,
  TurnCheckpointSchema,
  TurnCommandSchema,
  TurnIdSchema,
  TurnOutcomeSchema,
  TurnTriggerSchema,
  UiShowTargetSchema,
  UsageAggregateSchema,
  UsageBreakdownSchema,
  UsageCategorySchema,
  UsageCostSchema,
  UsageFilterSchema,
  UsageGroupSchema,
  UsageItemSchema,
  UsageModelAggregateSchema,
  UsagePriceSchema,
  UsagePricingSchema,
  UsageProviderAggregateSchema,
  UsageRecordSchema,
  UsageSchema,
  UsageTimingSchema,
  UsageTokensSchema,
  UserContentPartSchema,
  UserImageMimeTypeSchema,
  UserImagePartSchema,
  UserQuestionOptionSchema,
  UserQuestionSchema,
  VertexConfigSchema,
  WEVIR_EVENT_TYPES,
  WebSearchServiceIdSchema,
  WebSettingsSchema,
  WebTestFailureSchema,
  WevirEventEnvelopeSchema,
  WevirEventSchema,
  type WevirEventType,
  WorkspaceEntryKindSchema,
  WorkspaceEntrySchema,
  WorkspaceIdSchema,
  WorkspaceKindSchema,
  WorkspaceSchema,
  WorktreeModeSchema,
} from './index.js';
import {
  acceptance as acceptanceSample,
  agentProcess,
  boardTask,
  browserTab,
  checkDefinition,
  checkProcess,
  childSession,
  compatibleProvider,
  connectingUpstreamAccount,
  deepseekProvider,
  environment,
  errorDataSamples,
  eventOf,
  eventPayloads,
  exitedTerminal,
  gitStatusSample,
  handedOffSession,
  identity,
  ids,
  imagePart,
  methodSamples,
  notificationSamples,
  pendingApproval,
  pendingHeld,
  pendingQuestion,
  pendingSteer,
  promptSuggestion,
  readOnlySession,
  repairChain,
  reportedTask,
  reviewComment,
  sentReviewComment,
  session,
  sessionRules,
  sessionWithRules,
  signedInAccount,
  signingInAccount,
  snapshot,
  subagentSummary,
  suggestedTask,
  TS,
  terminalSample,
  toolDisplay,
  ULID,
  userResolution,
  verificationRun,
  waitingBoardTask,
  workbuddyLoginAccount,
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
  {
    name: 'AutomationId',
    schema: protocol.AutomationIdSchema,
    valid: ['aut_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    invalid: ['aut_', 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR'],
  },
  {
    name: 'AutomationRunId',
    schema: protocol.AutomationRunIdSchema,
    valid: ['arn_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    invalid: ['arn-1'],
  },
  {
    name: 'SessionAutomation',
    schema: protocol.SessionAutomationSchema,
    valid: [{ automationId: 'aut_1', runId: 'arn_1' }],
    invalid: [{ automationId: 'aut_1' }],
  },
  {
    name: 'AutomationTimeOfDay',
    schema: protocol.AutomationTimeOfDaySchema,
    valid: ['00:00', '09:30', '23:59'],
    invalid: ['9:30', '24:00', '12:60'],
  },
  {
    name: 'AutomationWeekday',
    schema: protocol.AutomationWeekdaySchema,
    valid: [0, 6],
    invalid: [7, -1, 1.5],
  },
  {
    name: 'AutomationSchedule',
    schema: protocol.AutomationScheduleSchema,
    valid: [
      { kind: 'manual' },
      { kind: 'once', at: '2026-10-23T09:00:00.000Z' },
      { kind: 'interval', minutes: 60 },
      { kind: 'daily', time: '09:00' },
      { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
      { kind: 'monthly', time: '08:00', day: 31 },
    ],
    invalid: [
      { kind: 'interval', minutes: 4 },
      { kind: 'once' },
      { kind: 'weekly', time: '09:00' },
    ],
  },
  {
    name: 'AutomationNotify',
    schema: protocol.AutomationNotifySchema,
    valid: ['always', 'important', 'failures', 'never'],
    invalid: ['loud'],
  },
  {
    name: 'AutomationCreator',
    schema: protocol.AutomationCreatorSchema,
    valid: [{ kind: 'user' }, { kind: 'agent', sessionId: 'ses_1' }],
    invalid: [{ kind: 'agent' }, { kind: 'host' }],
  },
  {
    name: 'AutomationRunTrigger',
    schema: protocol.AutomationRunTriggerSchema,
    valid: ['schedule', 'manual', 'catch_up'],
    invalid: ['webhook'],
  },
  {
    name: 'AutomationRunStatus',
    schema: protocol.AutomationRunStatusSchema,
    valid: ['running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped'],
    invalid: ['succeeded'],
  },
  {
    name: 'AutomationRun',
    schema: protocol.AutomationRunSchema,
    valid: [
      {
        id: 'arn_1',
        automationId: 'aut_1',
        trigger: 'manual',
        status: 'running',
        startedAt: '2026-10-20T20:00:00.000Z',
        sessionId: 'ses_1',
      },
      {
        id: 'arn_2',
        automationId: 'aut_1',
        trigger: 'schedule',
        status: 'completed',
        startedAt: '2026-10-20T20:00:00.000Z',
        finishedAt: '2026-10-20T20:01:00.000Z',
        quiet: true,
      },
    ],
    invalid: [
      { id: 'arn_1', automationId: 'aut_1', trigger: 'manual', status: 'running' },
      {
        id: 'arn_1',
        automationId: 'aut_1',
        trigger: 'manual',
        status: 'completed',
        startedAt: '2026-10-20T20:00:00.000Z',
        quiet: false,
      },
    ],
  },
  {
    name: 'Automation',
    schema: protocol.AutomationSchema,
    valid: [
      {
        id: 'aut_1',
        title: '每日站会摘要',
        prompt: '汇总昨天以来的提交。',
        schedule: { kind: 'manual' },
        timezone: 'Asia/Shanghai',
        enabled: true,
        providerId: 'deepseek',
        permissionMode: 'on_request',
        newSessionEachRun: false,
        sessionId: 'ses_1',
        notify: 'never',
        createdBy: { kind: 'user' },
        createdAt: '2026-10-20T20:00:00.000Z',
        updatedAt: '2026-10-20T20:00:00.000Z',
        runCount: 0,
      },
    ],
    invalid: [{ id: 'aut_1', title: 'x' }],
  },
  {
    name: 'ConnectorName',
    schema: protocol.ConnectorNameSchema,
    valid: ['sample', 'a_1-b'],
    invalid: ['wevir_x', 'Upper', '', '../x'],
  },
  {
    name: 'McpServerConfig',
    schema: protocol.McpServerConfigSchema,
    valid: [
      { transport: 'stdio', command: 'node', env: { KEY: 'input' } },
      { transport: 'http', url: 'https://example.com/mcp', headers: { Key: 'input' } },
    ],
    invalid: [
      { transport: 'stdio' },
      { transport: 'http', url: 'file:///tmp/x' },
      { transport: 'http', url: 'https://user:pass@example.com' },
      { transport: 'stdio', command: 'node', toolTimeoutSec: 0 },
    ],
  },
  {
    name: 'McpServerPatch',
    schema: protocol.McpServerPatchSchema,
    valid: [
      { transport: 'stdio', env: { KEY: null } },
      { transport: 'http', headers: {} },
    ],
    invalid: [{ env: {} }, { transport: 'http', headers: { KEY: true } }],
  },
  {
    name: 'McpServerView',
    schema: protocol.McpServerViewSchema,
    valid: [
      { transport: 'stdio', command: 'node', env: { KEY: true } },
      { transport: 'http', url: 'http://localhost/mcp', headers: { Authorization: true } },
    ],
    invalid: [
      { transport: 'stdio', command: 'node', env: { KEY: 'secret' } },
      { transport: 'http', url: 'http://localhost/mcp', headers: { Authorization: 'secret' } },
    ],
  },
  {
    name: 'Connector',
    schema: protocol.ConnectorSchema,
    valid: [
      {
        id: 'con_1',
        name: 'sample',
        config: { transport: 'stdio', command: 'node' },
        enabled: true,
        status: 'connected',
        authStatus: 'unsupported',
        tools: [{ name: 'ping' }],
      },
    ],
    invalid: [
      {
        id: 'con_1',
        name: 'wevir',
        config: { transport: 'stdio', command: 'node' },
        enabled: true,
      },
    ],
  },
  {
    name: 'Skill',
    schema: protocol.SkillSchema,
    valid: [
      {
        id: 'skl_1',
        name: 'sample',
        description: 'A skill',
        source: 'project',
        path: '/tmp/SKILL.md',
        enabled: false,
      },
    ],
    invalid: [
      {
        id: 'skl_1',
        name: 'sample',
        description: '',
        source: 'package',
        path: '/tmp/SKILL.md',
        enabled: true,
      },
    ],
  },
  {
    name: 'PluginId',
    schema: protocol.PluginIdSchema,
    valid: ['sample', 'a-1'],
    invalid: ['Sample', 'wevir-x', 'a_b', '-a', 'a--b', ''],
  },
  {
    name: 'PluginConnectorName',
    schema: protocol.PluginConnectorNameSchema,
    valid: ['api', 'wevir_ok_inside_plugin'],
    invalid: ['Api', 'a'.repeat(64)],
  },
  {
    name: 'PluginInputKey',
    schema: protocol.PluginInputKeySchema,
    valid: ['TOKEN', '_a1'],
    invalid: ['1A', 'a-b', ''],
  },
  {
    name: 'PluginPath',
    schema: protocol.PluginPathSchema,
    valid: ['./skills', './'],
    invalid: ['skills', '../x', './a/../b'],
  },
  {
    name: 'Semver',
    schema: protocol.SemverSchema,
    valid: ['1.0.0', '0.1.0-beta.1+sha.5'],
    invalid: ['1.0', 'v1.0.0', '01.0.0'],
  },
  {
    name: 'PluginInput',
    schema: protocol.PluginInputSchema,
    valid: [{ key: 'TOKEN', label: 'Token', secret: true, required: true }],
    invalid: [{ key: 'TOKEN' }, { key: 'TOKEN', label: 'Token', extra: 1 }],
  },
  {
    name: 'WevirPluginManifest',
    schema: protocol.WevirPluginManifestSchema,
    valid: [{ schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' }],
    invalid: [{ schemaVersion: 1, id: 'sample', name: 'Sample', version: '1' }],
  },
  {
    name: 'PluginInputView',
    schema: protocol.PluginInputViewSchema,
    valid: [{ key: 'TOKEN', label: 'Token', secret: true, required: true, set: false }],
    invalid: [{ key: 'TOKEN', label: 'Token', secret: true, required: true }],
  },
  {
    name: 'Plugin',
    schema: protocol.PluginSchema,
    valid: [
      {
        id: 'sample',
        name: 'Sample',
        version: '1.0',
        source: 'claude',
        enabled: true,
        path: '/data/plugins/packages/sample',
        inputs: [],
        connectors: [],
        skills: ['skl_1'],
      },
    ],
    invalid: [
      {
        id: 'sample',
        name: 'Sample',
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        path: '/x',
        inputs: [],
        connectors: [],
        skills: [],
      },
    ],
  },
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
    valid: [
      'openai-compatible',
      'chatgpt',
      'claude',
      'cursor',
      'opencode',
      'grok',
      'antigravity',
      'workbuddy',
    ],
    invalid: ['anthropic', 'gemini'],
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
    name: 'DiscoveredProviderModel',
    schema: DiscoveredProviderModelSchema,
    valid: [
      { model: { id: 'm' } },
      {
        model: { id: 'm', contextWindow: 4096 },
        maxContextWindow: 131072,
        contextSource: 'running',
        detailsAvailable: true,
      },
    ],
    invalid: [
      { model: { id: '' } },
      { model: { id: 'm' }, maxContextWindow: 0 },
      { model: { id: 'm' }, sizeBytes: -1 },
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
    name: 'VertexConfig',
    schema: VertexConfigSchema,
    valid: [{ project: 'vertex-example' }, { project: 'vertex-example', location: 'global' }],
    invalid: [{}, { project: '' }, { project: 'vertex-example', location: '' }],
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
    valid: [
      { contextUsed: 0, contextSize: 0 },
      {
        contextUsed: 10,
        contextSize: 100,
        breakdown: { categories: [{ name: 'Messages', tokens: 10, kind: 'used' }] },
      },
    ],
    invalid: [
      { contextUsed: 1 },
      { contextUsed: 1, contextSize: 2, breakdown: { categories: [{ name: 'Messages' }] } },
    ],
  },
  {
    name: 'UsageCategory',
    schema: UsageCategorySchema,
    valid: [
      { name: 'Free space', tokens: 297_700, kind: 'free' },
      { name: 'Something new', tokens: 0, kind: 'unknown-future-kind' },
    ],
    invalid: [
      { name: '', tokens: 1, kind: 'used' },
      { name: 'Messages', tokens: -1, kind: 'used' },
      { name: 'Messages', tokens: 1 },
    ],
  },
  {
    name: 'UsageItem',
    schema: UsageItemSchema,
    valid: [
      { name: 'mcp__linear__create_issue', source: 'linear', tokens: 120 },
      { name: 'a', tokens: 0 },
    ],
    invalid: [
      { name: '', tokens: 1 },
      { name: 'a', tokens: 1.5 },
    ],
  },
  {
    name: 'UsageGroup',
    schema: UsageGroupSchema,
    valid: [
      { group: 'mcp_tools', count: 406, items: [{ name: 'a', tokens: 3 }] },
      { group: 'agents', count: 0, items: [] },
    ],
    invalid: [
      { group: 'mcp_tools', count: -1, items: [] },
      {
        group: 'mcp_tools',
        count: 101,
        items: Array.from({ length: 101 }, () => ({ name: 'a', tokens: 1 })),
      },
    ],
  },
  {
    name: 'SessionRecap',
    schema: SessionRecapSchema,
    valid: [
      {
        text: '在修复登录接口的 500 错误。请在本地登录一次。',
        generatedAt: '2026-10-18T09:30:00.000Z',
        throughSeq: 41,
      },
    ],
    invalid: [
      {},
      { text: '', generatedAt: '2026-10-18T09:30:00.000Z', throughSeq: 41 },
      { text: 'x', generatedAt: '2026-10-18 09:30', throughSeq: 41 },
      { text: 'x', generatedAt: '2026-10-18T09:30:00.000Z', throughSeq: 0 },
      { text: 'x'.repeat(1001), generatedAt: '2026-10-18T09:30:00.000Z', throughSeq: 41 },
    ],
  },
  {
    name: 'HostSettings（离开后摘要开关可省略）',
    schema: HostSettingsSchema,
    valid: [{ sendWhileBusy: 'steer' }, { sendWhileBusy: 'queue', sessionRecap: false }],
    invalid: [{ sessionRecap: true }, { sendWhileBusy: 'steer', sessionRecap: 'yes' }],
  },
  {
    name: 'FilesRestore',
    schema: FilesRestoreSchema,
    valid: [
      { status: 'restored', fileCount: 2 },
      { status: 'unchanged' },
      { status: 'unavailable', reason: 'head_moved' },
    ],
    invalid: [
      {},
      { status: 'done' },
      { status: 'restored', fileCount: -1 },
      { status: 'unavailable', reason: '' },
    ],
  },
  {
    name: 'UsageTokens',
    schema: UsageTokensSchema,
    valid: [{ input: 2, output: 159, cacheRead: 225_678, cacheWrite: 697, reasoning: 0 }],
    invalid: [
      { input: 2, output: 159 },
      { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    ],
  },
  {
    name: 'UsageCost',
    schema: UsageCostSchema,
    valid: [{ input: 0, output: 0.0032, cacheRead: 0.0451, cacheWrite: 0.0056, total: 0.0539 }],
    invalid: [{ total: 1 }, { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }],
  },
  {
    name: 'UsagePrice',
    schema: UsagePriceSchema,
    valid: [
      { input: 5, output: 25 },
      { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    ],
    invalid: [{ input: 5 }, { input: -5, output: 25 }],
  },
  {
    name: 'UsageTiming',
    schema: UsageTimingSchema,
    valid: [
      { timedRequests: 0, outputTokens: 0, durationMs: 0, firstTokenCount: 0, firstTokenMs: 0 },
    ],
    invalid: [{ timedRequests: 1 }],
  },
  {
    name: 'UsageAggregate',
    schema: UsageAggregateSchema,
    valid: [
      {
        requests: 1,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        unpriced: 1,
        timing: {
          timedRequests: 0,
          outputTokens: 0,
          durationMs: 0,
          firstTokenCount: 0,
          firstTokenMs: 0,
        },
      },
    ],
    invalid: [{ requests: 1, cost: 0 }],
  },
  {
    name: 'UsageProviderAggregate',
    schema: UsageProviderAggregateSchema,
    valid: [
      {
        requests: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        unpriced: 0,
        timing: {
          timedRequests: 0,
          outputTokens: 0,
          durationMs: 0,
          firstTokenCount: 0,
          firstTokenMs: 0,
        },
        providerId: 'prv_1',
        providerName: 'DeepSeek',
        source: 'deepseek-official',
      },
    ],
    invalid: [{ providerId: 'prv_1', providerName: 'DeepSeek', source: 'deepseek-official' }],
  },
  {
    name: 'UsageModelAggregate',
    schema: UsageModelAggregateSchema,
    valid: [
      {
        requests: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: 0,
        unpriced: 0,
        timing: {
          timedRequests: 0,
          outputTokens: 0,
          durationMs: 0,
          firstTokenCount: 0,
          firstTokenMs: 0,
        },
        model: 'deepseek-chat',
      },
    ],
    invalid: [{ model: '' }],
  },
  {
    name: 'UsageFilter',
    schema: UsageFilterSchema,
    valid: [{}, { sources: [], providerIds: ['prv_1'], models: ['gpt-5.5'] }],
    invalid: [{ sources: ['nope'] }, { models: [''] }],
  },
  {
    name: 'UsagePricing',
    schema: UsagePricingSchema,
    valid: [
      { source: 'models.dev', models: 0, refreshing: false },
      { source: 'models.dev', fetchedAt: 1, models: 10, refreshing: true, lastError: 'HTTP 503' },
    ],
    invalid: [{ source: 'models.dev', models: 0 }],
  },
  {
    name: 'UsageRecord',
    schema: UsageRecordSchema,
    valid: [
      {
        id: '1',
        at: 1_760_937_254_000,
        sessionId: 'ses_gone',
        requestId: 'trn_1:1200',
        source: 'chatgpt',
        providerId: 'prv_chatgpt',
        providerName: 'ChatGPT',
        model: 'gpt-5.5',
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        price: { input: 1.25, output: 10, cacheRead: 0.125 },
        priceSource: 'openai',
        durationMs: 1_000,
        firstTokenMs: 200,
      },
    ],
    invalid: [{ id: '1', at: 0 }],
  },
  {
    name: 'UsageBreakdown',
    schema: UsageBreakdownSchema,
    valid: [
      { categories: [] },
      {
        categories: [{ name: 'Messages', tokens: 5, kind: 'used' }],
        groups: [
          { group: 'skills', count: 1, items: [{ name: 'pdf', source: 'plugin', tokens: 5 }] },
        ],
      },
    ],
    invalid: [
      {},
      { categories: [{ name: 'x', tokens: 1, kind: 'used' }], groups: [{ group: 'x' }] },
    ],
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
    valid: [{ type: 'text', text: '' }, imagePart],
    invalid: [{ type: 'image', url: 'x' }, { type: 'text' }],
  },
  {
    name: 'UserImageMimeType',
    schema: UserImageMimeTypeSchema,
    valid: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    invalid: ['image/svg+xml', 'image/bmp', 'image/heic'],
  },
  {
    name: 'UserImagePart',
    schema: UserImagePartSchema,
    valid: [imagePart, { type: 'image', imageId: ids.image, mimeType: 'image/gif', size: 1 }],
    invalid: [
      { ...imagePart, size: 0 },
      { ...imagePart, width: 0 },
      { ...imagePart, name: '' },
      { ...imagePart, imageId: ids.turn },
      { type: 'image', imageId: ids.image, mimeType: 'image/png' },
    ],
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
      sessionWithRules,
      childSession,
      handedOffSession,
    ],
    invalid: [
      { ...session, workspaceId: ids.session },
      { ...childSession, parentSessionId: ids.workspace },
      { ...handedOffSession, engines: [{ providerId: 'claude', sessionId: 'x', seenSeq: 0 }] },
    ],
  },
  {
    name: 'SessionEngine',
    schema: SessionEngineSchema,
    valid: [{ providerId: 'claude', modelId: 'claude-opus-5-5', sessionId: 'e1', seenSeq: 12 }],
    invalid: [{ providerId: 'claude', modelId: 'claude-opus-5-5', sessionId: '', seenSeq: 0 }],
  },
  {
    name: 'EngineFeatures',
    schema: EngineFeaturesSchema,
    valid: [
      { engine: 'echo' },
      { engine: 'codex', steer: true, fork: true, permissionModes: ['on_request', 'full_access'] },
    ],
    invalid: [{}, { engine: 'codex', permissionModes: ['yolo'] }],
  },
  {
    name: 'HandoffStrategy',
    schema: HandoffStrategySchema,
    valid: ['full_thread_summary', 'delta_since_target_last_seen', 'future_strategy'],
    invalid: ['', 1],
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
  {
    name: 'AccountKind',
    schema: AccountKindSchema,
    valid: ['chatgpt', 'claude', 'antigravity', 'workbuddy'],
    invalid: ['ChatGPT', 'gemini'],
  },
  {
    name: 'SubscriptionKind',
    schema: SubscriptionKindSchema,
    valid: ['claude', 'cursor', 'opencode', 'grok', 'antigravity', 'workbuddy'],
    invalid: ['chatgpt', 'Claude'],
  },
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
    name: 'AccountLabel',
    schema: AccountLabelSchema,
    valid: ['主号', 'Work', '工作 2', 'x'.repeat(16)],
    invalid: ['', ' 工作', '工作 ', 'x'.repeat(17), 3],
  },
  {
    name: 'AccountLoginOption',
    schema: AccountLoginOptionSchema,
    valid: [
      { id: 'internal', label: 'WeChat' },
      { id: 'external', label: 'Google / GitHub' },
    ],
    invalid: [
      { id: '', label: 'x' },
      { id: 'x'.repeat(65), label: 'x' },
      { id: 'internal', label: '' },
      { id: 'internal' },
      { label: 'x' },
    ],
  },
  {
    name: 'AccountUpstreamMethod',
    schema: AccountUpstreamMethodSchema,
    valid: [
      { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', option: '1' },
      { type: 'api_key', label: 'API key', option: 'default' },
    ],
    invalid: [
      { type: 'password', label: 'x', option: 0 },
      { type: 'oauth', label: '', option: 0 },
      { type: 'oauth', label: 'x', option: '' },
      { type: 'oauth', label: 'x', option: 0 },
      { type: 'oauth', label: 'x' },
    ],
  },
  {
    name: 'AccountUpstream',
    schema: AccountUpstreamSchema,
    valid: [
      {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        connected: false,
        featured: true,
        methods: [{ type: 'oauth', label: 'Login with GitHub Copilot', option: '0' }],
      },
    ],
    invalid: [
      { id: 'x', name: 'X', connected: false, featured: false, methods: [] },
      {
        id: '',
        name: 'X',
        connected: false,
        featured: false,
        methods: [{ type: 'api_key', label: 'k', option: 'default' }],
      },
      {
        id: 'x',
        name: 'X',
        connected: 'no',
        featured: false,
        methods: [{ type: 'api_key', label: 'k', option: 'default' }],
      },
      {
        id: 'x',
        name: 'X',
        connected: false,
        methods: [{ type: 'api_key', label: 'k', option: 'default' }],
      },
    ],
  },
  {
    name: 'AccountState',
    schema: AccountStateSchema,
    valid: [
      signedInAccount,
      signingInAccount,
      connectingUpstreamAccount,
      workbuddyLoginAccount,
      { kind: 'chatgpt', status: 'signed_out' },
    ],
    invalid: [
      { kind: 'chatgpt', status: 'signed_in', rateLimits: { primary: {} } },
      { kind: 'workbuddy', status: 'signed_out', loginOptions: [] },
      { kind: 'workbuddy', status: 'signed_out', loginOptions: [{ id: 'internal' }] },
    ],
  },
  { name: 'PendingDelivery', schema: PendingDeliverySchema, valid: ['queue'], invalid: ['now'] },
  {
    name: 'PermissionMode',
    schema: PermissionModeSchema,
    valid: ['on_request', 'auto_review', 'full_access'],
    invalid: ['never', ''],
  },
  {
    name: 'CollaborationMode',
    schema: CollaborationModeSchema,
    valid: ['default', 'plan'],
    invalid: ['ask', ''],
  },
  {
    name: 'ImageId',
    schema: ImageIdSchema,
    valid: ['img_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    invalid: ['trn_01JA2B3C4D5E6F7G8H9JKMNPQR', 'img_', 'img-1'],
  },
  {
    name: 'EnvironmentId',
    schema: EnvironmentIdSchema,
    valid: ['env_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    invalid: ['ws_01JA2B3C4D5E6F7G8H9JKMNPQR', 'env_'],
  },
  {
    name: 'WorkspaceKind',
    schema: WorkspaceKindSchema,
    valid: ['chats'],
    invalid: ['project', ''],
  },
  {
    name: 'WorktreeMode',
    schema: WorktreeModeSchema,
    valid: ['none', 'new'],
    invalid: ['reuse', ''],
  },
  {
    name: 'EnvironmentFolder',
    schema: EnvironmentFolderSchema,
    valid: [{ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', worktree: 'none' }],
    invalid: [{ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', worktree: 'reuse' }],
  },
  {
    name: 'Environment',
    schema: EnvironmentSchema,
    valid: [environment],
    invalid: [
      { ...environment, name: '' },
      { ...environment, location: { kind: 'ssh' } },
      { ...environment, folders: [] },
    ],
  },
  {
    name: 'SessionWorktree',
    schema: SessionWorktreeSchema,
    valid: [
      { workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', path: '/w/1-wevir', branch: 'wevir/a1' },
    ],
    invalid: [{ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR', path: '', branch: 'b' }],
  },
  {
    name: 'SessionWorktreeUsage',
    schema: SessionWorktreeUsageSchema,
    valid: [
      {
        workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
        branch: 'wevir/a1',
        path: '/w/1-wevir',
        bytes: 4096,
        dirty: false,
      },
      {
        workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
        branch: 'wevir/a1',
        path: '/w/1-wevir',
        bytes: 0,
        dirty: false,
        missing: true,
      },
    ],
    invalid: [
      {
        workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
        branch: 'b',
        path: '/w',
        bytes: 1.5,
        dirty: false,
      },
      {
        workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
        branch: 'b',
        path: '/w',
        bytes: 0,
        dirty: false,
        missing: false,
      },
    ],
  },
  {
    name: 'SessionUsage',
    schema: SessionUsageSchema,
    valid: [
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', eventBytes: 0, fileBytes: 0, worktrees: [] },
    ],
    invalid: [{ sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', eventBytes: 0, fileBytes: 0 }],
  },
  {
    name: 'TaskId',
    schema: TaskIdSchema,
    valid: ['tsk_01JA2B3C4D5E6F7G8H9JKMNPQR'],
    invalid: ['ses_01JA2B3C4D5E6F7G8H9JKMNPQR', 'tsk_'],
  },
  {
    name: 'SuggestedTask',
    schema: SuggestedTaskSchema,
    valid: [suggestedTask, reportedTask],
    invalid: [
      { ...suggestedTask, title: '' },
      { ...suggestedTask, prompt: 'x'.repeat(8001) },
      { ...suggestedTask, status: 'done' },
    ],
  },
  {
    name: 'SessionForkedFrom',
    schema: SessionForkedFromSchema,
    valid: [{ sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' }],
    invalid: [{ turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' }],
  },
  {
    name: 'SessionOrigin',
    schema: SessionOriginSchema,
    valid: [
      {
        kind: 'suggested_task',
        sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
        taskId: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPQR',
      },
    ],
    invalid: [{ kind: 'suggested_task', sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' }],
  },
  {
    name: 'SessionOpenedBy',
    schema: SessionOpenedBySchema,
    valid: [
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', role: 'explorer' },
    ],
    invalid: [
      { sessionId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' },
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', role: '' },
    ],
  },
  {
    name: 'BoardTaskStatus',
    schema: BoardTaskStatusSchema,
    valid: ['pending', 'in_progress', 'completed', 'cancelled'],
    invalid: ['blocked', 'done', ''],
  },
  {
    name: 'BoardTaskNote',
    schema: BoardTaskNoteSchema,
    valid: [boardTask.notes[0]],
    invalid: [
      { ...boardTask.notes[0], sessionId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' },
      { ...boardTask.notes[0], at: 'now' },
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', at: TS },
    ],
  },
  {
    name: 'BoardTask',
    schema: BoardTaskSchema,
    valid: [boardTask, waitingBoardTask],
    invalid: [
      { ...boardTask, subject: '' },
      { ...boardTask, status: 'blocked' },
      { ...boardTask, owner: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' },
      { ...boardTask, blockedBy: undefined },
      { ...boardTask, notes: [{ sessionId: 'x', text: 'a', at: TS }] },
      { ...boardTask, createdAt: 'yesterday' },
    ],
  },
  {
    name: 'MessageFrom',
    schema: MessageFromSchema,
    valid: [
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', kind: 'message', reportBack: true },
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', kind: 'report' },
      // 0.47.0：后台进程的通知。
      {
        sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
        kind: 'report',
        process: { id: 'p1', name: 'dev server', event: 'exit', exitCode: 1 },
      },
      {
        sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
        kind: 'report',
        process: { id: 'p2', name: 'watch', event: 'match' },
      },
    ],
    invalid: [
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', kind: 'reply' },
      {
        sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
        kind: 'report',
        process: { id: 'p1', event: 'exit', exitCode: 1.5 },
      },
      { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR', kind: 'message', reportBack: false },
    ],
  },
  {
    name: 'UiShowTarget',
    schema: UiShowTargetSchema,
    valid: [
      { kind: 'file', path: 'src/index.ts', line: 3 },
      { kind: 'file', path: 'README.md' },
      { kind: 'changes' },
      { kind: 'files' },
      { kind: 'session', sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
    ],
    invalid: [{ kind: 'file', path: '' }, { kind: 'browser' }, { kind: 'session' }],
  },
  {
    name: 'SharedFile',
    schema: SharedFileSchema,
    valid: [
      { path: 'report.md', name: 'report.md', size: 120, mimeType: 'text/markdown' },
      { path: 'out/a.bin', name: 'a.bin', size: 0 },
    ],
    invalid: [
      { path: '', name: 'a', size: 1 },
      { path: 'a', name: 'a', size: -1 },
      { path: 'a', name: 'a', size: 1.5 },
    ],
  },
  {
    name: 'GitFileChange',
    schema: GitFileChangeSchema,
    valid: [
      { path: 'src/a.ts', status: 'modified', added: 3, removed: 1 },
      { path: 'new.md', status: 'untracked' },
      { path: 'x', status: 'copied' },
    ],
    invalid: [
      { path: '', status: 'modified' },
      { path: 'a', status: 'modified', added: 1.5 },
    ],
  },
  {
    name: 'WorkspaceEntryKind',
    schema: WorkspaceEntryKindSchema,
    valid: ['file', 'directory'],
    invalid: ['symlink', ''],
  },
  {
    name: 'WorkspaceEntry',
    schema: WorkspaceEntrySchema,
    valid: [
      { path: 'src/a.ts', kind: 'file' },
      { path: 'dist', kind: 'directory', ignored: true },
    ],
    invalid: [
      { path: '', kind: 'file' },
      { path: 'a', kind: 'file', ignored: false },
    ],
  },
  {
    name: 'PreviewImageMimeType',
    schema: PreviewImageMimeTypeSchema,
    valid: ['image/png', 'image/svg+xml'],
    invalid: ['image/tiff', 'text/plain'],
  },
  {
    name: 'DiffSource',
    schema: DiffSourceSchema,
    valid: [
      { kind: 'uncommitted' },
      { kind: 'branch' },
      { kind: 'turn', turnId: ids.turn },
      { kind: 'staged' },
    ],
    invalid: [{ kind: 'turn' }, { kind: 'index' }, { kind: 'turn', turnId: ids.session }],
  },
  {
    name: 'DiffFile',
    schema: DiffFileSchema,
    valid: [
      { path: 'src/a.ts', status: 'modified', added: 3, removed: 1 },
      { path: 'b.ts', previousPath: 'a.ts', status: 'renamed', added: 0, removed: 0 },
      { path: 'logo.png', status: 'added', binary: true },
      { path: 'huge.log', status: 'untracked', omitted: 'over_limit' },
    ],
    invalid: [
      { path: '', status: 'modified' },
      { path: 'a', status: 'modified', binary: false },
      { path: 'a', status: 'modified', omitted: '' },
    ],
  },
  {
    name: 'GitObjectId',
    schema: GitObjectIdSchema,
    valid: ['1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', 'a'.repeat(64)],
    invalid: ['HEAD', '1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B', 'a'.repeat(39), '--output=x'],
  },
  {
    name: 'TurnCheckpoint',
    schema: TurnCheckpointSchema,
    valid: [{ turnId: ids.turn }, { turnId: ids.turn, fileCount: 1, added: 2, removed: 0 }],
    invalid: [{}, { turnId: ids.turn, fileCount: -1 }],
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
      { id: 'a', question: 'q', options: [], defaultOption: '' },
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
    name: 'QuestionResolutionReason',
    schema: QuestionResolutionReasonSchema,
    valid: ['user', 'turn_cancelled', 'host_restarted', 'timeout'],
    invalid: ['expired', ''],
  },
  {
    name: 'QuestionResolution',
    schema: QuestionResolutionSchema,
    valid: [
      { reason: 'user', answers: { scope: { answers: ['全链路'] } }, answeredBy: identity },
      { reason: 'turn_cancelled' },
      { reason: 'timeout', answers: { scope: { answers: ['全链路'] } } },
    ],
    invalid: [{}, { reason: 'expired' }],
  },
  {
    name: 'QuestionRequest',
    schema: QuestionRequestSchema,
    valid: [pendingQuestion],
    invalid: [
      { ...pendingQuestion, questions: [] },
      { ...pendingQuestion, id: ids.approval },
      { ...pendingQuestion, autoAnswerAt: '5 minutes' },
    ],
  },
  {
    name: 'WebSearchServiceId',
    schema: WebSearchServiceIdSchema,
    valid: ['bocha', 'tavily', 'brave_search'],
    invalid: ['', 'Bocha', '1st', 'a'.repeat(33)],
  },
  {
    name: 'WebSettings',
    schema: WebSettingsSchema,
    valid: [{ enabled: true, searchService: 'bocha', services: [{ id: 'bocha', hasKey: false }] }],
    invalid: [{ enabled: true, searchService: 'bocha' }, {}],
  },
  {
    name: 'WebTestFailure',
    schema: WebTestFailureSchema,
    valid: ['missing_key', 'quota', 'invalid_response'],
    invalid: ['expired'],
  },
  {
    name: 'HostSettings',
    schema: HostSettingsSchema,
    valid: [
      { sendWhileBusy: 'steer' },
      { sendWhileBusy: 'queue', promptSuggestions: false },
      { sendWhileBusy: 'steer', autoMemory: false },
    ],
    invalid: [
      {},
      { sendWhileBusy: 'later' },
      { sendWhileBusy: 'steer', promptSuggestions: 1 },
      { sendWhileBusy: 'steer', autoMemory: 'off' },
    ],
  },
  {
    name: 'MemoryType',
    schema: MemoryTypeSchema,
    valid: ['user', 'feedback', 'project', 'reference'],
    invalid: ['secret', ''],
  },
  {
    name: 'MemoryScope',
    schema: MemoryScopeSchema,
    valid: ['global', 'project'],
    invalid: ['team'],
  },
  {
    name: 'MemoryName',
    schema: MemoryNameSchema,
    valid: ['a', 'avoid-rm-f', `a${'b'.repeat(63)}`],
    invalid: ['', '-x', 'Upper', 'has space', '../x', `a${'b'.repeat(64)}`],
  },
  {
    name: 'MemoryAuthor',
    schema: MemoryAuthorSchema,
    valid: ['agent', 'user'],
    invalid: ['model', ''],
  },
  {
    name: 'HandoffMaterialRequest',
    schema: HandoffMaterialRequestSchema,
    valid: [
      {},
      { constraints: ['只改 src/'] },
      { notes: [{ scope: 'project', name: 'invoice-cents' }] },
      { constraints: ['x'.repeat(2000)], notes: [] },
    ],
    invalid: [
      { constraints: [''] },
      { constraints: Array.from({ length: 11 }, () => 'x') },
      { notes: [{ scope: 'project', name: 'Invoice Cents' }] },
      { notes: [{ scope: 'project' }] },
    ],
  },
  {
    name: 'RuleFileKind',
    schema: RuleFileKindSchema,
    valid: ['agents', 'claude', 'gemini', 'cursor', 'future_tool'],
    invalid: ['', 1],
  },
  {
    name: 'RuleFileScope',
    schema: RuleFileScopeSchema,
    valid: ['user', 'project'],
    invalid: ['workspace'],
  },
  {
    name: 'RuleFileDelivery',
    schema: RuleFileDeliverySchema,
    valid: ['engine', 'wevir', 'skipped'],
    invalid: ['host'],
  },
  {
    name: 'RuleFile',
    schema: RuleFileSchema,
    valid: [
      ...sessionRules.files,
      {
        path: '/Users/me/projects/wevir/docs/rules.md',
        scope: 'project',
        kind: 'claude',
        delivery: 'wevir',
        bytes: 30000,
        truncated: true,
        importedFrom: '/Users/me/projects/wevir/CLAUDE.md',
      },
    ],
    invalid: [
      { path: '', scope: 'project', kind: 'agents', delivery: 'engine', bytes: 1 },
      { path: '/a/AGENTS.md', scope: 'project', kind: 'agents', delivery: 'engine', bytes: -1 },
    ],
  },
  {
    name: 'RuleDeliveryChannel',
    schema: RuleDeliveryChannelSchema,
    valid: ['instructions', 'message'],
    invalid: ['system'],
  },
  {
    name: 'SessionRules',
    schema: SessionRulesSchema,
    valid: [sessionRules, { providerId: 'deepseek-official', files: [] }],
    invalid: [{ files: [] }, { ...sessionRules, channel: 'system' }, { ...sessionRules, bytes: 0 }],
  },
  {
    name: 'HandoffNoteRef',
    schema: HandoffNoteRefSchema,
    valid: [{ scope: 'global', name: 'reply-language', revision: '3f1c2a9b7d4e6f10' }],
    invalid: [
      { scope: 'global', name: 'reply-language' },
      { scope: 'global', name: 'reply-language', revision: '' },
    ],
  },
  {
    name: 'HandoffOmittedRange',
    schema: HandoffOmittedRangeSchema,
    valid: [{ first: 'e2', last: 'e9', count: 8 }],
    invalid: [
      { first: 'e2', last: 'e2', count: 0 },
      { first: '', last: 'e2', count: 1 },
    ],
  },
  {
    name: 'HandoffBinding',
    schema: HandoffBindingSchema,
    valid: [
      { providerId: 'claude', throughSeq: 0, strategy: 'full_thread_summary', notes: [] },
      {
        providerId: 'claude',
        throughSeq: 12,
        strategy: 'delta_since_target_last_seen',
        notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
        hash: '0'.repeat(64),
      },
    ],
    invalid: [
      { providerId: 'claude', throughSeq: 1, strategy: 'full_thread_summary' },
      { providerId: 'Claude', throughSeq: 1, strategy: 'full_thread_summary', notes: [] },
      { providerId: 'claude', throughSeq: 1, strategy: '', notes: [] },
    ],
  },
  {
    name: 'ToolGroup',
    schema: ToolGroupSchema,
    valid: ['sessions', 'browser', 'plugins'],
    invalid: ['terminal', 'Browser', ''],
  },
  {
    name: 'ToolPresetId',
    schema: ToolPresetIdSchema,
    valid: ['full', 'core'],
    invalid: ['minimal', ''],
  },
  {
    name: 'ToolPreset',
    schema: ToolPresetSchema,
    valid: [{ id: 'full' }, { id: 'core' }, { id: 'core', groups: ['browser', 'lsp'] }],
    invalid: [{}, { id: 'core', groups: ['terminal'] }, { id: 'core', groups: 'browser' }],
  },
  {
    name: 'ToolPresetInfo',
    schema: ToolPresetInfoSchema,
    valid: [{ id: 'core', groups: ['sessions', 'memory'] }],
    invalid: [{ id: 'core' }, { id: 'all', groups: [] }],
  },
  {
    name: 'ToolGroupInfo',
    schema: ToolGroupInfoSchema,
    valid: [
      { id: 'lsp', tools: ['lsp_hover'] },
      { id: 'browser', tools: [] },
    ],
    invalid: [{ id: 'lsp' }, { id: 'lsp', tools: [''] }],
  },
  {
    name: 'HandoffConfigure',
    schema: HandoffConfigureSchema,
    valid: [
      {},
      {
        constraints: ['只改 src/'],
        binding: {
          providerId: 'claude',
          throughSeq: 3,
          strategy: 'full_thread_summary',
          notes: [],
        },
      },
    ],
    invalid: [{ binding: { providerId: 'claude' } }, { constraints: [''] }],
  },
  {
    name: 'HandoffPreview',
    schema: HandoffPreviewSchema,
    valid: [
      {
        providerId: 'claude',
        strategy: 'full_thread_summary',
        resumed: false,
        historyTool: false,
        budgetBytes: 16000,
        items: 0,
        omittedItems: 0,
        omitted: [],
        constraints: 0,
        notes: [],
      },
    ],
    invalid: [
      {
        providerId: 'claude',
        strategy: 'full_thread_summary',
        resumed: false,
        historyTool: false,
        budgetBytes: 0,
        items: 0,
        omittedItems: 0,
        omitted: [],
        constraints: 0,
        notes: [],
      },
    ],
  },
  {
    name: 'HandoffHash',
    schema: HandoffHashSchema,
    valid: ['0'.repeat(64)],
    invalid: ['0'.repeat(63), 'A'.repeat(64), `sha256:${'0'.repeat(64)}`],
  },
  {
    name: 'MemorySourceStatus',
    schema: MemorySourceStatusSchema,
    valid: ['available', 'withdrawn', 'deleted'],
    invalid: ['stale'],
  },
  {
    name: 'MemorySource',
    schema: MemorySourceSchema,
    valid: [
      { by: 'user', at: TS },
      { by: 'agent', at: TS, sessionId: ids.session, turnId: ids.turn, seq: 4 },
      { by: 'agent', at: 'yesterday', sessionId: ids.session, status: 'deleted' },
    ],
    invalid: [
      { at: TS },
      { by: 'agent' },
      { by: 'system', at: TS },
      { by: 'agent', at: TS, sessionId: 'session-1' },
      { by: 'agent', at: TS, turnId: 'turn-1' },
      { by: 'agent', at: TS, seq: 0 },
      { by: 'agent', at: TS, sessionId: ids.session, status: 'stale' },
    ],
  },
  {
    name: 'MemorySummary',
    schema: MemorySummarySchema,
    valid: [
      {
        scope: 'global',
        name: 'reply-language',
        type: 'user',
        description: 'Answer in Chinese',
        updatedAt: '',
        enabled: false,
        revision: 'r1',
      },
    ],
    invalid: [
      {
        scope: 'global',
        name: 'reply-language',
        type: 'user',
        description: 'Answer in Chinese',
        updatedAt: '',
        revision: 'r1',
      },
    ],
  },
  {
    name: 'MemoryNote',
    schema: MemoryNoteSchema,
    valid: [
      {
        scope: 'project',
        name: 'invoice-cents',
        type: 'feedback',
        description: 'Money in cents',
        updatedAt: TS,
        enabled: true,
        revision: 'r1',
        content: 'Round once.',
      },
    ],
    invalid: [
      {
        scope: 'project',
        name: 'invoice-cents',
        type: 'feedback',
        description: 'Money in cents',
        updatedAt: TS,
        enabled: true,
        revision: 'r1',
      },
    ],
  },
  {
    name: 'PromptSuggestion',
    schema: PromptSuggestionSchema,
    valid: [promptSuggestion, { turnId: ids.turn, text: 'x'.repeat(PROMPT_SUGGESTION_MAX_LENGTH) }],
    invalid: [
      { turnId: ids.turn, text: '' },
      { turnId: ids.turn, text: 'x'.repeat(PROMPT_SUGGESTION_MAX_LENGTH + 1) },
      { turnId: 'trn_', text: '跑一下测试' },
      { text: '跑一下测试' },
    ],
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
  { name: 'ReviewTarget', schema: ReviewTargetSchema, valid: ['branch'], invalid: ['commit'] },
  { name: 'TurnTrigger', schema: TurnTriggerSchema, valid: ['goal'], invalid: ['plan'] },
  {
    name: 'GoalStatus',
    schema: GoalStatusSchema,
    valid: ['budget_limited', 'usage_limited'],
    invalid: ['budgetLimited', 'done'],
  },
  {
    name: 'SessionGoal',
    schema: SessionGoalSchema,
    valid: [
      {
        objective: '补齐测试',
        status: 'complete',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        updatedAt: '2026-10-15T08:00:00.000Z',
      },
    ],
    invalid: [
      {
        objective: '',
        status: 'active',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        updatedAt: '2026-10-15T08:00:00.000Z',
      },
      {
        objective: '补齐测试',
        status: 'active',
        tokenBudget: 0,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        updatedAt: '2026-10-15T08:00:00.000Z',
      },
    ],
  },
  {
    name: 'TurnCommand',
    schema: TurnCommandSchema,
    valid: [{ kind: 'compact' }, { kind: 'review', target: 'uncommitted' }],
    invalid: [{ kind: 'init' }, { kind: 'review', target: 'branch', baseBranch: '' }],
  },
  {
    name: 'SessionCommand',
    schema: SessionCommandSchema,
    valid: ['review'],
    invalid: ['init'],
  },
  {
    name: 'CompactionTrigger',
    schema: CompactionTriggerSchema,
    valid: ['auto'],
    invalid: ['scheduled'],
  },
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
  // browser（0.33.0）
  {
    name: 'BrowserRequestId',
    schema: protocol.BrowserRequestIdSchema,
    valid: [ids.browserRequest],
    invalid: ['brq_', `req_${ULID}`],
  },
  {
    name: 'BrowserTabId',
    schema: protocol.BrowserTabIdSchema,
    valid: [browserTab.browserId, 'a'],
    invalid: ['', 'tab 1', 'x'.repeat(65)],
  },
  {
    name: 'BrowserRef',
    schema: protocol.BrowserRefSchema,
    valid: ['@e1', '@e120'],
    invalid: ['e1', '@x1'],
  },
  {
    name: 'BrowserMouseButton',
    schema: protocol.BrowserMouseButtonSchema,
    valid: ['left', 'middle'],
    invalid: ['primary'],
  },
  {
    name: 'BrowserModifier',
    schema: protocol.BrowserModifierSchema,
    valid: ['Shift', 'Meta'],
    invalid: ['shift'],
  },
  {
    name: 'BrowserCommand',
    schema: protocol.BrowserCommandSchema,
    valid: [
      { command: 'list_tabs', args: {} },
      { command: 'screenshot', args: { browserId: browserTab.browserId, fullPage: true } },
      { command: 'scroll', args: { browserId: browserTab.browserId, deltaX: 0, deltaY: 400 } },
      // 0.48.0
      { command: 'evaluate', args: { browserId: browserTab.browserId, function: '() => 1' } },
      { command: 'query', args: { browserId: browserTab.browserId, selector: 'a', frame: '1.0' } },
      { command: 'network', args: { browserId: browserTab.browserId, id: '4', body: true } },
      { command: 'upload', args: { browserId: browserTab.browserId, paths: ['a.txt'] } },
    ],
    invalid: [
      { command: 'run_script', args: { browserId: browserTab.browserId, function: '() => 1' } },
      { command: 'new_tab', args: { url: 'javascript:alert(1)' } },
      { command: 'evaluate', args: { browserId: browserTab.browserId, function: '' } },
      { command: 'query', args: { browserId: browserTab.browserId, selector: 'a', maxResults: 0 } },
      { command: 'snapshot', args: { browserId: browserTab.browserId, maxNodes: 60000 } },
      { command: 'wait', args: { browserId: browserTab.browserId, selector: 'a', state: 'gone' } },
      { command: 'dialogs', args: { browserId: browserTab.browserId, confirm: 'yes' } },
      { command: 'download', args: { browserId: browserTab.browserId, timeoutMs: 600000 } },
    ],
  },
  {
    name: 'BrowserFrame',
    schema: protocol.BrowserFrameSchema,
    valid: ['1.0', 'checkout'],
    invalid: ['', 'x'.repeat(501)],
  },
  {
    name: 'BrowserDialogAction',
    schema: protocol.BrowserDialogActionSchema,
    valid: ['accept', 'dismiss'],
    invalid: ['ok'],
  },
  {
    name: 'BrowserElementState',
    schema: protocol.BrowserElementStateSchema,
    valid: ['attached', 'detached', 'visible', 'hidden'],
    invalid: ['gone'],
  },
  {
    name: 'BrowserTabInfo',
    schema: protocol.BrowserTabInfoSchema,
    valid: [browserTab, { ...browserTab, controller: 'user', canGoBack: undefined }],
    invalid: [{ ...browserTab, controller: '' }],
  },
  {
    name: 'BrowserSnapshotStats',
    schema: protocol.BrowserSnapshotStatsSchema,
    valid: [{ nodeCount: 1, refCount: 0, textLength: 10, iframeCount: 0, maxDepth: 3 }],
    invalid: [{ nodeCount: -1, refCount: 0, textLength: 0 }],
  },
  {
    name: 'BrowserConsoleEntry',
    schema: protocol.BrowserConsoleEntrySchema,
    valid: [{ level: 'error', message: 'boom', source: 'app.js', line: 3, timestamp: 1 }],
    invalid: [{ level: 'log', message: 'x' }],
  },
  {
    name: 'BrowserNetworkEntry',
    schema: protocol.BrowserNetworkEntrySchema,
    valid: [{ url: 'http://localhost:5173/', type: 'navigation', startTime: 0, duration: 12.5 }],
    invalid: [{ url: 'http://localhost:5173/', startTime: 0 }],
  },
  {
    name: 'BrowserResult',
    schema: protocol.BrowserResultSchema,
    valid: [
      { command: 'wait', browserId: browserTab.browserId, matched: 'text' },
      {
        command: 'screenshot',
        browserId: browserTab.browserId,
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
        width: 1280,
        height: 800,
      },
      {
        command: 'show',
        browserId: browserTab.browserId,
        url: browserTab.url,
        shown: false,
      },
    ],
    invalid: [
      {
        command: 'screenshot',
        browserId: browserTab.browserId,
        mimeType: 'image/jpeg',
        dataBase64: 'x',
        width: 1,
        height: 1,
      },
    ],
  },
  {
    name: 'BrowserError',
    schema: protocol.BrowserErrorSchema,
    valid: [
      { code: 'browser_no_host', message: 'No browser', retryable: true },
      { code: 'later_code', message: 'x' },
    ],
    invalid: [{ code: 'browser_no_host' }],
  },
  {
    name: 'BrowserDialogEvent',
    schema: protocol.BrowserDialogEventSchema,
    valid: [{ type: 'alert', message: 'Hi', action: 'accepted', timestamp: 1 }],
    invalid: [{ type: 'alert', message: 'Hi', timestamp: 1 }],
  },
  {
    name: 'BrowserEffects',
    schema: protocol.BrowserEffectsSchema,
    valid: [
      {},
      { navigation: { url: 'http://localhost:5173/' } },
      { openedTabs: [{ browserId: 'tab_a_1', url: '' }], fileChooser: { multiple: true } },
    ],
    invalid: [
      { navigation: { url: 'http://localhost:5173/', status: 99 } },
      { openedTabs: [{ browserId: 'bad id', url: '' }] },
      { downloads: [{ url: 'x', filename: 'x', state: '' }] },
    ],
  },
  {
    name: 'BrowserNetworkDetail',
    schema: protocol.BrowserNetworkDetailSchema,
    valid: [
      {
        id: '1',
        url: 'http://a.test/',
        method: 'GET',
        requestHeaders: {},
        startTime: 0,
        duration: 0,
      },
      {
        id: '2',
        url: 'http://a.test/x.png',
        method: 'GET',
        status: 200,
        requestHeaders: {},
        startTime: 1,
        duration: 2,
        body: { size: 10, binary: true },
      },
    ],
    invalid: [
      { id: '1', url: 'http://a.test/', method: 'GET', startTime: 0, duration: 0 },
      {
        id: '1',
        url: 'http://a.test/',
        method: 'GET',
        requestHeaders: { cookie: 1 },
        startTime: 0,
        duration: 0,
      },
      {
        id: '1',
        url: 'http://a.test/',
        method: 'GET',
        requestHeaders: {},
        startTime: 0,
        duration: 0,
        body: { size: -1 },
      },
    ],
  },
  {
    name: 'BrowserQueryElement',
    schema: protocol.BrowserQueryElementSchema,
    valid: [
      { tag: 'a', text: '', visible: false },
      {
        ref: '@e3',
        tag: 'a',
        text: 'Home',
        visible: true,
        box: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
    invalid: [
      { ref: 'a', tag: 'a', text: '', visible: true },
      { tag: 'a', text: '' },
    ],
  },
  {
    name: 'BrowserDialogPolicy',
    schema: protocol.BrowserDialogPolicySchema,
    valid: [
      { confirm: 'dismiss', prompt: 'dismiss', beforeunload: 'accept' },
      { confirm: 'accept', prompt: 'accept', promptText: '', beforeunload: 'ask' },
    ],
    invalid: [{ confirm: '', prompt: 'dismiss', beforeunload: 'accept' }, { confirm: 'accept' }],
  },
  {
    name: 'CheckId',
    schema: protocol.CheckIdSchema,
    valid: [`chk_${ULID}`],
    invalid: [`vrn_${ULID}`, 'chk_', ''],
  },
  {
    name: 'VerificationRunId',
    schema: protocol.VerificationRunIdSchema,
    valid: [`vrn_${ULID}`],
    invalid: [`chk_${ULID}`],
  },
  {
    name: 'VerificationRoundId',
    schema: protocol.VerificationRoundIdSchema,
    valid: [`vrd_${ULID}`],
    invalid: [`vrn_${ULID}`],
  },
  {
    name: 'RepairId',
    schema: protocol.RepairIdSchema,
    valid: [`rpr_${ULID}`],
    invalid: [`rp_${ULID}`],
  },
  {
    name: 'TerminalId',
    schema: protocol.TerminalIdSchema,
    valid: [`trm_${ULID}`],
    invalid: ['p3', `ses_${ULID}`],
  },
  {
    name: 'CheckKind',
    schema: protocol.CheckKindSchema,
    valid: ['test', 'build', 'typecheck', 'lint', 'other'],
    invalid: ['unit', ''],
  },
  {
    name: 'CheckTrigger',
    schema: protocol.CheckTriggerSchema,
    valid: ['manual', 'after_turn'],
    invalid: ['always'],
  },
  {
    name: 'CheckSource',
    schema: protocol.CheckSourceSchema,
    valid: [
      { kind: 'user' },
      { kind: 'package_script', file: 'package.json', script: 'test', scriptHash: 'sha256:1' },
      { kind: 'instructions', file: 'AGENTS.md' },
    ],
    invalid: [{ kind: 'package_script', file: 'package.json', script: 'test' }, { kind: 'repo' }],
  },
  {
    name: 'CheckDefinition',
    schema: protocol.CheckDefinitionSchema,
    valid: [checkDefinition, { ...checkDefinition, paths: undefined, trigger: 'manual' }],
    invalid: [
      { ...checkDefinition, revision: 0 },
      { ...checkDefinition, timeoutMs: 999 },
    ],
  },
  {
    name: 'CheckInput',
    schema: protocol.CheckInputSchema,
    valid: [{ name: 'test', command: 'npm test', kind: 'test', trigger: 'manual' }],
    invalid: [{ name: 'test', command: '   ', kind: 'test', trigger: 'manual' }],
  },
  {
    name: 'CheckCandidate',
    schema: protocol.CheckCandidateSchema,
    valid: [
      {
        name: 'test',
        command: 'npm run test',
        cwd: '',
        kind: 'test',
        source: {
          kind: 'package_script',
          file: 'package.json',
          script: 'test',
          body: 'node --test',
        },
      },
    ],
    invalid: [
      { name: 'test', command: 'npm test', cwd: '', kind: 'test', source: { kind: 'user' } },
    ],
  },
  {
    name: 'RepairSettings',
    schema: protocol.RepairSettingsSchema,
    valid: [protocol.DEFAULT_REPAIR_SETTINGS],
    invalid: [{ ...protocol.DEFAULT_REPAIR_SETTINGS, maxAttempts: 0 }],
  },
  {
    name: 'CodeState',
    schema: protocol.CodeStateSchema,
    valid: [
      { kind: 'git', head: 'abc', tree: 'def' },
      { kind: 'git', head: null, tree: 'def' },
      { kind: 'none', reason: 'not_git' },
    ],
    invalid: [{ kind: 'git', head: 'abc' }, { kind: 'none' }],
  },
  {
    name: 'VerificationStatus',
    schema: protocol.VerificationStatusSchema,
    valid: [
      'not_run',
      'running',
      'passed',
      'failed',
      'timed_out',
      'cancelled',
      'environment_unavailable',
      'stale',
    ],
    invalid: ['ok'],
  },
  {
    name: 'VerificationTrigger',
    schema: protocol.VerificationTriggerSchema,
    valid: ['manual', 'after_turn', 'repair'],
    invalid: ['auto'],
  },
  {
    name: 'VerificationTests',
    schema: protocol.VerificationTestsSchema,
    valid: [{ passed: 1, failed: 0, skipped: 0 }],
    invalid: [{ passed: 1 }],
  },
  {
    name: 'VerificationRun',
    schema: protocol.VerificationRunSchema,
    valid: [verificationRun, { ...verificationRun, status: 'stale', reason: 'code_changed' }],
    invalid: [{ ...verificationRun, checkRevision: 0 }],
  },
  {
    name: 'ProcessId',
    schema: protocol.ProcessIdSchema,
    valid: ['p1', 'v12'],
    invalid: ['p', '1', 'proc_1'],
  },
  {
    name: 'ProcessSource',
    schema: protocol.ProcessSourceSchema,
    valid: [
      agentProcess.source,
      checkProcess.source,
      { kind: 'agent', sessionId: agentProcess.source.sessionId },
    ],
    invalid: [{ kind: 'check', sessionId: agentProcess.source.sessionId }],
  },
  {
    name: 'ProcessStopSignal',
    schema: protocol.ProcessStopSignalSchema,
    valid: ['SIGINT', 'SIGTERM', 'SIGKILL'],
    invalid: ['SIGHUP'],
  },
  {
    name: 'HostProcess',
    schema: protocol.HostProcessSchema,
    valid: [agentProcess, checkProcess],
    invalid: [{ ...agentProcess, status: 'paused' }],
  },
  {
    name: 'Terminal',
    schema: protocol.TerminalSchema,
    valid: [terminalSample, exitedTerminal],
    invalid: [
      { ...terminalSample, cols: 1 },
      { ...terminalSample, title: 'x'.repeat(201) },
    ],
  },
  {
    name: 'AcceptanceStatus',
    schema: protocol.AcceptanceStatusSchema,
    valid: ['unverified', 'verifying', 'accepted', 'failed', 'environment_unavailable'],
    invalid: ['passed'],
  },
  {
    name: 'SessionAcceptance',
    schema: protocol.SessionAcceptanceSchema,
    valid: [acceptanceSample, { status: 'unverified', reason: 'code_changed', updatedAt: TS }],
    invalid: [{ status: 'unverified' }],
  },
  {
    name: 'RepairStatus',
    schema: protocol.RepairStatusSchema,
    valid: ['running', 'passed', 'stopped'],
    invalid: ['failed'],
  },
  {
    name: 'RepairChain',
    schema: protocol.RepairChainSchema,
    valid: [repairChain, { ...repairChain, status: 'running', stopReason: undefined }],
    invalid: [{ ...repairChain, maxAttempts: 0 }],
  },
  {
    name: 'RepairFrom',
    schema: protocol.RepairFromSchema,
    valid: [
      {
        repairId: `rpr_${ULID}`,
        attempt: 1,
        maxAttempts: 2,
        roundId: `vrd_${ULID}`,
        originTurnId: `trn_${ULID}`,
      },
    ],
    invalid: [{ repairId: `rpr_${ULID}`, attempt: 0, maxAttempts: 2 }],
  },
  {
    name: 'SessionVerification',
    schema: protocol.SessionVerificationSchema,
    valid: [{ acceptance: acceptanceSample, runs: [verificationRun], repair: repairChain }],
    invalid: [{ runs: [] }],
  },
  {
    name: 'GitIndexToken',
    schema: protocol.GitIndexTokenSchema,
    valid: ['a'.repeat(64)],
    invalid: ['a'.repeat(40), 'A'.repeat(64)],
  },
  {
    name: 'GitFileSide',
    schema: protocol.GitFileSideSchema,
    valid: [{ status: 'modified', added: 1, removed: 0 }, { status: 'untracked' }],
    invalid: [{ status: '' }, { status: 'modified', added: -1 }],
  },
  {
    name: 'GitStagedBy',
    schema: protocol.GitStagedBySchema,
    valid: ['wevir', 'external'],
    invalid: ['user'],
  },
  {
    name: 'GitStatusFile',
    schema: protocol.GitStatusFileSchema,
    valid: [
      ...(gitStatusSample.files ?? []),
      { path: 'lib/x.ts', staged: { status: 'added', by: 'external' }, outside: true },
    ],
    invalid: [{ path: '' }, { path: 'a.ts', staged: { status: 'added' } }],
  },
  {
    name: 'GitVerificationCheck',
    schema: protocol.GitVerificationCheckSchema,
    valid: [...(gitStatusSample.verification?.checks ?? [])],
    invalid: [{ checkId: ids.check, name: 'x', status: 'unknown' }],
  },
  {
    name: 'GitVerificationSummary',
    schema: protocol.GitVerificationSummarySchema,
    valid: [{ checks: [], stagedMatchesWorkingTree: true }],
    invalid: [{ checks: [] }],
  },
  {
    name: 'GitCommitOutcome',
    schema: protocol.GitCommitOutcomeSchema,
    valid: [
      { kind: 'failed', reason: 'signing_failed', exitCode: 128, output: 'error: gpg failed' },
      {
        kind: 'committed',
        commit: 'a'.repeat(40),
        parent: null,
        tree: 'b'.repeat(40),
        stagedTree: 'c'.repeat(40),
        treeChanged: true,
      },
    ],
    invalid: [{ kind: 'skipped' }, { kind: 'failed' }],
  },
  {
    name: 'ReviewCommentId',
    schema: protocol.ReviewCommentIdSchema,
    valid: [`rvc_${ULID}`],
    invalid: [`chk_${ULID}`, 'rvc_'],
  },
  {
    name: 'ReviewSide',
    schema: protocol.ReviewSideSchema,
    valid: ['old', 'new'],
    invalid: ['left', 'additions'],
  },
  {
    name: 'ReviewAnchor',
    schema: protocol.ReviewAnchorSchema,
    valid: [
      { state: 'current' },
      { state: 'relocated', startLine: 4, endLine: 6 },
      { state: 'outdated', reason: 'ambiguous' },
    ],
    invalid: [{ state: 'moved' }, { state: 'relocated', startLine: 0 }],
  },
  {
    name: 'ReviewSent',
    schema: protocol.ReviewSentSchema,
    valid: [{ sessionId: `ses_${ULID}`, at: TS, pendingId: `pnd_${ULID}` }],
    invalid: [{ at: TS }],
  },
  {
    name: 'ReviewComment',
    schema: protocol.ReviewCommentSchema,
    valid: [reviewComment, sentReviewComment],
    invalid: [
      { ...reviewComment, body: '' },
      { ...reviewComment, status: 'draft' },
    ],
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
  it('Gemini Schema 清洗可省略、无默认值，只接受布尔值', () => {
    expect(ProviderCompatSchema.parse({})).not.toHaveProperty('geminiToolSchema');
    for (const geminiToolSchema of [true, false])
      expect(ProviderCompatSchema.parse({ geminiToolSchema })).toEqual({ geminiToolSchema });
    expect(ProviderCompatSchema.safeParse({ geminiToolSchema: 'true' }).success).toBe(false);
  });
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
