// SPDX-License-Identifier: MIT
// 复用 Wevir adapter-grok 的 ACP 构造与历史 MCP 接法。其来源：pingdotgg/t3code
// packages/provider-grok/src/server/adapter.ts，提交 ec1313c8f8333292506f05a355bb72d308a455d8。
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 WorkBuddy 适配器改写；Devin 的模型与权限模式走会话 config option，恢复用 session/load 并丢掉它回放的历史。

import {
  AcpAdapter,
  AcpProcess,
  type AcpProcessOptions,
  type AcpSessionSetup,
  type AdapterLogger,
} from '@wevir/adapter-acp';
import type { McpServer } from '@wevir/adapter-acp/sdk';
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
import { DEVIN_SIGN_IN_HINT, DevinAccounts, type DevinAccountsOptions } from './accounts.js';
import { DEVIN_ENGINE, isDevinAuthRequired } from './engine.js';
import { DevinLauncher } from './launch.js';
import { record, selectEntries, selectOption } from './models.js';

/**
 * Wevir 的权限模式 → Devin 的会话模式（`mode` config option）。请求批准对应 Code（accept-edits：工作区里改文件自动通过，命令
 * 与工作区外的写入要批准）；自动审核对应 Smart（安全的由模型判断自动通过），Devin 没给 Smart 时退回 Code；完全访问对应
 * Bypass Permissions（组织策略要求审批的除外）。ACP 不提供 CLI 的 Normal 模式。
 */
export const DEVIN_MODES: Readonly<Record<PermissionMode, readonly string[]>> = {
  on_request: ['accept-edits'],
  auto_review: ['smart', 'accept-edits'],
  full_access: ['bypass'],
};
/** 恢复期间仍要看的更新（模式与模型），其余是 `session/load` 回放的历史。 */
const LIVE_DURING_LOAD = new Set(['config_option_update', 'current_mode_update']);

export interface DevinAdapterOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  accounts?: Pick<
    DevinAccountsOptions,
    'findExecutable' | 'probeSession' | 'installer' | 'startLogin' | 'now'
  >;
  process?: Partial<Pick<AcpProcessOptions, 'initializeTimeoutMs' | 'restart' | 'disposeTimeouts'>>;
  historyTool?: HistoryToolServer;
  appToolsBridge?: AppToolsBridge;
}

interface Settings {
  config: SessionConfig;
  configOptions: unknown;
  pending?: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode };
  sending?: boolean;
}

export class DevinAdapter extends AcpAdapter {
  readonly accounts: DevinAccounts;
  readonly historyTool: boolean;
  readonly permissionModes: readonly PermissionMode[] = [
    'on_request',
    'auto_review',
    'full_access',
  ];
  readonly #settings: Map<string, Settings>;
  readonly #loading: Set<string>;
  readonly #processVersion: () => string | undefined;

  /**
   * 0.68.0：Devin CLI 自己读 AGENTS.md 与 `.devin/`，也导入 Cursor、Windsurf、Claude Code 等的规则（`read_config_from`）；导入
   * 哪些由用户的配置决定，没有逐项核对，当作都不读（宁可多补一份，不让规则丢掉）。ACP 没有放说明的地方，随下一条消息交。
   */
  ruleFiles(): EngineRuleFiles {
    return { user: [], project: [], imports: false, instructions: false };
  }

