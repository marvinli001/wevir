// coding 评测的分类器：从记录下的模型请求（模型实际看到的工具调用与输出）和 Host 事件里数出编辑尝试与各类失败。
//
// 依据（锁定的 Codex rust-v0.162.1，codex-rs/core/src/tools/handlers/apply_patch.rs，2026-10-20 用假模型实测确认）：
// - 补丁在应用之前先解析、再对着文件核对上下文；这两步失败时 app-server **不发任何 item**（没有 fileChange，Host 也就没有
//   tool.started / tool.finished），只把错误文本作为 `custom_tool_call_output` 交还模型。所以失败的编辑只能从下一个请求的
//   请求体里看到，分类按这些固定前缀：
//   - `apply_patch verification failed: invalid patch: …` / `invalid hunk at line …` → 补丁格式解析失败；
//   - `apply_patch verification failed: Failed to find expected lines in <路径>:` → 前置内容不匹配；
//   - `apply_patch verification failed: Failed to read file to update|delete <路径>: …` → 目标文件不存在（也算文件版本问题）；
//   - `apply_patch handler received invalid patch input|non-apply_patch input|unsupported payload` → 工具参数没按约定到达；
// - 核对通过之后才有 fileChange item：成功时输出 `Success. Updated the following files:` 加 `A|M|D <路径>` 各行；需要审批
//   而被拒绝时 tool.finished 为 failed、同一 toolCallId 有被拒的审批（补丁的审批只有“拒绝并停止”，回合随即取消，模型看不到输出）。
// - shell 越出沙箱写文件：输出里有 `Operation not permitted`；拒绝提权审批：`exec_command failed: … rejected by user`。
// Chat Completions 上游（网关把 apply_patch 摊平成只有一个字符串参数 `input` 的函数）另外核对参数：不是 JSON 或没有 `input`
// 时网关原样交给 Codex，Codex 再报补丁格式错误——这算工具参数往返失败，不算模型写错了补丁格式。

import type { WevirEvent } from '@wevir/protocol';
import type { EvalRequest } from './recorder.js';

export type EditOutcome =
  | 'applied'
  | 'patch-format'
  | 'preimage-mismatch'
  | 'target-missing'
  | 'tool-args'
  | 'permission'
  | 'apply-error'
  | 'no-output'
  | 'unknown';

export interface ToolCallRecord {
  callId: string;
  /** 不带命名空间的名字（`apply_patch`、`exec_command`、`lsp_references`…）。 */
  name: string;
  namespace?: string;
  /** apply_patch 的补丁文本；其他工具是参数的 JSON 文本。 */
  input: string;
  /** Chat / Messages：参数是不是合法 JSON（apply_patch 还要求有字符串 `input`）。Responses 的 custom 调用总是 true。 */
  argsOk: boolean;
  output?: string;
  /** 第一次出现在第几个请求里。 */
  firstSeen: number;
}

/** 一次编辑尝试（一次 apply_patch 调用）。 */
export interface EditAttempt {
  callId: string;
  /** 在全部工具调用里的先后（从 0 起）。 */
  order: number;
  outcome: EditOutcome;
  /** 补丁头里的路径（`*** Add|Update|Delete File:`），成功时取输出里的 `A|M|D` 行。 */
  files: string[];
  /** 失败时的错误首行（路径换成相对的）。 */
  detail?: string;
  /** 之后对同一文件（路径不明时对任何文件）有一次成功的编辑。 */
  recovered?: boolean;
}

export interface ShellCall {
  callId: string;
  order: number;
  command: string;
  /** 看上去在写文件（重定向、sed -i、tee…）：绕过 apply_patch 的编辑。 */
  writes: boolean;
  /** 沙箱拒绝或用户拒绝了提权。 */
  denied: boolean;
  exitCode?: number;
}

const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string'
          ? part
          : part !== null && typeof part === 'object' && typeof part.text === 'string'
            ? (part.text as string)
            : '',
      )
      .join('');
  }
  return value === undefined || value === null ? '' : JSON.stringify(value);
}

