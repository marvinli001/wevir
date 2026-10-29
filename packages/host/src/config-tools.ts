// 配置 Wevir 本身的应用级工具（0.136.0）：用户在界面里能改的 Host 设置、项目、环境、验证检查、审批规则、依赖与语言服务器的安装、
// 会话的模型与目标，Agent 也能经这几个工具改，用户不必自己去设置里点。全部走现有的 Host 方法（`createHostMethods` 的同一套实现，
// 参数照样按方法注册表校验），不另写一套。
//
// 审批分三档：
// - 照常：引擎按会话的权限模式决定问不问（工具标 `destructiveHint`，不进 `APP_TOOLS_NO_APPROVAL`）。
// - 要用户批准：Agent 会借它放宽自己的权限、碰到密钥、或改动所有会话都会读的说明（`agentInstructions`、自动调优、环境、审批规则、
//   移除项目、依赖安装、全局装语言服务器……）。引擎已经为这次调用问过用户、用户答应了就不再问；没问过（`full_access`、自动审查、
//   引擎不问 MCP 工具）时 Host 补问（`requestAppToolApproval`），同插件写工具。
// - 只有用户能改：电脑操作、iOS 模拟器、远程访问、无人值守审批的过期时间。工具拒绝，让 Agent 请用户去设置里改。
// 读的那个（`wevir_config_read`）只读，不用批准。环境变量的值可能是密钥：工具只回名字，事件与审批卡片里的值换成 `[REDACTED]`。

import { createHash, randomUUID } from 'node:crypto';
import type {
  ClientIdentity,
  Hook,
  HookCommandHandler,
  HostSettings,
  MethodParams,
  MethodResult,
  Session,
  SessionId,
  TurnId,
  WorkspaceId,
} from '@wevir/protocol';
import { HOOK_EVENTS, MethodSchemas } from '@wevir/protocol';
import { type AgentEvent, APP_TOOLS_SERVER, appToolBaseName } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import {
  type AppTool,
  type AppToolCall,
  AppToolError,
  type AppToolResult,
  jsonResult,
} from './app-mcp.js';
import {
  objectSchema,
  optionalEnum,
  optionalInt,
  optionalString,
  requiredString,
} from './app-tools.js';
import { CHECK_PROPERTY, parseCheck } from './automations/automation-tools.js';
import { isHostError } from './errors.js';
import type { EventStore } from './event-store.js';
import type { HostMethodName, HostMethods } from './host-methods.js';
import type { SessionManager } from './session-manager.js';

/** 经 Host 方法表调一个方法：参数按注册表校验，身份是应用级工具。 */
export type HostCall = <M extends HostMethodName>(
  method: M,
  params: MethodParams<M>,
) => Promise<MethodResult<M>>;

/** 用 `createHostMethods` 的结果做 `HostCall`；方法表在 AppTools 之后才建好，取不到时回错。 */
export function hostCaller(
  methods: () => HostMethods | undefined,
  client: ClientIdentity,
): HostCall {
  return async (method, params) => {
    const table = methods();
    if (table === undefined) throw new AppToolError('Wevir is still starting. Try again.');
    const parsed = MethodSchemas[method].params.safeParse(params);
    if (!parsed.success) {
      throw new AppToolError(
        `Invalid ${method} parameters: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ')}.`,
      );
    }
    const handler = table[method] as (
      params: unknown,
      context: { client: ClientIdentity; capabilities: Record<string, never> },
    ) => MethodResult<typeof method> | Promise<MethodResult<typeof method>>;
    return handler(parsed.data, { client, capabilities: {} });
  };
}

/** 这组工具的名字（预设的分组、`prepareEvent` 认它们）。 */
export const CONFIG_TOOLS = [
  'wevir_config_read',
  'wevir_config_settings',
  'wevir_config_update',
  'wevir_config_checks',
  'wevir_config_install',
  'wevir_config_session',
] as const;
type ConfigToolName = (typeof CONFIG_TOOLS)[number];

/**
 * 每个 Host 设置谁能改：`agent` 照常、`approval` 要用户批准、`user` 只有用户。列全所有键，新加的设置不归档就编译不过。
 */
export const SETTINGS_ACCESS: Record<keyof HostSettings, 'agent' | 'approval' | 'user'> = {
  sendWhileBusy: 'agent',
  promptSuggestions: 'agent',
  sessionRecap: 'agent',
  sessionInsights: 'agent',
  autoMemory: 'agent',
  ruleFiles: 'agent',
  outputStyle: 'agent',
  marketMirror: 'agent',
  speechPolish: 'agent',
  writingStyle: 'agent',
  preventSleep: 'agent',
  notifications: 'agent',
  // 所有会话都读的长期说明：改它等于给以后的每个会话下指令。
  agentInstructions: 'approval',
  // 后台的额外模型请求与它们的月度额度。
  autoTuning: 'approval',
  autoTuningMonthlyTokens: 'approval',
  // 录音交给哪个 Provider 转写。
  speechTranscriber: 'approval',
  // 放宽 Agent 自己的能力或对外暴露：只有用户能改。
  computerUse: 'user',
  iosSimulator: 'user',
  remote: 'user',
  unattendedApprovalTimeoutMinutes: 'user',
};

/** 只有用户能改的设置在哪一页（`wevir_show` 的 `settings`）；没有界面的不给。 */
const USER_SETTING_PAGE: Partial<Record<keyof HostSettings, string>> = {
  computerUse: 'computerUse',
  remote: 'devices',
};

