// SPDX-License-Identifier: MIT
// 复用 Wevir adapter-grok 的 ACP 构造与历史 MCP 接法。其来源：pingdotgg/t3code
// packages/provider-grok/src/server/adapter.ts，提交 ec1313c8f8333292506f05a355bb72d308a455d8。
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 Devin 适配器改写；Copilot 的完全访问由 Wevir 自动批准它的权限请求，恢复用 session/load 并丢掉它回放的
// 历史，额度来自它的原始会话事件。

import {
  AcpAdapter,
  AcpProcess,
  type AcpProcessOptions,
  type AcpSessionSetup,
  type AdapterLogger,
} from '@wevir/adapter-acp';
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@wevir/adapter-acp/sdk';
import {
  AdapterError,
  type AgentInput,
  type EngineRuleFiles,
  type EngineSession,
  type PermissionMode,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import type { AppToolsBridge } from '@wevir/runtime-adapter/app-tools-bridge';
import {
  HISTORY_TOOL_SERVER,
  type HistoryToolServer,
  historyToolCommand,
  writeHistoryToolScript,
} from '@wevir/runtime-adapter/history-tool';
import { COPILOT_SIGN_IN_HINT, CopilotAccounts, type CopilotAccountsOptions } from './accounts.js';
import { COPILOT_ENGINE, COPILOT_SESSION_EVENT, isCopilotAuthRequired } from './engine.js';
import { type CopilotAccountDirs, CopilotLauncher } from './launch.js';
import { record } from './models.js';
import { rateLimitsOfEvent } from './usage.js';

/** 恢复期间仍要看的更新（模型与模式），其余是 `session/load` 回放的历史。 */
const LIVE_DURING_LOAD = new Set(['config_option_update', 'current_mode_update']);

/** 完全访问时替用户选的批准项：先选只批这一次的（Copilot 不接受工作流权限的“总是允许”）。 */
const AUTO_APPROVE_KINDS = ['allow_once', 'allow_always'];

export interface CopilotAdapterOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  /**
   * 添加的账号（0.63.0）：Copilot 的配置目录、空的 GitHub CLI 配置目录与引擎工作目录都在账号自己的目录里；首个账号省略，用
   * `<数据目录>/engines/copilot` 与用户本机的登录。
   */
  account?: CopilotAccountDirs & { workDir: string };
  accounts?: Pick<
    CopilotAccountsOptions,
    'findExecutable' | 'probeSession' | 'installer' | 'startLogin' | 'home' | 'now'
  >;
  process?: Partial<Pick<AcpProcessOptions, 'initializeTimeoutMs' | 'restart' | 'disposeTimeouts'>>;
  historyTool?: HistoryToolServer;
  appToolsBridge?: AppToolsBridge;
}

interface Settings {
  config: SessionConfig;
  pending?: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode };
  sending?: boolean;
}

export class CopilotAdapter extends AcpAdapter {
  readonly accounts: CopilotAccounts;
  readonly historyTool: boolean;
  /** 请求批准：Copilot 问的每一项都交给用户；完全访问：Wevir 替用户批准（同 CLI 的 `--allow-all`）。 */
  readonly permissionModes: readonly PermissionMode[] = ['on_request', 'full_access'];
  readonly #settings: Map<string, Settings>;
  readonly #loading: Set<string>;
  readonly #processVersion: () => string | undefined;

  /**
   * 0.68.0：Copilot CLI 自己读 AGENTS.md、.github/copilot-instructions.md、CLAUDE.md 与 `~/.copilot` 下的说明（`copilot instruction`
   * 能列出来），具体读哪些随版本和用户配置变，没有逐项核对，当作都不读（宁可多补一份，不让规则丢掉）。ACP 没有放说明的地方，
   * 随下一条消息交。
   */
  ruleFiles(): EngineRuleFiles {
    return { user: [], project: [], imports: false, instructions: false };
  }

