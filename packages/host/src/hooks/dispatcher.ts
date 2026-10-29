// 生命周期钩子的派发（0.137.0，ADR-0023 决策 1、2、5）：一个入口执行所有引擎的 hooks。
// - Codex：会话层命令 hook 经检查程序的 `--forward` 把事件转到 Host 的 `POST /hooks`（令牌对应会话），结果按退出码与输出交回；
// - Claude：适配器的 SDK 回调调 `HookTap.run`（进程内），护栏的检查程序也经这里执行（Codex 的护栏仍是它自己的会话层 hook）；
// - Host 自己：会话起止、提交提示与权限请求由会话管理调用；没有原生接点的引擎，回合结束后跑 Stop（要求继续时开后续回合）、工具完成
//   后跑 PostToolUse（只观察）。
// 起了作用的写成 `hook.outcome`。Stop 要求继续，同一回合（Host 兜底时是同一串后续回合）最多 `HOOK_STOP_CONTINUE_MAX` 次。

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type {
  HookOutcome,
  HookSupport,
  SessionId,
  TurnId,
  WevirEvent,
  WorkspaceId,
} from '@wevir/protocol';
import { HOOK_STOP_CONTINUE_MAX, HOST_HOOK_EVENTS } from '@wevir/protocol';
import type { EngineHook, HookTap, NativeHookEvent } from '@wevir/runtime-adapter';
import { NATIVE_HOOK_EVENTS } from '@wevir/runtime-adapter';
import {
  type GuardrailChecker,
  type GuardrailMarker,
  guardrailCheckerCommand,
  hookForwardCommand,
  parseGuardrailMarkers,
} from '@wevir/runtime-adapter/guardrail';
import {
  claudeOutput,
  codexOutput,
  emptyDecision,
  type HookDecision,
  interpret,
  outcomesOf,
  type RunnableHook,
  runHandler,
  toolAlias,
} from './run.js';
import type { HookScope, HookService } from './service.js';

/** Codex 接点转 Host 的地址路径。 */
export const HOOKS_PATH = '/hooks';
/** 请求体上限。 */
const BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** Codex 接点 hook 在处理器时限之外留的余量（秒）。 */
const TAP_TIMEOUT_SLACK_SEC = 30;

/** 会话管理给的会话信息。 */
export interface HookSessionInfo {
  providerId: string;
  cwd: string;
  workspaceId?: WorkspaceId;
  /** 进行中的回合。 */
  turnId?: TurnId;
  permissionMode?: string;
  /** Wevir 开的子会话（`wevir_session_*` / 子 agent 的子会话）：Host 兜底的 Stop 不对它开后续回合。 */
  child?: boolean;
}

export interface HookSessionPort {
  info(sessionId: SessionId): HookSessionInfo | undefined;
  outcome(sessionId: SessionId, outcome: HookOutcome): void;
  guardrailBlocked(sessionId: SessionId, marker: GuardrailMarker): void;
  /** Host 兜底的 Stop 要求继续：以一条消息开后续回合。 */
  continueTurn(
    sessionId: SessionId,
    text: string,
    hookId: string,
  ): Promise<{ turnId: TurnId } | { skipped: string }>;
}

/** 承载 Provider 的引擎与它的接点。 */
export interface HookEngine {
  engine: string;
  /** `codex` 命令 hook 转回，`callback` 进程内回调，没有时只有 Host 派发与兜底。 */
  tap?: 'codex' | 'callback';
}

