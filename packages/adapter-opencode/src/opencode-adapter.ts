// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/adapter.ts（`openSession`、`ensureThread`、`resumeThread`、
// `startTurn`、`interruptTurn`、`respondToRuntimeRequest`、`handleEvent`、`finalizeTurn`、`reconcileOpenCodePromptAdmissionStatus`、
// `abortDescendants`、`emitSubagent`、`routeRuntimeRequest`）、OpenCodeRuntime.ts
// （`openCodeQuestionId`、`toOpenCodeQuestionAnswers`），以及 adapter.ts 的 `steerTurn`、`advanceOpenCodePromptAdmission`、
// `reconcilePromptAdmission`、`forkThread`、`openCodeBoundaryAfterProviderTurn`
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS 的 AgentRuntimeAdapter；T3 的编排节点、计划与 MCP 工具、附件、slash 命令、压缩与回滚不搬；插话
// 以回答它的 assistant 消息（`parentID` 是插话的消息 ID）报 `turn.steered`，没用上的插话在下一次发送前从 opencode 的历史里删掉
// （T3 留着，Host 把它改为排队再发一次时模型会看到两遍）；分支只做 Wevir 的支线（分到最近一个完成的回合，补一条边界消息）；
// 子 agent 照 Wevir 的子会话报（subagent.started + 子会话自己的流），子会话的审批与提问在子会话的流里报（T3 挂到顶层
// 会话上，Wevir 的 Host 自己会把子会话的审批交给父会话的界面）；子会话的规则在 session.created 时就装上（T3 等 task 工具报出
// 子会话 ID 才装）；回合以见到它的 busy 为开始，之前的 idle 一律当作上一个回合留下的（T3 的 admission 状态机在“旧 idle 赶上
// opencode 的循环还没开始”时会去问 session.status、读到 idle 就提前结束回合）；取消在回合没停下之前每秒重发一次 abort。
//
// OpenCode 引擎（订阅来源 `opencode`，ADR-0005 补记 14，docs/architecture/opencode-event-mapping.md）：用户自己装的 `opencode`
// 与他接上的上游，Wevir 在本机起它的服务器（runtime.ts / server.ts），经 `@opencode-ai/sdk` 说话。一个 Wevir 会话是一个
// opencode 会话（引擎会话 ID = opencode 的 `ses_…`），一个回合是一次 `promptAsync`（带 Wevir 生成的用户消息 ID）到这个会话
// 回到 idle。每个工作目录订阅一条事件流，事件按 sessionID 分给会话（task 工具派出的子会话也在同一条流里）。
//
// 插话（R11，§5.10）是回合进行中再发一次 `promptAsync`（新的消息 ID）：opencode 存下这条用户消息，正在跑的循环在这一步结束后
// 看到它比最后一条 assistant 消息新，就接着跑一步，那一步的 assistant 消息的 `parentID` 就是它。支线（§5.12）是 `session.fork`
// 加一条 `noReply` 的边界消息，标题（§5.11）在临时会话里同步 `prompt`（title.ts）。

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AdapterError,
  type AgentEvent,
  type AgentInput,
  type AgentRuntimeAdapter,
  type ApprovalCancelledEvent,
  type ApprovalDecision,
  type EngineAppToolsGrant,
  type EngineRuleFiles,
  type EngineSession,
  EventHub,
  isAdapterError,
  type PendingApproval,
  type PermissionMode,
  type SessionConfig,
  type TitleRequest,
  type TurnFailedEvent,
  type UserQuestion,
} from '@wevir/runtime-adapter';
import { OpenCodeAccounts } from './accounts.js';
import { engineToolName, hiddenToolRules, listAppToolNames } from './app-tools.js';
import { openCodeAccountEnv } from './executable.js';
import { ENGINE_RAW_PROTOCOL, OpenCodeTurnMapper } from './mapping.js';
import { newMessageId } from './message-id.js';
import { lowestVariant, type ParsedModelId, parseModelId } from './models.js';
import {
  APPROVAL_OPTIONS,
  childPermissionRules,
  PERMISSION_MODES,
  permissionReply,
  permissionRules,
} from './permissions.js';
import { OpenCodeRuntime, type OpenCodeRuntimeOptions, type ServerLease } from './runtime.js';
import {
  type Event,
  errorMessage,
  isNotFound,
  type Message,
  type OpenCodeClient,
  type OpenCodeSdk,
  type Session as OpenCodeSessionInfo,
  type Part,
  type PermissionRuleset,
  type PromptInput,
} from './sdk.js';
import type { ServerExit } from './server.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import { generateTitleText } from './title.js';

/** 等取消确认的时限（T3 的 interruptTurn 等 10 秒）。 */
export const CANCEL_TIMEOUT_MS = 10_000;
/** 取消后回合还没停下时，隔多久再发一次 abort（abort 赶在 opencode 的循环开始之前到达时是空操作）。 */
export const ABORT_RETRY_MS = 1_000;
/** 接受输入之后多久还没见到 busy 就去问一次 session.status。 */
export const ACTIVITY_TIMEOUT_MS = 5_000;
/** 事件流连上（收到 server.connected）的时限。 */
export const STREAM_READY_TIMEOUT_MS = 10_000;
/** 插话交出去之前到的 idle 先压着；交出去之后再等这么久，还没见到 busy 才去问 session.status。 */
export const STEER_IDLE_GRACE_MS = 250;

/** 告警与日志出口；Host 的 Logger 满足这个接口。 */
export interface OpenCodeAdapterLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
}

export interface OpenCodeAdapterOptions {
  /** Wevir 数据目录（绝对路径）；台账与账号检测用其中的 `engines/opencode`。 */
  home: string;
  logger?: OpenCodeAdapterLogger;
  /** Host 进程的环境变量（交给 `opencode`）；省略时用 process.env。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 添加的账号（0.63.0）：opencode 的数据目录（`XDG_DATA_HOME`）放这里，登录与会话跟别的账号分开，配置与上游照旧共用
   * （`openCodeAccountEnv`）。下载来的 `opencode` 与服务器台账仍在 `<数据目录>/engines/opencode`。省略时是首个账号。
   */
  account?: { dataHome: string };
  /** 测试用：换掉 SDK、可执行文件的查找、版本探测与起服务器。 */
  sdk?: () => Promise<OpenCodeSdk>;
  findExecutable?: OpenCodeRuntimeOptions['findExecutable'];
  probeVersion?: OpenCodeRuntimeOptions['probeVersion'];
  startServer?: OpenCodeRuntimeOptions['startServer'];
  /** 测试用：换掉 Wevir 替用户装 `opencode` 的安装器（`null` 表示不能装）。 */
  installer?: OpenCodeRuntimeOptions['installer'];
  idleTtlMs?: number;
  cancelTimeoutMs?: number;
}

/** `<数据目录>/engines/opencode`。 */
export function openCodeEngineDir(home: string): string {
  return path.join(home, 'engines', 'opencode');
}

interface SessionSettings {
  modelId: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  additionalRoots?: string[];
  /** 这个会话看不到的应用级工具（Host 按角色与工具预设去掉的，`#hiddenAppTools`），在规则末尾写成 deny。 */
  hiddenTools?: string[];
  /** Host 补给的规则文件（0.68.0，`SessionConfig.ruleInstructions`）：每次 `promptAsync` 作为 `system` 带上。 */
  system?: string;
}

/** 交给进行中回合的一次插话。 */
interface Steer {
  readonly steerId: string;
  /** 插话的用户消息 ID（Wevir 生成）。 */
  readonly messageId: string;
  readonly abort: AbortController;
  /** `promptAsync` 已返回。 */
  accepted: boolean;
  /** 它的用户消息已在事件流里出现。 */
  seen: boolean;
  /** 已有回答它（或它之后的插话）的 assistant 消息，报过 turn.steered。 */
  steered: boolean;
}

/** 插话还在交接（T3 的 admissionPending）：`promptAsync` 没返回，或它的用户消息还没出现。 */
function admitting(steer: Steer): boolean {
  return !steer.steered && !(steer.accepted && steer.seen);
}

