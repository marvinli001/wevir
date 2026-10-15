import { z } from 'zod';
import {
  ClientCapabilitiesSchema,
  HostFeaturesSchema,
  type Permission,
  PermissionsSchema,
} from './capabilities.js';
import {
  ApprovalIdSchema,
  ClientKindSchema,
  ClientTokenSchema,
  EnvironmentIdSchema,
  HostIdSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionIdSchema,
  SubscriptionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  AccountKindSchema,
  AccountLoginMethodSchema,
  AccountStateSchema,
  ApprovalResolutionSchema,
  EngineErrorInfoSchema,
  EnvironmentFolderSchema,
  EnvironmentSchema,
  HostSettingsSchema,
  HttpUrlSchema,
  PendingDeliverySchema,
  PendingMessageSchema,
  PermissionModeSchema,
  ProviderApiSchema,
  ProviderCompatSchema,
  ProviderModelSchema,
  ProviderProfileSchema,
  QuestionAnswerSchema,
  QuestionResolutionSchema,
  ResolvedApprovalStatusSchema,
  SessionOriginSchema,
  SessionSchema,
  SessionSnapshotSchema,
  UserContentPartSchema,
  WorkspaceSchema,
  WorktreeModeSchema,
} from './entities.js';
import { WevirEventSchema } from './events.js';
import { ProtocolVersionSchema } from './version.js';

// Host API v0 的方法与通知。语义、错误与示例报文见 docs/architecture/host-api.md。

const EmptySchema = z.object({});

// ── host.* ────────────────────────────────────────────────────────────

export const HostHelloParamsSchema = z.object({
  /** `run/host.json` 里的令牌。 */
  token: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  clientKind: ClientKindSchema,
  /** 设备级标识。 */
  deviceId: ClientTokenSchema,
  /** 每个安装持久；同一台设备上的桌面与 CLI 不同。 */
  clientId: ClientTokenSchema,
  capabilities: ClientCapabilitiesSchema,
});

export const HostHelloResultSchema = z.object({
  hostId: HostIdSchema,
  hostVersion: z.string().min(1),
  /** 协商后的版本：客户端与 Host 中较低的一个。 */
  protocolVersion: ProtocolVersionSchema,
  minProtocolVersion: ProtocolVersionSchema,
  features: HostFeaturesSchema,
  /** 本连接拿到的权限；骨架阶段恒为 `PERMISSIONS` 全部。 */
  permissions: PermissionsSchema,
});

// ── settings.*（0.8.0） ────────────────────────────────────────────

export const SettingsResultSchema = z.object({
  settings: HostSettingsSchema,
});

export const SettingsUpdateParamsSchema = z.object({
  /** 只改给出的字段。 */
  settings: HostSettingsSchema.partial(),
});

/** `settings.updated` 通知：设置变了，带全部设置。发给调用过 `settings.*` 的连接。 */
export const SettingsUpdatedParamsSchema = SettingsResultSchema;

// ── workspace.* ───────────────────────────────────────────────────────

export const WorkspaceListResultSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});

export const WorkspaceAddParamsSchema = z.object({
  /** 绝对路径；Host 取 realpath 后去重。 */
  rootPath: z.string().min(1),
  /** 省略时取目录名。 */
  displayName: z.string().min(1).optional(),
});

export const WorkspaceAddResultSchema = z.object({
  workspace: WorkspaceSchema,
  /** false：同一 realpath 已有工作区（含曾被移除的），返回原 `id`。 */
  created: z.boolean(),
});

export const WorkspaceRemoveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

// ── environment.*（0.15.0，U22.1） ────────────────────────────────────

export const EnvironmentListResultSchema = z.object({
  /** 按创建时间。 */
  environments: z.array(EnvironmentSchema),
});

export const EnvironmentCreateParamsSchema = z.object({
  name: z.string().min(1).max(60),
  folders: z.array(EnvironmentFolderSchema).min(1).max(8),
});

export const EnvironmentUpdateParamsSchema = z.object({
  environmentId: EnvironmentIdSchema,
  /** 省略：不改。 */
  name: z.string().min(1).max(60).optional(),
  /** 省略：不改。 */
  folders: z.array(EnvironmentFolderSchema).min(1).max(8).optional(),
});

export const EnvironmentResultSchema = z.object({
  environment: EnvironmentSchema,
});

export const EnvironmentIdParamsSchema = z.object({
  environmentId: EnvironmentIdSchema,
});

// ── workspace.git（0.13.0，U18） ──────────────────────────────────────

export const WorkspaceGitParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** 0.15.0：读这个会话的目录（环境会话的 worktree）；会话要属于这个工作区。省略时读工作区目录。 */
  sessionId: SessionIdSchema.optional(),
});

