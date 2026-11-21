// SPDX-License-Identifier: MIT
// 复用 Wevir adapter-grok 的 ACP 构造与历史 MCP 接法。其来源：pingdotgg/t3code
// packages/provider-grok/src/server/adapter.ts，提交 ec1313c8f8333292506f05a355bb72d308a455d8。
// 单次授权规则参照 packages/provider-kiro/src/server/acpSupport.ts，提交 55e25385619c7680dad0b0f34f5185187806c57a（MIT）。
// prompt 活动门控参照同提交 packages/provider-kiro/src/server/adapter.ts（isKiroPromptActivity）。
// Copyright (c) 2026 T3 Tools Inc.
// 修改：经 Wevir 的 GitHub Copilot 适配器改写；Kiro 的完全访问由 Wevir 自动批准单次授权，恢复用 session/load 并丢掉它
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
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type CollaborationMode,
  type EngineRuleFiles,
  type EngineSession,
  type ForkOptions,
  isAdapterError,
  type PermissionMode,
  type SessionCapability,
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
import {
  applyKiroAutopilot,
  applyKiroEffort,
  applyKiroMode,
  type KiroConfigAccess,
  kiroAgentIds,
  kiroAllowsUnattended,
  kiroEffortValue,
  kiroSupportsPlan,
  selectKiroAgent,
} from './config.js';
import {
  isKiroAuthRequired,
  KIRO_COMPACTION_STATUS,
  KIRO_ENGINE,
  KIRO_METADATA,
  KIRO_V3_ENGINE,
} from './engine.js';
import {
  decodeKiroSessionId,
  encodeKiroSessionId,
  type KiroGeneration,
  KiroLauncher,
  kiroGenerationForVersion,
} from './launch.js';
import { KIRO_DEFAULT_MODEL, record } from './models.js';

/** 恢复期间仍要看的更新（模型与模式），其余是 `session/load` 回放的历史。 */
const LIVE_DURING_LOAD = new Set(['config_option_update', 'current_mode_update']);

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
  collaborationMode?: CollaborationMode;
  previousMode?: string | undefined;
}

interface Steering {
  queued: Map<string, string>;
  early: Set<string>;
  requests: number;
}

interface PromptActivity {
  ready: Promise<void>;
  started: () => void;
}

const CANCEL_HOLD_MS = 2000;
const KIRO_COMPACT = '_kiro/session/compact';
const KIRO_STEER = '_session/steer';

function requestedAgent(input: AgentInput): string | undefined {
  const [part] = input.content;
  if (input.content.length !== 1 || part?.type !== 'text') return undefined;
  return /^\/agent[ \t]+([^\r\n]+)$/.exec(part.text.trim())?.[1]?.trim();
}

function isPromptActivity(update: Record<string, unknown>): boolean {
  if (update.sessionUpdate === 'session_info_update') {
    return record(record(update._meta)?.kiro)?.kind === 'turn_start';
  }
  return [
    'agent_message_chunk',
    'agent_message',
    'agent_thought_chunk',
    'agent_thought',
    'tool_call',
    'tool_call_update',
    'tool_call_content_chunk',
    'plan',
    'plan_update',
  ].includes(String(update.sessionUpdate));
}

class KiroSessionAdapter extends AcpAdapter {
  readonly accounts: KiroAccounts;
  readonly generation: KiroGeneration;
  readonly #settings: Map<string, Settings>;
  readonly #loading: Set<string>;
  readonly #prompts: Map<string, PromptActivity>;
  readonly #processVersion: () => string | undefined;
  readonly #configUpdates: Map<string, Set<() => void>>;
  readonly #steering = new Map<string, Steering>();
  readonly #manualCompactions = new Set<string>();
  /** 报了开始、还没认出结束的压缩，按引擎会话。 */
  readonly #compacting = new Map<string, string>();
  #compactions = 0;