  constructor(options: DevinAdapterOptions) {
    const workDir = `${options.home}/engines/devin`;
    const accounts = new DevinAccounts({
      workDir,
      ...(options.env !== undefined && { env: options.env }),
      ...options.accounts,
    });
    const settings = new Map<string, Settings>();
    const loading = new Set<string>();
    let processVersion: string | undefined;
    const engine = {
      ...DEVIN_ENGINE,
      classifyTurnError: (error: unknown) => {
        const classified = DEVIN_ENGINE.classifyTurnError(error);
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
          launcher: new DevinLauncher(workDir, () => {
            if (options.historyTool !== undefined) writeHistoryToolScript(options.historyTool);
            return accounts.executable();
          }),
          onSessionUpdate: (params) => {
            const fields = record(params);
            const update = record(fields?.update);
            const sessionId = typeof fields?.sessionId === 'string' ? fields.sessionId : undefined;
            if (sessionId !== undefined && update?.sessionUpdate === 'config_option_update') {
              const known = settings.get(sessionId);
              if (known !== undefined) known.configOptions = update.configOptions;
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
          onExtRequest: hooks.onExtRequest,
          onExtNotification: hooks.onExtNotification,
        });
        process.on('ready', ({ initialize }) => {
          // 3000.11.92 的 agentInfo.version 是 0.0.0-dev，用 `devin --version` 读到的。
          const reported = initialize.agentInfo?.version;
          processVersion =
            reported !== undefined && !/^0\.0\.0/.test(reported) ? reported : accounts.version;
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
        settings.configOptions = await this.#applyMode(
          id,
          settings.configOptions,
          config.permissionMode ?? 'on_request',
        );
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

  /** Devin 没登录也照样建会话、到发消息才报错：进程已在运行时（启动器不再检查）先看账号。 */
  protected override async beforeActivation(): Promise<void> {
    const state = await this.accounts.read('devin');
    if (state.status !== 'signed_in') {
      throw new AdapterError('missing_credentials', state.lastError ?? DEVIN_SIGN_IN_HINT);
    }
  }

  protected override async authenticateAfter(error: unknown): Promise<boolean> {
    if (!isDevinAuthRequired(error)) return false;
    this.accounts.markSignedOut();
    // authenticate 会打开浏览器，只在用户点“登录”时调；这里给指引。
    throw new AdapterError('missing_credentials', DEVIN_SIGN_IN_HINT);
  }

  protected override async afterActivation(
    id: string,
    config: SessionConfig,
    setup: AcpSessionSetup,
  ): Promise<unknown> {
    const configOptions = await this.#applyMode(
      id,
      setup.configOptions,
      config.permissionMode ?? 'on_request',
    );
    this.#settings.set(id, { config, configOptions });
    this.accounts.noteSessionModels(configOptions);
    return configOptions;
  }

  async #applyMode(id: string, configOptions: unknown, mode: PermissionMode): Promise<unknown> {
    const option = selectOption(configOptions, 'mode');
    const offered = new Set(selectEntries(option?.options).map((entry) => entry.value));
    const value = DEVIN_MODES[mode].find((candidate) => offered.has(candidate));
    if (value === undefined) {
      throw new AdapterError(
        'invalid_input',
        `Devin CLI does not offer a session mode for ${mode}; update the CLI`,
      );
    }
    if (option?.currentValue === value) return configOptions;
    let result: { configOptions?: unknown };
    try {
      result = await this.process.connection.agent.request('session/set_config_option', {
        sessionId: id,
        configId: 'mode',
        value,
      });
    } catch (cause) {
      if (isDevinAuthRequired(cause)) {
        this.accounts.markSignedOut();
        throw new AdapterError('missing_credentials', DEVIN_SIGN_IN_HINT, { cause });
      }
      throw new AdapterError('invalid_input', `Devin CLI could not switch to mode ${value}`, {
        cause,
      });
    }
    if (selectOption(result.configOptions, 'mode')?.currentValue !== value) {
      throw new AdapterError('invalid_input', `Devin CLI did not switch to mode ${value}`);
    }
    return result.configOptions;
  }

  #versioned(session: EngineSession): EngineSession {
    return { ...session, engineVersion: this.#processVersion() ?? session.engineVersion };
  }
}

/** 3000.11.92 未登录时 ACP 只给 `mode` 与 `model` 两个选项，推理档位怎么设没有核对过：不交给 ACP，用 Devin 的默认档位。 */
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