interface Turn {
  readonly mapper: OpenCodeTurnMapper;
  /** 顶层回合：Wevir 生成的用户消息 ID。 */
  readonly messageId: string | undefined;
  /**
   * 顶层回合：见到这个会话的 busy（或回答这条用户消息的 assistant 消息）之后，idle 才算这个回合结束；之前的 idle 是上一个回合
   * 留下的（opencode 结束时先发 session.status idle，有时再发一条 session.idle）。子回合一开始就是 true。
   */
  active: boolean;
  /** 接受输入之后一直没见到 busy 时去问 session.status 的计时器。 */
  watchdog: ReturnType<typeof setTimeout> | undefined;
  reconciling: boolean;
  /** `promptAsync` 返回之前的事件先存着（引擎接受输入之后才报这个回合的事件）。 */
  buffer: AgentEvent[] | undefined;
  /** 插话，按交出的顺序。 */
  readonly steers: Steer[];
  /** 插话交接期间到了 idle（可能是循环在插话存下之前就结束了）：先不结算，见到 busy 时作废（T3 的 idleDuringAdmission）。 */
  idleHeld: boolean;
  rechecking: boolean;
  prompt: AbortController | undefined;
  cancelling: boolean;
  done: boolean;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

interface Approval {
  readonly pending: PendingApproval;
  /** 没有 tool part 的审批（死循环检测等），工具调用是适配器合成的。 */
  readonly synthetic: boolean;
}

interface Question {
  readonly ids: string[];
}

interface DirectoryStream {
  readonly directory: string;
  readonly client: OpenCodeClient;
  readonly lease: ServerLease;
  readonly abort: AbortController;
  ready: Promise<void>;
  /** 挂在这个目录上的顶层会话数。 */
  refs: number;
  /** 收到过 server.connected 的次数（重连后用量可能不全）。 */
  connected: number;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly parent: Session | undefined;
  settings: SessionSettings;
  rules: PermissionRuleset;
  hub: EventHub<AgentEvent>;
  attached: boolean;
  stream: DirectoryStream | undefined;
  turn: Turn | undefined;
  readonly roles: Map<string, 'user' | 'assistant'>;
  readonly approvals: Map<string, Approval>;
  readonly questions: Map<string, Question>;
  readonly usage: { totalTokens: number };
  readonly children: Set<Session>;
  /** 子会话：已在父会话的流里报过 subagent.started。 */
  announced: boolean;
  /** 有完成过的回合（或是恢复、分出来的，opencode 里有历史）：可以分出支线。 */
  history: boolean;
  /** 回合进行中补来的说明，回合之后、下一次发送之前写进去（回合中写进去 opencode 的循环会接着回答它）。 */
  readonly notes: string[];
  /** 结算时没用上的插话的消息 ID，下一次发送（或分支）之前从 opencode 的历史里删掉。 */
  readonly staleSteers: string[];
}

/** 不映射、也不保留为 engine.raw 的事件（高频的状态与本适配器不用的通知）。 */
const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.diff',
  'session.compacted',
  'message.removed',
  'message.part.removed',
  'todo.updated',
  'file.edited',
  'file.watcher.updated',
  'lsp.updated',
  'lsp.client.diagnostics',
  'vcs.branch.updated',
  'command.executed',
  'mcp.tools.changed',
  'project.updated',
]);

/** T3 的 `openCodeQuestionId`：提问的 ID 由序号与标题拼成。 */
export function questionId(index: number, header: string): string {
  const slug = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  return slug === '' ? `question-${index}` : `question-${index}-${slug}`;
}

/** opencode 的提问 → Wevir 的 `UserQuestion`（opencode 的 `custom` 默认允许自己填）。 */
export function userQuestions(
  questions: ReadonlyArray<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>,
): UserQuestion[] {
  return questions.map((question, index) => ({
    id: questionId(index, question.header),
    ...(question.header.trim() !== '' && { header: question.header.trim() }),
    question: question.question.trim() || question.header.trim() || `Question ${index + 1}`,
    options: question.options.map((option) => ({
      label: option.label.trim() || 'Option',
      ...(option.description.trim() !== '' && { description: option.description.trim() }),
    })),
    ...(question.multiple === true && { multiSelect: true }),
    allowOther: question.custom !== false,
  }));
}

/** `session.error` 的错误 → 回合失败的归类。 */
export function errorCategory(
  error: { name: string; data?: Record<string, unknown> } | undefined,
): TurnFailedEvent['category'] {
  if (error === undefined) return 'unknown';
  if (error.name === 'ProviderAuthError') return 'missing_credentials';
  if (error.name === 'APIError') {
    const status = error.data?.statusCode;
    return status === 401 || status === 403 ? 'missing_credentials' : 'provider';
  }
  if (error.name === 'UnknownError') return 'unknown';
  return 'provider';
}

function sessionIdOf(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  const part = properties.part as { sessionID?: unknown } | undefined;
  if (typeof part?.sessionID === 'string') return part.sessionID;
  const info = properties.info as { sessionID?: unknown } | undefined;
  if (typeof info?.sessionID === 'string') return info.sessionID;
  return undefined;
}

function adapterError(error: unknown, operation: string): AdapterError {
  if (isAdapterError(error)) return error;
  return new AdapterError(
    'engine_unavailable',
    `OpenCode ${operation} failed: ${errorMessage(error)}`,
    { cause: error },
  );
}

export class OpenCodeAdapter implements AgentRuntimeAdapter {
  readonly accounts: OpenCodeAccounts;
  readonly permissionModes = PERMISSION_MODES;
  readonly additionalRoots = true;
  /**
   * 应用级工具（0.30.0，opencode-event-mapping.md §4.4）：一个服务器服务所有会话，按会话的令牌（`SessionConfig.appTools`）挂
   * 不上，用 Host 给的引擎令牌经插件挂在服务器上（`bindEngineAppTools`，app-tools.ts）。
   */
  readonly appTools = true;

  bindEngineAppTools(grant: EngineAppToolsGrant): void {
    this.#runtime.setAppTools(() => grant(['opencode']));
  }

  /** 图片（0.28.0）：交给 opencode；模型不收图片时 Host 按模型列表的 `supportsImages: false` 先拒绝。 */
  acceptsImages(): boolean {
    return true;
  }