export interface HookDispatcherOptions {
  service: HookService;
  engineOf: (providerId: string) => HookEngine | undefined;
  /** 检查程序（Codex 接点经它的 `--forward` 转回；Claude 会话的护栏也由它执行）。 */
  checker?: GuardrailChecker;
  /** 护栏：这个范围里有哪些种类的规则（Claude 会话有对应种类时才跑检查程序）。 */
  guardrailKinds?: (workspaceId: WorkspaceId | undefined) => ReadonlySet<string>;
  /** Codex 接点文件的目录（0700）。 */
  tapDir: string;
  /** 各引擎的支持情况（`hook.list` 的 `support`）用：这个 Host 上的 Provider。 */
  providers?: () => ReadonlyArray<{ id: string; kind: string }>;
  platform?: NodeJS.Platform;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const GUARDRAIL_EVENT_KINDS: Readonly<Record<string, readonly string[]>> = {
  PreToolUse: ['forbidden_command', 'protected_path', 'commit_check'],
  Stop: ['stop_check'],
};

/** 没有原生接点时 Host 兜底的事件。 */
const FALLBACK_EVENTS: readonly string[] = ['PostToolUse', 'Stop'];

export class HookDispatcher {
  readonly #options: HookDispatcherOptions;
  readonly #platform: NodeJS.Platform;
  #port: HookSessionPort | undefined;
  #httpPort: number | undefined;
  readonly #tokens = new Map<SessionId, string>();
  readonly #sessions = new Map<string, SessionId>();
  /** Stop 要求继续的次数：会话 → 回合与次数。 */
  readonly #stops = new Map<SessionId, { turnId: string; count: number }>();
  /** Host 兜底的 Stop 开的后续回合（这串回合共用次数）。 */
  readonly #hookTurns = new Set<string>();
  /** Host 兜底的 PostToolUse：工具调用 → 工具名与输入。 */
  readonly #tools = new Map<string, { toolName: string; input: unknown }>();
  /** 跑过 SessionStart 的引擎会话（会话 → 次数标记）。 */
  readonly #started = new Set<SessionId>();

  constructor(options: HookDispatcherOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
  }

  bind(port: HookSessionPort): void {
    this.#port = port;
  }

  setPort(port: number): void {
    this.#httpPort = port;
  }

  /** 各引擎有接点的事件：Host 派发的四种都有，原生接点的加上那七种，没有的加兜底的两种。 */
  support(): HookSupport[] {
    const seen = new Map<string, HookSupport>();
    for (const provider of this.#options.providers?.() ?? []) {
      const engine = this.#options.engineOf(provider.id);
      if (engine === undefined || seen.has(engine.engine)) continue;
      const native = engine.tap === undefined ? FALLBACK_EVENTS : NATIVE_HOOK_EVENTS;
      seen.set(engine.engine, { engine: engine.engine, events: [...HOST_HOOK_EVENTS, ...native] });
    }
    return [...seen.values()];
  }

  #context(
    sessionId: SessionId,
  ): { info: HookSessionInfo; engine: HookEngine; scope: HookScope } | undefined {
    const info = this.#port?.info(sessionId);
    if (info === undefined) return undefined;
    const engine = this.#options.engineOf(info.providerId) ?? { engine: 'unknown' };
    return {
      info,
      engine,
      scope: { workspaceId: info.workspaceId, cwd: info.cwd, engine: engine.engine },
    };
  }