/** `workspace.git` 结果里的一个改动的文件。 */
export const GitFileChangeSchema = z.object({
  /** 相对工作区目录，`/` 分隔。 */
  path: z.string().min(1),
  /** 已见 `modified` / `added` / `deleted` / `untracked`；开放字符串，以后可能多出取值。 */
  status: z.string().min(1),
  /** 增删行数；二进制文件与未跟踪文件没有。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

/** 文件列表最多这么多项，多了 `truncated`。 */
export const WORKSPACE_GIT_MAX_FILES = 200;

/**
 * 工作区目录的 git 状态（host-api.md §3.1）：每次调用现读，不缓存。`repo: false`（不是仓库、没有 git、出错或超时）时
 * 其余字段都省略。
 */
export const WorkspaceGitResultSchema = z.object({
  repo: z.boolean(),
  /** 当前分支（含还没有提交的新分支）；分离头指针时没有。 */
  branch: z.string().min(1).optional(),
  /** 分离头指针时 HEAD 的短 SHA。 */
  detachedAt: z.string().min(1).optional(),
  /** 已跟踪文件相对 HEAD 的增删行数之和（工作树 + 暂存区，只算工作区目录里的）。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
  /** 改动的文件数，含未跟踪文件；`files` 被截断时仍是总数。 */
  fileCount: z.int().min(0).optional(),
  files: z.array(GitFileChangeSchema).max(WORKSPACE_GIT_MAX_FILES).optional(),
  /** `files` 只列了前 `WORKSPACE_GIT_MAX_FILES` 项。 */
  truncated: z.boolean().optional(),
});
export type WorkspaceGitResult = z.infer<typeof WorkspaceGitResultSchema>;

// ── provider.* ────────────────────────────────────────────────────────

export const ProviderListResultSchema = z.object({
  providers: z.array(ProviderProfileSchema),
});

const providerUpsertCommon = {
  displayName: z.string().min(1),
  defaultModelId: z.string().min(1),
  /**
   * 省略：保留已存的 Key；字符串：设置或替换；null：删除。
   * Key 只进 SecretStore，Host 不得把它写进日志或任何响应。
   */
  apiKey: z.string().min(1).nullable().optional(),
};

/** 整体替换非密钥字段（不是合并）；`id` 不存在时新建。`kind` 创建后不可改。 */
export const ProviderUpsertParamsSchema = z.discriminatedUnion('kind', [
  z.object({
    ...providerUpsertCommon,
    /** dsh 的路由名固定，所以这类 Profile 最多一个。 */
    id: z.literal('deepseek-official'),
    kind: z.literal('deepseek-official'),
    baseURL: HttpUrlSchema.optional(),
    models: z.array(ProviderModelSchema),
  }),
  z.object({
    ...providerUpsertCommon,
    id: ProviderIdSchema,
    kind: z.literal('openai-compatible'),
    api: ProviderApiSchema,
    baseURL: HttpUrlSchema,
    compat: ProviderCompatSchema.optional(),
    models: z.array(ProviderModelSchema).min(1),
  }),
  /**
   * ChatGPT 订阅（0.7.0）：没有 Key、地址与 compat；`models` 由 Host 从引擎取（ChatGPT 登录成功时 Host 会自己建这个
   * Provider，客户端用 upsert 改显示名与默认模型）。`defaultModelId` 要在引擎给的模型列表里。只在 Host 声明了
   * `chatgpt_account` 功能时可用，否则 `INVALID_PARAMS`。
   */
  z.object({
    id: z.literal('chatgpt'),
    kind: z.literal('chatgpt'),
    displayName: z.string().min(1),
    defaultModelId: z.string().min(1),
  }),
]);

export const ProviderUpsertResultSchema = z.object({
  provider: ProviderProfileSchema,
  created: z.boolean(),
});

export const ProviderIdParamsSchema = z.object({
  providerId: ProviderIdSchema,
});

export const ProviderTestParamsSchema = z.object({
  providerId: ProviderIdSchema,
  /** 省略时用 `defaultModelId`。 */
  modelId: z.string().min(1).optional(),
});

/**
 * `provider.test` 失败的原因（0.2.0），供界面给出对应的修复提示；原文在 `error.message`。
 * missing_key：没有存 Key，没有发请求；network：连不上（DNS、拒绝连接、TLS）；timeout：时限内没有响应；
 * auth：401 / 403；model_not_found：服务端说没有这个模型；protocol：地址能连上但不按所选协议应答
 * （404 / 405、返回的不是该协议的流）；rate_limited：429（含额度用完）；server：5xx；unknown：其他。
 */
export const ProviderTestFailureSchema = z.enum([
  'missing_key',
  'network',
  'timeout',
  'auth',
  'model_not_found',
  'protocol',
  'rate_limited',
  'server',
  'unknown',
]);
export type ProviderTestFailure = z.infer<typeof ProviderTestFailureSchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.int().min(0).optional(),
  /** `ok` 为 false 时必有。 */
  error: EngineErrorInfoSchema.optional(),
  /** `ok` 为 false 时有（0.2.0）。 */
  reason: ProviderTestFailureSchema.optional(),
  /** 服务端返回的 HTTP 状态码（0.2.0）；没有收到响应时省略。 */
  httpStatus: z.int().min(100).max(599).optional(),
});