  /**
   * 0.68.0：OpenCode 读哪些规则文件（它的 rules 文档）：项目里从 cwd 往上到仓库根的 AGENTS.md，没有时读 CLAUDE.md；用户级的是它
   * 自己的 `~/.config/opencode/AGENTS.md`，没有时读 `~/.claude/CLAUDE.md`。`OPENCODE_DISABLE_CLAUDE_CODE` 关掉所有 CLAUDE.md，
   * `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` 只关掉用户级的。补给的每次作为 `system` 带上。
   */
  async ruleFiles(): Promise<EngineRuleFiles> {
    return openCodeRuleFiles(this.#options.env ?? process.env);
  }
  readonly #options: OpenCodeAdapterOptions;
  readonly #runtime: OpenCodeRuntime;
  readonly #sessions = new Map<string, Session>();
  readonly #streams = new Map<string, Promise<DirectoryStream>>();
  readonly #unsubscribeExit: () => void;
  #disposed = false;

  constructor(options: OpenCodeAdapterOptions) {
    this.#options = options;
    const logger = options.logger;
    const env =
      options.account === undefined
        ? options.env
        : openCodeAccountEnv(options.env ?? process.env, options.account.dataHome);
    this.#runtime = new OpenCodeRuntime({
      engineDir: openCodeEngineDir(options.home),
      ...(env !== undefined && { env }),
      ...(options.sdk !== undefined && { sdk: options.sdk }),
      ...(logger !== undefined && { warn: (message, fields) => logger.warn(message, fields) }),
      ...(options.findExecutable !== undefined && { findExecutable: options.findExecutable }),
      ...(options.probeVersion !== undefined && { probeVersion: options.probeVersion }),
      ...(options.startServer !== undefined && { startServer: options.startServer }),
      ...(options.installer !== undefined && { installer: options.installer }),
      ...(options.idleTtlMs !== undefined && { idleTtlMs: options.idleTtlMs }),
    });
    this.accounts = new OpenCodeAccounts({
      runtime: this.#runtime,
      ...(env !== undefined && { env }),
    });
    this.#unsubscribeExit = this.#runtime.onServerExit((exit) => this.#onServerExit(exit));
  }

  /** 正在跑的 opencode 服务器的进程 ID（诊断与测试用）；没在跑时 undefined。 */
  get serverPid(): number | undefined {
    return this.#runtime.serverPid;
  }

  /**
   * 会话的设置，加上它看不到的应用级工具：插件在服务器上挂的是所有会话共用的一份，Host 按会话（角色、工具预设）过滤的结果要经会话
   * 自己的令牌列一次才知道（建会话时 Host 已经认得这个正在建的会话）。列不出来时不藏，只记一条警告：调用仍由 Host 按会话拒绝。
   */
  async #settings(config: SessionConfig): Promise<SessionSettings> {
    const settings = settingsOf(config);
    const own = config.appTools;
    const engine = this.#runtime.appToolsEndpoint();
    if (own === undefined || engine === undefined) return settings;
    try {
      const [visible, all] = await Promise.all([listAppToolNames(own), listAppToolNames(engine)]);
      const allowed = new Set(visible);
      const hidden = all.filter((name) => !allowed.has(name));
      return hidden.length === 0 ? settings : { ...settings, hiddenTools: hidden };
    } catch (error) {
      this.#options.logger?.warn('could not list the Wevir tools for an OpenCode session', {
        error: errorMessage(error),
      });
      return settings;
    }
  }

  async createSession(config: SessionConfig): Promise<EngineSession> {
    this.#alive();
    await checkCwd(config.cwd);
    const settings = await this.#settings(config);
    await this.accounts.requireReady();
    const stream = await this.#stream(config.cwd);
    const rules = sessionRules(settings);
    let info: OpenCodeSessionInfo;
    try {
      info = await stream.client.createSession({ permission: rules });
    } catch (error) {
      this.#releaseStream(stream);
      throw adapterError(error, 'session.create');
    }
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode adapter was disposed');
    this.#register(info.id, config.cwd, settings, rules, stream, false);
    return this.#engineSession(info.id, settings);
  }

  async resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#alive();
    const existing = this.#sessions.get(engineSessionId);
    if (existing?.attached === true) return this.#engineSession(engineSessionId, existing.settings);
    if (!engineSessionId.startsWith('ses_')) {
      // opencode 的会话 ID 都是 `ses_…`；别的格式它回 400 而不是 404。
      throw new AdapterError('session_lost', `OpenCode has no session ${engineSessionId}`, {
        lostReason: 'not_found',
      });
    }
    await checkCwd(config.cwd);
    const settings = await this.#settings(config);
    await this.accounts.requireReady();
    const stream = await this.#stream(config.cwd);
    const rules = sessionRules(settings);
    try {
      await stream.client.getSession(engineSessionId);
      // 权限模式可能换过：恢复时按现在的配置重装规则。
      await stream.client.updateSession(engineSessionId, { permission: rules });
    } catch (error) {
      this.#releaseStream(stream);
      if (isNotFound(error)) {
        throw new AdapterError('session_lost', `OpenCode has no session ${engineSessionId}`, {
          cause: error,
          lostReason: 'not_found',
        });
      }
      throw adapterError(error, 'session resume');
    }
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode adapter was disposed');
    this.#register(engineSessionId, config.cwd, settings, rules, stream, true);
    return this.#engineSession(engineSessionId, settings);
  }

  subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    this.#alive();
    return this.#attached(engineSessionId).hub.subscribe();
  }

  async send(engineSessionId: string, input: AgentInput): Promise<void> {
    this.#alive();
    const session = this.#attached(engineSessionId);
    if (session.parent !== undefined) {
      throw new AdapterError('invalid_input', 'subagent sessions are driven by their parent agent');
    }
    if (session.turn !== undefined) {
      throw new AdapterError('session_busy', 'the OpenCode session is already running a turn');
    }
    const parts = inputParts(input);
    const model = modelOf(session.settings.modelId);
    const stream = session.stream;
    if (stream === undefined) throw new AdapterError('session_closed', 'the session is detached');

    const messageId = newMessageId();
    const turn = this.#newTurn(session, messageId, true);
    session.turn = turn;
    turn.prompt = new AbortController();
    try {
      await stream.ready;
      await this.#dropStaleSteers(session);
      await this.#writeNotes(session);
      await stream.client.promptAsync(
        {
          sessionID: session.id,
          messageID: messageId,
          model,
          ...variantOf(session.settings),
          ...(session.settings.system !== undefined && { system: session.settings.system }),
          parts,
        },
        turn.prompt.signal,
      );
    } catch (error) {
      if (turn.done) {
        // 发送途中被取消了：回合已按取消结算，交出存着的事件（含终结事件）。
        const buffered = turn.buffer ?? [];
        turn.buffer = undefined;
        for (const event of buffered) session.hub.emit(event);
        return;
      }
      if (session.turn === turn) session.turn = undefined;
      turn.done = true;
      turn.buffer = undefined;
      turn.resolve();
      throw adapterError(error, 'prompt');
    }
    turn.prompt = undefined;
    const buffered = turn.buffer ?? [];
    turn.buffer = undefined;
    for (const event of buffered) session.hub.emit(event);
    if (turn.done || turn.active) return;
    turn.watchdog = setTimeout(() => this.#reconcile(session, turn), ACTIVITY_TIMEOUT_MS);
    turn.watchdog.unref?.();
  }

  /**
   * 插话（T3 的 `steerTurn`）：回合进行中再发一次 `promptAsync`，opencode 在这一步之后接着回答它。没有进行中的回合、回合正在
   * 取消、或 opencode 不收时报 `steer_rejected`（Host 改为排队）。
   */
  async steer(engineSessionId: string, steerId: string, input: AgentInput): Promise<void> {
    this.#alive();
    const session = this.#attached(engineSessionId);
    if (session.parent !== undefined) {
      throw new AdapterError('invalid_input', 'subagent sessions are driven by their parent agent');
    }
    const parts = inputParts(input);
    const turn = session.turn;
    const stream = session.stream;
    if (turn === undefined || turn.done || turn.cancelling || stream === undefined) {
      throw new AdapterError('steer_rejected', 'the OpenCode session has no turn to steer');
    }
    const model = modelOf(session.settings.modelId);
    const steer: Steer = {
      steerId,
      messageId: newMessageId(),
      abort: new AbortController(),
      accepted: false,
      seen: false,
      steered: false,
    };
    turn.steers.push(steer);
    try {
      await stream.client.promptAsync(
        {
          sessionID: session.id,
          messageID: steer.messageId,
          model,
          ...variantOf(session.settings),
          ...(session.settings.system !== undefined && { system: session.settings.system }),
          parts,
        },
        steer.abort.signal,
      );
    } catch (error) {
      const index = turn.steers.indexOf(steer);
      if (index >= 0) turn.steers.splice(index, 1);
      if (turn.done) await this.#lateSteer(session, steer);
      else this.#admitted(session, turn);
      throw new AdapterError(
        'steer_rejected',
        `OpenCode did not take the steer: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    steer.accepted = true;
    if (turn.done) {
      await this.#lateSteer(session, steer);
      throw new AdapterError('steer_rejected', 'the OpenCode turn ended before the steer arrived');
    }
    this.#admitted(session, turn);
  }

  /**
   * 支线（0.17.0）：`session.fork` 分到最近一个完成的回合（回合进行中时不含它：fork 的边界不含那条消息，T3 的
   * openCodeBoundaryAfterProviderTurn），装上支线的规则，再用 `noReply` 补一条边界消息。分出的是普通的 opencode 会话。
   */
  async fork(engineSessionId: string, config: SessionConfig): Promise<EngineSession> {
    this.#alive();
    const source = this.#attached(engineSessionId);
    if (source.parent !== undefined) {
      throw new AdapterError('invalid_input', 'a subagent session cannot be forked');
    }
    if (!source.history) {
      throw new AdapterError('invalid_input', 'the session has no finished turn to fork from');
    }
    await checkCwd(config.cwd);
    const settings = await this.#settings(config);
    const model = modelOf(settings.modelId);
    await this.accounts.requireReady();
    const running = source.turn !== undefined && !source.turn.done ? source.turn : undefined;
    const stream = await this.#stream(config.cwd);
    const rules = sessionRules(settings);
    let info: OpenCodeSessionInfo | undefined;
    try {
      if (running === undefined) await this.#dropStaleSteers(source);
      info = await stream.client.forkSession(source.id, running?.messageId);
      await stream.client.updateSession(info.id, { permission: rules });
      await stream.client.prompt({
        sessionID: info.id,
        messageID: newMessageId(),
        model,
        ...variantOf(settings),
        noReply: true,
        parts: [{ type: 'text', text: SIDE_BOUNDARY_NOTE }],
      });
    } catch (error) {
      if (info !== undefined) void stream.client.deleteSession(info.id).catch(() => {});
      this.#releaseStream(stream);
      throw adapterError(error, 'session.fork');
    }
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode adapter was disposed');
    this.#register(info.id, config.cwd, settings, rules, stream, true);
    return this.#engineSession(info.id, settings);
  }

  /**
   * 补一条说明（0.16.0）：`noReply` 的 prompt 只把它存成一条用户消息，不开回合。回合进行中先留着，下一次发送之前再写（回合中
   * 写进去，opencode 的循环在这一步之后会接着回答它）。
   */
  async injectNote(engineSessionId: string, text: string): Promise<void> {
    this.#alive();
    const session = this.#attached(engineSessionId);
    if (session.parent !== undefined) {
      throw new AdapterError('invalid_input', 'subagent sessions are driven by their parent agent');
    }
    session.notes.push(text);
    if (session.turn !== undefined && !session.turn.done) return;
    try {
      await this.#writeNotes(session);
    } catch (error) {
      throw adapterError(error, 'note');
    }
  }

  /** 会话标题（title.ts）：用会话的模型、最低的一档变体，在临时会话里同步跑一次。 */
  async generateTitle(engineSessionId: string, request: TitleRequest): Promise<string> {
    this.#alive();
    const session = this.#attached(engineSessionId);
    const stream = session.stream;
    if (stream === undefined) {
      throw new AdapterError(
        'session_closed',
        `the OpenCode session ${engineSessionId} is not attached`,
      );
    }
    const model = modelOf(session.settings.modelId);
    const variant = lowestVariant(this.accounts.variants(session.settings.modelId));
    const logger = this.#options.logger;
    try {
      await stream.ready;
      return await generateTitleText({
        client: stream.client,
        model,
        ...(variant !== undefined && { variant }),
        request,
        ...(logger !== undefined && { warn: (message, fields) => logger.warn(message, fields) }),
      });
    } catch (error) {
      throw new AdapterError(
        'engine_unavailable',
        `OpenCode could not generate a title: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async configureSession(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown OpenCode session ${engineSessionId}`);
    }
    if (session.parent !== undefined) {
      throw new AdapterError('invalid_input', 'subagent sessions follow their parent');
    }
    if (parseModelId(config.modelId) === undefined) {
      throw new AdapterError(
        'invalid_input',
        `OpenCode model '${config.modelId}' must use the provider/model format`,
      );
    }
    session.settings = {
      ...settingsOf(config),
      ...(session.settings.additionalRoots !== undefined && {
        additionalRoots: session.settings.additionalRoots,
      }),
      ...(session.settings.hiddenTools !== undefined && {
        hiddenTools: session.settings.hiddenTools,
      }),
      ...(session.settings.system !== undefined && { system: session.settings.system }),
    };
    const rules = sessionRules(session.settings);
    if (JSON.stringify(rules) === JSON.stringify(session.rules)) return;
    session.rules = rules;
    if (session.attached && session.stream !== undefined) {
      try {
        await session.stream.client.updateSession(session.id, { permission: session.rules });
      } catch (error) {
        throw adapterError(error, 'session.update');
      }
    }
  }

  async respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown OpenCode session ${engineSessionId}`);
    }
    const approval = session.approvals.get(requestId);
    if (approval === undefined) {
      throw new AdapterError('approval_not_found', `OpenCode has no pending approval ${requestId}`);
    }
    const reply = permissionReply(decision.optionId);
    if (reply === undefined) {
      throw new AdapterError('invalid_option', `unknown approval option ${decision.optionId}`);
    }
    const client = session.stream?.client;
    if (client === undefined) {
      throw new AdapterError('approval_not_found', `OpenCode has no pending approval ${requestId}`);
    }
    session.approvals.delete(requestId);
    try {
      await client.replyPermission(requestId, reply.reply, reply.message);
    } catch (error) {
      if (isNotFound(error)) {
        throw new AdapterError(
          'approval_not_found',
          `OpenCode has no pending approval ${requestId}`,
        );
      }
      session.approvals.set(requestId, approval);
      throw adapterError(error, 'permission.reply');
    }
    if (approval.synthetic) {
      const status = reply.reply === 'reject' ? 'failed' : 'completed';
      this.#emit(
        session,
        session.turn?.mapper.finishSynthetic(approval.pending.toolCallId, status) ?? [],
      );
    }
  }

  async respondToQuestion(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown OpenCode session ${engineSessionId}`);
    }
    const question = session.questions.get(requestId);
    const client = session.stream?.client;
    if (question === undefined || client === undefined) {
      throw new AdapterError('question_not_found', `OpenCode has no pending question ${requestId}`);
    }
    session.questions.delete(requestId);
    try {
      // T3 的 toOpenCodeQuestionAnswers：按问题的顺序给，没答的是空数组。
      await client.replyQuestion(
        requestId,
        question.ids.map((id) => (answers[id] ?? []).filter((answer) => answer.trim() !== '')),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new AdapterError(
          'question_not_found',
          `OpenCode has no pending question ${requestId}`,
        );
      }
      session.questions.set(requestId, question);
      throw adapterError(error, 'question.reply');
    }
  }

  async listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]> {
    this.#alive();
    const sessions =
      engineSessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#sessions.get(engineSessionId)].filter(
            (session): session is Session => session !== undefined,
          );
    return sessions.flatMap((session) =>
      [...session.approvals.values()].map((approval) => ({ ...approval.pending })),
    );
  }

  async cancel(engineSessionId: string): Promise<void> {
    const session = this.#sessions.get(engineSessionId);
    const turn = session?.turn;
    if (session === undefined || turn === undefined || turn.done) return;
    turn.cancelling = true;
    turn.prompt?.abort();
    for (const steer of turn.steers) if (!steer.accepted) steer.abort.abort();
    const client = session.stream?.client;
    const abort = async () => {
      if (client === undefined) return;
      try {
        await client.abort(session.id);
      } catch (error) {
        if (!isNotFound(error)) {
          this.#options.logger?.warn('OpenCode abort failed', {
            engineSessionId,
            error: errorMessage(error),
          });
        }
      }
    };
    await abort();
    // 顶层的 abort 停不下子会话（T3 的 abortDescendants）。
    if (client !== undefined) void this.#abortDescendants(client, session.id);
    const timeoutMs = this.#options.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (!turn.done && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        turn.settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(ABORT_RETRY_MS, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      if (!turn.done && Date.now() < deadline) await abort();
    }
    if (turn.done) return;
    this.#options.logger?.warn('OpenCode turn did not stop in time; settling it as cancelled', {
      engineSessionId,
    });
    this.#settle(session, turn, {
      type: 'turn.settled',
      engineSessionId,
      outcome: 'cancelled',
      stopReason: 'cancelled',
    });
  }

  async close(engineSessionId: string): Promise<void> {
    this.#alive();
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown OpenCode session ${engineSessionId}`);
    }
    if (!session.attached) return;
    await this.cancel(engineSessionId);
    this.#detach(session, 'turn_cancelled');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeExit();
    for (const session of this.#sessions.values()) {
      const turn = session.turn;
      if (turn !== undefined && !turn.done) {
        turn.done = true;
        turn.prompt?.abort();
        for (const steer of turn.steers) steer.abort.abort();
        session.turn = undefined;
        turn.resolve();
      }
      this.#emit(session, this.#cancelRequests(session, 'disposed'), true);
      session.attached = false;
      session.stream = undefined;
      session.hub.end();
    }
    const streams = await Promise.allSettled([...this.#streams.values()]);
    this.#streams.clear();
    for (const result of streams) {
      if (result.status === 'fulfilled') {
        result.value.abort.abort();
        result.value.lease.release();
      }
    }
    this.accounts.dispose();
    await this.#runtime.dispose();
  }

  // ── 会话 ─────────────────────────────────────────────────────────────────────

  #register(
    id: string,
    cwd: string,
    settings: SessionSettings,
    rules: PermissionRuleset,
    stream: DirectoryStream,
    history: boolean,
  ): Session {
    const existing = this.#sessions.get(id);
    if (existing?.attached === true) {
      this.#releaseStream(stream);
      return existing;
    }
    const session: Session = {
      id,
      cwd,
      parent: undefined,
      settings,
      rules,
      hub: new EventHub(),
      attached: true,
      stream,
      turn: undefined,
      roles: new Map(),
      approvals: new Map(),
      questions: new Map(),
      usage: existing?.usage ?? { totalTokens: 0 },
      children: new Set(),
      announced: true,
      history: history || existing?.history === true,
      notes: existing?.notes ?? [],
      staleSteers: existing?.staleSteers ?? [],
    };
    this.#sessions.set(id, session);
    return session;
  }

  /** task 工具派出的子会话：登记、装上父会话的规则（T3 的 openCodeChildPermissionRules）。 */
  #adoptChild(parent: Session, info: OpenCodeSessionInfo): Session {
    const existing = this.#sessions.get(info.id);
    if (existing?.attached) return existing;
    const root = rootOf(parent);
    const child: Session = {
      id: info.id,
      cwd: parent.cwd,
      parent,
      settings: { ...root.settings },
      // 父会话藏掉的应用级工具再接在最后，免得 opencode 给子会话的规则里排在后面的放行盖过它们。
      rules: [
        ...childPermissionRules(root.rules, info.permission ?? []),
        ...hiddenToolRules(root.settings.hiddenTools ?? []),
      ],
      hub: new EventHub({ bufferUntilSubscribed: true }),
      attached: true,
      stream: parent.stream,
      turn: undefined,
      roles: new Map(),
      approvals: new Map(),
      questions: new Map(),
      usage: { totalTokens: 0 },
      children: new Set(),
      announced: false,
      history: false,
      notes: [],
      staleSteers: [],
    };
    this.#sessions.set(child.id, child);
    parent.children.add(child);
    const client = parent.stream?.client;
    if (client !== undefined) {
      client.updateSession(child.id, { permission: child.rules }).catch((error: unknown) => {
        this.#options.logger?.warn('could not install the subagent permission rules', {
          engineSessionId: child.id,
          error: errorMessage(error),
        });
      });
    }
    return child;
  }

  /** 父会话的 task 工具报出了子会话 ID：在父会话的流里报 subagent.started（T3 的 emitSubagent）。 */
  #announceChild(parent: Session, part: Extract<Part, { type: 'tool' }>): void {
    const metadata = (part.state as { metadata?: Record<string, unknown> }).metadata;
    const childId =
      typeof metadata?.sessionId === 'string'
        ? metadata.sessionId
        : typeof metadata?.sessionID === 'string'
          ? metadata.sessionID
          : undefined;
    if (childId === undefined) return;
    const child =
      this.#sessions.get(childId) ??
      this.#adoptChild(parent, { id: childId, permission: [] } as unknown as OpenCodeSessionInfo);
    if (child.announced || child.parent !== parent) return;
    child.announced = true;
    const input = part.state.input as Record<string, unknown>;
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const title =
      description ||
      ((part.state as { title?: unknown }).title as string | undefined)?.trim() ||
      '';
    const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
    const role = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
    const model = metadata?.model as { providerID?: unknown; modelID?: unknown } | undefined;
    const modelId =
      typeof model?.providerID === 'string' && typeof model.modelID === 'string'
        ? `${model.providerID}/${model.modelID}`
        : undefined;
    if (modelId !== undefined) child.settings = { ...child.settings, modelId };
    this.#emit(parent, [
      {
        type: 'subagent.started',
        engineSessionId: parent.id,
        childEngineSessionId: child.id,
        parentToolCallId: part.callID,
        title,
        ...(prompt !== undefined && { prompt }),
        ...(modelId !== undefined && { modelId }),
        ...(role !== undefined && { role }),
      },
    ]);
  }

  #newTurn(session: Session, messageId: string | undefined, root: boolean): Turn {
    let resolve: () => void = () => {};
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    return {
      mapper: new OpenCodeTurnMapper(session.id, {
        contextSize: () => this.accounts.contextWindow(session.settings.modelId),
        usage: session.usage,
      }),
      messageId,
      active: !root,
      watchdog: undefined,
      reconciling: false,
      buffer: root ? [] : undefined,
      steers: [],
      idleHeld: false,
      rechecking: false,
      prompt: undefined,
      cancelling: false,
      done: false,
      settled,
      resolve,
    };
  }

  /** 子会话的回合由父 agent 开始（task 工具发来的用户消息）。 */
  #startChildTurn(session: Session, text: string | undefined): Turn {
    const turn = this.#newTurn(session, undefined, false);
    session.turn = turn;
    this.#emit(session, [
      {
        type: 'turn.started',
        engineSessionId: session.id,
        ...(text !== undefined && text.trim() !== '' && { input: [{ type: 'text', text }] }),
      },
    ]);
    return turn;
  }

  /**
   * 接受输入之后一直没见到 busy（T3 的 `reconcileOpenCodePromptAdmissionStatus`）：问 `session.status`，busy 就当回合已开始，idle
   * 就按完成结算（opencode 的循环这时早该开始了）。读不到时隔 250 毫秒再问。
   */
  #reconcile(session: Session, turn: Turn): void {
    if (turn.reconciling) return;
    turn.reconciling = true;
    const current = () => session.turn === turn && !turn.done && !turn.active;
    void (async () => {
      try {
        while (current()) {
          let status: 'idle' | 'busy' | 'unknown' = 'unknown';
          try {
            const statuses = (await session.stream?.client.status()) ?? {};
            const entry = statuses[session.id];
            status = entry === undefined || entry.type === 'idle' ? 'idle' : 'busy';
          } catch {
            status = 'unknown';
          }
          if (!current()) return;
          if (status === 'busy') {
            turn.active = true;
            return;
          }
          if (status === 'idle') {
            this.#settle(session, turn, this.#completed(session, turn));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        turn.reconciling = false;
      }
    })();
  }

  #completed(session: Session, turn: Turn): AgentEvent {
    return turn.cancelling
      ? {
          type: 'turn.settled',
          engineSessionId: session.id,
          outcome: 'cancelled',
          stopReason: 'cancelled',
        }
      : {
          type: 'turn.settled',
          engineSessionId: session.id,
          outcome: 'completed',
          stopReason: turn.mapper.lastFinish ?? 'stop',
        };
  }

  /** 发出回合的终结事件（T3 的 finalizeTurn）：先提交没提交的文本、结掉未决的审批与提问。 */
  #settle(session: Session, turn: Turn, terminal: AgentEvent): void {
    if (turn.done) return;
    turn.done = true;
    clearTimeout(turn.watchdog);
    if (session.parent === undefined) session.history = true;
    // 没用上的插话留到下一次发送之前从 opencode 删掉（Host 把它们改为排队，之后再发）；还在交接的由 steer 自己收尾。
    for (const steer of turn.steers) {
      if (steer.accepted && !steer.steered) session.staleSteers.push(steer.messageId);
    }
    const events = [
      ...turn.mapper.finish(),
      ...this.#cancelRequests(session, turn.cancelling ? 'turn_cancelled' : 'turn_ended'),
      terminal,
    ];
    if (turn.buffer !== undefined) turn.buffer.push(...events);
    else this.#emit(session, events, true);
    if (session.turn === turn) session.turn = undefined;
    turn.resolve();
  }

  #cancelRequests(session: Session, reason: ApprovalCancelledEvent['reason']): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [requestId] of session.approvals) {
      events.push({ type: 'approval.cancelled', engineSessionId: session.id, requestId, reason });
    }
    session.approvals.clear();
    for (const [requestId] of session.questions) {
      events.push({ type: 'question.cancelled', engineSessionId: session.id, requestId, reason });
    }
    session.questions.clear();
    return events;
  }

  /** 会话不再挂着（关闭、引擎退出）：子会话一并脱开，事件流没人用了就停。 */
  #detach(session: Session, reason: ApprovalCancelledEvent['reason'], exit?: ServerExit): void {
    if (!session.attached) return;
    for (const child of session.children) this.#detach(child, reason, exit);
    const turn = session.turn;
    const events: AgentEvent[] = [];
    if (turn !== undefined && !turn.done) {
      turn.done = true;
      turn.prompt?.abort();
      for (const steer of turn.steers) steer.abort.abort();
      events.push(...turn.mapper.finish());
      session.turn = undefined;
      turn.resolve();
    }
    events.push(...this.#cancelRequests(session, reason));
    if (exit !== undefined) {
      events.push({
        type: 'engine.exited',
        engineSessionId: session.id,
        exitCode: exit.code,
        signal: exit.signal,
        ...(exit.stderrTail !== '' && { stderrTail: exit.stderrTail.slice(-4_000) }),
      });
    }
    this.#emit(session, events, true);
    session.attached = false;
    session.hub.end();
    const stream = session.stream;
    session.stream = undefined;
    if (session.parent === undefined && stream !== undefined) this.#releaseStream(stream);
  }

  // ── 事件流 ───────────────────────────────────────────────────────────────────

  /** 工作目录的事件流：第一次用到时借服务器、订阅，等收到 server.connected。 */
  async #stream(directory: string): Promise<DirectoryStream> {
    let pending = this.#streams.get(directory);
    if (pending === undefined) {
      pending = this.#openStream(directory);
      this.#streams.set(directory, pending);
      pending.catch(() => {
        if (this.#streams.get(directory) === pending) this.#streams.delete(directory);
      });
    }
    const stream = await pending;
    stream.refs += 1;
    try {
      await stream.ready;
    } catch (error) {
      this.#releaseStream(stream);
      throw adapterError(error, 'event subscription');
    }
    return stream;
  }

  async #openStream(directory: string): Promise<DirectoryStream> {
    let lease: ServerLease;
    try {
      lease = await this.#runtime.acquire();
    } catch (error) {
      throw adapterError(error, 'server start');
    }
    const stream: DirectoryStream = {
      directory,
      client: lease.client(directory),
      lease,
      abort: new AbortController(),
      ready: Promise.resolve(),
      refs: 0,
      connected: 0,
    };
    let markReady: () => void = () => {};
    let failReady: (error: unknown) => void = () => {};
    stream.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    stream.ready.catch(() => {});
    const timer = setTimeout(
      () => failReady(new Error(`no server.connected within ${STREAM_READY_TIMEOUT_MS} ms`)),
      STREAM_READY_TIMEOUT_MS,
    );
    void (async () => {
      let failure: unknown;
      try {
        const events = await stream.client.subscribe(stream.abort.signal);
        for await (const event of events) {
          if (event.type === 'server.connected') {
            stream.connected += 1;
            if (stream.connected === 1) {
              clearTimeout(timer);
              markReady();
            } else {
              this.#options.logger?.warn(
                'OpenCode event stream reconnected; events may be missing',
                {
                  directory,
                },
              );
            }
            continue;
          }
          try {
            this.#handle(stream, event);
          } catch (error) {
            this.#options.logger?.warn('OpenCode event mapping failed', {
              type: event.type,
              error: errorMessage(error),
            });
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        failReady(failure ?? new Error('the event stream ended'));
        this.#onStreamEnd(stream, failure);
      }
    })();
    return stream;
  }

  #releaseStream(stream: DirectoryStream): void {
    stream.refs = Math.max(0, stream.refs - 1);
    if (stream.refs > 0) return;
    void this.#streams.get(stream.directory)?.then((current) => {
      if (current !== stream || stream.refs > 0) return;
      this.#streams.delete(stream.directory);
      stream.abort.abort();
      stream.lease.release();
    });
  }

  /** 事件流意外结束（不是自己停的）：这个目录的会话都以 engine.exited 脱开。 */
  #onStreamEnd(stream: DirectoryStream, failure: unknown): void {
    if (stream.abort.signal.aborted || this.#disposed) return;
    stream.abort.abort();
    if (this.#streams.get(stream.directory) !== undefined) {
      void this.#streams.get(stream.directory)?.then((current) => {
        if (current === stream) this.#streams.delete(stream.directory);
      });
    }
    const exit: ServerExit = {
      code: null,
      signal: null,
      stderrTail:
        failure === undefined
          ? 'OpenCode event stream ended'
          : `OpenCode event stream failed: ${errorMessage(failure)}`,
    };
    for (const session of [...this.#sessions.values()]) {
      if (session.stream === stream && session.parent === undefined) {
        this.#detach(session, 'engine_exited', exit);
      }
    }
    stream.lease.release();
  }

  /** 服务器意外退出：所有会话以 engine.exited 脱开（T3 同样以 transport_error 结束回合），下次用到时重起服务器。 */
  #onServerExit(exit: ServerExit): void {
    if (this.#disposed) return;
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    for (const session of [...this.#sessions.values()]) {
      if (session.attached && session.parent === undefined) {
        session.stream?.abort.abort();
        this.#detach(session, 'engine_exited', exit);
      }
    }
    for (const pending of streams) {
      void pending.then(
        (stream) => {
          stream.abort.abort();
          stream.lease.release();
        },
        () => {},
      );
    }
  }

  #handle(stream: DirectoryStream, event: Event): void {
    if (event.type === 'session.created' || event.type === 'session.updated') {
      const info = event.properties.info;
      const parent = info.parentID === undefined ? undefined : this.#sessions.get(info.parentID);
      if (parent?.attached === true && parent.stream === stream && !this.#sessions.has(info.id)) {
        this.#adoptChild(parent, info);
      }
      return;
    }
    const sessionId = sessionIdOf(event);
    if (sessionId === undefined) return;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || !session.attached || session.stream !== stream) return;
    switch (event.type) {
      case 'message.updated':
        this.#onMessage(session, event.properties.info);
        return;
      case 'message.part.updated':
        this.#onPart(session, event.properties.part);
        return;
      case 'message.part.delta': {
        const turn = session.turn;
        if (turn !== undefined) this.#emit(session, turn.mapper.delta(event.properties));
        return;
      }
      case 'permission.asked':
        this.#onPermission(session, event.properties);
        return;
      case 'permission.replied': {
        const approval = session.approvals.get(event.properties.requestID);
        if (approval === undefined) return;
        // 不是经 respondToApproval 回的（拒绝时 opencode 把同一会话的其他请求一并拒掉，或在别的客户端里回了）。
        session.approvals.delete(event.properties.requestID);
        const events: AgentEvent[] = [
          {
            type: 'approval.cancelled',
            engineSessionId: session.id,
            requestId: event.properties.requestID,
            reason: 'turn_ended',
          },
        ];
        if (approval.synthetic) {
          events.push(
            ...(session.turn?.mapper.finishSynthetic(
              approval.pending.toolCallId,
              event.properties.reply === 'reject' ? 'failed' : 'completed',
            ) ?? []),
          );
        }
        this.#emit(session, events);
        return;
      }
      case 'question.asked':
        this.#onQuestion(session, event.properties);
        return;
      case 'question.replied':
      case 'question.rejected':
        if (session.questions.delete(event.properties.requestID)) {
          this.#emit(session, [
            {
              type: 'question.cancelled',
              engineSessionId: session.id,
              requestId: event.properties.requestID,
              reason: 'turn_ended',
            },
          ]);
        }
        return;
      case 'session.status':
        if (event.properties.status.type === 'idle') this.#onIdle(session);
        else if (session.turn !== undefined) {
          session.turn.active = true;
          // 压着的 idle 之后又忙起来：opencode 为插话接着跑了（或另起了循环）。
          session.turn.idleHeld = false;
        }
        return;
      case 'session.idle':
        this.#onIdle(session);
        return;
      case 'session.error':
        this.#onError(session, event.properties.error);
        return;
      default:
        if (!IGNORED_EVENTS.has(event.type)) {
          this.#emit(session, [
            {
              type: 'engine.raw',
              engineSessionId: session.id,
              protocol: ENGINE_RAW_PROTOCOL,
              method: 'event',
              kind: event.type,
              params: event.properties,
            },
          ]);
        }
    }
  }

  #onMessage(session: Session, info: Message): void {
    const known = session.roles.has(info.id);
    session.roles.set(info.id, info.role);
    const turn = session.turn;
    if (info.role === 'user') {
      const steer = turn?.steers.find((candidate) => candidate.messageId === info.id);
      if (turn !== undefined && steer !== undefined && !steer.seen) {
        steer.seen = true;
        this.#admitted(session, turn);
      }
      return;
    }
    if (turn !== undefined && turn.messageId !== undefined && info.parentID === turn.messageId) {
      turn.active = true;
    }
    if (turn !== undefined && !turn.done) this.#emit(session, this.#steered(session, turn, info));
    // 子会话没收到用户消息就开始答（不该发生）：照样开一个回合；结算之后才到的旧消息不算。
    const active =
      turn ??
      (session.parent !== undefined && !known && info.time.completed === undefined
        ? this.#startChildTurn(session, undefined)
        : undefined);
    if (active === undefined) return;
    this.#emit(session, active.mapper.message(info));
  }

  #onPart(session: Session, part: Part): void {
    if (session.roles.get(part.messageID) === 'user') {
      // 子会话的回合从 task 工具发来的用户消息开始。
      if (session.parent !== undefined && session.turn === undefined && part.type === 'text') {
        this.#startChildTurn(session, part.text);
      }
      return;
    }
    let turn = session.turn;
    if (turn === undefined) {
      if (session.parent === undefined) return;
      turn = this.#startChildTurn(session, undefined);
    }
    this.#emit(session, turn.mapper.part(part));
    if (part.type === 'tool' && part.tool.toLowerCase() === 'task')
      this.#announceChild(session, part);
  }

  #onPermission(
    session: Session,
    request: Extract<Event, { type: 'permission.asked' }>['properties'],
  ): void {
    if (session.approvals.has(request.id)) return;
    const turn = session.turn;
    const client = session.stream?.client;
    if (turn === undefined) {
      // 没有回合时没人能回答：拒掉，不让 opencode 的会话一直等。
      this.#options.logger?.warn('rejecting an OpenCode permission request outside a turn', {
        engineSessionId: session.id,
        permission: request.permission,
      });
      void client?.replyPermission(request.id, 'reject').catch(() => {});
      return;
    }
    const callID = request.tool?.callID;
    const synthetic = callID === undefined;
    const toolCallId = callID ?? `permission:${request.id}`;
    const toolName =
      (callID === undefined ? undefined : turn.mapper.toolName(callID)) ??
      engineToolName(request.permission);
    const input = synthetic
      ? { ...request.metadata, patterns: request.patterns }
      : Object.keys(request.metadata).length > 0
        ? request.metadata
        : { patterns: request.patterns };
    const pending: PendingApproval = {
      engineSessionId: session.id,
      requestId: request.id,
      toolCallId,
      options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
    };
    session.approvals.set(request.id, { pending, synthetic });
    this.#emit(session, [
      ...turn.mapper.ensureTool(toolCallId, toolName, input),
      { type: 'approval.requested', ...pending },
    ]);
  }

  #onQuestion(
    session: Session,
    request: Extract<Event, { type: 'question.asked' }>['properties'],
  ): void {
    if (session.questions.has(request.id)) return;
    const client = session.stream?.client;
    if (session.turn === undefined) {
      void client?.rejectQuestion(request.id).catch(() => {});
      return;
    }
    const questions = userQuestions(request.questions);
    session.questions.set(request.id, { ids: questions.map((question) => question.id) });
    this.#emit(session, [
      { type: 'question.requested', engineSessionId: session.id, requestId: request.id, questions },
    ]);
  }

  #onIdle(session: Session): void {
    const turn = session.turn;
    // 还没见到这个回合的 busy：是上一个回合留下的 idle。
    if (turn === undefined || turn.done || !turn.active) return;
    if (!turn.cancelling && turn.steers.some(admitting)) {
      turn.idleHeld = true;
      return;
    }
    this.#settle(session, turn, this.#completed(session, turn));
  }

  /**
   * 回答插话的 assistant 消息（`parentID` 是插话的消息 ID）：报 turn.steered。几条插话在同一步之前交出时 opencode 只回答最后
   * 一条（parentID 是它），之前的一并算进去。
   */
  #steered(
    session: Session,
    turn: Turn,
    info: Extract<Message, { role: 'assistant' }>,
  ): AgentEvent[] {
    const index = turn.steers.findIndex((steer) => steer.messageId === info.parentID);
    if (index < 0) return [];
    const events: AgentEvent[] = [];
    for (const steer of turn.steers.slice(0, index + 1)) {
      if (steer.steered) continue;
      steer.steered = true;
      steer.seen = true;
      events.push({ type: 'turn.steered', engineSessionId: session.id, steerId: steer.steerId });
    }
    return events;
  }

  /**
   * 插话交接完了（T3 的 advanceOpenCodePromptAdmission 走到 reconcile-idle）：交接期间压着 idle、之后又没见到 busy 时，等一会儿
   * 问 session.status，busy 就接着等，idle 就结算（opencode 的循环在插话存下之前已经结束：它把这次 prompt 并进了正要结束的那次
   * 运行，不会再回答它）。只等 `promptAsync` 返回，不等它的用户消息出现（opencode 先回 204 再存消息，等的那一会儿盖住这段；
   * 事件丢了也不会一直压着）。
   */
  #admitted(session: Session, turn: Turn): void {
    if (!turn.idleHeld || turn.done || turn.rechecking) return;
    if (turn.steers.some((steer) => !steer.steered && !steer.accepted)) return;
    turn.rechecking = true;
    const current = () => session.turn === turn && !turn.done && turn.idleHeld;
    void (async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, STEER_IDLE_GRACE_MS));
        while (current()) {
          let status: 'idle' | 'busy' | 'unknown' = 'unknown';
          try {
            const statuses = (await session.stream?.client.status()) ?? {};
            const entry = statuses[session.id];
            status = entry === undefined || entry.type === 'idle' ? 'idle' : 'busy';
          } catch {
            status = 'unknown';
          }
          if (!current()) return;
          if (status === 'busy') {
            turn.idleHeld = false;
            return;
          }
          if (status === 'idle') {
            this.#settle(session, turn, this.#completed(session, turn));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        turn.rechecking = false;
      }
    })();
  }

  #onError(
    session: Session,
    error: Extract<Event, { type: 'session.error' }>['properties']['error'],
  ): void {
    const turn = session.turn;
    if (turn === undefined || turn.done) return;
    if (turn.cancelling || error?.name === 'MessageAbortedError') {
      this.#settle(session, turn, {
        type: 'turn.settled',
        engineSessionId: session.id,
        outcome: 'cancelled',
        stopReason: turn.cancelling ? 'cancelled' : 'aborted',
      });
      return;
    }
    const data = (error?.data ?? {}) as Record<string, unknown>;
    const message =
      (typeof data.message === 'string' && data.message.trim()) ||
      error?.name ||
      'OpenCode session failed without an error payload';
    const statusCode = typeof data.statusCode === 'number' ? data.statusCode : undefined;
    this.#settle(session, turn, {
      type: 'turn.failed',
      engineSessionId: session.id,
      category: errorCategory(
        error as { name: string; data?: Record<string, unknown> } | undefined,
      ),
      message,
      ...(statusCode !== undefined && { code: statusCode }),
    });
  }

  /** 停掉会话的全部子孙会话（T3 的 abortDescendants，最多 15 秒）。 */
  async #abortDescendants(client: OpenCodeClient, rootId: string): Promise<void> {
    const visited = new Set([rootId]);
    const deadline = Date.now() + 15_000;
    const queue = [rootId];
    while (queue.length > 0 && Date.now() < deadline) {
      const id = queue.shift() as string;
      let children: OpenCodeSessionInfo[] = [];
      try {
        children = await client.children(id);
      } catch {
        continue;
      }
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        queue.push(child.id);
        await client.abort(child.id).catch(() => {});
      }
    }
  }

  /**
   * 回合结算之后插话才交接完（或交接失败）：opencode 可能已经存下它，并因为会话空闲为它另起了一次循环。没有新的回合时停下那次
   * 循环（不留没人看的回合），消息记为没用上的；Host 已经开始下一个回合时什么都不做（新回合会带上它）。
   */
  async #lateSteer(session: Session, steer: Steer): Promise<void> {
    const client = session.stream?.client;
    if (client === undefined || !session.attached || session.turn !== undefined) return;
    session.staleSteers.push(steer.messageId);
    await client.abort(session.id).catch(() => {});
  }

  /** 删掉没用上的插话（上一个回合结算时记下的），失败只告警。 */
  async #dropStaleSteers(session: Session): Promise<void> {
    const client = session.stream?.client;
    const ids = session.staleSteers.splice(0);
    if (client === undefined) return;
    for (const messageId of ids) {
      await client.deleteMessage(session.id, messageId).catch((error: unknown) => {
        if (isNotFound(error)) return;
        this.#options.logger?.warn('could not remove an unused OpenCode steer message', {
          engineSessionId: session.id,
          error: errorMessage(error),
        });
      });
    }
  }

  /** 把留着的说明写进会话（`noReply`）。写不进去的留着，抛出。 */
  async #writeNotes(session: Session): Promise<void> {
    const client = session.stream?.client;
    if (client === undefined || session.notes.length === 0) return;
    const model = parseModelId(session.settings.modelId);
    while (session.notes.length > 0) {
      const text = session.notes[0] as string;
      await client.prompt({
        sessionID: session.id,
        messageID: newMessageId(),
        ...(model !== undefined && { model }),
        noReply: true,
        parts: [{ type: 'text', text }],
      });
      session.notes.shift();
    }
  }

  // ── 其他 ─────────────────────────────────────────────────────────────────────

  #engineSession(engineSessionId: string, settings: SessionSettings): EngineSession {
    const version = this.#runtime.serverVersion ?? this.#runtime.installation?.version;
    return {
      engineSessionId,
      modelId: settings.modelId,
      ...(settings.reasoningEffort !== undefined && { reasoningEffort: settings.reasoningEffort }),
      ...(version !== undefined && { engineVersion: version }),
    };
  }

  /** 发事件；顶层回合在 `promptAsync` 返回之前先存着。`force` 跳过缓冲（终结与脱开时已处理过）。 */
  #emit(session: Session, events: readonly AgentEvent[], force = false): void {
    if (events.length === 0) return;
    const buffer = force ? undefined : session.turn?.buffer;
    if (buffer !== undefined) {
      buffer.push(...events);
      return;
    }
    for (const event of events) session.hub.emit(event);
  }

  #attached(engineSessionId: string): Session {
    const session = this.#sessions.get(engineSessionId);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `unknown OpenCode session ${engineSessionId}`);
    }
    if (!session.attached) {
      throw new AdapterError(
        'session_closed',
        `the OpenCode session ${engineSessionId} is not attached`,
      );
    }
    return session;
  }

  #alive(): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode adapter was disposed');
  }
}