  /** 交给 hook 的输入：引擎给的原样，补上 Wevir 的会话信息与工具别名。 */
  #input(
    sessionId: SessionId,
    event: string,
    context: { info: HookSessionInfo; engine: HookEngine },
    base: Record<string, unknown>,
  ): Record<string, unknown> {
    const tool = typeof base.tool_name === 'string' ? base.tool_name : undefined;
    return {
      session_id: sessionId,
      cwd: context.info.cwd,
      ...(context.info.permissionMode !== undefined && {
        permission_mode: context.info.permissionMode,
      }),
      ...base,
      hook_event_name: event,
      wevir: {
        engine: context.engine.engine,
        providerId: context.info.providerId,
        sessionId,
        ...(context.info.workspaceId !== undefined && { workspaceId: context.info.workspaceId }),
        ...(tool !== undefined && { tool: toolAlias(tool) }),
      },
    };
  }

  /**
   * 执行一个事件的 hooks，记下起了作用的，返回合并的判定。`guardrails` 时先跑护栏的检查程序（Claude 会话），拦下了就不再跑 hooks。
   * 不抛错。
   */
  async run(
    sessionId: SessionId,
    event: string,
    base: Record<string, unknown>,
    options: { signal?: AbortSignal; guardrails?: boolean; turnId?: string; stopKey?: string } = {},
  ): Promise<HookDecision> {
    const context = this.#context(sessionId);
    if (context === undefined) return emptyDecision();
    const input = this.#input(sessionId, event, context, base);
    const turnId = options.turnId ?? context.info.turnId;
    const tool = typeof input.tool_name === 'string' ? input.tool_name : undefined;
    try {
      if (options.guardrails === true) {
        const blocked = await this.#guardrail(sessionId, event, context, input, options.signal);
        if (blocked !== undefined) return blocked;
      }
      const handlers = this.#options.service.handlers(context.scope, event, input);
      if (handlers.length === 0) return emptyDecision();
      const stdin = JSON.stringify(input);
      const runs = await Promise.all(
        handlers.map((hook) =>
          runHandler(hook, stdin, context.info.cwd, {
            ...(options.signal !== undefined && { signal: options.signal }),
            platform: this.#platform,
          }),
        ),
      );
      const decision = interpret(event, runs);
      let limited = false;
      if ((event === 'Stop' || event === 'SubagentStop') && decision.block !== undefined) {
        limited = !this.#countStop(sessionId, options.stopKey ?? turnId ?? '');
      }
      const outcomes = outcomesOf(event, decision, {
        ...(turnId !== undefined && { turnId }),
        ...(tool !== undefined && { tool }),
        ...(limited && { blockAction: 'limit' }),
      });
      for (const outcome of outcomes) this.#port?.outcome(sessionId, outcome);
      if (limited) {
        const { block: _block, ...rest } = decision;
        return rest;
      }
      return decision;
    } catch (error) {
      this.#options.onWarning?.('hook dispatch failed', {
        sessionId,
        event,
        error: (error as Error).message,
      });
      return emptyDecision();
    }
  }

  /** 这一回合还能不能让 Agent 继续：能时计一次。 */
  #countStop(sessionId: SessionId, turnId: string): boolean {
    const current = this.#stops.get(sessionId);
    const state =
      current !== undefined && current.turnId === turnId ? current : { turnId, count: 0 };
    if (state.count >= HOOK_STOP_CONTINUE_MAX) return false;
    state.count += 1;
    this.#stops.set(sessionId, state);
    return true;
  }

  /** 护栏的检查程序（Claude 会话的 PreToolUse 与 Stop）：拦下时返回判定并报 `guardrail.blocked`。 */
  async #guardrail(
    sessionId: SessionId,
    event: string,
    context: { info: HookSessionInfo },
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<HookDecision | undefined> {
    const checker = this.#options.checker;
    const kinds = GUARDRAIL_EVENT_KINDS[event];
    if (
      checker === undefined ||
      this.#options.guardrailKinds === undefined ||
      kinds === undefined
    ) {
      return undefined;
    }
    const present = this.#options.guardrailKinds(context.info.workspaceId);
    if (!kinds.some((kind) => present.has(kind))) return undefined;
    const args = [
      '--dir',
      checker.dir,
      ...(context.info.workspaceId === undefined ? [] : ['--workspace', context.info.workspaceId]),
    ];
    const hook: RunnableHook = {
      id: 'guardrail',
      source: 'guardrail',
      command: guardrailCheckerCommand(checker, args, this.#platform),
      timeoutSec: 3600,
    };
    const stdin = JSON.stringify({ ...input, turn_id: context.info.turnId ?? '' });
    const run = await runHandler(hook, stdin, context.info.cwd, {
      ...(signal !== undefined && { signal }),
      platform: this.#platform,
      trusted: true,
    });
    for (const marker of parseGuardrailMarkers(`${run.stderr}\n${run.stdout}`)) {
      this.#port?.guardrailBlocked(sessionId, marker);
    }
    if (run.exitCode !== 2) return undefined;
    const reason = run.stderr
      .split(/\r?\n/)
      .filter((line) => !line.includes('wevir-guardrail: '))
      .join('\n')
      .trim();
    return {
      ...emptyDecision(),
      block: {
        reason: reason || 'Blocked by a Wevir guardrail.',
        hookId: 'guardrail',
        source: 'guardrail',
        command: '',
      },
    };
  }

  // ── Claude：进程内接点 ─────────────────────────────────────────────────

  /** Claude 会话的接点（`SessionConfig.hookTap`）。 */
  claudeTap(sessionId: SessionId): HookTap {
    return {
      run: async (event: NativeHookEvent, input, signal) => {
        const decision = await this.run(sessionId, event, input, {
          ...(signal !== undefined && { signal }),
          guardrails: true,
        });
        return claudeOutput(event, decision);
      },
    };
  }

  // ── Codex：命令 hook 转回 ─────────────────────────────────────────────

  /**
   * Codex 会话的接点 hooks：有处理器的事件各挂一个转发命令（接点文件里是地址与这个会话的令牌）。Host 还没有端口、或没有检查程序时
   * 不挂。
   */
  codexHooks(sessionId: SessionId, info: HookSessionInfo): EngineHook[] {
    const checker = this.#options.checker;
    if (checker === undefined || this.#httpPort === undefined) return [];
    const engine = this.#options.engineOf(info.providerId) ?? { engine: 'codex' };
    const context = {
      scope: { workspaceId: info.workspaceId, cwd: info.cwd, engine: engine.engine },
    };
    const events = NATIVE_HOOK_EVENTS.map((event) => ({
      event,
      seconds: this.#options.service.pending(context.scope, event),
    })).filter((item) => item.seconds > 0);
    if (events.length === 0) return [];
    const timeoutSec = Math.max(...events.map((item) => item.seconds)) + TAP_TIMEOUT_SLACK_SEC;
    const file = this.#writeTap(sessionId, timeoutSec);
    if (file === undefined) return [];
    return events.map(({ event, seconds }) => ({
      event,
      command: hookForwardCommand(checker, file, this.#platform),
      timeoutSec: seconds + TAP_TIMEOUT_SLACK_SEC,
    }));
  }

  #writeTap(sessionId: SessionId, timeoutSec: number): string | undefined {
    let token = this.#tokens.get(sessionId);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.#tokens.set(sessionId, token);
      this.#sessions.set(digest(token), sessionId);
    }
    const file = join(this.#options.tapDir, `${sessionId}.json`);
    try {
      mkdirSync(this.#options.tapDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({
          url: `http://127.0.0.1:${this.#httpPort}${HOOKS_PATH}`,
          token,
          timeoutSec,
        }),
        { mode: 0o600 },
      );
      return file;
    } catch (error) {
      this.#options.onWarning?.('failed to write a hook tap file', {
        sessionId,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  /** `POST /hooks`：Codex 接点转来的事件。不是这个路径时返回 false。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? '').split('?')[0];
    if (path !== HOOKS_PATH) return false;
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') {
      reply(405, { error: 'method not allowed' });
      return true;
    }
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const sessionId = token === undefined ? undefined : this.#sessions.get(digest(token));
    if (sessionId === undefined) {
      reply(401, { error: 'unauthorized' });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
        input = parsed as Record<string, unknown>;
      } catch {
        reply(400, { error: 'invalid JSON' });
        return;
      }
      const event = input.hook_event_name;
      if (typeof event !== 'string' || !(NATIVE_HOOK_EVENTS as readonly string[]).includes(event)) {
        reply(200, { exitCode: 0 });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      void this.run(sessionId, event, input, { signal: controller.signal }).then((decision) =>
        reply(200, codexOutput(event, decision)),
      );
    });
    return true;
  }

  /** 会话关闭：作废令牌、删接点文件。 */
  forget(sessionId: SessionId): void {
    const token = this.#tokens.get(sessionId);
    if (token !== undefined) this.#sessions.delete(digest(token));
    this.#tokens.delete(sessionId);
    this.#stops.delete(sessionId);
    this.#started.delete(sessionId);
    try {
      rmSync(join(this.#options.tapDir, `${sessionId}.json`), { force: true });
    } catch {}
  }

  // ── Host 派发 ─────────────────────────────────────────────────────────

  /** 这个引擎会话第一次交回合之前：SessionStart，返回附加上下文。同一个会话在 Host 运行期间只跑一次（恢复后的第一回合算 `resume`）。 */
  async sessionStart(
    sessionId: SessionId,
    source: 'startup' | 'resume',
  ): Promise<string | undefined> {
    if (this.#started.has(sessionId)) return undefined;
    this.#started.add(sessionId);
    const decision = await this.run(sessionId, 'SessionStart', { source });
    const text = decision.context.map((item) => item.text).join('\n\n');
    return text === '' ? undefined : text;
  }

  /** 会话换了引擎会话（恢复、换来源）：下一回合前再跑一次 SessionStart。 */
  restarted(sessionId: SessionId): void {
    this.#started.delete(sessionId);
  }

  /** 把用户消息交给引擎之前：拦下（理由给用户）或附加上下文。 */
  async userPromptSubmit(
    sessionId: SessionId,
    prompt: string,
  ): Promise<{ blocked?: string; context?: string }> {
    const decision = await this.run(sessionId, 'UserPromptSubmit', { prompt });
    if (decision.block !== undefined) return { blocked: decision.block.reason };
    const text = decision.context.map((item) => item.text).join('\n\n');
    return text === '' ? {} : { context: text };
  }

  /** 引擎来要审批时：hooks 能直接批准或拒绝。没有处理器时立即返回 undefined。 */
  async permissionRequest(
    sessionId: SessionId,
    toolName: string,
    toolInput: unknown,
  ): Promise<{ behavior: 'allow' | 'deny'; reason?: string } | undefined> {
    const context = this.#context(sessionId);
    if (context === undefined) return undefined;
    const base = { tool_name: toolName, tool_input: toolInput ?? {} };
    const probe = this.#input(sessionId, 'PermissionRequest', context, base);
    if (this.#options.service.handlers(context.scope, 'PermissionRequest', probe).length === 0) {
      return undefined;
    }
    const decision = await this.run(sessionId, 'PermissionRequest', base);
    if (decision.block !== undefined) return { behavior: 'deny', reason: decision.block.reason };
    if (decision.allow !== undefined) {
      return {
        behavior: 'allow',
        ...(decision.allow.reason !== undefined && { reason: decision.allow.reason }),
      };
    }
    return undefined;
  }

  /** 有没有这个事件要跑的处理器（权限请求与提交提示先看一眼，免得没有 hooks 时也走异步）。 */
  has(sessionId: SessionId, event: string): boolean {
    const context = this.#context(sessionId);
    return context !== undefined && this.#options.service.pending(context.scope, event) > 0;
  }

  /** 全部会话的事件（`listenAll`）：SessionEnd，与没有原生接点的引擎的 Stop、PostToolUse。 */
  onEvent(event: WevirEvent): void {
    const sessionId = event.sessionId;
    switch (event.type) {
      case 'session.state_changed':
        if (event.payload.to === 'closed') {
          void this.run(sessionId, 'SessionEnd', { reason: 'closed' }).finally(() =>
            this.forget(sessionId),
          );
        }
        return;
      case 'tool.started': {
        if (!this.#fallback(sessionId, 'PostToolUse')) return;
        this.#tools.set(`${sessionId}:${event.payload.toolCallId}`, {
          toolName: event.payload.toolName,
          input: event.payload.input,
        });
        return;
      }
      case 'tool.finished': {
        const key = `${sessionId}:${event.payload.toolCallId}`;
        const tool = this.#tools.get(key);
        if (tool === undefined) return;
        this.#tools.delete(key);
        void this.run(sessionId, 'PostToolUse', {
          tool_name: tool.toolName,
          tool_input: tool.input ?? {},
          tool_response: event.payload.output ?? {},
          tool_use_id: event.payload.toolCallId,
        });
        return;
      }
      case 'turn.finished': {
        const turnId = event.payload.turnId;
        const chained = this.#hookTurns.delete(turnId);
        if (event.payload.outcome !== 'completed') return;
        if (!this.#fallback(sessionId, 'Stop')) return;
        const info = this.#port?.info(sessionId);
        if (info === undefined || info.child === true) return;
        void this.#fallbackStop(sessionId, turnId, chained);
        return;
      }
    }
  }

  /** 这个会话的引擎没有原生接点、且这个事件有处理器。 */
  #fallback(sessionId: SessionId, event: string): boolean {
    const context = this.#context(sessionId);
    if (context === undefined || context.engine.tap !== undefined) return false;
    return this.#options.service.pending(context.scope, event) > 0;
  }

  async #fallbackStop(sessionId: SessionId, turnId: string, chained: boolean): Promise<void> {
    // Host 开的后续回合与它前面的回合共用次数：记在这串的第一个回合上。
    const chain = chained ? (this.#stops.get(sessionId)?.turnId ?? turnId) : turnId;
    const decision = await this.run(
      sessionId,
      'Stop',
      { stop_hook_active: chained },
      { turnId, stopKey: chain },
    );
    if (decision.block === undefined) return;
    const result = await this.#port
      ?.continueTurn(sessionId, decision.block.reason, decision.block.hookId)
      .catch((error: unknown) => {
        this.#options.onWarning?.('hook continuation failed', {
          sessionId,
          error: (error as Error).message,
        });
        return undefined;
      });
    if (result !== undefined && 'turnId' in result) this.#hookTurns.add(result.turnId);
  }
}
