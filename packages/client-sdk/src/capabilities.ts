import type {
  ClientCapability,
  EngineFeatures,
  HostFeature,
  HostFeatures,
  SessionCommand,
} from '@wevir/protocol';

/**
 * 本版 client-sdk 能理解的全部客户端能力位（ADR-0002 §2、host-api.md §10），在 `host.hello` 里声明。
 * CLI 与桌面直接继承这张表，不各自维护。
 *
 * 穷举：protocol 的 `CLIENT_CAPABILITIES` 每加一个能力位，`satisfies` 就要求这里写上它，否则类型检查
 * 失败。新能力位意味着客户端要能处理它放开的新形状，所以加进来之前先把处理写好。
 * - `title_source_generated`（0.5.0）：`TitleSource` 的 `generated` 只是一个新的来源值，会话列表与消息投影
 *   不按来源分支，照常显示标题。
 * - `provider_kind_chatgpt`（0.7.0）：`ProviderKind` 的 `chatgpt`。CLI 的 `provider list` 与桌面端的 Provider 列表
 *   按 kind 分支的地方都处理了它（没有 Key、没有地址，桌面端在“ChatGPT 账号”一节里显示）。
 * - `subscription_kinds`（0.19.0）：`ProviderKind` 与 `AccountKind` 的订阅来源。CLI 的 `provider list` 写“订阅登录”，桌面端的
 *   表单只管 DeepSeek 官方与 OpenAI 兼容，订阅来源在设置的订阅一节与模型选择里按种类显示。
 * - `subscription_accounts`（0.63.0）：同一来源的多个账号（`AccountState.id`）。`watchAccounts` 按账号 ID 替换，`watchAccount`
 *   只跟首个账号；CLI 只管 ChatGPT 的首个账号，桌面端的订阅一节与模型选择按账号显示。
 * - `user_images`（0.28.0）：`UserContentPart` 的 `image`。消息投影把它投成图片段（`ChatPart` 的 `image`），CLI 写成
 *   “[图片]”，桌面端经 `image.read` 读出来显示。
 * - `question_timeout`（0.72.0）：`QuestionResolutionReason` 的 `timeout`。回答照常投影；桌面端在回答下面写“超时，按推荐回答”，
 *   CLI 在回答前加“超时”。
 * - `approval_rules`（0.80.0）：`ApprovalResolutionReason` 的 `rule`。桌面端与 CLI 写“已按规则允许”。
 * - `approval_timeout`（0.105.0）：`ApprovalResolutionReason` 的 `timeout` 与错误码 `APPROVAL_EXPIRED`。桌面端与 CLI 写“审批已过期”。
 * - `dev_preview`（0.84.0）：`ProcessSource` 的 `preview`。桌面端的进程窗格与“预览”卡片按它显示；CLI 不列进程。
 * - `tool_display_image`（0.116.0）：`ToolDisplayKind` 的 `image`。消息投影把 `tool.finished` 的 `images` 放进工具段，桌面端把这种
 *   工具画成消息流里的一张图（生成时 img-fx 的动画，生成后显现），CLI 照普通工具写一行。
 */
export const DEFAULT_CLIENT_CAPABILITIES = {
  title_source_generated: true,
  provider_kind_chatgpt: true,
  provider_kind_google_vertex: true,
  subscription_kinds: true,
  subscription_accounts: true,
  user_images: true,
  question_timeout: true,
  approval_rules: true,
  approval_timeout: true,
  dev_preview: true,
  tool_display_image: true,
} as const satisfies Record<ClientCapability, true>;

/** Host 是否声明了这项功能（host-api.md §10：客户端只在一处判断，功能内部不写降级路径）。 */
export function hostSupports(features: HostFeatures, feature: HostFeature): boolean {
  return features[feature] === true;
}

const COMMAND_FEATURES = {
  compact: 'session_compact',
  review: 'session_review',
} as const satisfies Record<SessionCommand, HostFeature>;

/**
 * 会话能不能用这个命令（0.27.0）：Host 声明了功能，且会话当前的引擎会。`engine` 是 `host.hello` 的 `engineFeatures` 按会话当前
 * Provider 的种类查到的那项；0.27.0 之前的 Host 没有它的 `commands`，只看功能（引擎不会时发出去才被拒绝）。
 */
export function commandSupported(
  features: HostFeatures,
  engine: EngineFeatures | undefined,
  command: SessionCommand,
): boolean {
  return (
    hostSupports(features, COMMAND_FEATURES[command]) &&
    (engine?.commands === undefined || engine.commands.includes(command))
  );
}

/**
 * 会话能不能用目标（0.35.0，`session.setGoal` 等）：Host 声明了 `session_goals`，且会话当前的引擎有目标（`engineFeatures` 的
 * `goals`）。没有 `engineFeatures` 的旧 Host 也没有这个功能。
 */
export function goalsSupported(
  features: HostFeatures,
  engine: EngineFeatures | undefined,
): boolean {
  return hostSupports(features, 'session_goals') && engine?.goals === true;
}

/**
 * 会话能不能用计划模式（0.36.0）：Host 声明了 `plan_mode`，且会话当前的引擎有（`engineFeatures` 的 `planMode`）。`engine` 同
 * `commandSupported`；0.36.0 的 Host 总是给 `engineFeatures`，没有那一项时当作没有。
 */
export function planModeSupported(
  features: HostFeatures,
  engine: EngineFeatures | undefined,
): boolean {
  return hostSupports(features, 'plan_mode') && engine?.planMode === true;
}

/**
 * 会话能不能分支到新会话（0.38.0，`session.fork` 不带 `side`）：Host 声明了 `session_branches`，且会话当前的引擎能分支
 * （`engineFeatures` 的 `branch`）。
 */
export function branchSupported(
  features: HostFeatures,
  engine: EngineFeatures | undefined,
): boolean {
  return hostSupports(features, 'session_branches') && engine?.branch === true;
}

/**
 * 会话能不能撤回最后一个回合（0.38.0，`session.rewind`，编辑重发最后一条用户消息）：Host 声明了 `session_rewind`，且会话当前的
 * 引擎能撤回（`engineFeatures` 的 `rewind`）。
 */
export function rewindSupported(
  features: HostFeatures,
  engine: EngineFeatures | undefined,
): boolean {
  return hostSupports(features, 'session_rewind') && engine?.rewind === true;
}

/**
 * 会话能不能撤销与重做回合（0.51.0，`session.undo` / `session.redo`）：Host 声明了 `session_undo`，且会话当前的引擎收得了补进上下文的
 * 说明（`engineFeatures` 的 `undo`）。
 */
export function undoSupported(features: HostFeatures, engine: EngineFeatures | undefined): boolean {
  return hostSupports(features, 'session_undo') && engine?.undo === true;
}