// ── account.*（0.7.0，R6） ─────────────────────────────────────────────

export const AccountKindParamsSchema = z.object({
  kind: AccountKindSchema,
});

export const AccountLoginParamsSchema = z.object({
  kind: AccountKindSchema,
  method: AccountLoginMethodSchema,
});

export const AccountCancelLoginParamsSchema = z.object({
  kind: AccountKindSchema,
  /** 省略时取消当前的登录；与当前的不符时什么都不做。 */
  loginId: z.string().min(1).optional(),
});

export const AccountResultSchema = z.object({
  account: AccountStateSchema,
});

/** `account.updated` 通知：账号状态变了（登录开始、完成、失败、取消，登出，套餐或用量变化），带完整的状态。 */
export const AccountUpdatedParamsSchema = z.object({
  account: AccountStateSchema,
});

// ── session.* ─────────────────────────────────────────────────────────

/** `session.fork`（0.17.0，Host 功能 `side_sessions`）：从会话分出一个支线会话。`side` 现在只能是 `true`。 */
export const SessionForkParamsSchema = z.object({
  sessionId: SessionIdSchema,
  side: z.literal(true),
});

export const SessionCreateParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  providerId: ProviderIdSchema,
  /** 省略时用 Provider 的 `defaultModelId`。 */
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  /** 权限模式（0.11.0，Host 功能 `permission_modes`）；省略时是 `on_request`。 */
  permissionMode: PermissionModeSchema.optional(),
  /** 用这个环境建（0.15.0，Host 功能 `environments`）：`workspaceId` 必须是它的主文件夹。 */
  environmentId: EnvironmentIdSchema.optional(),
  /**
   * `new`：在工作区的仓库里给这个会话新开一个 git worktree（0.18.0，Host 功能 `session_worktree`，domain-model §3.10）；
   * 省略或 `none`：用工作区目录本身。不能与 `environmentId` 同时给（环境按文件夹定）。
   */
  worktree: WorktreeModeSchema.optional(),
  /** 从一项建议开出来（0.16.0，Host 功能 `suggested_tasks`）。 */
  origin: SessionOriginSchema.optional(),
});

export const SessionResultSchema = z.object({
  session: SessionSchema,
});

/**
 * 换会话的模型、推理档位（0.9.0，Host 功能 `session_configure`）或权限模式（0.11.0，Host 功能 `permission_modes`）：从下一个
 * 回合起生效，进行中的回合不受影响。只能在会话所用 Provider 的模型里换（Provider 列了模型时）；不换 Provider。
 */
export const SessionConfigureParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** 省略：不改。 */
  modelId: z.string().min(1).optional(),
  /** 省略：不改；null：清掉，用模型的默认档位。换了模型而没给它时也清掉。 */
  reasoningEffort: z.string().min(1).nullable().optional(),
  /** 省略：不改。 */
  permissionMode: PermissionModeSchema.optional(),
});

export const SessionListParamsSchema = z.object({
  /** 省略时列出所有未移除工作区的会话。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /**
   * 给了就只列出这个会话的子会话（0.6.0）；不给时不含子会话（domain-model §3.3.1）。
   */
  parentSessionId: SessionIdSchema.optional(),
});

export const SessionListResultSchema = z.object({
  /** 按 `updatedAt` 从新到旧。 */
  sessions: z.array(SessionSchema),
});

export const SessionIdParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SessionSendParamsSchema = z.object({
  sessionId: SessionIdSchema,
  content: z.array(UserContentPartSchema).min(1),
  /** 幂等键：同一会话里同一 ID 重发返回原结果，不再发给引擎；请求体不同则 `CLIENT_MESSAGE_CONFLICT`。 */
  clientMessageId: ClientTokenSchema.optional(),
  /**
   * 回合进行中怎样送达（0.8.0，domain-model §4.6）：`steer` 插话、`queue` 排队，成为待发消息。省略时
   * 回合进行中回 `SESSION_BUSY`（旧客户端的行为）。会话空闲时不起作用。
   */
  delivery: PendingDeliverySchema.optional(),
});