  constructor(options: CopilotAdapterOptions) {
    const workDir = options.account?.workDir ?? `${options.home}/engines/copilot`;
    const accounts = new CopilotAccounts({
      workDir,
      ...(options.env !== undefined && { env: options.env }),
      ...(options.account !== undefined && {
        account: {
          copilotHome: options.account.copilotHome,
          ghConfigDir: options.account.ghConfigDir,
        },
      }),
      ...options.accounts,
    });
    const settings = new Map<string, Settings>();
    const loading = new Set<string>();
    let processVersion: string | undefined;
    const engine = {
      ...COPILOT_ENGINE,
      classifyTurnError: (error: unknown) => {
        const classified = COPILOT_ENGINE.classifyTurnError(error);
        if (classified.category === 'missing_credentials') accounts.markSignedOut();
        return classified;
      },
    };
    super({
      engine,
      ...(options.logger !== undefined && { logger: options.logger }),
      ...(options.cancelTimeoutMs !== undefined && { cancelTimeoutMs: options.cancelTimeoutMs }),
      ...(options.historyTool !== undefined && {
        mcpServers: [historyServer(options.historyTool)],
      }),
      ...(options.appToolsBridge !== undefined && { appToolsBridge: options.appToolsBridge }),
      createProcess: (hooks) => {
        const process = new AcpProcess({
          ...options.process,
          engine,
          launcher: new CopilotLauncher(workDir, () => {
            if (options.historyTool !== undefined) writeHistoryToolScript(options.historyTool);
            return accounts.executable();
          }),
          onSessionUpdate: (params) => {
            const fields = record(params);
            const update = record(fields?.update);
            const sessionId = typeof fields?.sessionId === 'string' ? fields.sessionId : undefined;
            if (update?.sessionUpdate === 'config_option_update') {
              accounts.noteSessionModels(update.configOptions);
            }
            // session/load 回放的历史已经在 Wevir 的事件里了，不再交给会话。
            if (
              sessionId !== undefined &&
              loading.has(sessionId) &&
              !LIVE_DURING_LOAD.has(String(update?.sessionUpdate))
            ) {
              return;
            }
            hooks.onSessionUpdate(params);
          },
          onRequestPermission: hooks.onRequestPermission,
          onElicitation: hooks.onElicitation,
          onExtRequest: hooks.onExtRequest,
          onExtNotification: hooks.onExtNotification,
        });
        process.on('ready', ({ initialize }) => {
          processVersion = initialize.agentInfo?.version ?? accounts.version;
        });
        return process;
      },
    });
    this.accounts = accounts;
    this.#settings = settings;
    this.#loading = loading;
    this.#processVersion = () => processVersion;
    this.historyTool = options.historyTool !== undefined;
  }

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    return this.#versioned(await super.createSession(withoutEffort(config)));
  }

  override async resumeSession(id: string, config: SessionConfig): Promise<EngineSession> {
    this.#loading.add(id);
    try {
      return this.#versioned(await super.resumeSession(id, withoutEffort(config)));
    } finally {
      this.#loading.delete(id);
    }
  }

  async configureSession(id: string, config: NonNullable<Settings['pending']>): Promise<void> {
    this.assertUsable();
    this.assertOpenSession(id);
    const settings = this.#settings.get(id);
    if (settings !== undefined) settings.pending = { ...config };
  }

  override async send(id: string, input: AgentInput): Promise<void> {
    this.assertUsable();
    this.assertOpenSession(id);
    const settings = this.#settings.get(id);
    if (this.inTurn(id) || settings?.sending)
      throw new AdapterError('session_busy', 'Session is busy');
    if (settings === undefined) return super.send(id, input);
    settings.sending = true;
    try {
      const pending = settings.pending;
      if (pending !== undefined) {
        const config = withoutEffort({ ...settings.config, ...pending });
        await this.applyRoute(id, config);
        settings.config = config;
        if (settings.pending === pending) settings.pending = undefined;
      }
      await super.send(id, input);
    } finally {
      settings.sending = false;
    }
  }

  override async dispose(): Promise<void> {
    await this.accounts.dispose();
    await super.dispose();
    this.#settings.clear();
  }

  /** 进程已在运行时（启动器不再检查）先看账号，没登录不建会话。 */
  protected override async beforeActivation(): Promise<void> {
    const state = await this.accounts.read('copilot');
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? COPILOT_SIGN_IN_HINT);
    }
  }

  protected override async authenticateAfter(error: unknown): Promise<boolean> {
    if (!isCopilotAuthRequired(error)) return false;
    this.accounts.markSignedOut();
    // Copilot 的 ACP 只给终端登录；设置里的“登录”起设备码登录，这里给指引。
    throw new AdapterError('missing_credentials', COPILOT_SIGN_IN_HINT);
  }

  protected override async afterActivation(
    id: string,
    config: SessionConfig,
    setup: AcpSessionSetup,
  ): Promise<unknown> {
    this.#settings.set(id, { config });
    this.accounts.noteSessionModels(setup.configOptions);
    return setup.configOptions;
  }

  /** 完全访问的会话：Copilot 的权限请求由 Wevir 直接批准，不打扰用户。 */
  protected override interceptPermission(
    params: RequestPermissionRequest,
    _signal: AbortSignal,
  ): Promise<RequestPermissionResponse> | undefined {
    const settings = this.#settings.get(params.sessionId);
    if (settings?.config.permissionMode !== 'full_access') return undefined;
    for (const kind of AUTO_APPROVE_KINDS) {
      const option = params.options.find((candidate) => candidate.kind === kind);
      if (option !== undefined) {
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
      }
    }
    return undefined;
  }

  /** 原始会话事件：只看 `assistant.usage` 里的额度。 */
  protected override extNotification(method: string, params: unknown): void {
    if (method !== COPILOT_SESSION_EVENT && method !== `_${COPILOT_SESSION_EVENT}`) return;
    const rateLimits = rateLimitsOfEvent(params);
    if (rateLimits !== undefined) this.accounts.setRateLimits(rateLimits);
  }

  #versioned(session: EngineSession): EngineSession {
    return { ...session, engineVersion: this.#processVersion() ?? session.engineVersion };
  }
}

/** 推理档位要按模型选 Copilot 的 `thought_level`，各模型的档位没有核对过：不交给 ACP，用 Copilot 的默认档位。 */
function withoutEffort(config: SessionConfig): SessionConfig {
  const { reasoningEffort: _effort, ...rest } = config;
  return rest;
}

function historyServer(server: HistoryToolServer): McpServer {
  const { command, args, env } = historyToolCommand(server);
  return {
    name: HISTORY_TOOL_SERVER,
    command,
    args,
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}
