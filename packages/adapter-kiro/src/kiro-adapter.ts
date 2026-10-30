// SPDX-License-Identifier: MIT
// 复用 Wevir adapter-grok 的 ACP 构造与历史 MCP 接法。其来源：pingdotgg/t3code
// packages/provider-grok/src/server/adapter.ts，提交 ec1313c8f8333292506f05a355bb72d308a455d8。
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 GitHub Copilot 适配器改写；Kiro 的完全访问由 Wevir 自动批准它的权限请求，恢复用 session/load 并丢掉它
// 回放的历史，换模型用 session/set_model。

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
import { KIRO_SIGN_IN_HINT, KiroAccounts, type KiroAccountsOptions } from './accounts.js';
import { isKiroAuthRequired, KIRO_ENGINE } from './engine.js';
import { KiroLauncher } from './launch.js';
import { record } from './models.js';

/** 恢复期间仍要看的更新（模型与模式），其余是 `session/load` 回放的历史。 */
const LIVE_DURING_LOAD = new Set(['config_option_update', 'current_mode_update']);

/** 完全访问时替用户选的批准项：先选只批这一次的，不让 Kiro 记下长期的信任。 */
const AUTO_APPROVE_KINDS = ['allow_once', 'allow_always'];

export interface KiroAdapterOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  accounts?: Pick<KiroAccountsOptions, 'findExecutable' | 'installer' | 'startLogin' | 'now'>;
  process?: Partial<Pick<AcpProcessOptions, 'initializeTimeoutMs' | 'restart' | 'disposeTimeouts'>>;
  historyTool?: HistoryToolServer;
  appToolsBridge?: AppToolsBridge;
}

interface Settings {
  config: SessionConfig;
  pending?: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode };
  sending?: boolean;
}

export class KiroAdapter extends AcpAdapter {
  readonly accounts: KiroAccounts;
  readonly historyTool: boolean;
  /** 请求批准：Kiro 问的每一项都交给用户；完全访问：Wevir 替用户批准（同 CLI 的 `--trust-all-tools`）。 */
  readonly permissionModes: readonly PermissionMode[] = ['on_request', 'full_access'];
  readonly #settings: Map<string, Settings>;
  readonly #loading: Set<string>;
  readonly #processVersion: () => string | undefined;

  /**
   * 0.68.0：Kiro CLI 自己读 `.kiro/steering/`、AGENTS.md 与 `~/.kiro` 下的说明，具体读哪些随版本、代理配置与用户设置变，没有逐项
   * 核对，当作都不读（宁可多补一份，不让规则丢掉）。ACP 没有放说明的地方，随下一条消息交。
   */
  ruleFiles(): EngineRuleFiles {
    return { user: [], project: [], imports: false, instructions: false };
  }

  constructor(options: KiroAdapterOptions) {
    const workDir = `${options.home}/engines/kiro`;
    const accounts = new KiroAccounts({
      workDir,
      ...(options.env !== undefined && { env: options.env }),
      ...options.accounts,
    });
    const settings = new Map<string, Settings>();
    const loading = new Set<string>();
    let processVersion: string | undefined;
    const engine = {
      ...KIRO_ENGINE,
      classifyTurnError: (error: unknown) => {
        const classified = KIRO_ENGINE.classifyTurnError(error);
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
          launcher: new KiroLauncher(workDir, () => {
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

  /** MCP 服务的表单（ACP `elicitation/create`）换成的提问由用户回答（adapter-acp 的 `#onElicitation`）。 */
  async respondToQuestion(
    id: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.assertUsable();
    this.answerQuestion(id, requestId, answers);
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
    const state = await this.accounts.read('kiro');
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? KIRO_SIGN_IN_HINT);
    }
  }

  protected override async authenticateAfter(error: unknown): Promise<boolean> {
    if (!isKiroAuthRequired(error)) return false;
    this.accounts.markSignedOut();
    // Kiro 的 ACP 没有登录方法；设置里的“登录”起设备码登录，这里给指引。
    throw new AdapterError('missing_credentials', KIRO_SIGN_IN_HINT);
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

  /** 完全访问的会话：Kiro 的权限请求由 Wevir 直接批准，不打扰用户。 */
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

  #versioned(session: EngineSession): EngineSession {
    return { ...session, engineVersion: this.#processVersion() ?? session.engineVersion };
  }
}

/** Kiro 的推理档位（`--effort`）在 ACP 里怎么设没有核对过：不交给 ACP，用 Kiro 的默认档位。 */
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
