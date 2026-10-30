// 新建会话（M2）：选项目（或不在项目里的对话）、同目录或新工作树、来源（引擎与账号）、模型与思考力度、权限模式，写第一条消息；
// `session.create` 之后 `session.send`（同桌面：发出第一条消息时才建）。权限模式只给“请求批准”和“自动批准”，完全放行只在电脑上。
// 列模型服务要 `provider.read`，手机没有时说明只能在电脑上新建。每台电脑上次的选择记在手机上（`NewSessionDefaults`），下次照用，
// 多数时候打开就能直接写、直接发。纯逻辑，连接由调用方注入。

import { accountId, isRpcError } from '@wevir/client-sdk';
import type {
  AccountState,
  HostFeature,
  MethodParams,
  PermissionMode,
  ProviderModel,
  ProviderProfile,
  Session,
  UserContentPart,
  Workspace,
  WorkspaceId,
} from '@wevir/protocol';
import { SUBSCRIPTION_KINDS } from '@wevir/protocol';
import type { MessageKey } from '../i18n';
import type { SessionClient } from './session-watch';

/** 手机上能选的权限模式：没有“完全放行”（`policy.write` 只在电脑上）。 */
export const PHONE_PERMISSION_MODES = [
  'on_request',
  'auto_review',
] as const satisfies readonly PermissionMode[];
export type PhonePermissionMode = (typeof PHONE_PERMISSION_MODES)[number];

/** 订阅来源的顺序与名称（软件名照原文，不翻译）；ChatGPT 订阅跑在 Codex 上，叫 Codex。同桌面 data/sources.ts。 */
const SOURCE_KINDS = ['chatgpt', ...SUBSCRIPTION_KINDS] as const;
const SOURCE_NAMES: Record<(typeof SOURCE_KINDS)[number], string> = {
  chatgpt: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  workbuddy: 'WorkBuddy',
  grok: 'Grok',
  antigravity: 'Antigravity',
  devin: 'Devin',
  copilot: 'Copilot',
  kiro: 'Kiro',
};

function isSourceKind(kind: string): kind is (typeof SOURCE_KINDS)[number] {
  return (SOURCE_KINDS as readonly string[]).includes(kind);
}

function accountOf(
  provider: Pick<ProviderProfile, 'id' | 'kind'>,
  accounts: readonly AccountState[] | undefined,
): AccountState | undefined {
  if (!isSourceKind(provider.kind)) return undefined;
  return accounts?.find((account) => accountId(account) === provider.id);
}

/**
 * 能选的来源，订阅在前（按固定顺序）、API 在后（Host 给的顺序）：停用的不列，订阅要已登录（没读到账号时照列）。同桌面的
 * `isPickable` 与 `pickerOrder`。
 */
export function pickableProviders(
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
): ProviderProfile[] {
  const rank = (provider: ProviderProfile) => {
    const index = (SOURCE_KINDS as readonly string[]).indexOf(provider.kind);
    return index < 0 ? SOURCE_KINDS.length : index;
  };
  return providers
    .filter((provider) => {
      if (provider.enabled === false) return false;
      const account = accountOf(provider, accounts);
      return account === undefined || account.status === 'signed_in';
    })
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(({ provider }) => provider);
}

/** 来源给人看的名字：订阅是软件名，同种有多个账号时加标签或序号（“Claude · 工作”“Claude 2”）；API 是 Provider 的名字。 */
export function providerTitle(
  provider: ProviderProfile,
  accounts: readonly AccountState[] | undefined,
): string {
  if (!isSourceKind(provider.kind)) return provider.displayName || provider.id;
  const name = SOURCE_NAMES[provider.kind];
  const account = accountOf(provider, accounts);
  if (account === undefined) return name;
  if (account.label !== undefined) return `${name} · ${account.label}`;
  if (accountId(account) === account.kind) return name;
  const siblings = (accounts ?? []).filter((a) => a.kind === account.kind);
  const index = siblings.indexOf(account);
  return index < 0 ? name : `${name} ${index + 1}`;
}

