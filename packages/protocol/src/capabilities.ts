import { z } from 'zod';

// 能力位、功能与权限（host-api.md「兼容规则」）。三者都是开放集合：认不出的键或值照常接受，
// 新老两端互相解析时不会因为对方多了一项而失败。

/**
 * 客户端能力位：客户端在 `host.hello` 里声明自己能理解的新线缆形状，Host 据此决定发新形状还是降级。
 * 新增时按下面的格式写，并在 host-api.md 的能力表里登记：
 *
 * ```ts
 * // COMPAT(fooEnum): added in 0.2.0, remove gate after 2027-06-01
 * fooEnum: 'foo_enum',
 * ```
 */
export const CLIENT_CAPABILITIES = {
  // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
  /** 认得 `TitleSource` 的 `generated`；没有时 Host 把它降级成 `first_prompt`。 */
  titleSourceGenerated: 'title_source_generated',
  // COMPAT(providerKindChatgpt): added in 0.7.0, remove gate after 2027-06-01
  /** 认得 `ProviderKind` 的 `chatgpt`；没有时 Host 从 `provider.list` 的结果里去掉这类 Provider。 */
  providerKindChatgpt: 'provider_kind_chatgpt',
} as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/** 已知能力位写成 `z.boolean().optional()`；未知键原样保留。 */
export const ClientCapabilitiesSchema = z.looseObject({
  title_source_generated: z.boolean().optional(),
  provider_kind_chatgpt: z.boolean().optional(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

/**
 * Host 功能：Host 在 `host.hello` 结果里声明，客户端在一处判断是启用功能还是提示升级 Host。
 * 新增方式同 `CLIENT_CAPABILITIES`，并在 host-api.md 的功能表里登记。功能可能取决于 Host 用的引擎，所以只列名字，值由 Host
 * 每次握手时给出。
 */
export const HOST_FEATURES = {
  /**
   * ChatGPT 账号（0.7.0，R6）：`account.*` 方法、`account.updated` 通知与 `chatgpt` 类 Provider 可用。只有 Codex 引擎有，
   * dsh 与 echo 引擎的 Host 不声明它。
   */
  chatgptAccount: 'chatgpt_account',
  /** 回合进行中发消息（0.8.0）：`session.send` 的 `delivery`、`pending.*` 方法与事件、`user.steered`。 */
  pendingMessages: 'pending_messages',
  /** Host 设置（0.8.0）：`settings.get` / `settings.update` 与 `settings.updated` 通知。 */
  hostSettings: 'host_settings',
  /** 换会话的模型与推理档位（0.9.0）：`session.configure` 与 `session.configured` 事件。取决于引擎（Codex 有）。 */
  sessionConfigure: 'session_configure',
  /** 引擎向用户提问（0.10.0）：`question.*` 事件与 `question.respond`。取决于引擎（Codex 有）。 */
  userQuestions: 'user_questions',
  /**
   * 权限模式（0.11.0）：`session.create` 与 `session.configure` 的 `permissionMode`，会话与 `session.created` /
   * `session.configured` 带它。取决于引擎（Codex 有，dsh 没有）。
   */
  permissionModes: 'permission_modes',
  /** 工作区的 git 状态（0.13.0，U18）：`workspace.git`。与引擎无关。 */
  workspaceGit: 'workspace_git',
  /** 子会话本身可以 `session.cancel`（0.14.0，U21），父会话不受影响。与引擎无关。 */
  subagentCancel: 'subagent_cancel',
  /** 保存的环境（0.15.0，U22.1）：`environment.*` 与 `session.create` 的 `environmentId`。与引擎无关。 */
  environments: 'environments',
  /** 建议的后续任务（0.16.0，U23）：`tasks.suggested` / `task.*` 事件与 `session.create` 的 `origin`。取决于引擎。 */
  suggestedTasks: 'suggested_tasks',
  /** 支线会话（0.17.0，U23.1）：`session.fork` 与 `Session` 的 `forkedFrom`、`side`。取决于引擎。 */
  sideSessions: 'side_sessions',
} as const;
export type HostFeature = (typeof HOST_FEATURES)[keyof typeof HOST_FEATURES];

export const HostFeaturesSchema = z.looseObject({
  chatgpt_account: z.boolean().optional(),
  pending_messages: z.boolean().optional(),
  host_settings: z.boolean().optional(),
  session_configure: z.boolean().optional(),
  user_questions: z.boolean().optional(),
  permission_modes: z.boolean().optional(),
  workspace_git: z.boolean().optional(),
  subagent_cancel: z.boolean().optional(),
  environments: z.boolean().optional(),
  suggested_tasks: z.boolean().optional(),
  side_sessions: z.boolean().optional(),
});
export type HostFeatures = z.infer<typeof HostFeaturesSchema>;

/**
 * 权限词表。每个方法需要其中一项（`MethodSchemas[*].permission`）；骨架阶段 Host 对每个连接都给全部，
 * 词表为将来的设备权限预留（ADR-0002 未决事项 3）。
 */
export const PERMISSIONS = [
  'host.manage',
  'workspace.read',
  'workspace.write',
  'provider.read',
  'provider.write',
  'session.read',
  'session.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 线缆上是开放的字符串数组，旧客户端遇到新权限名不会解析失败。 */
export const PermissionsSchema = z.array(z.string().min(1));