/** `wevir_show` 的 `settings` 能打开的页（桌面端的设置分页，加上插件页）。 */
export const SETTINGS_PAGES = [
  'general',
  'appearance',
  'notifications',
  'providers',
  'personalization',
  'web',
  'computerUse',
  'dictation',
  'memory',
  'approvalRules',
  'workspaces',
  'devices',
  'storage',
  'plugins',
] as const;

const READ_SECTIONS = [
  'settings',
  'projects',
  'environments',
  'checks',
  'approval_rules',
  'usage',
  'lsp',
  'hooks',
] as const;
const CONFIGURE_TARGETS = [
  'project',
  'environment',
  'approval_rule',
  'memory_note',
  'hook',
] as const;
const CONFIGURE_ACTIONS = ['add', 'update', 'remove', 'enable', 'disable'] as const;
const CHECK_ACTIONS = ['save', 'remove', 'repair', 'test_automation_check'] as const;
const TOOLCHAIN_ACTIONS = [
  'install_dependencies',
  'install_language_server',
  'restart_language_server',
] as const;

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** 照常审批：Codex 看到 destructive 就按权限模式问，Claude 与 OpenCode 看 `APP_TOOLS_NO_APPROVAL`（不在表里）。 */
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
/** 只动自己或自己开出的会话，不用批准（同 `wevir_session_close`）。 */
const OWN_SESSION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const REDACTED = '[REDACTED]';
const DAY_MS = 24 * 60 * 60_000;

export interface ConfigToolsOptions {
  call: HostCall;
  storage: Storage;
  events: EventStore;
  sessions: Pick<SessionManager, 'requestAppToolApproval'>;
  /** 调用方自己（`id` 省略或是它自己）或它开出的会话（沿 `openedBy`）；别的会话抛 `AppToolError`。 */
  ownSession(callerId: SessionId, id: string | undefined): Session;
}

/** 引擎为一次调用报过的工具事件：参数的摘要与用户在引擎的审批里答了什么。 */
interface Seen {
  sessionId: SessionId;
  toolCallId: string;
  name: ConfigToolName;
  turnId: TurnId | undefined;
  fingerprint: string;
  approved?: boolean;
  consumed?: boolean;
}

export class ConfigTools {
  readonly tools: readonly AppTool[];
  readonly #options: ConfigToolsOptions;
  readonly #seen = new Map<string, Seen>();

  constructor(options: ConfigToolsOptions) {
    this.#options = options;
    this.tools = [
      this.#readTool(),
      this.#settingsTool(),
      this.#configureTool(),
      this.#checksTool(),
      this.#toolchainTool(),
      this.#sessionTool(),
    ];
  }

