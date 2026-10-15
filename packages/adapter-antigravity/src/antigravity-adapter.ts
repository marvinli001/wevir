// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts（权限模式、模型选择、提问）与
// provider/acp/AntigravityAcpSupport.ts（antigravityPermissionMode、applyAntigravityAcpModelSelection）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：建在 Wevir 的通用 ACP 适配器（AcpAdapter）上，一个进程承载全部会话；Wevir 的三种权限模式对到 Antigravity 的
// default / auto_edit / yolo；会话中换模型与模式记下、下一个回合开始前生效；不声明 fs 能力（T3 让编辑经它的文件接口走），
// 工具在运行体自己的环境里执行，审批照 ACP 原样转交；没有 T3 的附件、子 agent 批次与文本生成。
//
// Antigravity 引擎的 AgentRuntimeAdapter（订阅来源 `antigravity`，docs/architecture/antigravity-event-mapping.md）。

import { AcpAdapter, type AcpSessionSetup, type AdapterLogger } from '@wevir/adapter-acp';
import {
  methods,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@wevir/adapter-acp/sdk';
import {
  type AgentInput,
  type EngineSession,
  isAdapterError,
  type PermissionMode,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import { AntigravityAccounts } from './accounts.js';
import { ANTIGRAVITY_ENGINE, classifyAntigravityTurnError } from './engine.js';
import { AntigravityInstallation, type AntigravityInstallationOptions } from './installation.js';
import {
  type AntigravityLauncher,
  type AntigravityRuntimeContext,
  antigravityPaths,
  createAntigravityProcess,
  validateAntigravityRuntime,
} from './process.js';
import { antigravityQuestion } from './protocol.js';

const PERMISSION_CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** Wevir 的权限模式 → Antigravity 的会话模式（T3 的 antigravityPermissionMode）。 */
export const ANTIGRAVITY_MODES: Readonly<Record<PermissionMode, string>> = Object.freeze({
  on_request: 'default',
  auto_review: 'auto_edit',
  full_access: 'yolo',
});

export interface AntigravityAdapterOptions {
  /** Wevir 的数据目录：运行体、profile 与临时目录都在 `<home>/engines/antigravity/` 下。 */
  home: string;
  logger?: AdapterLogger;
  env?: NodeJS.ProcessEnv;
  /** BROWSER 钩子用的 Node；默认 Host 自己（process.execPath）。 */
  nodeExecutable?: string;
  /** 测试用：换掉钉住的发布、下载与校验。 */
  installation?: Partial<Omit<AntigravityInstallationOptions, 'directory'>>;
  initializeTimeoutMs?: number;
  cancelTimeoutMs?: number;
}

interface SessionSettings {
  providerId: string;
  configOptions: unknown;
  modes: unknown;
  /** 会话中改了、下一个回合开始前才交给运行体的设置。 */
  pending?: { modelId: string; permissionMode: PermissionMode };
}

export class AntigravityAdapter extends AcpAdapter {
  readonly accounts: AntigravityAccounts;
  readonly permissionModes: readonly PermissionMode[] = [
    'on_request',
    'auto_review',
    'full_access',
  ];
  readonly installation: AntigravityInstallation;
  readonly #launcher: AntigravityLauncher;
  readonly #sessions = new Map<string, SessionSettings>();

  constructor(options: AntigravityAdapterOptions) {
    const env = options.env ?? process.env;
    const logger: AdapterLogger = options.logger ?? {
      warn: (message, fields) =>
        process.stderr.write(
          `[adapter-antigravity] ${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`,
        ),
    };
    const paths = antigravityPaths(options.home);
    let accounts: AntigravityAccounts | undefined;
    const context: AntigravityRuntimeContext = {
      // 构造顺序：installation 在下面赋值，进程只在第一次用到时才启动。
      installation: undefined as unknown as AntigravityInstallation,
      paths,
      env,
      customPath: () => accounts?.customPath ?? null,
      logger,
      ...(options.nodeExecutable !== undefined && { nodeExecutable: options.nodeExecutable }),
      ...(options.initializeTimeoutMs !== undefined && {
        initializeTimeoutMs: options.initializeTimeoutMs,
      }),
    };
    const installation = new AntigravityInstallation({
      directory: paths.root,
      env,
      validate: (executable, version, signal) =>
        validateAntigravityRuntime(context, executable, version, signal),
      ...options.installation,
    });
    context.installation = installation;
    let launcher: AntigravityLauncher | undefined;
    super({
      // 会话报要登录时账号改为未登录（登录过期、被撤销）。
      engine: {
        ...ANTIGRAVITY_ENGINE,
        classifyTurnError: (error) => {
          const classified = classifyAntigravityTurnError(error);
          if (classified.category === 'missing_credentials') accounts?.markSignInRequired();
          return classified;
        },
      },
      createProcess: (hooks) => {
        const created = createAntigravityProcess({ context, hooks, authenticate: 'session' });
        launcher = created.launcher;
        return created.process;
      },
      logger,
      ...(options.cancelTimeoutMs !== undefined && { cancelTimeoutMs: options.cancelTimeoutMs }),
    });
    this.installation = installation;
    this.#launcher = launcher as AntigravityLauncher;
    accounts = new AntigravityAccounts({
      context,
      onSignedOut: async () => {
        // 旧进程里缓存着凭据：停掉它，挂着的会话脱开，下次用时以新的登录重新启动。
        await this.stopEngine('config_changed');
        await this.#launcher.cleanup();
      },
    });
    this.accounts = accounts;
  }

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    return this.#signInAware(() => super.createSession(config));
  }

  override async resumeSession(
    engineSessionId: string,
    config: SessionConfig,
  ): Promise<EngineSession> {
    return this.#signInAware(() => super.resumeSession(engineSessionId, config));
  }

  /** 会话中换模型或权限模式：记下，下一个回合开始前交给运行体（AgentRuntimeAdapter.configureSession 的约定）。 */
  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.assertUsable();
    this.assertOpenSession(engineSessionId);
    const settings = this.#sessions.get(engineSessionId);
    if (settings === undefined) return;
    settings.pending = {
      modelId: config.modelId,
      permissionMode: config.permissionMode ?? 'on_request',
    };
  }

  override async send(engineSessionId: string, input: AgentInput): Promise<void> {
    const settings = this.#sessions.get(engineSessionId);
    const pending = settings?.pending;
    if (settings !== undefined && pending !== undefined) {
      this.assertUsable();
      this.assertOpenSession(engineSessionId);
      settings.pending = undefined;
      // 模型照通用适配器的路由选定（session/set_config_option `model`）。
      await this.applyRoute(engineSessionId, {
        providerId: settings.providerId,
        modelId: pending.modelId,
      });
      await this.#applyMode(engineSessionId, settings, pending.permissionMode);
    }
    return super.send(engineSessionId, input);
  }

  /** 回答 Antigravity 借审批方法发来的提问（`interaction_*`，见 `interceptPermission`）。 */
  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.assertUsable();
    this.answerQuestion(engineSessionId, requestId, answers);
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.accounts.dispose();
    await this.#launcher.cleanup();
    this.#sessions.clear();
  }

  protected override async afterActivation(
    engineSessionId: string,
    config: SessionConfig,
    setup: AcpSessionSetup,
  ): Promise<unknown> {
    const settings: SessionSettings = {
      providerId: config.providerId,
      configOptions: setup.configOptions,
      modes: setup.modes,
    };
    this.#sessions.set(engineSessionId, settings);
    this.accounts.noteSessionModels(setup.configOptions);
    await this.#applyMode(engineSessionId, settings, config.permissionMode ?? 'on_request');
    return settings.configOptions;
  }

  /**
   * `interaction_*` 的 `session/request_permission` 是向用户的单选题（T3 的 extractAntigravityUserInputQuestion）：经
   * `requestAnswers` 报 `question.requested`，回答（Host 已按问题核对过）换成引擎要的选项 ID 再回复。换不上或提问被取消时
   * 回复 cancelled。
   */
  protected override interceptPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> | undefined {
    const question = antigravityQuestion(params);
    if (question === undefined) return undefined;
    return this.requestAnswers(
      params.sessionId,
      params.toolCall.toolCallId,
      question.questions,
      signal,
    ).then((answers) => {
      if (answers === undefined) return PERMISSION_CANCELLED;
      const response = question.respond(answers);
      if (response === undefined) {
        this.logger.warn('Antigravity 提问的回答对不上选项，回复 cancelled', {
          engineSessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
        });
        return PERMISSION_CANCELLED;
      }
      return response;
    });
  }

  async #signInAware(run: () => Promise<EngineSession>): Promise<EngineSession> {
    try {
      return await run();
    } catch (error) {
      if (isAdapterError(error, 'missing_credentials')) this.accounts.markSignInRequired();
      throw error;
    }
  }

  /**
   * 会话的权限模式：mode 类 config option（`category: "mode"`，Antigravity 的 `mode`）在就用 `session/set_config_option`，
   * 只有 ACP `modes` 时用 `session/set_mode`（T3 AcpSessionRuntime 的 setMode）。运行体没有这个模式时告警，不换。
   */
  async #applyMode(
    engineSessionId: string,
    settings: SessionSettings,
    permissionMode: PermissionMode,
  ): Promise<void> {
    const modeId = ANTIGRAVITY_MODES[permissionMode];
    const connection = this.process.connection;
    const option = modeOption(settings.configOptions);
    if (option !== undefined) {
      if (option.currentValue === modeId) return;
      if (!option.values.includes(modeId)) {
        this.logger.warn('Antigravity 没有这个会话模式，沿用当前模式', {
          engineSessionId,
          modeId,
          available: option.values,
        });
        return;
      }
      const result = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: engineSessionId,
        configId: option.id,
        value: modeId,
      });
      settings.configOptions = result.configOptions;
      return;
    }
    const modes = settings.modes as
      | { currentModeId?: unknown; availableModes?: Array<{ id?: unknown }> }
      | undefined;
    if (modes === undefined || modes === null || modes.currentModeId === modeId) return;
    if (!modes.availableModes?.some((mode) => mode.id === modeId)) {
      this.logger.warn('Antigravity 没有这个会话模式，沿用当前模式', { engineSessionId, modeId });
      return;
    }
    await connection.agent.request(methods.agent.session.setMode, {
      sessionId: engineSessionId,
      modeId,
    });
    settings.modes = { ...modes, currentModeId: modeId };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** mode 类的 select 选项（id、当前值、可选值）。 */
function modeOption(
  configOptions: unknown,
): { id: string; currentValue?: string; values: string[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find(
    (o) => isRecord(o) && o.category === 'mode' && o.type === 'select' && typeof o.id === 'string',
  ) as Record<string, unknown> | undefined;
  if (option === undefined) return undefined;
  const values: string[] = [];
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (typeof entry.value === 'string') values.push(entry.value);
      else collect(entry.options);
    }
  };
  collect(option.options);
  return {
    id: option.id as string,
    ...(typeof option.currentValue === 'string' && { currentValue: option.currentValue }),
    values,
  };
}
