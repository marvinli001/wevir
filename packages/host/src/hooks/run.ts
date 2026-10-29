// 生命周期钩子的执行与判定（0.137.0，ADR-0023 决策 3）：选出匹配的处理器，并行执行，按 Claude Code 的输出协议合并成一个判定，再
// 按调用方要的形式交回（Claude Agent SDK 的 HookJSONOutput、Codex 命令 hook 的退出码与输出、Host 自己用的判定）。
//
// 输出协议：退出码 0 放行，stdout 可给 JSON（`continue`、`decision`/`reason`、`hookSpecificOutput.permissionDecision`、
// `hookSpecificOutput.decision.behavior`、`hookSpecificOutput.additionalContext`、`systemMessage`），UserPromptSubmit 与
// SessionStart 的纯文本 stdout 当作附加上下文；退出码 2 拦下、stderr 是理由；其他退出码与超时是不拦的错误，`onFailure: block` 时拦下。

import { spawn } from 'node:child_process';
import type { HookOutcome } from '@wevir/protocol';
import { HOOK_OUTCOME_TEXT_MAX_LENGTH, HOOK_TIMEOUT_DEFAULT_SEC } from '@wevir/protocol';
import { GUARDRAIL_MARKER } from '@wevir/runtime-adapter/guardrail';

/** 一个处理器的输出最多收多少字节（stdout、stderr 各自）。 */
export const HOOK_OUTPUT_MAX_BYTES = 1024 * 1024;

/** 要执行的一个处理器。 */
export interface RunnableHook {
  id: string;
  source: string;
  command: string;
  timeoutSec?: number;
  onFailure?: string;
  /** 另加的环境变量（插件目录）。 */
  env?: Record<string, string>;
}

export interface HandlerRun {
  hook: RunnableHook;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** 合并后的判定。 */
export interface HookDecision {
  /** 拦下 / 拒绝 / 要求继续 / 给 Agent 的反馈（PostToolUse）。 */
  block?: { reason: string; hookId: string; source: string; command: string };
  /** 放行工具调用或批准权限请求。 */
  allow?: { reason?: string; hookId: string; source: string; command: string };
  context: Array<{ text: string; hookId: string; source: string; command: string }>;
  messages: string[];
  failures: Array<{ reason: string; hookId: string; source: string; command: string }>;
}

export const emptyDecision = (): HookDecision => ({ context: [], messages: [], failures: [] });

/** 工具名的别名：跨引擎的 matcher 用（`Bash`、`Edit`、`Read`）。MCP 工具（`mcp__…`）就是它自己。 */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: 'Bash',
  bash: 'Bash',
  shell: 'Bash',
  exec_command: 'Bash',
  local_shell: 'Bash',
  Edit: 'Edit',
  Write: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  apply_patch: 'Edit',
  edit: 'Edit',
  write: 'Edit',
  patch: 'Edit',
  Read: 'Read',
  read: 'Read',
};

export function toolAlias(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

const TOOL_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
]);

/** matcher 对照的值：工具类事件是工具名与别名，SessionStart 是来源，压缩是触发方式，子 agent 是种类；别的事件不看 matcher。 */
function matchTargets(event: string, input: Record<string, unknown>): string[] | undefined {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  if (TOOL_EVENTS.has(event)) {
    const tool = text('tool_name');
    return [tool, toolAlias(tool)];
  }
  if (event === 'SessionStart') return [text('source')];
  if (event === 'PreCompact' || event === 'PostCompact') return [text('trigger')];
  if (event === 'SubagentStart' || event === 'SubagentStop') return [text('agent_type')];
  return undefined;
}

/** matcher 是整串正则（`Edit|Write`）；省略、空串与 `*` 匹配全部；写错的正则按字面比较。 */
export function matcherMatches(
  matcher: string | undefined,
  event: string,
  input: Record<string, unknown>,
): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  const targets = matchTargets(event, input);
  if (targets === undefined) return true;
  let re: RegExp | undefined;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {}
  return targets.some((target) => (re === undefined ? target === matcher : re.test(target)));
}

/** 去掉 Wevir 的变量（网关与应用级工具的令牌）与 Electron 的开关，同护栏的检查程序。 */
export function scrubbedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^WEVIR_/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key))
      continue;
    out[key] = value;
  }
  return out;
}