  constructor(options: KiroAdapterOptions, accounts: KiroAccounts, generation: KiroGeneration) {
    const workDir = `${options.home}/engines/kiro`;
    const settings = new Map<string, Settings>();
    const loading = new Set<string>();
    const prompts = new Map<string, PromptActivity>();
    const configUpdates = new Map<string, Set<() => void>>();
    const cloudConfigTools = new Set<string>();
    let processVersion: string | undefined;
    const dialect = generation === 'v3' ? KIRO_V3_ENGINE : KIRO_ENGINE;
    const engine = {
      ...dialect,
      classifyTurnError: (error: unknown) => {
        const classified = dialect.classifyTurnError(error);
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
          launcher: new KiroLauncher(
            workDir,
            async () => {
              if (options.historyTool !== undefined) writeHistoryToolScript(options.historyTool);
              const executable = await accounts.executable();
              return { ...executable, version: accounts.version };
            },
            generation,
          ),
          onSessionUpdate: (params) => {
            const fields = record(params);
            const update = record(fields?.update);
            const sessionId = typeof fields?.sessionId === 'string' ? fields.sessionId : undefined;
            if (sessionId !== undefined && typeof update?.toolCallId === 'string') {
              const key = `${sessionId}\n${update.toolCallId}`;
              if (record(record(update._meta)?.kiro)?.toolId === 'fetch_cloud_config') {
                cloudConfigTools.add(key);
              }
              if (cloudConfigTools.has(key)) {
                if (update.status === 'completed' || update.status === 'failed')
                  cloudConfigTools.delete(key);
                return;
              }
            }
            // session/load 回放的历史已经在 Wevir 的事件里了，不再交给会话。
            if (
              sessionId !== undefined &&
              loading.has(sessionId) &&
              !LIVE_DURING_LOAD.has(String(update?.sessionUpdate))
            ) {
              return;
            }
            if (sessionId !== undefined && update !== undefined && isPromptActivity(update)) {
              prompts.get(sessionId)?.started();
            }
            if (
              generation === 'v3' &&
              sessionId !== undefined &&
              update?.sessionUpdate === 'compaction_update' &&
              this.#manualCompactions.has(sessionId)
            )
              return;
            if (
              generation === 'v3' &&
              sessionId !== undefined &&
              update?.sessionUpdate === 'session_info_update' &&
              this.#sessionInfo(sessionId, update)
            )
              return;
            hooks.onSessionUpdate(params);
            if (sessionId !== undefined && update?.sessionUpdate === 'config_option_update') {
              if (generation === 'v3' || kiroGenerationForVersion(accounts.version) === 'v2') {
                accounts.noteSessionModels(update.configOptions);
              }
              for (const changed of configUpdates.get(sessionId) ?? []) changed();
            }
          },
          onRequestPermission: (params, signal) => {
            if (generation === 'v2') return hooks.onRequestPermission(params, signal);
            // Persistent consent needs resource and scope. Wevir only collects a one-time choice.
            const choices = params.options.filter(
              ({ kind }) => kind === 'allow_once' || kind === 'reject_once',
            );
            return choices.length === 0
              ? Promise.resolve({ outcome: { outcome: 'cancelled' } })
              : hooks.onRequestPermission({ ...params, options: choices }, signal);
          },
          onElicitation: hooks.onElicitation,
          onExtRequest: hooks.onExtRequest,
          onExtNotification: hooks.onExtNotification,
        });
        process.on('ready', ({ initialize }) => {
          processVersion = initialize.agentInfo?.version ?? accounts.version;
        });
        process.on('exit', () => {
          for (const prompt of prompts.values()) prompt.started();
          prompts.clear();
          cloudConfigTools.clear();
          settings.clear();
          this.#steering.clear();
          this.#compacting.clear();
          this.#manualCompactions.clear();
        });
        return process;
      },
    });
    this.accounts = accounts;
    this.generation = generation;
    this.watchRuntime(accounts);
    this.#settings = settings;
    this.#loading = loading;
    this.#prompts = prompts;
    this.#configUpdates = configUpdates;
    this.#processVersion = () => processVersion;
  }

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    return this.#versioned(await super.createSession(config));
  }

  supports(id: string, method: SessionCapability): boolean {
    if (this.generation !== 'v3') return false;
    switch (method) {
      case 'branch':
        return this.#forkCapability() !== undefined;
      case 'compact':
        return this.#supportsExtension(KIRO_COMPACT);
      case 'planMode':
        return this.#settings.has(id) && kiroSupportsPlan(this.sessionConfigOptions(id));
      default:
        return false;
    }
  }

  async fork(id: string, config: SessionConfig, options?: ForkOptions): Promise<EngineSession> {
    this.assertUsable();
    this.assertOpenSession(id);
    const available = this.#forkCapability();
    if (this.generation !== 'v3' || available === undefined || options?.kind !== 'branch') {
      throw new AdapterError('invalid_input', 'Kiro does not support this type of session fork');
    }
    const boundary = record(record(available._meta)?.kiro)?.messageId === true;
    const messageId = boundary ? options.nativeTurnId : undefined;
    if (messageId === undefined && (!options.atHead || this.inTurn(id))) {
      throw new AdapterError('invalid_input', 'Kiro has no native message ID for this fork point');
    }
    return this.#versioned(
      await this.activateNewSession(config, {
        sessionId: id,
        _meta: messageId === undefined ? {} : { kiro: { messageId } },
      }),
    );
  }

  async compact(id: string): Promise<void> {
    this.assertUsable();
    this.assertOpenSession(id);
    if (!this.supports(id, 'compact')) {
      throw new AdapterError('invalid_input', 'Kiro does not support native compaction');
    }
    if (this.#settings.get(id)?.sending) throw new AdapterError('session_busy', 'Session is busy');
    const agent = this.process.connection.agent;
    const compactionId = `kiro-compaction-${++this.#compactions}`;
    this.startRequestTurn(id, async () => {
      this.#manualCompactions.add(id);
      this.reportCompaction(id, compactionId, 'compacting', 'manual');
      const result = await agent.request<unknown>(KIRO_COMPACT, { sessionId: id });
      if (record(result)?.success !== true) throw new Error('Kiro could not compact the session');
      if (this.#manualCompactions.has(id)) {
        this.reportCompaction(id, compactionId, 'compacted', 'manual');
      }
      return { stopReason: 'end_turn' };
    });
  }

  async steer(id: string, steerId: string, input: AgentInput): Promise<void> {
    this.assertUsable();
    this.assertOpenSession(id);
    if (
      this.generation !== 'v3' ||
      !this.#supportsExtension(KIRO_STEER) ||
      !this.acceptsSteer(id) ||
      this.#manualCompactions.has(id) ||
      requestedAgent(input) !== undefined ||
      (input.collaborationMode !== undefined &&
        input.collaborationMode !== this.#settings.get(id)?.collaborationMode) ||
      input.content.some((part) => part.type !== 'text')
    ) {
      throw new AdapterError('steer_rejected', 'Kiro cannot steer this turn');
    }
    const message = input.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    if (!message.trim()) throw new AdapterError('steer_rejected', 'Kiro steering requires text');
    let state = this.#steering.get(id);
    if (state === undefined) {
      state = { queued: new Map(), early: new Set(), requests: 0 };
      this.#steering.set(id, state);
    }
    state.requests += 1;
    try {
      const result = record(
        await this.process.connection.agent.request<unknown>(KIRO_STEER, {
          sessionId: id,
          message,
        }),
      );
      if (result?.queued !== true || typeof result.messageId !== 'string' || !result.messageId) {
        throw new AdapterError('steer_rejected', 'Kiro did not queue the steering message');
      }
      if (this.#steering.get(id) !== state) return;
      if (state.early.delete(result.messageId)) {
        this.reportTurnEvent({ type: 'turn.steered', engineSessionId: id, steerId });
      } else {
        state.queued.set(result.messageId, steerId);
      }
    } catch (cause) {
      throw new AdapterError('steer_rejected', 'Kiro did not accept steering', { cause });
    } finally {
      state.requests -= 1;
      if (state.requests === 0) state.early.clear();
    }
  }

  override async resumeSession(id: string, config: SessionConfig): Promise<EngineSession> {
    this.#loading.add(id);
    try {
      return this.#versioned(await super.resumeSession(id, config));
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

  override async listCommands(id: string) {
    const commands = await super.listCommands(id);
    if (this.generation === 'v2' || !this.#settings.has(id)) return commands;
    const agents = kiroAgentIds(this.sessionConfigOptions(id));
    return agents.length === 0
      ? commands
      : [
          ...commands.filter(({ name }) => name !== 'agent'),
          { name: 'agent', argumentHint: agents.join(' | ') },
        ];
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
      const { reasoningEffort: _effort, permissionMode: _permission, ...base } = settings.config;
      const config = pending === undefined ? settings.config : { ...base, ...pending };
      const agent = this.generation === 'v3' ? requestedAgent(input) : undefined;
      if (this.generation === 'v3') {
        const access = this.#configAccess(id);
        const mode = agent === undefined ? (input.collaborationMode ?? 'default') : 'default';
        // Switch agents with Autopilot disabled. Kiro can reset it on a mode change.
        if (
          agent !== undefined ||
          settings.collaborationMode !== mode ||
          !kiroAllowsUnattended(config, mode)
        ) {
          await applyKiroAutopilot(access, config, 'plan');
        }
        if (agent === undefined) {
          settings.previousMode = await applyKiroMode(access, mode, settings.previousMode);
        } else {
          await selectKiroAgent(access, agent);
          settings.previousMode = undefined;
        }
        await this.applyRoute(id, config);
        await this.#applyEffort(access, config);
        await applyKiroAutopilot(access, config, mode);
        settings.collaborationMode = mode;
      } else {
        if (input.collaborationMode === 'plan') {
          throw new AdapterError('invalid_input', 'Kiro V2 does not support ACP plan mode');
        }
        if (pending !== undefined) await this.applyRoute(id, config);
      }
      settings.config = config;
      if (settings.pending === pending) settings.pending = undefined;
      if (agent === undefined) {
        await super.send(id, input);
      } else {
        this.startRequestTurn(id, async () => ({ stopReason: 'end_turn' }));
      }
    } finally {
      settings.sending = false;
    }
  }

  override async dispose(): Promise<void> {
    for (const prompt of this.#prompts.values()) prompt.started();
    this.#prompts.clear();
    await super.dispose();
    this.#settings.clear();
  }

  override async close(id: string): Promise<void> {
    await super.close(id);
    this.#settings.delete(id);
  }

  protected override promptMeta(id: string): undefined {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.#prompts.set(id, { ready, started });
    return undefined;
  }

  protected override async notifyCancel(id: string): Promise<void> {
    if (this.#manualCompactions.has(id)) {
      await super.notifyCancel(id);
      return;
    }
    const prompt = this.#prompts.get(id);
    if (prompt === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        prompt.ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CANCEL_HOLD_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (this.#prompts.get(id) === prompt && this.inTurn(id)) await super.notifyCancel(id);
  }

  protected override afterTurn(id: string): void {
    this.#prompts.get(id)?.started();
    this.#prompts.delete(id);
    this.#steering.delete(id);
    this.#manualCompactions.delete(id);
    this.#compacting.delete(id);
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
    let options = setup.configOptions;
    if (this.generation === 'v3') {
      const access = this.#configAccess(id);
      // A fork can return only its ID. Request the supervised state to get its options.
      if (access.read() === undefined) await access.set('autopilot', 'off');
      await applyKiroAutopilot(access, config, 'plan');
      await this.#applyEffort(access, config);
      options = access.read();
    }
    this.#settings.set(id, { config });
    if (this.generation === 'v3' || kiroGenerationForVersion(this.accounts.version) === 'v2') {
      this.accounts.noteSessionModels(options);
    }
    return options;
  }

  /** `allow_always` 会留下工作区信任规则，只有用户能选择。 */
  protected override interceptPermission(
    params: RequestPermissionRequest,
    _signal: AbortSignal,
  ): Promise<RequestPermissionResponse> | undefined {
    const settings = this.#settings.get(params.sessionId);
    if (!settings || !kiroAllowsUnattended(settings.config, settings.collaborationMode)) {
      return undefined;
    }
    const option = params.options.find(
      (candidate) => candidate.kind === 'allow_once' && candidate.optionId.trim() !== '',
    );
    if (option !== undefined) {
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
    }
    return undefined;
  }

  /**
   * 上下文压缩（`_kiro.dev/compaction/status`）：字段没有公开，按状态类字段的值认——像失败、取消的不算，像完成的报
   * `context.compacted`，其余（开始、进行中，或认不出）报 `context.compacting`；之后 Kiro 重算上下文用量的 `_kiro.dev/metadata`
   * 当作这次压缩完成。Host 据 `context.compacted` 在下一回合重新补随消息交的规则。没有真实账号核对过。
   */
  protected override extNotification(method: string, params: unknown): void {
    const fields = record(params);
    if (typeof fields?.sessionId !== 'string') return;
    const sessionId = fields.sessionId;
    const open = this.#compacting.get(sessionId);
    if (method === KIRO_METADATA) {
      if (open === undefined) return;
      this.#compacting.delete(sessionId);
      this.reportCompaction(sessionId, open, 'compacted');
      return;
    }
    if (method !== KIRO_COMPACTION_STATUS) return;
    const status = compactionStatus(fields);
    if (status === 'failed') {
      this.#compacting.delete(sessionId);
      return;
    }
    const id = open ?? `kiro-compaction-${++this.#compactions}`;
    if (status === 'completed') {
      this.#compacting.delete(sessionId);
      this.reportCompaction(sessionId, id, 'compacted');
      return;
    }
    if (this.reportCompaction(sessionId, id, 'compacting')) this.#compacting.set(sessionId, id);
  }

  #versioned(session: EngineSession): EngineSession {
    const effort =
      this.generation === 'v3'
        ? kiroEffortValue(this.sessionConfigOptions(session.engineSessionId))
        : undefined;
    return {
      ...session,
      engineVersion: this.#processVersion() ?? session.engineVersion,
      ...(effort !== undefined && { reasoningEffort: effort }),
    };
  }

  #configAccess(id: string): KiroConfigAccess {
    const read = () => this.sessionConfigOptions(id);
    return {
      read,
      set: async (key, value) => {
        await this.setSessionConfigOption(id, key, value);
      },
      waitFor: (matches, timeoutMs) =>
        new Promise((resolve) => {
          const updates = this.#configUpdates.get(id) ?? new Set<() => void>();
          const finish = (value: unknown) => {
            clearTimeout(timer);
            updates.delete(changed);
            if (updates.size === 0) this.#configUpdates.delete(id);
            resolve(value);
          };
          const changed = () => {
            const options = read();
            if (matches(options)) finish(options);
          };
          const timer = setTimeout(() => finish(undefined), timeoutMs);
          updates.add(changed);
          this.#configUpdates.set(id, updates);
          changed();
        }),
    };
  }

  #applyEffort(access: KiroConfigAccess, config: SessionConfig): Promise<void> {
    return applyKiroEffort(
      access,
      config.modelId === KIRO_DEFAULT_MODEL ? undefined : config.modelId,
      config.reasoningEffort,
    );
  }

  #forkCapability(): Record<string, unknown> | undefined {
    return record(this.process.initializeResponse?.agentCapabilities?.sessionCapabilities?.fork);
  }

  #supportsExtension(method: string): boolean {
    const kiro = record(record(this.process.initializeResponse?.agentCapabilities?._meta)?.kiro);
    return Array.isArray(kiro?.extensionMethods) && kiro.extensionMethods.includes(method);
  }

  #sessionInfo(id: string, update: Record<string, unknown>): boolean {
    const meta = record(record(update._meta)?.kiro);
    switch (meta?.kind) {
      case 'user_message_id_assigned':
        if (typeof meta.userMessageId === 'string' && meta.userMessageId) {
          this.reportTurnEvent({
            type: 'turn.bound',
            engineSessionId: id,
            engineTurnId: meta.userMessageId,
            forkPoint: true,
          });
        }
        return true;
      case 'steering_injected': {
        const state = this.#steering.get(id);
        if (state === undefined || typeof meta.messageId !== 'string') return true;
        const steerId = state.queued.get(meta.messageId);
        if (steerId !== undefined) {
          state.queued.delete(meta.messageId);
          this.reportTurnEvent({ type: 'turn.steered', engineSessionId: id, steerId });
        } else if (state.requests !== 0) {
          state.early.add(meta.messageId);
        }
        return true;
      }
      case 'steering_queued':
      case 'steering_cleared':
        return true;
      case 'summarization_completed':
        if (!this.#manualCompactions.has(id)) {
          const summarization = record(meta.summarization);
          if (summarization?.status === 'success') {
            this.reportCompaction(id, `kiro-compaction-${++this.#compactions}`, 'compacted');
          }
        }
        return true;
      default:
        return false;
    }
  }
}

export class KiroAdapter implements AgentRuntimeAdapter {
  readonly accounts: KiroAccounts;
  readonly appTools: boolean;
  readonly historyTool: boolean;
  readonly branches = true;
  readonly sideSessions = false;
  readonly planMode = true;
  readonly permissionModes: readonly PermissionMode[] = ['on_request', 'full_access'];
  readonly #legacy: KiroSessionAdapter;
  readonly #modern: KiroSessionAdapter;
  #unsupportedV3?: { executablePath: string | undefined; version: string | undefined };

  constructor(options: KiroAdapterOptions) {
    this.accounts = new KiroAccounts({
      workDir: `${options.home}/engines/kiro`,
      ...(options.env !== undefined && { env: options.env }),
      ...options.accounts,
    });
    this.#legacy = new KiroSessionAdapter(options, this.accounts, 'v2');
    this.#modern = new KiroSessionAdapter(options, this.accounts, 'v3');
    this.appTools = options.appToolsBridge !== undefined;
    this.historyTool = options.historyTool !== undefined;
  }

  get process(): AcpProcess {
    return this.#preferred().process;
  }

  ruleFiles(): EngineRuleFiles {
    return { user: [], project: [], imports: false, instructions: false };
  }

  acceptsImages(): boolean {
    return true;
  }

  async prewarm(_providerId: string): Promise<void> {
    await this.#forNewSession();
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    if (!config.cwd) throw new AdapterError('invalid_input', 'cwd is required');
    const adapter = await this.#forNewSession();
    return this.#publicSession(await adapter.createSession(config), adapter.generation);
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    const { adapter, id } = this.#byId(engineSessionId);
    return this.#publicSession(await adapter.resumeSession(id, config), adapter.generation);
  }

  async fork(engineSessionId: string, config: SessionConfig, options?: ForkOptions) {
    const { adapter, id } = this.#byId(engineSessionId);
    return this.#publicSession(await adapter.fork(id, config, options), adapter.generation);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const { adapter, id } = this.#byId(engineSessionId);
    const stream = adapter.subscribe(id);
    if (id === engineSessionId) return stream;
    const iterator = stream[Symbol.asyncIterator]();
    const mapped: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]: () => mapped,
      async next() {
        const result = await iterator.next();
        return result.done ? result : { done: false, value: { ...result.value, engineSessionId } };
      },
      return: () => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined }),
    };
    return mapped;
  }

  supports(engineSessionId: string, method: SessionCapability): boolean {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.supports(id, method);
  }

  send(engineSessionId: string, input: AgentInput): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.send(id, input);
  }

  steer(engineSessionId: string, steerId: string, input: AgentInput): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.steer(id, steerId, input);
  }

  compact(engineSessionId: string): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.compact(id);
  }

  cancel(engineSessionId: string): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.cancel(id);
  }

  close(engineSessionId: string): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.close(id);
  }

  listCommands(engineSessionId: string) {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.listCommands(id);
  }

  configureSession(engineSessionId: string, config: NonNullable<Settings['pending']>) {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.configureSession(id, config);
  }

  respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: Parameters<KiroSessionAdapter['respondToApproval']>[2],
  ): Promise<void> {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.respondToApproval(id, requestId, decision);
  }

  respondToQuestion(engineSessionId: string, requestId: string, answers: Record<string, string[]>) {
    const { adapter, id } = this.#byId(engineSessionId);
    return adapter.respondToQuestion(id, requestId, answers);
  }

  async listPendingApprovals(engineSessionId?: string) {
    if (engineSessionId !== undefined) {
      const { adapter, id } = this.#byId(engineSessionId);
      const approvals = await adapter.listPendingApprovals(id);
      return approvals.map((approval) => ({ ...approval, engineSessionId }));
    }
    const [legacy, modern] = await Promise.all([
      this.#legacy.listPendingApprovals(),
      this.#modern.listPendingApprovals(),
    ]);
    return [
      ...legacy,
      ...modern.map((approval) => ({
        ...approval,
        engineSessionId: encodeKiroSessionId(approval.engineSessionId, 'v3'),
      })),
    ];
  }

  async dispose(): Promise<void> {
    await this.accounts.dispose();
    await Promise.all([this.#legacy.dispose(), this.#modern.dispose()]);
  }

  #preferred(): KiroSessionAdapter {
    return kiroGenerationForVersion(this.accounts.version) === 'v3' &&
      this.#unsupportedV3?.version !== this.accounts.version
      ? this.#modern
      : this.#legacy;
  }

  async #forNewSession(): Promise<KiroSessionAdapter> {
    const { version, executablePath } = await this.accounts.read('kiro');
    if (this.#unsupportedV3?.executablePath !== executablePath) this.#unsupportedV3 = undefined;
    const preferred = this.#preferred();
    try {
      await preferred.process.start();
      return preferred;
    } catch (error) {
      if (
        preferred !== this.#modern ||
        !isAdapterError(error, 'engine_unavailable') ||
        !/V3 is currently not supported on this system/i.test(error.message)
      )
        throw error;
      this.#unsupportedV3 = { executablePath, version };
      await this.#legacy.process.start();
      return this.#legacy;
    }
  }

  #byId(engineSessionId: string) {
    const { id, generation } = decodeKiroSessionId(engineSessionId);
    return { id, adapter: generation === 'v3' ? this.#modern : this.#legacy };
  }

  #publicSession(session: EngineSession, generation: KiroGeneration): EngineSession {
    return {
      ...session,
      engineSessionId: encodeKiroSessionId(session.engineSessionId, generation),
    };
  }
}

/** `_kiro.dev/compaction/status` 的状态：看 `status`、`state`、`phase`、`stage`、`event`、`type` 里第一个字符串（也看嵌在 `status` 里的）。 */
function compactionStatus(fields: Record<string, unknown>): 'failed' | 'completed' | 'running' {
  const nested = record(fields.status);
  const value = [fields, nested]
    .flatMap((source) =>
      source === undefined
        ? []
        : ['status', 'state', 'phase', 'stage', 'event', 'type'].map((key) => source[key]),
    )
    .find((candidate): candidate is string => typeof candidate === 'string');
  if (value === undefined) return 'running';
  const words = value.toLowerCase().split(/[^a-z]+/);
  if (
    words.some((word) =>
      /^(?:fail|failed|failure|error|errored|cancel|cancell?ed|abort|aborted)$/.test(word),
    )
  ) {
    return 'failed';
  }
  if (
    words.some((word) =>
      /^(?:complete|completed|done|success|succeeded|finish|finished|end|ended)$/.test(word),
    )
  ) {
    return 'completed';
  }
  return 'running';
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