  /** 引擎事件落库前：记下这组工具调用的参数摘要（批准沿用），环境变量的值换成 `[REDACTED]`。 */
  prepareEvent(sessionId: SessionId, event: AgentEvent): AgentEvent {
    if (event.type !== 'tool.started' && event.type !== 'tool.updated') return event;
    const key = `${sessionId}:${event.toolCallId}`;
    const name =
      event.type === 'tool.started' ? configToolName(event.toolName) : this.#seen.get(key)?.name;
    if (name === undefined || event.input === undefined) return event;
    const fingerprintOf = fingerprint(name, engineArgs(event.input, name));
    const seen = this.#seen.get(key);
    if (seen !== undefined) seen.fingerprint = fingerprintOf;
    else {
      this.#seen.set(key, {
        sessionId,
        toolCallId: event.toolCallId,
        name,
        turnId: this.#options.events.snapshot(sessionId)?.session.activeTurn?.turnId,
        fingerprint: fingerprintOf,
      });
    }
    return { ...event, input: redact(event.input) };
  }

  /** 引擎的审批结了：`approvedByUser` 是用户自己答应的（不是规则或自动审查）。 */
  resolved(sessionId: SessionId, toolCallId: string, approvedByUser: boolean): void {
    const seen = this.#seen.get(`${sessionId}:${toolCallId}`);
    if (seen) seen.approved = approvedByUser;
  }

  finishTurn(sessionId: SessionId, turnId: TurnId): void {
    for (const [key, seen] of this.#seen) {
      if (seen.sessionId === sessionId && (seen.turnId === turnId || seen.consumed === true)) {
        this.#seen.delete(key);
      }
    }
  }

  // ── 批准 ───────────────────────────────────────────────────────────

  /** 要用户批准的改动：引擎为这次调用问过、用户答应了就过；没问过时 Host 补问。 */
  async #approve(
    call: AppToolCall,
    name: ConfigToolName,
    args: Record<string, unknown>,
    summary: Record<string, unknown>,
  ): Promise<void> {
    const hash = fingerprint(name, args);
    const candidates = [...this.#seen.values()].filter(
      (seen) => seen.sessionId === call.sessionId && seen.fingerprint === hash && !seen.consumed,
    );
    const seen = candidates.find((item) => item.approved === true) ?? candidates[0];
    if (seen) seen.consumed = true;
    if (seen?.approved === true) return;
    const server = call.server ?? APP_TOOLS_SERVER;
    const approved = await this.#options.sessions.requestAppToolApproval(
      call.sessionId,
      seen?.toolCallId ?? `app-${randomUUID()}`,
      {
        toolName: `mcp__${server}__${name}`,
        display: { kind: 'unknown', mcpServer: server, summary: JSON.stringify(summary, null, 2) },
        input: summary,
      },
      call.signal,
    );
    if (!approved) {
      throw new AppToolError('The user denied or cancelled this change. Nothing was changed.');
    }
  }

  // ── 调用方 ─────────────────────────────────────────────────────────

  #caller(sessionId: SessionId) {
    const record = this.#options.storage.sessions.get(sessionId);
    const workspace = record && this.#options.storage.workspaces.get(record.workspaceId);
    if (!record || !workspace || workspace.removedAt !== undefined) {
      throw new AppToolError('This Wevir session no longer exists.');
    }
    return { record, workspaceId: record.workspaceId as WorkspaceId };
  }

  async #host<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isHostError(error)) {
        const issues = (
          error.data as { issues?: { path?: unknown[]; message?: string }[] } | undefined
        )?.issues;
        const detail =
          issues !== undefined && issues.length > 0
            ? ` (${issues.map((issue) => `${(issue.path ?? []).join('.') || 'params'}: ${issue.message ?? ''}`).join('; ')})`
            : '';
        throw new AppToolError(`${error.code}: ${error.message}${detail}`);
      }
      throw error;
    }
  }

  // ── 工具 ───────────────────────────────────────────────────────────

  #readTool(): AppTool {
    return {
      name: 'wevir_config_read',
      title: 'Read Wevir configuration',
      description:
        'Read Wevir setup: settings (and who may change each), projects, environments, checks (with candidate ' +
        'commands), approval_rules, usage (cost of the last days, default 30), lsp (language servers, install ' +
        'plans) or hooks (lifecycle hooks of every source, status, engines that run each event). The other ' +
        'wevir_config_* tools change it.',
      inputSchema: objectSchema(
        {
          section: { type: 'string', enum: [...READ_SECTIONS] },
          days: { type: 'integer', minimum: 1, maximum: 365 },
        },
        ['section'],
      ),
      annotations: READ,
      call: async (args, { sessionId }) => {
        const { workspaceId } = this.#caller(sessionId);
        const call = this.#options.call;
        switch (optionalEnum(args, 'section', READ_SECTIONS)) {
          case 'settings': {
            const { settings } = await this.#host(() => call('settings.get', {}));
            return jsonResult({ settings, access: settingsAccess() });
          }
          case 'projects': {
            const { workspaces } = await this.#host(() => call('workspace.list', {}));
            return jsonResult({
              currentProjectId: workspaceId,
              projects: workspaces.filter((workspace) => workspace.kind !== 'chats'),
            });
          }
          case 'environments': {
            const { environments } = await this.#host(() => call('environment.list', {}));
            return jsonResult({ environments: environments.map(withoutValues) });
          }
          case 'checks': {
            const [checks, { candidates }] = await this.#host(() =>
              Promise.all([
                call('checks.list', { workspaceId }),
                call('checks.candidates', { workspaceId }),
              ]),
            );
            return jsonResult({ ...checks, candidates });
          }
          case 'approval_rules':
            return jsonResult(await this.#host(() => call('approvalRule.list', { workspaceId })));
          case 'usage': {
            const days = optionalInt(args, 'days', 1, 365) ?? 30;
            const now = Date.now();
            const summary = await this.#host(() =>
              call('usage.summary', { edges: [now - days * DAY_MS, now] }),
            );
            return jsonResult({
              days,
              totals: summary.totals,
              byProvider: summary.byProvider,
              byModel: summary.byModel,
              pricing: summary.pricing,
            });
          }
          case 'lsp':
            return jsonResult(
              await this.#host(() => call('lsp.status', { workspaceId, sessionId })),
            );
          case 'hooks':
            return jsonResult(await this.#host(() => call('hook.list', { workspaceId })));
          default:
            throw new AppToolError(`section must be one of ${READ_SECTIONS.join(', ')}.`);
        }
      },
    };
  }

  #settingsTool(): AppTool {
    const keys = (access: 'agent' | 'approval' | 'user') =>
      Object.entries(SETTINGS_ACCESS)
        .filter(([, value]) => value === access)
        .map(([key]) => key)
        .join(', ');
    return {
      name: 'wevir_config_settings',
      title: 'Change Wevir settings',
      description:
        'Change Wevir settings shared by all sessions; give only the fields to change (see wevir_config_read ' +
        `section "settings" for current values). You may change: ${keys('agent')}. The user must approve: ` +
        `${keys('approval')}. Only the user can change: ${keys('user')} (ask them; wevir_show kind "settings" ` +
        'opens the page). Most changes apply from the next new or resumed session.',
      inputSchema: objectSchema({ settings: { type: 'object' } }, ['settings']),
      annotations: WRITE,
      call: async (args, call) => {
        this.#caller(call.sessionId);
        const settings = args.settings;
        if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
          throw new AppToolError('settings must be an object of the fields to change.');
        }
        const entries = Object.entries(settings as Record<string, unknown>);
        if (entries.length === 0) throw new AppToolError('settings is empty.');
        const unknown = entries.filter(([key]) => !(key in SETTINGS_ACCESS)).map(([key]) => key);
        if (unknown.length > 0) {
          throw new AppToolError(
            `Unknown settings: ${unknown.join(', ')}. Known: ${Object.keys(SETTINGS_ACCESS).join(', ')}.`,
          );
        }
        const userOnly = entries
          .map(([key]) => key as keyof HostSettings)
          .filter((key) => SETTINGS_ACCESS[key] === 'user');
        if (userOnly.length > 0) {
          const pages = userOnly.flatMap((key) => USER_SETTING_PAGE[key] ?? []);
          throw new AppToolError(
            `Only the user can change ${userOnly.join(', ')}. Ask them to change it themselves` +
              (pages.length > 0
                ? `; wevir_show with kind "settings" and page "${pages[0]}" opens the page.`
                : '.'),
          );
        }
        const sensitive = entries.filter(
          ([key]) => SETTINGS_ACCESS[key as keyof HostSettings] === 'approval',
        );
        if (sensitive.length > 0) {
          await this.#approve(call, 'wevir_config_settings', args, {
            action: 'Change Wevir settings',
            settings,
          });
        }
        const { settings: updated } = await this.#host(() =>
          this.#options.call('settings.update', {
            settings: settings as MethodParams<'settings.update'>['settings'],
          }),
        );
        return jsonResult({ settings: updated });
      },
    };
  }

  #configureTool(): AppTool {
    return {
      name: 'wevir_config_update',
      title: 'Configure Wevir projects',
      description:
        'Change Wevir configuration by target and action. project: add (rootPath, optional name and extraFolders), ' +
        'update (projectId defaults to this project; name, extraFolders replaces the extra source folders) or remove ' +
        '(projectId; the user must approve; no open sessions). environment: add (name, folders, variables), update ' +
        '(environmentId; name, folders, variables replaces the whole list: give only name to keep a stored value) or ' +
        'remove; folders are [{"projectId","worktree":"none"|"new"}]; the user approves every environment change, ' +
        'and variable values are never shown back. approval_rule: add (prefix: command tokens such as ["pnpm","test"], ' +
        'scope "project" or "global") or remove (ruleId); commands starting with the prefix then run without asking, ' +
        "so the user must approve. memory_note: enable or disable (scope, name); enabling needs the user's approval. " +
        'hook: Wevir lifecycle hooks (Claude Code format): add (event, optional matcher, command, timeout, onFailure, ' +
        'name, scope), update (hookId and fields), remove, enable or disable (hookId); the user approves every hook ' +
        'change. Hooks from the repository or plugins can only be enabled by the user on the settings page.',
      inputSchema: objectSchema(
        {
          target: { type: 'string', enum: [...CONFIGURE_TARGETS] },
          action: { type: 'string', enum: [...CONFIGURE_ACTIONS] },
          projectId: { type: 'string' },
          rootPath: { type: 'string' },
          name: { type: 'string' },
          extraFolders: { type: 'array', items: { type: 'string' } },
          environmentId: { type: 'string' },
          folders: {
            type: 'array',
            items: objectSchema(
              {
                projectId: { type: 'string' },
                worktree: { type: 'string', enum: ['none', 'new'] },
              },
              ['projectId', 'worktree'],
            ),
          },
          variables: {
            type: 'array',
            items: objectSchema({ name: { type: 'string' }, value: { type: 'string' } }, ['name']),
          },
          prefix: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string', enum: ['project', 'global'] },
          ruleId: { type: 'string' },
          hookId: { type: 'string' },
          event: { type: 'string', enum: [...HOOK_EVENTS] },
          matcher: { type: 'string' },
          command: { type: 'string' },
          timeout: { type: 'integer', minimum: 1, maximum: 600 },
          onFailure: { type: 'string', enum: ['block', 'continue'] },
        },
        ['target', 'action'],
      ),
      annotations: WRITE,
      call: async (args, call) => {
        const target = optionalEnum(args, 'target', CONFIGURE_TARGETS);
        const action = optionalEnum(args, 'action', CONFIGURE_ACTIONS);
        switch (target) {
          case 'project':
            return this.#project(action, args, call);
          case 'environment':
            return this.#environment(action, args, call);
          case 'approval_rule':
            return this.#approvalRule(action, args, call);
          case 'memory_note':
            return this.#memoryNote(action, args, call);
          case 'hook':
            return this.#hook(action, args, call);
          default:
            throw new AppToolError(`target must be one of ${CONFIGURE_TARGETS.join(', ')}.`);
        }
      },
    };
  }

  async #project(
    action: (typeof CONFIGURE_ACTIONS)[number] | undefined,
    args: Record<string, unknown>,
    call: AppToolCall,
  ): Promise<AppToolResult> {
    const { workspaceId } = this.#caller(call.sessionId);
    const host = this.#options.call;
    const name = optionalString(args, 'name');
    const extraFolders = stringArray(args, 'extraFolders');
    switch (action) {
      case 'add': {
        const result = await this.#host(() =>
          host('workspace.add', {
            rootPath: requiredString(args, 'rootPath'),
            ...(name !== undefined && { displayName: name }),
            ...(extraFolders !== undefined && { extraFolders }),
          }),
        );
        return jsonResult({ project: result.workspace, created: result.created });
      }
      case 'update': {
        const projectId = (optionalString(args, 'projectId') ?? workspaceId) as WorkspaceId;
        if (name === undefined && extraFolders === undefined) {
          throw new AppToolError('Give name or extraFolders to change.');
        }
        const result = await this.#host(() =>
          host('workspace.update', {
            workspaceId: projectId,
            ...(name !== undefined && { displayName: name }),
            ...(extraFolders !== undefined && { extraFolders }),
          }),
        );
        return jsonResult({ project: result.workspace });
      }
      case 'remove': {
        const projectId = requiredString(args, 'projectId') as WorkspaceId;
        const project = this.#options.storage.workspaces.get(projectId);
        if (project === undefined || project.removedAt !== undefined) {
          throw new AppToolError(`No Wevir project ${projectId}.`);
        }
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Remove a project from Wevir (files stay on disk)',
          project: project.displayName,
          path: project.rootPath,
        });
        await this.#host(() => host('workspace.remove', { workspaceId: projectId }));
        return jsonResult({ removed: projectId });
      }
      default:
        throw new AppToolError('project actions are add, update and remove.');
    }
  }

  async #environment(
    action: (typeof CONFIGURE_ACTIONS)[number] | undefined,
    args: Record<string, unknown>,
    call: AppToolCall,
  ): Promise<AppToolResult> {
    this.#caller(call.sessionId);
    const host = this.#options.call;
    const name = optionalString(args, 'name');
    const folders = environmentFolders(args.folders);
    const variables = environmentVariables(args.variables);
    // 审批卡片里只有变量名与“设新值 / 沿用”，不出现值。
    const summary = {
      ...(name !== undefined && { name }),
      ...(folders !== undefined && { folders }),
      ...(variables !== undefined && {
        variables: variables.map((variable) =>
          variable.value === undefined
            ? `${variable.name} (keep stored value)`
            : `${variable.name} (new value)`,
        ),
      }),
    };
    switch (action) {
      case 'add': {
        if (name === undefined || folders === undefined) {
          throw new AppToolError('Adding an environment needs name and folders.');
        }
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Create a Wevir environment',
          ...summary,
        });
        const { environment } = await this.#host(() =>
          host('environment.create', {
            name,
            folders,
            ...(variables !== undefined && { variables }),
          }),
        );
        return jsonResult({ environment: withoutValues(environment) });
      }
      case 'update': {
        const environmentId = requiredString(args, 'environmentId');
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Change a Wevir environment',
          environmentId,
          ...summary,
        });
        const { environment } = await this.#host(() =>
          host('environment.update', {
            environmentId: environmentId as MethodParams<'environment.update'>['environmentId'],
            ...(name !== undefined && { name }),
            ...(folders !== undefined && { folders }),
            ...(variables !== undefined && { variables }),
          }),
        );
        return jsonResult({ environment: withoutValues(environment) });
      }
      case 'remove': {
        const environmentId = requiredString(args, 'environmentId');
        const current = this.#options.storage.environments.get(environmentId);
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Delete a Wevir environment and its variables',
          environmentId,
          ...(current !== undefined && { name: current.name }),
        });
        await this.#host(() =>
          host('environment.remove', {
            environmentId: environmentId as MethodParams<'environment.remove'>['environmentId'],
          }),
        );
        return jsonResult({ removed: environmentId });
      }
      default:
        throw new AppToolError('environment actions are add, update and remove.');
    }
  }

  async #approvalRule(
    action: (typeof CONFIGURE_ACTIONS)[number] | undefined,
    args: Record<string, unknown>,
    call: AppToolCall,
  ): Promise<AppToolResult> {
    const { workspaceId } = this.#caller(call.sessionId);
    const host = this.#options.call;
    switch (action) {
      case 'add': {
        const prefix = stringArray(args, 'prefix');
        if (prefix === undefined || prefix.length === 0) {
          throw new AppToolError('prefix is required: the command tokens, e.g. ["pnpm","test"].');
        }
        const scope = optionalEnum(args, 'scope', ['project', 'global'] as const) ?? 'project';
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Always allow commands starting with this prefix',
          prefix: prefix.join(' '),
          scope,
        });
        const { rule } = await this.#host(() =>
          host('approvalRule.add', {
            prefix,
            ...(scope === 'project' && { workspaceId }),
          }),
        );
        return jsonResult({ rule });
      }
      case 'remove': {
        const ruleId = requiredString(args, 'ruleId');
        const { rules } = await this.#host(() => host('approvalRule.list', {}));
        const rule = rules.find((item) => item.id === ruleId);
        if (rule === undefined) throw new AppToolError(`No approval rule ${ruleId}.`);
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Delete an approval rule',
          prefix: rule.prefix.join(' '),
        });
        const { deleted } = await this.#host(() =>
          host('approvalRule.delete', { ruleId: rule.id }),
        );
        return jsonResult({ deleted });
      }
      default:
        throw new AppToolError('approval_rule actions are add and remove.');
    }
  }

  /** Wevir 自己的生命周期钩子（0.137.0，ADR-0023 决策 7）：每个改动都要用户批准；仓库与插件来源的不能经 Agent 启用。 */
  async #hook(
    action: (typeof CONFIGURE_ACTIONS)[number] | undefined,
    args: Record<string, unknown>,
    call: AppToolCall,
  ): Promise<AppToolResult> {
    const { workspaceId } = this.#caller(call.sessionId);
    const host = this.#options.call;
    const handlerOf = (command: string): HookCommandHandler => {
      const timeout = optionalInt(args, 'timeout', 1, 600);
      const onFailure = optionalEnum(args, 'onFailure', ['block', 'continue'] as const);
      return {
        type: 'command',
        command,
        ...(timeout !== undefined && { timeout }),
        ...(onFailure !== undefined && { onFailure }),
      };
    };
    const own = async (): Promise<Hook> => {
      const hookId = requiredString(args, 'hookId');
      const { hooks } = await this.#host(() => host('hook.list', { workspaceId }));
      const hook = hooks.find((item) => item.id === hookId);
      if (hook === undefined) throw new AppToolError(`No hook ${hookId}.`);
      if (hook.source !== 'wevir') {
        throw new AppToolError(
          `Hook ${hookId} comes from ${hook.source === 'plugin' ? 'a plugin' : 'the repository or another app'}; only the user can enable or disable it on the settings page.`,
        );
      }
      return hook;
    };
    switch (action) {
      case 'add': {
        const event = optionalEnum(args, 'event', HOOK_EVENTS);
        if (event === undefined)
          throw new AppToolError(`event must be one of ${HOOK_EVENTS.join(', ')}.`);
        const command = requiredString(args, 'command');
        const matcher = optionalString(args, 'matcher');
        const name = optionalString(args, 'name');
        const scope = optionalEnum(args, 'scope', ['project', 'global'] as const) ?? 'project';
        const handler = handlerOf(command);
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Add a lifecycle hook that runs a command',
          scope,
          event,
          ...(matcher !== undefined && { matcher }),
          command,
        });
        const { hook } = await this.#host(() =>
          host('hook.add', {
            event,
            handler,
            ...(matcher !== undefined && { matcher }),
            ...(name !== undefined && { name }),
            ...(scope === 'project' && { workspaceId }),
          }),
        );
        return jsonResult({ hook });
      }
      case 'update': {
        const hook = await own();
        const event = optionalEnum(args, 'event', HOOK_EVENTS);
        const command = optionalString(args, 'command');
        const matcher = optionalString(args, 'matcher');
        const name = optionalString(args, 'name');
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Change a lifecycle hook',
          event: event ?? hook.event,
          ...((matcher ?? hook.matcher) !== undefined && { matcher: matcher ?? hook.matcher }),
          command: command ?? hook.command,
        });
        const handler =
          command !== undefined || args.timeout !== undefined || args.onFailure !== undefined
            ? handlerOf(command ?? hook.command ?? '')
            : undefined;
        const { hook: updated } = await this.#host(() =>
          host('hook.update', {
            hookId: hook.id,
            ...(event !== undefined && { event }),
            ...(matcher !== undefined && { matcher }),
            ...(name !== undefined && { name }),
            ...(handler !== undefined && { handler }),
          }),
        );
        return jsonResult({ hook: updated });
      }
      case 'remove': {
        const hook = await own();
        await this.#approve(call, 'wevir_config_update', args, {
          action: 'Delete a lifecycle hook',
          event: hook.event,
          command: hook.command,
        });
        await this.#host(() => host('hook.delete', { hookId: hook.id }));
        return jsonResult({ deleted: true });
      }
      case 'enable':
      case 'disable': {
        const hook = await own();
        await this.#approve(call, 'wevir_config_update', args, {
          action: action === 'enable' ? 'Enable a lifecycle hook' : 'Disable a lifecycle hook',
          event: hook.event,
          command: hook.command,
        });
        const { hook: updated } = await this.#host(() =>
          host('hook.setEnabled', { hookId: hook.id, enabled: action === 'enable' }),
        );
        return jsonResult({ hook: updated });
      }
      default:
        throw new AppToolError('hook actions are add, update, remove, enable and disable.');
    }
  }

  async #memoryNote(
    action: (typeof CONFIGURE_ACTIONS)[number] | undefined,
    args: Record<string, unknown>,
    call: AppToolCall,
  ): Promise<AppToolResult> {
    const { workspaceId } = this.#caller(call.sessionId);
    if (action !== 'enable' && action !== 'disable') {
      throw new AppToolError('memory_note actions are enable and disable.');
    }
    const scope = optionalEnum(args, 'scope', ['project', 'global'] as const) ?? 'project';
    const name = requiredString(args, 'name');
    // 停用的笔记是用户停的：重新启用要用户批准。
    if (action === 'enable') {
      await this.#approve(call, 'wevir_config_update', args, {
        action: 'Enable a memory note again',
        scope,
        name,
      });
    }
    const { note } = await this.#host(() =>
      this.#options.call('memory.setEnabled', {
        scope,
        ...(scope === 'project' && { workspaceId }),
        name,
        enabled: action === 'enable',
      } as MethodParams<'memory.setEnabled'>),
    );
    return jsonResult({ note: { scope: note.scope, name: note.name, enabled: note.enabled } });
  }

  #checksTool(): AppTool {
    return {
      name: 'wevir_config_checks',
      title: 'Configure verification checks',
      description:
        "Set up this project's verification checks, the commands Wevir runs after turns that change files and when " +
        'the user runs checks. save: check {name, command, kind (test|build|typecheck|lint|other), trigger ' +
        '(manual|after_turn), optional cwd (relative), timeoutMs, paths (globs that must change), expectOutput ' +
        '(regex), id to replace one}. Prefer commands the repo declares (wevir_config_read section "checks" lists ' +
        'candidates). remove: checkId. repair: repair {enabled, maxAttempts, maxDurationMs, maxTokens}, whether ' +
        'Wevir asks the agent to fix failed checks. test_automation_check: run an automation gate script once ' +
        '(automationCheck) to see whether it would wake the agent.',
      inputSchema: objectSchema(
        {
          action: { type: 'string', enum: [...CHECK_ACTIONS] },
          check: { type: 'object' },
          checkId: { type: 'string' },
          repair: { type: 'object' },
          automationCheck: CHECK_PROPERTY,
        },
        ['action'],
      ),
      annotations: WRITE,
      call: async (args, { sessionId }) => {
        const { workspaceId } = this.#caller(sessionId);
        const host = this.#options.call;
        switch (optionalEnum(args, 'action', CHECK_ACTIONS)) {
          case 'save': {
            const check = args.check;
            if (check === null || typeof check !== 'object' || Array.isArray(check)) {
              throw new AppToolError('check is required for save.');
            }
            const { check: saved } = await this.#host(() =>
              host('checks.save', {
                workspaceId,
                check: {
                  source: { kind: 'user' },
                  ...check,
                } as MethodParams<'checks.save'>['check'],
              }),
            );
            return jsonResult({ check: saved });
          }
          case 'remove':
            return jsonResult(
              await this.#host(() =>
                host('checks.remove', {
                  workspaceId,
                  checkId: requiredString(
                    args,
                    'checkId',
                  ) as MethodParams<'checks.remove'>['checkId'],
                }),
              ),
            );
          case 'repair': {
            const repair = args.repair;
            if (repair === null || typeof repair !== 'object' || Array.isArray(repair)) {
              throw new AppToolError('repair is required: the fields to change.');
            }
            return jsonResult(
              await this.#host(() =>
                host('checks.setRepair', {
                  workspaceId,
                  repair: repair as MethodParams<'checks.setRepair'>['repair'],
                }),
              ),
            );
          }
          case 'test_automation_check': {
            const check = parseCheck(args.automationCheck, false);
            if (check == null) throw new AppToolError('automationCheck is required.');
            return jsonResult(
              await this.#host(() => host('automation.testCheck', { check, sessionId })),
            );
          }
          default:
            throw new AppToolError(`action must be one of ${CHECK_ACTIONS.join(', ')}.`);
        }
      },
    };
  }

  #toolchainTool(): AppTool {
    return {
      name: 'wevir_config_install',
      title: 'Install project tools',
      description:
        "Install what this session's folder is missing. install_dependencies: run an install plan (planId from " +
        "wevir_workspace_readiness, e.g. the project's package-manager install); it runs dependency scripts, so the " +
        'user must approve. install_language_server: install a language server (serverId, root and planId from ' +
        'wevir_config_read section "lsp"); user or system-wide plans need the user\'s approval. ' +
        'restart_language_server: restart one (serverId, root). Installs run in the background: check the result ' +
        'with wevir_workspace_readiness or wevir_config_read.',
      inputSchema: objectSchema(
        {
          action: { type: 'string', enum: [...TOOLCHAIN_ACTIONS] },
          planId: { type: 'string' },
          serverId: { type: 'string' },
          root: { type: 'string' },
        },
        ['action'],
      ),
      annotations: WRITE,
      call: async (args, call) => {
        const { sessionId } = call;
        const { workspaceId } = this.#caller(sessionId);
        const host = this.#options.call;
        switch (optionalEnum(args, 'action', TOOLCHAIN_ACTIONS)) {
          case 'install_dependencies': {
            const planId = requiredString(args, 'planId');
            const { report } = await this.#host(() =>
              host('readiness.get', { workspaceId, sessionId }),
            );
            const plan = report.plans.find((item) => item.id === planId);
            if (plan === undefined) {
              throw new AppToolError(
                `No install plan ${planId}. Plans: ${report.plans.map((item) => item.id).join(', ') || 'none'}.`,
              );
            }
            await this.#approve(call, 'wevir_config_install', args, {
              action: 'Install dependencies',
              command: plan.command,
              folder: plan.path === '' ? '.' : plan.path,
              projectScripts: plan.scripts.project,
              dependencyScripts: plan.scripts.dependencies,
              writesLockfile: plan.writesLockfile,
            });
            const { run } = await this.#host(() =>
              host('readiness.install', { workspaceId, sessionId, planId, acceptScripts: true }),
            );
            return jsonResult({ run });
          }
          case 'install_language_server': {
            const serverId = requiredString(args, 'serverId');
            const root = requiredString(args, 'root');
            const planId = requiredString(args, 'planId');
            const { servers } = await this.#host(() =>
              host('lsp.status', { workspaceId, sessionId }),
            );
            const server = servers.find((item) => item.serverId === serverId && item.root === root);
            const plan = server?.plans?.find((item) => item.id === planId);
            if (server === undefined || plan === undefined) {
              throw new AppToolError(
                `No install plan ${planId} for ${serverId} at ${root}. See wevir_config_read section "lsp".`,
              );
            }
            const global = plan.scope !== 'project';
            if (global) {
              await this.#approve(call, 'wevir_config_install', args, {
                action: `Install a language server (${plan.scope})`,
                server: server.language,
                command: plan.command,
              });
            }
            const { run } = await this.#host(() =>
              host('lsp.install', {
                workspaceId,
                sessionId,
                serverId,
                root,
                planId,
                ...(global && { confirmGlobal: true }),
              }),
            );
            return jsonResult({ run });
          }
          case 'restart_language_server':
            return jsonResult(
              await this.#host(() =>
                host('lsp.restart', {
                  workspaceId,
                  sessionId,
                  serverId: requiredString(args, 'serverId'),
                  root: requiredString(args, 'root'),
                }),
              ),
            );
          default:
            throw new AppToolError(`action must be one of ${TOOLCHAIN_ACTIONS.join(', ')}.`);
        }
      },
    };
  }

  #sessionTool(): AppTool {
    return {
      name: 'wevir_config_session',
      title: 'Configure a session',
      description:
        'Change this session or one you opened (sessionId; default this one): model (same provider, see ' +
        'wevir_models) and effort (null for the model default) from the next turn, title, goal {objective, ' +
        'tokenBudget} to start a goal turn, goalStatus active|paused|cleared, or compact: true to compact its ' +
        'context. goal and compact start a turn, so they need an idle session. Never changes the permission mode.',
      inputSchema: objectSchema({
        sessionId: { type: 'string' },
        model: { type: 'string' },
        effort: { type: ['string', 'null'] },
        title: { type: 'string' },
        goal: objectSchema(
          { objective: { type: 'string' }, tokenBudget: { type: 'integer', minimum: 1 } },
          ['objective'],
        ),
        goalStatus: { type: 'string', enum: ['active', 'paused', 'cleared'] },
        compact: { type: 'boolean' },
      }),
      annotations: OWN_SESSION,
      call: async (args, { sessionId }) => {
        this.#caller(sessionId);
        const target = this.#options.ownSession(sessionId, optionalString(args, 'sessionId'));
        const host = this.#options.call;
        const model = optionalString(args, 'model');
        const effort = args.effort === null ? null : optionalString(args, 'effort');
        const title = optionalString(args, 'title');
        const goalStatus = optionalEnum(args, 'goalStatus', [
          'active',
          'paused',
          'cleared',
        ] as const);
        const goal = args.goal as { objective?: unknown; tokenBudget?: unknown } | undefined;
        const compact = args.compact === true;
        if (
          model === undefined &&
          effort === undefined &&
          title === undefined &&
          goalStatus === undefined &&
          goal === undefined &&
          !compact
        ) {
          throw new AppToolError(
            'Nothing to change: give model, effort, title, goal, goalStatus or compact.',
          );
        }
        const done: Record<string, unknown> = { sessionId: target.id };
        if (title !== undefined) {
          const { session } = await this.#host(() =>
            host('session.rename', { sessionId: target.id, title }),
          );
          done.title = session.title;
        }
        if (model !== undefined || effort !== undefined) {
          // 只换模型与档位：不带 providerId（不接力），不带 permissionMode（权限模式只有用户能改）。
          const { session } = await this.#host(() =>
            host('session.configure', {
              sessionId: target.id,
              ...(model !== undefined && { modelId: model }),
              ...(effort !== undefined && { reasoningEffort: effort }),
            }),
          );
          done.model = session.modelId;
          done.effort = session.reasoningEffort ?? null;
        }
        if (goalStatus === 'cleared') {
          await this.#host(() => host('session.clearGoal', { sessionId: target.id }));
          done.goal = 'cleared';
        } else if (goalStatus !== undefined) {
          await this.#host(() =>
            host('session.updateGoal', { sessionId: target.id, status: goalStatus }),
          );
          done.goal = goalStatus;
        }
        if (goal !== undefined) {
          if (typeof goal.objective !== 'string') {
            throw new AppToolError('goal.objective is required.');
          }
          const objective = goal.objective;
          await this.#host(() =>
            host('session.setGoal', {
              sessionId: target.id,
              objective,
              ...(typeof goal.tokenBudget === 'number' && { tokenBudget: goal.tokenBudget }),
            }),
          );
          done.goal = 'set';
        }
        if (compact) {
          await this.#host(() => host('session.compact', { sessionId: target.id }));
          done.compact = 'started';
        }
        return jsonResult(done);
      },
    };
  }
}

