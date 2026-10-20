// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/adapter.ts（makeCursorAgentOptions、cursorRuntimeAgentPolicy、
// openAgent、startTurn、interruptTurn）、CursorAgentSdk.ts、driver.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS 的 AgentRuntimeAdapter；去掉 T3 的 MCP 服务、skills、附件与计划模式；权限模式改按 Wevir 的三种映射；
// 换权限时重新打开 agent；取消 10 秒确认不了时自己按取消结算。
//
// Cursor 引擎（订阅来源 `cursor`，ADR-0005 补记 14，docs/architecture/cursor-event-mapping.md）：经官方 `@cursor/sdk` 在 Host
// 进程里跑本地 agent。一个 Wevir 会话是一个 Cursor agent（引擎会话 ID = agentId），一个回合是一次 `agent.send` 开出的 run。
//
// Cursor 的 SDK 没有审批回调：工具调用要么在沙箱里直接做，要么交给 Cursor 的 Auto-review 分类器决定，要么不用沙箱（T3 的能力表
// supports*Approval 都是 false）。Wevir 的三种权限模式按语义映射到 `sandboxOptions.enabled` 与 `autoReview`（permissionPolicy）。

import { readFile, stat } from 'node:fs/promises';
import type {
  AgentOptions,
  InteractionUpdate,
  SDKModel,
  SDKUserMessage,
  SettingSource,
} from '@cursor/sdk';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  APP_TOOLS_SERVER,
  type ApprovalDecision,
  type AppToolsEndpoint,
  type EngineRuleFiles,
  type EngineSession,
  EventHub,
  isAdapterError,
  type PendingApproval,
  type PermissionMode,
  type SessionConfig,
  type TurnFailedEvent,
} from '@wevir/runtime-adapter';
import { CursorAccounts } from './accounts.js';
import { cursorCredentialsPath } from './credentials.js';
import {
  adapterError,
  errorMessage,
  isActiveRunConflict,
  isAgentNotFound,
  isAuthenticationFailure,
  isCancellationError,
} from './errors.js';
import { CursorTurnMapper } from './mapping.js';
import { modelSelection } from './models.js';
import {
  CURSOR_SDK_VERSION,
  type CursorAgentHandle,
  type CursorRun,
  type CursorSdk,
  loadCursorSdk,
} from './sdk.js';

/** 等取消确认的时限（T3 的 interruptTurn 等 10 秒）。 */
export const CANCEL_TIMEOUT_MS = 10_000;

/** 告警与日志出口；Host 的 Logger 满足这个接口（`addSecret` 登记 API Key，日志里抹掉）。 */
export interface CursorAdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  addSecret?(value: string): void;
}

export interface CursorAdapterOptions {
  /** Wevir 数据目录（绝对路径）；登录铸出的 API Key 存在其中的 `engines/cursor/auth.json`。 */
  home: string;
  logger?: CursorAdapterLogger;
  /** Host 进程的环境变量（`CURSOR_API_KEY`）；省略时当作空。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 0.63.0：添加的账号把铸出的 API Key 存在这里（`<数据目录>/accounts/<id>/cursor/auth.json`）；省略时是首个账号的
   * `engines/cursor/auth.json`。
   */
  credentialsPath?: string;
  /** 测试用：换掉 SDK。 */
  sdk?: () => Promise<CursorSdk>;
  cancelTimeoutMs?: number;
  loginTimeoutMs?: number;
}

/** CursorAdapter 声明的权限模式。 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'on_request',
  'auto_review',
  'full_access',
];

/**
 * 权限模式 → SDK 的本地选项（cursor-event-mapping.md §3.2）。SDK 不能问用户，所以：
 * - `on_request`：在 Cursor 的沙箱里做，不开 Auto-review，沙箱外的操作没人批准就不做（越界的不问也不做）；
 * - `auto_review`：沙箱加 Cursor 的 Auto-review（分类器替用户判断越界的操作，对应“先由模型审查”）；
 * - `full_access`：不用沙箱、不审查。
 * T3 的 cursorRuntimeAgentPolicy 是同一组开关（approval-required 开 Auto-review，full-access 关沙箱）。
 */