/** 命名空间摊平后的名字（`mcp__wevir__lsp_references`）取最后一段。 */
function baseName(name: string): string {
  const at = name.lastIndexOf('__');
  return at >= 0 ? name.slice(at + 2) : name;
}

/**
 * 补丁文本本身是一个 JSON 对象：模型把参数写成了别的形状（例如 Chat 上游回 `{"patch": …}` 而不是 `{"input": …}`）。网关把
 * 原文交给 Codex，下一个请求的历史里又被包回 `{"input": <原文>}`，所以只看历史里的参数形状看不出来，要看补丁内容。
 */
function looksLikeJsonArgs(input: string): boolean {
  const text = input.trim();
  if (!text.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function patchArgs(raw: string): { input: string; ok: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { input?: unknown }).input === 'string'
    ) {
      const input = (parsed as { input: string }).input;
      return { input, ok: !looksLikeJsonArgs(input) };
    }
  } catch {
    // 落到下面：网关会把原文交给 Codex。
  }
  return { input: raw, ok: false };
}

function jsonOk(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** 所有请求里的工具调用与输出，按第一次出现的顺序（每个请求都带完整历史，所以就是时间顺序）。 */
export function toolCalls(requests: readonly EvalRequest[]): ToolCallRecord[] {
  const calls = new Map<string, ToolCallRecord>();
  const outputs = new Map<string, string>();
  for (const request of requests) {
    const body = request.body;
    if (Array.isArray(body.input)) {
      for (const item of body.input as Array<Record<string, unknown>>) {
        const callId = String(item.call_id ?? '');
        if (item.type === 'custom_tool_call' && !calls.has(callId)) {
          calls.set(callId, {
            callId,
            name: String(item.name),
            ...(typeof item.namespace === 'string' && { namespace: item.namespace }),
            input: String(item.input ?? ''),
            argsOk: !looksLikeJsonArgs(String(item.input ?? '')),
            firstSeen: request.index,
          });
        } else if (item.type === 'function_call' && !calls.has(callId)) {
          const raw = String(item.arguments ?? '');
          const name = baseName(String(item.name));
          const patch = name === 'apply_patch' ? patchArgs(raw) : undefined;
          calls.set(callId, {
            callId,
            name,
            ...(typeof item.namespace === 'string' && { namespace: item.namespace }),
            input: patch?.input ?? raw,
            argsOk: patch?.ok ?? jsonOk(raw),
            firstSeen: request.index,
          });
        } else if (typeof item.type === 'string' && OUTPUT_TYPES.has(item.type)) {
          outputs.set(callId, textOf(item.output));
        }
      }
    }
    if (Array.isArray(body.messages)) {
      for (const message of body.messages as Array<Record<string, unknown>>) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls as Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>) {
            const callId = String(call.id ?? '');
            if (calls.has(callId)) continue;
            const raw = call.function?.arguments ?? '';
            const name = baseName(call.function?.name ?? '?');
            const patch = name === 'apply_patch' ? patchArgs(raw) : undefined;
            calls.set(callId, {
              callId,
              name,
              input: patch?.input ?? raw,
              argsOk: patch?.ok ?? jsonOk(raw),
              firstSeen: request.index,
            });
          }
        } else if (message.role === 'tool') {
          outputs.set(String(message.tool_call_id ?? ''), textOf(message.content));
        } else if (Array.isArray(message.content)) {
          // Anthropic Messages：assistant 的 tool_use、user 的 tool_result。
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_use') {
              const callId = String(block.id ?? '');
              if (calls.has(callId)) continue;
              const name = baseName(String(block.name ?? '?'));
              const input = block.input as { input?: unknown } | undefined;
              calls.set(callId, {
                callId,
                name,
                input:
                  name === 'apply_patch' && typeof input?.input === 'string'
                    ? input.input
                    : JSON.stringify(block.input ?? {}),
                argsOk: name !== 'apply_patch' || typeof input?.input === 'string',
                firstSeen: request.index,
              });
            } else if (block.type === 'tool_result') {
              outputs.set(String(block.tool_use_id ?? ''), textOf(block.content));
            }
          }
        }
      }
    }
  }
  return [...calls.values()].map((call) => {
    const output = outputs.get(call.callId);
    return output === undefined ? call : { ...call, output };
  });
}