/** 给模型看：每个设置谁能改。 */
function settingsAccess(): Record<string, string[]> {
  const access: Record<string, string[]> = { agent: [], needsApproval: [], userOnly: [] };
  for (const [key, value] of Object.entries(SETTINGS_ACCESS)) {
    access[value === 'agent' ? 'agent' : value === 'approval' ? 'needsApproval' : 'userOnly']?.push(
      key,
    );
  }
  return access;
}

/** 环境只回变量名，打码的预览也不给。 */
function withoutValues<T extends { variables?: { name: string }[] }>(
  environment: T,
): Omit<T, 'variables'> & { variables?: string[] } {
  const { variables, ...rest } = environment;
  return {
    ...rest,
    ...(variables !== undefined && { variables: variables.map((item) => item.name) }),
  };
}

function stringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppToolError(`${key} must be an array of strings.`);
  }
  return value as string[];
}

function environmentFolders(
  value: unknown,
): MethodParams<'environment.create'>['folders'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new AppToolError('folders must be an array.');
  return value.map((item) => {
    const folder = item as { projectId?: unknown; worktree?: unknown };
    if (
      typeof folder?.projectId !== 'string' ||
      (folder.worktree !== 'none' && folder.worktree !== 'new')
    ) {
      throw new AppToolError('Each folder is {"projectId": "...", "worktree": "none" | "new"}.');
    }
    return {
      workspaceId: folder.projectId as WorkspaceId,
      worktree: folder.worktree,
    };
  });
}

