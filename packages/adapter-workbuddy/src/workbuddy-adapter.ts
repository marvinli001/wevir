// SPDX-License-Identifier: MIT
// 复用 Wevir adapter-grok 的 ACP 构造与历史 MCP 接法。其来源：pingdotgg/t3code
// packages/provider-grok/src/server/adapter.ts，提交 ec1313c8f8333292506f05a355bb72d308a455d8。
// Copyright (c) 2026 T3 Tools Inc.
// 修改：CodeBuddy 的模型、推理档位和权限模式都走会话 config option；不认证、不按模式分进程。

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
import { WorkBuddyAccounts, type WorkBuddyAccountsOptions } from './accounts.js';
import {
  isWorkBuddyAuthRequired,
  WORKBUDDY_AUTH_URL,
  WORKBUDDY_ENGINE,
  WORKBUDDY_QUESTION,
  WORKBUDDY_RESOLVE_INTERRUPTION,
} from './engine.js';
import { WorkBuddyLauncher } from './launch.js';
import { nativeEffort, record, selectEntries, selectOption, wevirEffort } from './models.js';
import { workBuddyQuestions } from './questions.js';
import { workBuddyToolName } from './tool-display.js';

export const WORKBUDDY_MODES: Readonly<Record<PermissionMode, string>> = {
  on_request: 'default',
  auto_review: 'auto',
  full_access: 'bypassPermissions',
};
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

export interface WorkBuddyAdapterOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  logger?: AdapterLogger;
  cancelTimeoutMs?: number;
  accounts?: Pick<
    WorkBuddyAccountsOptions,
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

export class WorkBuddyAdapter extends AcpAdapter {
  readonly accounts: WorkBuddyAccounts;
  readonly historyTool: boolean;
  readonly permissionModes: readonly PermissionMode[] = [
    'on_request',
    'auto_review',
    'full_access',
  ];
  readonly #settings: Map<string, Settings>;
  readonly #processVersion: () => string | undefined;

  /**
   * 0.68.0：CodeBuddy 读它自己的 CODEBUDDY.md；它读不读 AGENTS.md / CLAUDE.md 没有核对过，当作都不读（宁可多补一份，不让规则
   * 丢掉）。ACP 没有放说明的地方，随下一条消息交。
   */
  ruleFiles(): EngineRuleFiles {
    return { user: [], project: [], imports: false, instructions: false };
  }