export const SessionSendResultSchema = z.object({
  /** 开始的回合；成为待发消息时没有（0.8.0）。 */
  turnId: TurnIdSchema.optional(),
  /** 成为待发消息时有（0.8.0）。 */
  pendingId: PendingMessageIdSchema.optional(),
  /** 本次 `user.message`（成为待发消息时是 `pending.added`）事件的 `seq`。 */
  seq: SeqSchema,
});

// ── pending.*（0.8.0） ─────────────────────────────────────────────

export const PendingUpdateParamsSchema = z.object({
  sessionId: SessionIdSchema,
  pendingId: PendingMessageIdSchema,
  /** 新的内容；只有排队的与暂停的能改。 */
  content: z.array(UserContentPartSchema).min(1).optional(),
  /** 新的方式（domain-model §4.6）。 */
  delivery: PendingDeliverySchema.optional(),
});

export const PendingIdParamsSchema = z.object({
  sessionId: SessionIdSchema,
  pendingId: PendingMessageIdSchema,
});

export const PendingResultSchema = z.object({
  pending: PendingMessageSchema,
});

export const PendingListResultSchema = z.object({
  /** 未到终态的待发消息，按加入的先后。 */
  pendingMessages: z.array(PendingMessageSchema),
});

// ── approval.* ────────────────────────────────────────────────────────

// ── question.*（0.10.0） ─────────────────────────────────────────────

export const QuestionRespondParamsSchema = z.object({
  questionId: QuestionIdSchema,
  /** 按问题 ID 的回答；没回答的问题可以省略（当作跳过）。 */
  answers: z.record(z.string(), QuestionAnswerSchema),
});

export const QuestionRespondResultSchema = z.object({
  questionId: QuestionIdSchema,
  status: z.enum(['answered', 'cancelled']),
  resolution: QuestionResolutionSchema,
});

export const ApprovalRespondParamsSchema = z.object({
  approvalId: ApprovalIdSchema,
  /** 必须是该审批 `options` 里的一个，否则 `INVALID_PARAMS`。 */
  optionId: z.string().min(1),
});

export const ApprovalRespondResultSchema = z.object({
  approvalId: ApprovalIdSchema,
  status: ResolvedApprovalStatusSchema,
  resolution: ApprovalResolutionSchema,
});

// ── events.* ──────────────────────────────────────────────────────────

export const EventsSubscribeParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** 补发 `seq > sinceSeq` 的事件；0 = 从头开始。 */
  sinceSeq: SeqCursorSchema,
});

export const EventsSubscribeResultSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  /** 回放结束标记：订阅建立时会话的 `lastSeq`。客户端应用到这个 `seq` 即追平，之后都是实时事件。 */
  replayedThroughSeq: SeqCursorSchema,
});

export const EventsUnsubscribeParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
});

/** `events.event` 通知的参数：每条通知一个事件。 */
export const EventsEventParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  event: WevirEventSchema,
});

// ── 注册表 ────────────────────────────────────────────────────────────

export interface MethodSpec {
  params: z.ZodType;
  result: z.ZodType;
  /** 调用所需权限；null = 不需要（握手与心跳）。 */
  permission: Permission | null;
}

/**
 * 客户端 → Host 的方法注册表，Host 与 client-sdk 共用。键是方法名，顺序与 host-api.md 的方法表一致。
 * 除 `host.hello` 外，所有方法都要求本连接已完成 hello。
 */