export function permissionPolicy(mode: PermissionMode | undefined): {
  autoReview: boolean;
  sandboxEnabled: boolean;
} {
  switch (mode) {
    case 'full_access':
      return { autoReview: false, sandboxEnabled: false };
    case 'auto_review':
      return { autoReview: true, sandboxEnabled: true };
    default:
      return { autoReview: false, sandboxEnabled: true };
  }
}

/**
 * 本地 agent 读的 Cursor 设置层，与 Cursor CLI 相同：项目与用户的规则、skills、hooks、MCP，团队与 MDM 的策略，账号的插件（T3 的
 * CURSOR_AGENT_SETTING_SOURCES）。不写时 SDK 一层都不读。沙箱策略文件总会读，hooks 只能拒绝或询问（本地 run 把询问当拒绝），
 * 这些层放宽不了上面的沙箱与审查设置。
 */
export const SETTING_SOURCES: readonly SettingSource[] = [
  'project',
  'user',
  'team',
  'mdm',
  'plugins',
];

/**
 * 会话的配置 → `Agent.create` / `Agent.resume` 的选项（T3 的 makeCursorAgentOptions；T3 自己的 MCP 服务换成 Wevir 的应用级工具，
 * 0.30.0，cursor-event-mapping.md §7）。
 */
export function agentOptions(input: {
  apiKey: string;
  cwd: string;
  modelId: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  catalog?: readonly SDKModel[];
  appTools?: AppToolsEndpoint;
}): AgentOptions {
  const policy = permissionPolicy(input.permissionMode);
  return {
    model: modelSelection(input.modelId, input.reasoningEffort, input.catalog),
    name: 'Wevir',
    mode: 'agent',
    apiKey: input.apiKey,
    local: {
      cwd: input.cwd,
      autoReview: policy.autoReview,
      settingSources: [...SETTING_SOURCES],
      sandboxOptions: { enabled: policy.sandboxEnabled },
      enableAgentRetries: true,
    },
    ...(input.appTools !== undefined && {
      mcpServers: {
        [APP_TOOLS_SERVER]: {
          type: 'http',
          url: input.appTools.url,
          headers: { Authorization: `Bearer ${input.appTools.token}` },
        },
      },
    }),
  };
}

interface SessionSettings {
  modelId: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
}

interface Turn {
  run: CursorRun | undefined;
  mapper: CursorTurnMapper | undefined;
  cancelling: boolean;
  /** 已发出终结事件（或已放弃），之后的更新都不要。 */
  done: boolean;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  settings: SessionSettings;
  /** 应用级工具（0.30.0）：重新打开 agent 时照样挂上。 */
  appTools: AppToolsEndpoint | undefined;
  /** 挂着的 agent；关闭、登出、dispose 之后是 undefined，要 `resumeSession`。 */
  agent: CursorAgentHandle | undefined;
  hub: EventHub<AgentEvent>;
  turn: Turn | undefined;
  /** 权限模式变了：下一个回合前按新设置重新打开 agent（沙箱与 Auto-review 只能在打开时给）。 */
  reopen: boolean;
  /** 刚恢复：第一条消息可能撞上上一个进程留下的 run（T3 的 abandonedRunRecoveryAvailable）。 */
  recoverAbandonedRun: boolean;
}

export class CursorAdapter implements AgentRuntimeAdapter {
  readonly accounts: CursorAccounts;
  readonly permissionModes = PERMISSION_MODES;
  /** 应用级工具（0.30.0）：HTTP 的 MCP 服务交给 agent；Cursor 没有审批，工具直接调用。 */
  readonly appTools = true;

  /**
   * 0.68.0：Cursor 的 SDK 从 cwd 一路往上读 `.cursor/rules`、AGENTS.md、CLAUDE.md 与 CLAUDE.local.md，仓库根的 .cursorrules（打包的
   * 689.js，`loadRulesFromDirAndAncestors`）；用户级的规则在 Cursor 的账号设置里，不是文件。SDK 的 `systemPrompt` 会整个换掉
   * Cursor 的提示词，不能用来补，所以补给的随下一条消息交。
   */
  ruleFiles(): EngineRuleFiles {
    return {
      user: [],
      project: ['agents', 'claude', 'cursor'],
      imports: false,
      instructions: false,
    };
  }