function rootOf(session: Session): Session {
  let current = session;
  while (current.parent !== undefined) current = current.parent;
  return current;
}

/** 输入的文本段（只用文本）。 */
/**
 * `promptAsync` 的部件：文本合成一段，图片（0.28.0）是 `file` 部件，opencode 自己读 `file://` 地址的文件（同 T3 Code 的
 * toOpenCodeFileParts）。都没有时报 `invalid_input`。
 */
function inputParts(input: AgentInput): PromptInput['parts'] {
  const text = input.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n');
  const files = input.content.flatMap((part) =>
    part.type === 'image'
      ? [
          {
            type: 'file' as const,
            mime: part.mimeType,
            ...(part.name !== undefined && { filename: part.name }),
            url: pathToFileURL(part.path).href,
          },
        ]
      : [],
  );
  if (text.trim() === '' && files.length === 0) {
    throw new AdapterError('invalid_input', 'the message is empty');
  }
  return [...(text.trim() === '' ? [] : [{ type: 'text' as const, text }]), ...files];
}

function modelOf(modelId: string): ParsedModelId {
  const model = parseModelId(modelId);
  if (model === undefined) {
    throw new AdapterError(
      'invalid_input',
      `OpenCode model '${modelId}' must use the provider/model format`,
    );
  }
  return model;
}