/** 补丁头里的路径。 */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
    (match[1] ?? '').trim(),
  );
}

/** apply_patch 的输出 → 结果类别（见文件头的依据）。 */
export function editOutcome(output: string | undefined): { outcome: EditOutcome; detail?: string } {
  if (output === undefined) return { outcome: 'no-output' };
  const first = output.split('\n')[0] ?? '';
  if (/Success\. Updated the following files:/.test(output)) return { outcome: 'applied' };
  if (
    /apply_patch handler received (invalid patch input|non-apply_patch input|unsupported payload)/.test(
      output,
    )
  )
    return { outcome: 'tool-args', detail: first };
  if (/apply_patch verification failed: (invalid patch|invalid hunk)/.test(output))
    return { outcome: 'patch-format', detail: first };
  if (/apply_patch verification failed: Failed to find expected lines/.test(output))
    return { outcome: 'preimage-mismatch', detail: first };
  if (/apply_patch verification failed: Failed to read file to (update|delete)/.test(output))
    return { outcome: 'target-missing', detail: first };
  if (/rejected by user|Rejected\(|Operation not permitted|Permission denied/i.test(output))
    return { outcome: 'permission', detail: first };
  if (/apply_patch verification failed/.test(output))
    return { outcome: 'patch-format', detail: first };
  if (/Exit code: [1-9]/.test(output)) return { outcome: 'apply-error', detail: first };
  return { outcome: 'unknown', detail: first };
}

// 重定向不算 `2>&1`、`2>/dev/null` 与箭头函数（`node -e "… m => …"`）。
const SHELL_WRITE =
  /(^|[;&|]\s*|\s)(sed\s+(-[a-zA-Z]*i|--in-place)|perl\s+-[a-zA-Z]*i|tee\b|truncate\b|rm\s|mv\s|cp\s|git\s+(checkout|restore|stash|reset|clean|commit|add)\b)|(^|[^0-9<>&=-])>>?\s*(?!\/dev\/null)[^&\s|=]|\bcat\s*<<|writeFileSync|open\([^)]*['"]w/;

/** 命令看上去在写文件（绕过 apply_patch 的编辑）。 */
export function looksLikeShellWrite(command: string): boolean {
  return SHELL_WRITE.test(command);
}

/** exec_command 的参数里的命令。 */
function commandOf(input: string): string {
  try {
    const parsed = JSON.parse(input) as { cmd?: unknown; command?: unknown };
    const cmd = parsed.cmd ?? parsed.command;
    if (typeof cmd === 'string') return cmd;
    if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  } catch {
    // 落到下面。
  }
  return input;
}

export interface ClassifyInput {
  requests: readonly EvalRequest[];
  /** 这次运行里所有回合的 Host 事件（订阅收到的，按顺序）。 */
  events: readonly WevirEvent[];
  /** 工作区根目录：错误信息里的绝对路径换成相对路径。 */
  root: string;
}

export interface Classified {
  calls: number;
  /** 没收到输出的调用（回合被取消时最后那个调用除外，见 `cancelledCalls`）。 */
  unmatchedCalls: string[];
  cancelledCalls: string[];
  /** 参数没按约定到达的调用（Chat 参数不是 JSON、apply_patch 没有 `input`、Codex 回“invalid patch input”）。 */
  toolArgErrors: Array<{ callId: string; name: string; detail: string }>;
  edits: EditAttempt[];
  shell: ShellCall[];
  /** 审批：请求数、被拒数。 */
  approvals: { requested: number; denied: number };
  /** 上游 HTTP 错误、网络错误与 engine.error。 */
  gatewayFailures: Array<{ kind: 'http' | 'network' | 'upstream' | 'engine'; detail: string }>;
  toolNames: string[];
}

/** 从请求体与事件分类。 */
export function classify({ requests, events, root }: ClassifyInput): Classified {
  const rel = (text: string) => text.split(`${root}/`).join('').split(root).join('.');
  const calls = toolCalls(requests);
  const denied = new Set<string>();
  const approvalByCall = new Map<string, string>();
  let approvalsRequested = 0;
  for (const event of events) {
    if (event.type === 'approval.requested') {
      approvalsRequested += 1;
      const { approval } = event.payload;
      if (approval.toolCallId !== undefined) approvalByCall.set(approval.id, approval.toolCallId);
    } else if (event.type === 'approval.resolved' && event.payload.status === 'denied') {
      const callId = approvalByCall.get(event.payload.approvalId);
      denied.add(callId ?? event.payload.approvalId);
    }
  }
  const failedTools = new Set(
    events.flatMap((event) =>
      event.type === 'tool.finished' && event.payload.status === 'failed'
        ? [event.payload.toolCallId]
        : [],
    ),
  );
  const cancelledTurns = new Set(
    events.flatMap((event) =>
      event.type === 'turn.finished' && event.payload.outcome !== 'completed'
        ? [event.payload.turnId]
        : [],
    ),
  );
  const startedInCancelled = new Set(
    events.flatMap((event) =>
      event.type === 'tool.started' && cancelledTurns.has(event.payload.turnId)
        ? [event.payload.toolCallId]
        : [],
    ),
  );
  const edits: EditAttempt[] = [];
  const shell: ShellCall[] = [];
  const toolArgErrors: Classified['toolArgErrors'] = [];
  const unmatchedCalls: string[] = [];
  const cancelledCalls: string[] = [];
  const lastRequest = Math.max(-1, ...requests.map((request) => request.index));
  for (const [order, call] of calls.entries()) {
    if (call.output === undefined) {
      // 回合被取消、或者最后一个请求里刚发出（还没有下一个请求）的调用不算往返失败。
      if (
        startedInCancelled.has(call.callId) ||
        denied.has(call.callId) ||
        call.firstSeen === lastRequest
      )
        cancelledCalls.push(call.callId);
      else unmatchedCalls.push(call.callId);
    }
    if (!call.argsOk) {
      toolArgErrors.push({
        callId: call.callId,
        name: call.name,
        detail:
          call.name === 'apply_patch'
            ? 'arguments are not a JSON object with a string `input`'
            : 'arguments are not valid JSON',
      });
    }
    if (call.name === 'apply_patch') {
      let { outcome, detail } = editOutcome(call.output);
      if (call.output === undefined && (denied.has(call.callId) || failedTools.has(call.callId)))
        outcome = denied.has(call.callId) ? 'permission' : 'apply-error';
      // 参数没按约定到达时，Codex 报的“补丁格式错误”其实是往返的问题。
      if (!call.argsOk && outcome !== 'applied') outcome = 'tool-args';
      if (outcome === 'tool-args' && call.argsOk)
        toolArgErrors.push({ callId: call.callId, name: call.name, detail: detail ?? '' });
      const files =
        outcome === 'applied'
          ? [...(call.output ?? '').matchAll(/^[AMD] (.+)$/gm)].map((match) =>
              rel((match[1] ?? '').trim()),
            )
          : patchFiles(call.input).map(rel);
      edits.push({
        callId: call.callId,
        order,
        outcome,
        files,
        ...(detail !== undefined && outcome !== 'applied' && { detail: rel(detail) }),
      });
    } else if (
      call.name === 'exec_command' ||
      call.name === 'shell' ||
      call.name === 'local_shell'
    ) {
      const command = commandOf(call.input);
      const exit = /Process exited with code (\d+)|Exit code: (\d+)/.exec(call.output ?? '');
      shell.push({
        callId: call.callId,
        order,
        command,
        writes: looksLikeShellWrite(command),
        denied:
          denied.has(call.callId) ||
          /rejected by user|Operation not permitted|Permission denied/i.test(call.output ?? ''),
        ...(exit !== null && { exitCode: Number(exit[1] ?? exit[2]) }),
      });
    }
  }
  // 模型再也没看到输出的编辑（审批被拒后回合停了、回合被取消）不在任何请求体里，只有 Host 的 fileChange 事件。
  const seen = new Set(calls.map((call) => call.callId));
  const finished = new Map(
    events.flatMap((event) =>
      event.type === 'tool.finished'
        ? [[event.payload.toolCallId, event.payload.status] as const]
        : [],
    ),
  );
  for (const event of events) {
    if (event.type !== 'tool.started' || event.payload.toolName !== 'fileChange') continue;
    const callId = event.payload.toolCallId;
    if (seen.has(callId)) continue;
    seen.add(callId);
    const status = finished.get(callId);
    edits.push({
      callId,
      order: calls.length + edits.length,
      outcome: denied.has(callId)
        ? 'permission'
        : status === 'completed'
          ? 'applied'
          : status === 'failed'
            ? 'apply-error'
            : 'no-output',
      files: (event.payload.display.paths ?? []).map(rel),
      detail: 'seen only in Host events (the model never got the output)',
    });
    if (!denied.has(callId) && status === undefined) cancelledCalls.push(callId);
  }
  // 失败之后同一文件（路径不明时任何文件）还有成功的编辑：算重试后恢复。
  edits.forEach((edit, index) => {
    if (edit.outcome === 'applied') return;
    const later = edits.slice(index + 1).filter((next) => next.outcome === 'applied');
    edit.recovered =
      edit.files.length === 0
        ? later.length > 0
        : edit.files.some((file) => later.some((next) => next.files.includes(file)));
  });
  const gatewayFailures: Classified['gatewayFailures'] = [];
  for (const request of requests) {
    if (request.networkError !== undefined)
      gatewayFailures.push({
        kind: 'network',
        detail: `request ${request.index}: ${request.networkError}`,
      });
    else if (request.status !== undefined && request.status >= 400)
      gatewayFailures.push({
        kind: 'http',
        detail: `request ${request.index}: HTTP ${request.status}`,
      });
    // HTTP 200 的流里上游报失败（Responses 的 `response.failed`）：Codex 会重试，但这一个请求是上游故障。
    else if (request.terminal === 'response.failed')
      gatewayFailures.push({
        kind: 'upstream',
        detail: `request ${request.index}: response.failed in the stream`,
      });
  }
  for (const event of events) {
    if (event.type === 'engine.error')
      gatewayFailures.push({
        kind: 'engine',
        detail: `${event.payload.category}: ${event.payload.message.slice(0, 200)}`,
      });
  }
  return {
    calls: calls.length,
    unmatchedCalls,
    cancelledCalls,
    toolArgErrors,
    edits,
    shell,
    approvals: { requested: approvalsRequested, denied: denied.size },
    gatewayFailures,
    toolNames: calls.map((call) => call.name),
  };
}

/** 最终回答在说“做完了 / 通过了”。 */
export function claimsSuccess(text: string): boolean {
  return /(测试|检查|tests?)[^。\n]{0,24}(全部|都|已经|均)?(通过|成功|passed|pass(es)?\b|green)|全部通过|✅|all (\d+ )?tests? pass/i.test(
    text,
  );
}

/** 最终回答承认有没做成或失败的部分。 */
export function admitsFailure(text: string): boolean {
  return /失败|未通过|没通过|不通过|没能|未能|无法|不能|拒绝|没有权限|fail|error|denied|not permitted|could not|unable/i.test(
    text,
  );
}