function environmentVariables(value: unknown): { name: string; value?: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new AppToolError('variables must be an array.');
  return value.map((item) => {
    const variable = item as { name?: unknown; value?: unknown };
    if (
      typeof variable?.name !== 'string' ||
      (variable.value !== undefined && typeof variable.value !== 'string')
    ) {
      throw new AppToolError(
        'Each variable is {"name": "...", "value": "..."}; omit value to keep the stored one.',
      );
    }
    return {
      name: variable.name,
      ...(typeof variable.value === 'string' && { value: variable.value }),
    };
  });
}

function configToolName(toolName: string): ConfigToolName | undefined {
  const bare = appToolBaseName(toolName);
  return CONFIG_TOOLS.find((name) => name === bare);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 引擎事件里的工具参数：Codex 带 `arguments`，Cursor 的在 `args`（旁边是 providerIdentifier / toolName），Claude / ACP 直接给。 */
function engineArgs(input: unknown, name: string): Record<string, unknown> {
  const value = record(input);
  if ('arguments' in value) return record(value.arguments);
  if (value.providerIdentifier === APP_TOOLS_SERVER && value.toolName === name)
    return record(value.args);
  return value;
}

/** 环境变量的值换成 `[REDACTED]`（任何一层的 `variables: [{name, value}]`）。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'variables' && Array.isArray(item)
        ? item.map((variable) =>
            variable !== null && typeof variable === 'object' && 'value' in variable
              ? { ...variable, value: REDACTED }
              : variable,
          )
        : redact(item),
    ]),
  );
}

function fingerprint(name: string, args: Record<string, unknown>): string {
  // 对象键顺序不决定是不是同一次调用；只留摘要，不留参数（可能有环境变量的值）。
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return createHash('sha256')
    .update(name)
    .update(JSON.stringify(stable(args)))
    .digest('hex');
}