/** 来源的模型；没列模型的只有默认模型。 */
export function modelsOf(provider: ProviderProfile): ProviderModel[] {
  if (provider.models.length > 0) return provider.models;
  return [{ id: provider.defaultModelId }];
}

export function modelName(model: ProviderModel): string {
  return model.displayName ?? model.id;
}

export interface ModelChoice {
  providerId: string;
  modelId: string;
  /** 省略：模型的默认力度。 */
  reasoningEffort?: string;
}

/** 选中的（或第一个）来源的默认模型；之前的选择还能用就沿用，力度不在模型的档位里时去掉。 */
export function resolveChoice(
  providers: readonly ProviderProfile[],
  previous: ModelChoice | undefined,
): ModelChoice | undefined {
  const provider = providers.find((p) => p.id === previous?.providerId) ?? providers[0];
  if (provider === undefined) return undefined;
  const models = modelsOf(provider);
  const model =
    previous?.providerId === provider.id
      ? models.find((m) => m.id === previous.modelId)
      : undefined;
  if (model === undefined || previous === undefined)
    return { providerId: provider.id, modelId: provider.defaultModelId };
  const effort = previous.reasoningEffort;
  return {
    providerId: provider.id,
    modelId: model.id,
    ...(effort !== undefined &&
      (model.reasoningEfforts as readonly string[] | undefined)?.includes(effort) && {
        reasoningEffort: effort,
      }),
  };
}

/** 选的模型能选的思考力度（空：不能选，用默认）。 */
export function effortsOf(
  providers: readonly ProviderProfile[],
  choice: ModelChoice | undefined,
): string[] {
  if (choice === undefined) return [];
  const provider = providers.find((p) => p.id === choice.providerId);
  if (provider === undefined) return [];
  const model = modelsOf(provider).find((m) => m.id === choice.modelId);
  return [...(model?.reasoningEfforts ?? [])];
}

export interface NewSessionDraft {
  /** 省略：不在项目里的对话。 */
  workspaceId?: WorkspaceId;
  /** 在项目的仓库里新开一个工作树。 */
  newWorktree: boolean;
  choice: ModelChoice;
  permissionMode: PhonePermissionMode;
}

/** 这台电脑支持的部分（看 `host.hello` 的功能位）。 */
export interface NewSessionFeatures {
  chats: boolean;
  worktree: boolean;
  permissionModes: boolean;
}

export function createParams(
  draft: NewSessionDraft,
  features: NewSessionFeatures,
): MethodParams<'session.create'> {
  const { choice } = draft;
  return {
    ...(draft.workspaceId !== undefined && { workspaceId: draft.workspaceId }),
    providerId: choice.providerId,
    modelId: choice.modelId,
    ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
    ...(features.permissionModes && { permissionMode: draft.permissionMode }),
    ...(draft.newWorktree &&
      draft.workspaceId !== undefined &&
      features.worktree && { worktree: 'new' as const }),
  } as MethodParams<'session.create'>;
}

/** 读到的选项，或读不了的原因。 */
export type NewSessionOptions =
  | {
      kind: 'ready';
      workspaces: Workspace[];
      providers: ProviderProfile[];
      accounts: AccountState[] | undefined;
      features: NewSessionFeatures;
    }
  /** 这台手机缺权限（`session.write` 或 `provider.read`）：只能在电脑上新建。 */
  | { kind: 'forbidden' }
  | { kind: 'failed' };

/** 新建会话要用到的连接（`SessionClient` 加功能位与权限）。 */
export interface NewSessionClient extends SessionClient {
  readonly canReadProviders: boolean;
  supports(feature: HostFeature): boolean;
}