/** 输出里伪造的护栏标记改掉（hook 不能冒充护栏的拦截）。 */
const defang = (text: string) => text.split(GUARDRAIL_MARKER).join('wevir-guardrail (hook): ');

/** 执行一个处理器：stdin 是事件 JSON，cwd 是会话目录。不抛错。 */
export function runHandler(
  hook: RunnableHook,
  stdin: string,
  cwd: string,
  options: { signal?: AbortSignal; platform?: NodeJS.Platform; trusted?: boolean } = {},
): Promise<HandlerRun> {
  const platform = options.platform ?? process.platform;
  const timeoutSec = hook.timeoutSec ?? HOOK_TIMEOUT_DEFAULT_SEC;
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        hook,
        exitCode,
        stdout: options.trusted ? stdout : defang(stdout),
        stderr: options.trusted ? stderr : defang(stderr),
        timedOut,
        ...(error !== undefined && { error }),
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, {
        cwd,
        shell: true,
        env: { ...scrubbedEnv(process.env), CLAUDE_PROJECT_DIR: cwd, ...hook.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({
        hook,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: (error as Error).message,
      });
      return;
    }
    const kill = () => {
      try {
        if (platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    timer.unref?.();
    const onAbort = () => {
      kill();
      finish(null, 'cancelled');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (which: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const current = which === 'stdout' ? stdout : stderr;
      if (current.length >= HOOK_OUTPUT_MAX_BYTES) return;
      const next = (current + chunk.toString('utf8')).slice(0, HOOK_OUTPUT_MAX_BYTES);
      if (which === 'stdout') stdout = next;
      else stderr = next;
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code, timedOut ? 'timed out' : undefined));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** stdout 里的 JSON 对象（登录 shell 的启动脚本可能先写了几行，取最后一个以 `{` 开头的段）。 */
function jsonOutput(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (text === '') return undefined;
  const at = text.startsWith('{') ? 0 : text.lastIndexOf('\n{') + 1;
  if (at < 0 || text[at] !== '{') return undefined;
  try {
    const value = JSON.parse(text.slice(at));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** 各处理器的结果 → 一个判定。拦下 / 拒绝优先于放行；上下文与消息依次接起来。 */
export function interpret(event: string, runs: readonly HandlerRun[]): HookDecision {
  const decision = emptyDecision();
  for (const run of runs) {
    const who = { hookId: run.hook.id, source: run.hook.source, command: run.hook.command };
    const block = (reason: string) => {
      decision.block ??= { reason, ...who };
    };
    if (run.error !== undefined || run.timedOut || (run.exitCode !== 0 && run.exitCode !== 2)) {
      const reason = run.timedOut
        ? `The hook timed out after ${run.hook.timeoutSec ?? HOOK_TIMEOUT_DEFAULT_SEC} s.`
        : run.error !== undefined && run.error !== 'timed out'
          ? `The hook could not run: ${run.error}`
          : `The hook failed (exit ${run.exitCode ?? '?'}). ${run.stderr.trim()}`.trim();
      decision.failures.push({ reason, ...who });
      if (run.hook.onFailure === 'block') block(reason);
      continue;
    }
    if (run.exitCode === 2) {
      block(run.stderr.trim() || 'Blocked by a hook.');
      continue;
    }
    const output = jsonOutput(run.stdout);
    if (output === undefined) {
      const text = run.stdout.trim();
      if (text !== '' && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
        decision.context.push({ text, ...who });
      }
      continue;
    }
    const message = str(output.systemMessage);
    if (message !== undefined) decision.messages.push(message);
    if (output.continue === false && event !== 'Stop' && event !== 'SubagentStop') {
      block(str(output.stopReason) ?? 'Stopped by a hook.');
    }
    if (output.decision === 'block') block(str(output.reason) ?? 'Blocked by a hook.');
    if (output.decision === 'approve') decision.allow ??= { ...who };
    const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
    const permission = specific.permissionDecision;
    if (permission === 'deny') {
      block(str(specific.permissionDecisionReason) ?? 'Denied by a hook.');
    } else if (permission === 'allow') {
      const reason = str(specific.permissionDecisionReason);
      decision.allow ??= { ...(reason !== undefined && { reason }), ...who };
    }
    const behavior = isRecord(specific.decision) ? specific.decision : undefined;
    if (behavior?.behavior === 'deny') block(str(behavior.message) ?? 'Denied by a hook.');
    else if (behavior?.behavior === 'allow') decision.allow ??= { ...who };
    const context = str(specific.additionalContext);
    if (context !== undefined) decision.context.push({ text: context, ...who });
  }
  return decision;
}

const contextText = (decision: HookDecision) =>
  decision.context.map((item) => item.text).join('\n\n');

/** 交回 Claude Agent SDK 的回调（HookJSONOutput）。 */
export function claudeOutput(event: string, decision: HookDecision): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (decision.messages.length > 0) out.systemMessage = decision.messages.join('\n');
  const context = contextText(decision);
  if (event === 'PreToolUse') {
    const specific: Record<string, unknown> = { hookEventName: event };
    if (decision.block !== undefined) {
      specific.permissionDecision = 'deny';
      specific.permissionDecisionReason = decision.block.reason;
    } else if (decision.allow !== undefined) {
      specific.permissionDecision = 'allow';
      if (decision.allow.reason !== undefined) {
        specific.permissionDecisionReason = decision.allow.reason;
      }
    }
    if (context !== '') specific.additionalContext = context;
    if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific;
    return out;
  }
  if (decision.block !== undefined) {
    out.decision = 'block';
    out.reason = decision.block.reason;
  }
  if (context !== '' && (event === 'PostToolUse' || event === 'SubagentStart')) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: context };
  }
  return out;
}

/** 交回 Codex 的命令 hook：拦下时退出码 2、理由写 stderr（退出码 2 时 Codex 不看 stdout）；否则退出码 0、需要时 stdout 给 JSON。 */
export function codexOutput(
  event: string,
  decision: HookDecision,
): { exitCode: number; stdout?: string; stderr?: string } {
  if (decision.block !== undefined) return { exitCode: 2, stderr: `${decision.block.reason}\n` };
  const out: Record<string, unknown> = {};
  if (decision.messages.length > 0) out.systemMessage = decision.messages.join('\n');
  const context = contextText(decision);
  const specific: Record<string, unknown> = { hookEventName: event };
  if (context !== '') specific.additionalContext = context;
  if (event === 'PreToolUse' && decision.allow !== undefined) specific.permissionDecision = 'allow';
  if (Object.keys(specific).length > 1) out.hookSpecificOutput = specific;
  return Object.keys(out).length === 0
    ? { exitCode: 0 }
    : { exitCode: 0, stdout: `${JSON.stringify(out)}\n` };
}

function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length <= HOOK_OUTCOME_TEXT_MAX_LENGTH
    ? text
    : `${chars.slice(0, HOOK_OUTCOME_TEXT_MAX_LENGTH - 1).join('')}…`;
}

/** 判定 → `hook.outcome` 事件（只记有作用的）。`blockAction` 是这个事件里拦下的含义。 */
export function outcomesOf(
  event: string,
  decision: HookDecision,
  extra: { turnId?: string; tool?: string; blockAction?: string } = {},
): HookOutcome[] {
  const base = (who: { hookId: string; source: string; command: string }) => ({
    hookId: who.hookId,
    source: who.source,
    event,
    ...(extra.turnId !== undefined && { turnId: extra.turnId as HookOutcome['turnId'] }),
    ...(extra.tool !== undefined && extra.tool !== '' && { tool: extra.tool }),
    command: clip(who.command),
  });
  const outcomes: HookOutcome[] = [];
  if (decision.block !== undefined) {
    const blockAction =
      extra.blockAction ??
      (event === 'Stop' || event === 'SubagentStop'
        ? 'continued'
        : event === 'PermissionRequest'
          ? 'denied'
          : 'blocked');
    outcomes.push({
      ...base(decision.block),
      action: blockAction,
      reason: clip(decision.block.reason),
    });
  } else if (decision.allow !== undefined) {
    outcomes.push({
      ...base(decision.allow),
      action: 'allowed',
      ...(decision.allow.reason !== undefined && { reason: clip(decision.allow.reason) }),
    });
  }
  for (const item of decision.context) {
    outcomes.push({ ...base(item), action: 'context', reason: clip(item.text) });
  }
  for (const failure of decision.failures) {
    outcomes.push({ ...base(failure), action: 'failed', reason: clip(failure.reason) });
  }
  return outcomes;
}