/** 推理档位作 opencode 的变体。 */
function variantOf(settings: SessionSettings): { variant?: string } {
  return settings.reasoningEffort === undefined ? {} : { variant: settings.reasoningEffort };
}

/** `OpenCodeAdapter.ruleFiles`（0.68.0）。 */
export async function openCodeRuleFiles(env: NodeJS.ProcessEnv): Promise<EngineRuleFiles> {
  const flag = (name: string) => {
    const value = env[name]?.trim().toLowerCase();
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
  };
  const noClaude = flag('OPENCODE_DISABLE_CLAUDE_CODE');
  const home = env.HOME?.trim() ? env.HOME : homedir();
  const configHome = env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  const ownGlobal = await stat(path.join(configHome, 'opencode', 'AGENTS.md')).then(
    (info) => info.isFile(),
    () => false,
  );
  const userClaude = !noClaude && !flag('OPENCODE_DISABLE_CLAUDE_CODE_PROMPT') && !ownGlobal;
  return {
    user: userClaude ? ['claude'] : [],
    project: ['agents'],
    ...(!noClaude && { projectFallback: ['claude'] }),
    imports: false,
    instructions: true,
  };
}

function settingsOf(config: {
  modelId: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  additionalRoots?: string[];
  ruleInstructions?: string;
}): SessionSettings {
  return {
    modelId: config.modelId,
    ...(config.ruleInstructions !== undefined && { system: config.ruleInstructions }),
    ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    ...(config.permissionMode !== undefined && { permissionMode: config.permissionMode }),
    ...(config.additionalRoots !== undefined &&
      config.additionalRoots.length > 0 && { additionalRoots: [...config.additionalRoots] }),
  };
}

/** 会话的规则集：权限模式的规则，末尾接上它看不到的应用级工具的 deny（最后命中的规则生效）。 */
function sessionRules(settings: SessionSettings): PermissionRuleset {
  const rules = permissionRules(settings.permissionMode, settings.additionalRoots);
  const hidden = settings.hiddenTools ?? [];
  return hidden.length === 0 ? rules : [...rules, ...hiddenToolRules(hidden)];
}

async function checkCwd(cwd: string): Promise<void> {
  if (cwd === '') throw new AdapterError('invalid_input', 'cwd is empty');
  const info = await stat(cwd).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new AdapterError('invalid_input', `${cwd} is not a directory`);
  }
}