  /** 图片（0.28.0）：经 SDK 的 `images` 交给 Cursor，模型由它挑。 */
  acceptsImages(): boolean {
    return true;
  }
  readonly #options: CursorAdapterOptions;
  readonly #sdk: () => Promise<CursorSdk>;
  readonly #sessions = new Map<string, Session>();
  #disposed = false;

  constructor(options: CursorAdapterOptions) {
    this.#options = options;
    this.#sdk = options.sdk ?? loadCursorSdk;
    const logger = options.logger;
    this.accounts = new CursorAccounts({
      sdk: () => this.#sdk(),
      credentialsPath: options.credentialsPath ?? cursorCredentialsPath(options.home),
      ...(options.env !== undefined && { env: options.env }),
      ...(logger?.addSecret !== undefined && { addSecret: (value) => logger.addSecret?.(value) }),
      onSignedOut: () =>
        this.#detachAll('signed out of Cursor; sign in again and resume the session'),
      ...(options.loginTimeoutMs !== undefined && { loginTimeoutMs: options.loginTimeoutMs }),
    });
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#alive();
    await checkCwd(config.cwd);
    const settings = settingsOf(config);
    const apiKey = await this.accounts.requireApiKey();
    const sdk = await this.#loadSdk();
    const options = agentOptions({
      apiKey,
      cwd: config.cwd,
      ...settings,
      catalog: await this.#catalog(apiKey, settings),
      ...(config.appTools !== undefined && { appTools: config.appTools }),
    });
    let agent: CursorAgentHandle;
    try {
      agent = await sdk.createAgent(options);
    } catch (error) {
      throw adapterError(error, 'agent create');
    }
    if (this.#disposed) {
      agent.close();
      throw new AdapterError('disposed', 'the Cursor adapter was disposed');
    }
    this.#sessions.set(agent.agentId, {
      id: agent.agentId,
      cwd: config.cwd,
      settings,
      appTools: config.appTools,
      agent,
      hub: new EventHub(),
      turn: undefined,
      reopen: false,
      recoverAbandonedRun: false,
    });
    return engineSession(agent.agentId, settings);
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#alive();
    const existing = this.#sessions.get(engineSessionId);
    if (existing?.agent !== undefined) return engineSession(engineSessionId, existing.settings);
    await checkCwd(config.cwd);
    const settings = settingsOf(config);
    const apiKey = await this.accounts.requireApiKey();
    const sdk = await this.#loadSdk();
    const options = agentOptions({
      apiKey,
      cwd: config.cwd,
      ...settings,
      catalog: await this.#catalog(apiKey, settings),
      ...(config.appTools !== undefined && { appTools: config.appTools }),
    });
    let agent: CursorAgentHandle;
    try {
      agent = await sdk.resumeAgent(engineSessionId, options);
    } catch (error) {
      if (isAgentNotFound(error)) {
        throw new AdapterError('session_lost', `Cursor has no agent ${engineSessionId}`, {
          cause: error,
          lostReason: 'not_found',
        });
      }
      throw adapterError(error, 'agent resume');
    }
    if (this.#disposed) {
      agent.close();
      throw new AdapterError('disposed', 'the Cursor adapter was disposed');
    }
    this.#sessions.set(engineSessionId, {
      id: engineSessionId,
      cwd: config.cwd,
      settings,
      appTools: config.appTools,
      agent,
      hub: new EventHub(),
      turn: undefined,
      reopen: false,
      recoverAbandonedRun: true,
    });
    return engineSession(engineSessionId, settings);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#alive();
    return this.#attached(engineSessionId).hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#alive();
    const session = this.#attached(engineSessionId);
    if (session.turn !== undefined) {
      throw new AdapterError('session_busy', 'the Cursor agent is already running a turn');
    }
    const text = input.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n\n');
    // 图片（0.28.0）：SDK 的 `SDKUserMessage.images`，base64（同 T3 Code 的 CursorAdapterV2）。
    // 只有文本时不让出事件循环。
    const reads = input.content.flatMap((part) =>
      part.type === 'image'
        ? [
            readFile(part.path).then((bytes) => ({
              data: bytes.toString('base64'),
              mimeType: part.mimeType,
            })),
          ]
        : [],
    );
    const images = reads.length === 0 ? [] : await Promise.all(reads);
    if (text.trim() === '' && images.length === 0) {
      throw new AdapterError('invalid_input', 'the message is empty');
    }
    const message: string | SDKUserMessage = images.length === 0 ? text : { text, images };

    let resolve: () => void = () => {};
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    const turn: Turn = {
      run: undefined,
      mapper: undefined,
      cancelling: false,
      done: false,
      settled,
      resolve,
    };
    session.turn = turn;
    try {
      const apiKey = await this.accounts.requireApiKey();
      const agent = await this.#openAgent(session, apiKey);
      // run 开出之前 SDK 就可能调 onDelta：先存着，有了 runId 再按顺序映射（T3 的 pendingUpdates）。
      const pending: InteractionUpdate[] = [];
      const onDelta = ({ update }: { update: InteractionUpdate }) => {
        if (turn.done) return;
        if (turn.mapper === undefined) pending.push(update);
        else this.#emit(session, turn.mapper.map(update));
      };
      const send = () =>
        agent.send(message, {
          model: modelSelection(
            session.settings.modelId,
            session.settings.reasoningEffort,
            this.accounts.cachedModels(apiKey),
          ),
          mode: 'agent',
          onDelta,
        });
      let run: CursorRun;
      try {
        run = await send();
      } catch (error) {
        if (!session.recoverAbandonedRun || !isActiveRunConflict(error)) throw error;
        run = await this.#recoverAbandonedRun(session, apiKey, error, send);
      }
      session.recoverAbandonedRun = false;
      if (turn.done) {
        // 等 run 开出的时候会话被关了或适配器被释放了。
        run.cancel().catch(() => {});
        return;
      }
      const mapper = new CursorTurnMapper(engineSessionId, run.id);
      turn.run = run;
      turn.mapper = mapper;
      for (const update of pending) this.#emit(session, mapper.map(update));
      if (turn.cancelling) run.cancel().catch(() => {});
      void this.#watch(session, turn, run, mapper);
    } catch (error) {
      if (session.turn === turn) session.turn = undefined;
      turn.done = true;
      turn.resolve();
      if (isAdapterError(error)) throw error;
      throw adapterError(error, 'send');
    }
  }

  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown Cursor agent ${engineSessionId}`);
    }
    const previous = permissionPolicy(session.settings.permissionMode);
    const next = permissionPolicy(config.permissionMode);
    session.settings = settingsOf(config);
    if (
      previous.autoReview !== next.autoReview ||
      previous.sandboxEnabled !== next.sandboxEnabled
    ) {
      session.reopen = true;
    }
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    this.#alive();
    if (!this.#sessions.has(engineSessionId)) {
      throw new AdapterError('session_not_found', `unknown Cursor agent ${engineSessionId}`);
    }
    throw new AdapterError('approval_not_found', `Cursor has no approval ${requestId}`);
  }

  async listPendingApprovals(_engineSessionId?: string): Promise<PendingApproval[]> {
    this.#alive();
    return [];
  }

  async cancel(engineSessionId: string): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined || turn.done) return;
    turn.cancelling = true;
    if (turn.run !== undefined) {
      try {
        await turn.run.cancel();
      } catch (error) {
        if (!isCancellationError(error)) {
          this.#options.logger?.warn('Cursor run cancel failed', {
            engineSessionId,
            error: errorMessage(error),
          });
        }
      }
    }
    const timeoutMs = this.#options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmed = await Promise.race([
      turn.settled.then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (confirmed) return;
    // SDK 在时限内没结束这个 run：这边不再等它，按取消结算（T3 同样在 10 秒后自己收尾）。之后的更新都丢掉；下一条消息若撞上
    // 还没停的 run，按恢复的办法取消它再发。
    this.#options.logger?.warn('Cursor run did not stop in time; settling it as cancelled', {
      engineSessionId,
    });
    session.recoverAbandonedRun = true;
    this.#settle(session, turn, [
      ...(turn.mapper?.finish('cancelled') ?? []),
      { type: 'turn.settled', engineSessionId, outcome: 'cancelled', stopReason: 'cancelled' },
    ]);
  }

  async close(engineSessionId: string): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown Cursor agent ${engineSessionId}`);
    }
    if (session.agent === undefined) return;
    await this.cancel(engineSessionId);
    session.agent?.close();
    session.agent = undefined;
    session.hub.end();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.accounts.dispose();
    for (const session of this.#sessions.values()) {
      const turn = session.turn;
      if (turn !== undefined) {
        turn.done = true;
        turn.run?.cancel().catch(() => {});
        session.turn = undefined;
        turn.resolve();
      }
      session.agent?.close();
      session.agent = undefined;
      session.hub.end();
    }
  }

  // ── 回合 ─────────────────────────────────────────────────────────────────────

  /** 等 run 结束，发出终结事件（T3 的 startTurn 里 sdkRun.wait 之后的那一段）。 */
  async #watch(
    session: Session,
    turn: Turn,
    run: CursorRun,
    mapper: CursorTurnMapper,
  ): Promise<void> {
    const engineSessionId = session.id;
    let events: AgentEvent[];
    try {
      const result = await run.wait();
      if (turn.done) return;
      const answer = mapper.finalResult(result.result);
      if (turn.cancelling || result.status === 'cancelled') {
        events = [
          ...answer,
          ...mapper.finish('cancelled'),
          { type: 'turn.settled', engineSessionId, outcome: 'cancelled', stopReason: 'cancelled' },
        ];
      } else if (result.status === 'error') {
        const message = result.error?.message || 'Cursor run failed';
        events = [
          ...answer,
          ...mapper.finish('failed'),
          {
            type: 'turn.failed',
            engineSessionId,
            category: runErrorCategory(result.error),
            message,
          },
        ];
      } else {
        const failure = mapper.reply.failure;
        events =
          failure === undefined
            ? [
                ...answer,
                ...mapper.finish('completed'),
                {
                  type: 'turn.settled',
                  engineSessionId,
                  outcome: 'completed',
                  stopReason: result.status,
                },
              ]
            : [
                ...answer,
                ...mapper.finish('failed'),
                { type: 'turn.failed', engineSessionId, category: 'provider', message: failure },
              ];
      }
    } catch (error) {
      if (turn.done) return;
      events =
        turn.cancelling || isCancellationError(error)
          ? [
              ...mapper.finish('cancelled'),
              {
                type: 'turn.settled',
                engineSessionId,
                outcome: 'cancelled',
                stopReason: 'cancelled',
              },
            ]
          : [
              ...mapper.finish('failed'),
              {
                type: 'turn.failed',
                engineSessionId,
                category: isAuthenticationFailure(error) ? 'missing_credentials' : 'unknown',
                message: errorMessage(error),
              },
            ];
    }
    this.#settle(session, turn, events);
  }

  #settle(session: Session, turn: Turn, events: AgentEvent[]): void {
    if (turn.done) return;
    turn.done = true;
    this.#emit(session, events);
    if (session.turn === turn) session.turn = undefined;
    turn.resolve();
  }

  /**
   * 恢复的 agent 第一次发消息就撞上“already has active run”：上一个 Host 进程的 run 还登记着。找出它、取消、再发一次；找不到
   * 就照原样报错（T3 的 CursorAgentSdk.send）。
   */
  async #recoverAbandonedRun(
    session: Session,
    apiKey: string,
    conflict: unknown,
    send: () => Promise<CursorRun>,
  ): Promise<CursorRun> {
    session.recoverAbandonedRun = false;
    const sdk = await this.#loadSdk();
    const runs = await sdk.listRuns(session.id, { cwd: session.cwd, apiKey, limit: 1 });
    const active = runs.items.find((candidate) => candidate.status === 'running');
    if (active === undefined) throw conflict;
    this.#options.logger?.warn('cancelling a Cursor run left over from an earlier process', {
      engineSessionId: session.id,
      runId: active.id,
    });
    await sdk.cancelRun(active.id, { cwd: session.cwd, apiKey });
    return send();
  }

  /** 会话的 agent；权限模式变了时按新设置重新打开（`Agent.resume`）。 */
  async #openAgent(session: Session, apiKey: string): Promise<CursorAgentHandle> {
    const agent = session.agent;
    if (agent === undefined) throw new AdapterError('session_closed', 'the Cursor agent is closed');
    if (!session.reopen) return agent;
    const sdk = await this.#loadSdk();
    const options = agentOptions({
      apiKey,
      cwd: session.cwd,
      ...session.settings,
      catalog: await this.#catalog(apiKey, session.settings),
      ...(session.appTools !== undefined && { appTools: session.appTools }),
    });
    let reopened: CursorAgentHandle;
    try {
      reopened = await sdk.resumeAgent(session.id, options);
    } catch (error) {
      throw adapterError(error, 'agent resume');
    }
    agent.close();
    session.agent = reopened;
    session.reopen = false;
    return reopened;
  }

  // ── 其他 ─────────────────────────────────────────────────────────────────────

  /** 登出：用着旧 Key 的会话都停下、脱开（T3：sign-out stops sessions that hold the credential），之后要登录再恢复。 */
  #detachAll(reason: string): void {
    for (const session of this.#sessions.values()) {
      if (session.agent === undefined) continue;
      const turn = session.turn;
      const events: AgentEvent[] = [];
      if (turn !== undefined && !turn.done) {
        turn.done = true;
        turn.run?.cancel().catch(() => {});
        events.push(...(turn.mapper?.finish('failed') ?? []));
        session.turn = undefined;
        turn.resolve();
      }
      events.push({
        type: 'engine.exited',
        engineSessionId: session.id,
        exitCode: null,
        signal: null,
        stderrTail: reason,
      });
      this.#emit(session, events);
      session.agent.close();
      session.agent = undefined;
      session.hub.end();
    }
  }

  /** 推理档位换成 SDK 参数要模型列表：有缓存用缓存，没有且要用时读一次（失败就不带档位）。 */
  async #catalog(apiKey: string, settings: SessionSettings): Promise<SDKModel[] | undefined> {
    const cached = this.accounts.cachedModels(apiKey);
    if (cached !== undefined || settings.reasoningEffort === undefined) return cached;
    return this.accounts.catalogModels(apiKey).catch(() => undefined);
  }

  #emit(session: Session, events: readonly AgentEvent[]): void {
    for (const event of events) session.hub.emit(event);
  }

  #attached(engineSessionId: string): Session {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown Cursor agent ${engineSessionId}`);
    }
    if (session.agent === undefined) {
      throw new AdapterError(
        'session_closed',
        `the Cursor agent ${engineSessionId} is not attached`,
      );
    }
    return session;
  }

  async #loadSdk(): Promise<CursorSdk> {
    try {
      return await this.#sdk();
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `Cursor SDK failed to load: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }

  #alive(): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the Cursor adapter was disposed');
  }
}

function settingsOf(config: {
  modelId: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
}): SessionSettings {
  return {
    modelId: config.modelId,
    ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
  };
}

function engineSession(engineSessionId: string, settings: SessionSettings): EngineSession {
  return {
    engineSessionId,
    modelId: settings.modelId,
    ...(settings.reasoningEffort !== undefined && { reasoningEffort: settings.reasoningEffort }),
    engineVersion: CURSOR_SDK_VERSION,
  };
}

/**
 * 工作目录要是存在的目录：SDK 在不存在的目录里起 shell 会变成进程级的 unhandled rejection（errors.ts 的
 * isCursorShellSpawnFailure），先在这里拦下。
 */
async function checkCwd(cwd: string): Promise<void> {
  if (cwd === '') throw new AdapterError('invalid_input', 'cwd is empty');
  const info = await stat(cwd).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new AdapterError('invalid_input', `${cwd} is not a directory`);
  }
}

/** run 以 error 结束时的归类：认证类是 missing_credentials，其余算模型服务（Cursor）那边的错。 */
function runErrorCategory(
  error: { message: string; code?: string } | undefined,
): TurnFailedEvent['category'] {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`;
  return /unauthenticated|unauthorized|authentication|api key/i.test(text)
    ? 'missing_credentials'
    : 'provider';
}