export const MethodSchemas = {
  'host.hello': {
    params: HostHelloParamsSchema,
    result: HostHelloResultSchema,
    permission: null,
  },
  'host.ping': { params: EmptySchema, result: EmptySchema, permission: null },
  'host.shutdown': { params: EmptySchema, result: EmptySchema, permission: 'host.manage' },
  'settings.get': {
    params: EmptySchema,
    result: SettingsResultSchema,
    permission: 'session.read',
  },
  'settings.update': {
    params: SettingsUpdateParamsSchema,
    result: SettingsResultSchema,
    permission: 'host.manage',
  },

  'workspace.list': {
    params: EmptySchema,
    result: WorkspaceListResultSchema,
    permission: 'workspace.read',
  },
  'workspace.add': {
    params: WorkspaceAddParamsSchema,
    result: WorkspaceAddResultSchema,
    permission: 'workspace.write',
  },
  'workspace.remove': {
    params: WorkspaceRemoveParamsSchema,
    result: EmptySchema,
    permission: 'workspace.write',
  },
  'environment.list': {
    params: EmptySchema,
    result: EnvironmentListResultSchema,
    permission: 'workspace.read',
  },
  'environment.create': {
    params: EnvironmentCreateParamsSchema,
    result: EnvironmentResultSchema,
    permission: 'workspace.write',
  },
  'environment.update': {
    params: EnvironmentUpdateParamsSchema,
    result: EnvironmentResultSchema,
    permission: 'workspace.write',
  },
  'environment.remove': {
    params: EnvironmentIdParamsSchema,
    result: EmptySchema,
    permission: 'workspace.write',
  },
  'workspace.git': {
    params: WorkspaceGitParamsSchema,
    result: WorkspaceGitResultSchema,
    permission: 'workspace.read',
  },

  'provider.list': {
    params: EmptySchema,
    result: ProviderListResultSchema,
    permission: 'provider.read',
  },
  'provider.upsert': {
    params: ProviderUpsertParamsSchema,
    result: ProviderUpsertResultSchema,
    permission: 'provider.write',
  },
  'provider.remove': {
    params: ProviderIdParamsSchema,
    result: EmptySchema,
    permission: 'provider.write',
  },
  'provider.test': {
    params: ProviderTestParamsSchema,
    result: ProviderTestResultSchema,
    permission: 'provider.write',
  },

  'account.get': {
    params: AccountKindParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.read',
  },
  'account.login': {
    params: AccountLoginParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.cancelLogin': {
    params: AccountCancelLoginParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.logout': {
    params: AccountKindParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },

  'session.create': {
    params: SessionCreateParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.list': {
    params: SessionListParamsSchema,
    result: SessionListResultSchema,
    permission: 'session.read',
  },
  'session.get': {
    params: SessionIdParamsSchema,
    result: SessionSnapshotSchema,
    permission: 'session.read',
  },
  'session.configure': {
    params: SessionConfigureParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.send': {
    params: SessionSendParamsSchema,
    result: SessionSendResultSchema,
    permission: 'session.write',
  },
  'session.cancel': {
    params: SessionIdParamsSchema,
    result: EmptySchema,
    permission: 'session.write',
  },
  'session.close': {
    params: SessionIdParamsSchema,
    result: EmptySchema,
    permission: 'session.write',
  },
  'session.resume': {
    params: SessionIdParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.fork': {
    params: SessionForkParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'pending.update': {
    params: PendingUpdateParamsSchema,
    result: PendingResultSchema,
    permission: 'session.write',
  },
  'pending.cancel': {
    params: PendingIdParamsSchema,
    result: PendingResultSchema,
    permission: 'session.write',
  },
  'pending.resume': {
    params: SessionIdParamsSchema,
    result: PendingListResultSchema,
    permission: 'session.write',
  },

  'question.respond': {
    params: QuestionRespondParamsSchema,
    result: QuestionRespondResultSchema,
    permission: 'session.write',
  },
  'approval.respond': {
    params: ApprovalRespondParamsSchema,
    result: ApprovalRespondResultSchema,
    permission: 'session.write',
  },

  'events.subscribe': {
    params: EventsSubscribeParamsSchema,
    result: EventsSubscribeResultSchema,
    permission: 'session.read',
  },
  'events.unsubscribe': {
    params: EventsUnsubscribeParamsSchema,
    result: EmptySchema,
    permission: 'session.read',
  },
} as const satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof MethodSchemas;
export type MethodParams<M extends MethodName> = z.infer<(typeof MethodSchemas)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof MethodSchemas)[M]['result']>;

export const METHOD_NAMES = Object.keys(MethodSchemas) as MethodName[];

export function isMethodName(method: string): method is MethodName {
  return Object.hasOwn(MethodSchemas, method);
}

/** Host → 客户端的通知注册表。 */
export const NotificationSchemas = {
  'events.event': { params: EventsEventParamsSchema },
  /** 发给调用过 `account.*` 方法的连接（0.7.0）。 */
  'account.updated': { params: AccountUpdatedParamsSchema },
  /** 发给调用过 `settings.*` 的连接（0.8.0）。 */
  'settings.updated': { params: SettingsUpdatedParamsSchema },
} as const satisfies Record<string, { params: z.ZodType }>;

export type NotificationName = keyof typeof NotificationSchemas;
export type NotificationParams<N extends NotificationName> = z.infer<
  (typeof NotificationSchemas)[N]['params']
>;

export const NOTIFICATION_NAMES = Object.keys(NotificationSchemas) as NotificationName[];