export async function loadOptions(client: NewSessionClient): Promise<NewSessionOptions> {
  if (!client.canWrite || !client.canReadProviders) return { kind: 'forbidden' };
  try {
    const [workspaces, providers, accounts] = await Promise.all([
      client.request('workspace.list', {}),
      client.request('provider.list', {}),
      client.request('account.list', {}).then(
        (result) => result.accounts,
        () => undefined,
      ),
    ]);
    return {
      kind: 'ready',
      // “对话”工作区不当作项目列出：不选项目就是建在它里面。
      workspaces: workspaces.workspaces.filter((w) => w.kind === undefined),
      providers: pickableProviders(providers.providers, accounts),
      accounts,
      features: {
        chats: client.supports('chat_sessions'),
        worktree: client.supports('session_worktree'),
        permissionModes: client.supports('permission_modes'),
      },
    };
  } catch (error) {
    if (isRpcError(error, 'DEVICE_FORBIDDEN')) return { kind: 'forbidden' };
    return { kind: 'failed' };
  }
}

/** 上次在一台电脑上新建会话时的选择。 */
export interface NewSessionDefaults {
  /** `null`：不在项目里的对话。 */
  workspaceId?: string | null;
  /** 只对同一个项目沿用。 */
  newWorktree?: boolean;
  choice?: ModelChoice;
  permissionMode?: PhonePermissionMode;
}

/** 手机上记着的：上次用的电脑与每台电脑的选择。 */
export interface NewSessionMemory {
  computer?: string;
  computers: Record<string, NewSessionDefaults>;
}

export function isNewSessionMemory(value: unknown): value is NewSessionMemory {
  if (typeof value !== 'object' || value === null) return false;
  const { computer, computers } = value as Partial<NewSessionMemory>;
  return (
    (computer === undefined || typeof computer === 'string') &&
    typeof computers === 'object' &&
    computers !== null
  );
}

/** 页面打开时的选择：指定的项目优先，其次是上次的选择（还在、还能用的部分），最后是默认。 */
export function initialDraft(
  options: Extract<NewSessionOptions, { kind: 'ready' }>,
  saved: NewSessionDefaults | undefined,
  requested?: string,
): Omit<NewSessionDraft, 'choice'> & { choice: ModelChoice | undefined } {
  const exists = (id: string | null | undefined): id is string =>
    typeof id === 'string' && options.workspaces.some((w) => w.id === id);
  const workspaceId = exists(requested)
    ? requested
    : exists(saved?.workspaceId)
      ? saved.workspaceId
      : options.features.chats
        ? undefined
        : options.workspaces[0]?.id;
  const savedMode = saved?.permissionMode;
  return {
    ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
    newWorktree:
      workspaceId !== undefined &&
      options.features.worktree &&
      saved?.workspaceId === workspaceId &&
      saved.newWorktree === true,
    choice: resolveChoice(options.providers, saved?.choice),
    permissionMode:
      savedMode !== undefined && (PHONE_PERMISSION_MODES as readonly string[]).includes(savedMode)
        ? savedMode
        : 'on_request',
  };
}

/** 新建成功后记下的选择。 */
export function rememberDraft(draft: NewSessionDraft): NewSessionDefaults {
  return {
    workspaceId: draft.workspaceId ?? null,
    newWorktree: draft.newWorktree,
    choice: draft.choice,
    permissionMode: draft.permissionMode,
  };
}

/** 建会话并发出第一条消息；返回建好的会话。消息没发出时会话已经建好，照样返回（之后在会话页再发）。 */
export async function startSession(
  client: SessionClient,
  draft: NewSessionDraft,
  features: NewSessionFeatures,
  content: UserContentPart[],
  clientMessageId: string,
): Promise<{ session: Session; sent: boolean }> {
  const { session } = await client.request('session.create', createParams(draft, features));
  try {
    await client.request('session.send', {
      sessionId: session.id,
      content,
      clientMessageId,
    });
    return { session, sent: true };
  } catch {
    return { session, sent: false };
  }
}

/** 建会话失败时给界面的一句话。 */
export function createErrorKey(error: unknown): MessageKey {
  if (isRpcError(error, 'DEVICE_FORBIDDEN')) return 'error.computerOnly';
  return 'newSession.failed';
}