  constructor(options: WorkBuddyAdapterOptions) {
    const workDir = `${options.home}/engines/workbuddy`;
    const accounts = new WorkBuddyAccounts({
      workDir,
      ...(options.env !== undefined && { env: options.env }),
      ...options.accounts,
    });
    const settings = new Map<string, Settings>();
    let processVersion: string | undefined;
    const engine = {
      ...WORKBUDDY_ENGINE,
      classifyTurnError: (error: unknown) => {
        const classified = WORKBUDDY_ENGINE.classifyTurnError(error);
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
          launcher: new WorkBuddyLauncher(workDir, () => {
            if (options.historyTool !== undefined) writeHistoryToolScript(options.historyTool);
            return accounts.executable();
          }),
          onSessionUpdate: (params) => {
            const fields = record(params);
            const update = record(fields?.update);
            if (
              typeof fields?.sessionId === 'string' &&
              update?.sessionUpdate === 'config_option_update'
            ) {
              const known = settings.get(fields.sessionId);
              if (known !== undefined) known.configOptions = update.configOptions;
              accounts.noteSessionModels(update.configOptions);
            }
            hooks.onSessionUpdate(params);
          },
          onRequestPermission: hooks.onRequestPermission,
          onElicitation: hooks.onElicitation,
          onExtRequest: hooks.onExtRequest,
          onExtNotification: hooks.onExtNotification,
        });
        process.on('ready', ({ initialize }) => {
          // 刷新账号可能看到已更新的 CLI，不能因此改掉仍在运行的旧进程的版本。
          processVersion = initialize.agentInfo?.version ?? accounts.version;
        });
        return process;
      },
    });
    this.accounts = accounts;
    this.#settings = settings;
    this.#processVersion = () => processVersion;
    this.historyTool = options.historyTool !== undefined;
  }

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    return this.#versioned(await super.createSession(toNative(config)));
  }

  override async resumeSession(id: string, config: SessionConfig): Promise<EngineSession> {
    return this.#versioned(await super.resumeSession(id, toNative(config)));
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
        const { reasoningEffort: _old, ...base } = settings.config;
        const config = toNative({ ...base, ...pending });
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

  async respondToQuestion(
    id: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.assertUsable();
    this.answerQuestion(id, requestId, answers);
  }

  override async dispose(): Promise<void> {
    await this.accounts.dispose();
    await super.dispose();
    this.#settings.clear();
  }

  protected override async authenticateAfter(error: unknown): Promise<boolean> {
    if (!isWorkBuddyAuthRequired(error)) return false;
    this.accounts.markSignedOut();
    // CodeBuddy authenticate 会撤销已有登录；绝不能用它作检测或“重试”。
    throw new AdapterError('missing_credentials', this.accounts.signInHint());
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

  protected override interceptPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> | undefined {
    const name = workBuddyToolName(params.toolCall.title ?? '', params.toolCall._meta);
    if (name === 'AskUserQuestion') {
      const questions = workBuddyQuestions(params.toolCall.rawInput);
      if (questions === undefined) return Promise.resolve(CANCELLED);
      return this.requestAnswers(
        params.sessionId,
        params.toolCall.toolCallId,
        questions,
        signal,
      ).then(async (answers) => {
        if (answers === undefined || !this.inTurn(params.sessionId)) return CANCELLED;
        // ACP selected 本身不带答案；官方扩展先把答案交给 AskService，再结束原审批。
        const resolved = await this.process.connection.agent.request<{ resolved?: boolean }>(
          WORKBUDDY_RESOLVE_INTERRUPTION,
          {
            sessionId: params.sessionId,
            toolCallId: params.toolCall.toolCallId,
            decision: Object.values(answers).some((values) => values.length > 0) ? 'allow' : 'deny',
            answers,
          },
        );
        if (resolved.resolved !== true)
          throw new Error('CodeBuddy did not accept question answers');
        const allow = params.options.find((option) => option.kind === 'allow_once');
        return allow === undefined
          ? CANCELLED
          : { outcome: { outcome: 'selected', optionId: allow.optionId } };
      });
    }
    if (name === 'ExitPlanMode') {
      const plan = record(params.toolCall._meta)?.['codebuddy.ai/plan'];
      if (typeof plan === 'string' && plan.trim())
        this.proposePlan(params.sessionId, params.toolCall.toolCallId, plan.trim());
      const reject = params.options.find((option) => option.kind === 'reject_once');
      return Promise.resolve(
        reject === undefined
          ? CANCELLED
          : { outcome: { outcome: 'selected', optionId: reject.optionId } },
      );
    }
    return undefined;
  }

  protected override async extRequest(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (method === WORKBUDDY_AUTH_URL) return { outcome: 'cancelled' };
    if (method !== WORKBUDDY_QUESTION) return super.extRequest(method, params, signal);
    const fields = record(params);
    const questions = workBuddyQuestions(fields?.schema);
    if (typeof fields?.sessionId !== 'string' || questions === undefined) {
      throw Object.assign(new Error('Invalid CodeBuddy question'), { code: -32602 });
    }
    const answers = await this.requestAnswers(
      fields.sessionId,
      typeof fields.toolCallId === 'string' ? fields.toolCallId : undefined,
      questions,
      signal,
    );
    return answers === undefined ? { outcome: 'cancelled' } : { outcome: 'submitted', answers };
  }

  async #applyMode(id: string, configOptions: unknown, mode: PermissionMode): Promise<unknown> {
    const option = selectOption(configOptions, 'mode');
    const value = WORKBUDDY_MODES[mode];
    if (!selectEntries(option?.options).some((entry) => entry.value === value)) {
      throw new AdapterError(
        'invalid_input',
        `CodeBuddy does not expose permission mode ${value}; update the CLI`,
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
      if (isWorkBuddyAuthRequired(cause)) {
        this.accounts.markSignedOut();
        throw new AdapterError('missing_credentials', this.accounts.signInHint(), { cause });
      }
      throw new AdapterError(
        'invalid_input',
        `CodeBuddy could not apply permission mode ${value}`,
        { cause },
      );
    }
    if (selectOption(result.configOptions, 'mode')?.currentValue !== value) {
      throw new AdapterError('invalid_input', `CodeBuddy did not apply permission mode ${value}`);
    }
    return result.configOptions;
  }

  #versioned(session: EngineSession): EngineSession {
    const { reasoningEffort, ...rest } = session;
    const effort = wevirEffort(reasoningEffort);
    return {
      ...rest,
      engineVersion: this.#processVersion() ?? session.engineVersion,
      ...(effort !== undefined && { reasoningEffort: effort }),
    };
  }
}

function toNative(config: SessionConfig): SessionConfig {
  const { reasoningEffort, ...rest } = config;
  const effort = nativeEffort(reasoningEffort);
  return { ...rest, ...(effort !== undefined && { reasoningEffort: effort }) };
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
