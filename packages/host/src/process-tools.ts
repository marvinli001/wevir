// 后台进程的应用级工具（domain-model §3.15）：`wevir_process_*` 交给 processes.ts 的 ProcessManager。起进程与写 stdin、发信号
// 不是只读的，按会话的权限模式走引擎的审批（同 browser_* 的写操作）；列出、读输出、等待标 `readOnlyHint`。

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionId, TurnId } from '@wevir/protocol';
import { type AppTool, AppToolError, type AppToolResult } from './app-mcp.js';
import {
  objectSchema,
  optionalEnum,
  optionalInt,
  optionalString,
  requiredString,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
} from './app-tools.js';
import {
  PROCESS_NOTIFY_BATCH_MS,
  PROCESS_NOTIFY_DEFAULT_LIMIT,
  PROCESS_NOTIFY_INTERVAL_MS,
  PROCESS_NOTIFY_MAX_LIMIT,
  PROCESS_SIGNALS,
  PROCESS_TAIL_LINES,
  type ProcessInfo,
  type ProcessManager,
  type ProcessNotice,
  type ProcessSignal,
  stripAnsi,
} from './processes.js';
import { formatBytes } from './tool-output.js';

/** 起进程后等多久再回结果（看它是不是立刻失败）。 */
export const PROCESS_START_SETTLE_MS = 1500;
/** `lines` 的默认与上限、`grep` 最多列几行。 */
export const PROCESS_OUTPUT_DEFAULT_LINES = 50;
export const PROCESS_OUTPUT_MAX_LINES = 1000;
export const PROCESS_GREP_MAX = 200;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RUN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
/** 停 agent 自己起的进程：不用批准（2026-10-22，维护者定；用户起的预览与检查进程拒绝）。不标 `readOnlyHint`。 */
const STOP_OWN = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export interface ProcessToolsOptions {
  processes: ProcessManager;
  /** 调工具的会话的目录（会话不在了时抛 AppToolError）。 */
  cwdOf: (sessionId: SessionId) => string;
  /** 会话此刻进行中的回合（记进进程的来源，客户端的“进程输出”显示）。 */
  turnOf?: (sessionId: SessionId) => TurnId | undefined;
}

const text = (value: string): AppToolResult => ({ content: [{ type: 'text', text: value }] });

export function processTools({ processes, cwdOf, turnOf }: ProcessToolsOptions): AppTool[] {
  return [
    {
      name: 'wevir_process_start',
      title: 'Start a background process',
      description:
        'Start a long-running command in the background, managed by Wevir instead of your shell: dev servers, ' +
        'watchers, long builds or test runs. It keeps running after this tool call and after your turn ends, until ' +
        'it exits, you stop it with wevir_process_kill, or the session is deleted or Wevir quits. Runs in your login ' +
        "shell (no terminal), in this session's folder or a folder inside it. stdout and stderr go to a log file " +
        '(path in the result) that you can read with wevir_process_output or rg / tail. When it exits on its own ' +
        'Wevir tells you with a message (notifyOnExit, default true), so you can end your turn instead of polling ' +
        '(this also covers CI: run a command that waits for the result, such as gh pr checks <number> --watch). ' +
        'notifyOn messages you whenever output lines match a regular expression (for example "error|FAIL|ready", or ' +
        '"." for every line), which starts a turn if you are idle: use it to watch CI, logs or long tests without ' +
        `polling. Matches are batched (lines within ${PROCESS_NOTIFY_BATCH_MS / 1000} s of each other go in one message, ` +
        `messages are at least ${PROCESS_NOTIFY_INTERVAL_MS / 1000} s apart) and notifyLimit caps how many messages it ` +
        `sends (default ${PROCESS_NOTIFY_DEFAULT_LIMIT}, at most ${PROCESS_NOTIFY_MAX_LIMIT}); keep the pattern specific. ` +
        'waitFor waits in this call until a line matches (for example "Local:.*http" for a dev server), the process ' +
        'exits, or timeoutMs passes. Patterns are JavaScript regular expressions, optionally written as /pattern/i.',
      inputSchema: objectSchema(
        {
          command: { type: 'string' },
          cwd: { type: 'string', description: "Folder to run in, inside this session's folder." },
          name: { type: 'string', description: 'Short label, for example "dev server".' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          notifyOnExit: { type: 'boolean' },
          notifyOn: { type: 'string' },
          notifyLimit: { type: 'integer', minimum: 1, maximum: PROCESS_NOTIFY_MAX_LIMIT },
          waitFor: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 0, maximum: WAIT_MAX_MS },
        },
        ['command'],
      ),
      annotations: RUN,
      async call(args, call) {
        const command = requiredString(args, 'command');
        const cwd = await processCwd(cwdOf(call.sessionId), optionalString(args, 'cwd'));
        const notifyOn = pattern(args, 'notifyOn');
        const notifyLimit =
          optionalInt(args, 'notifyLimit', 1, PROCESS_NOTIFY_MAX_LIMIT) ??
          PROCESS_NOTIFY_DEFAULT_LIMIT;
        const waitFor = pattern(args, 'waitFor');
        const timeoutMs = optionalInt(args, 'timeoutMs', 0, WAIT_MAX_MS) ?? WAIT_DEFAULT_MS;
        const name = optionalString(args, 'name');
        const env = envArg(args);
        const notifyOnExit = args.notifyOnExit !== false;
        const turnId = turnOf?.(call.sessionId);
        const started = await processes.start(call.sessionId, {
          command,
          cwd,
          ...(name !== undefined && { name }),
          ...(env !== undefined && { env }),
          notifyOnExit,
          ...(notifyOn !== undefined && { notifyPattern: notifyOn, notifyLimit }),
          ...(turnId !== undefined && { turnId }),
        });
        const lines = [`Started ${describe(started)}.`, `log: ${started.logPath}`];
        if (started.status === 'exited') {
          return { ...text(statusText(processes, call.sessionId, started.id)), isError: true };
        }
        const waited = await processes.wait(
          call.sessionId,
          started.id,
          waitFor,
          waitFor === undefined ? PROCESS_START_SETTLE_MS : timeoutMs,
          call.signal,
        );
        if (waitFor !== undefined) lines.push(waitText(waited.reason, waited.line, waitFor));
        lines.push(statusText(processes, call.sessionId, started.id, false));
        const info = processes.info(call.sessionId, started.id);
        if (info.status === 'running') {
          lines.push(
            notifyOnExit
              ? 'Wevir will message you when it exits.'
              : 'It will not message you when it exits (notifyOnExit is false).',
          );
          if (notifyOn !== undefined) {
            lines.push(
              `Wevir will message you when lines match ${String(notifyOn)} (at most ${notifyLimit} ${notifyLimit === 1 ? 'message' : 'messages'}).`,
            );
          }
        }
        return text(lines.join('\n'));
      },
    },
    {
      name: 'wevir_process_list',
      title: 'List background processes',
      description:
        "List this session's background processes started with wevir_process_start: id, status, exit code, " +
        'command, how long it ran, output size and log file.',
      inputSchema: objectSchema({}),
      annotations: READ,
      async call(_args, call) {
        const list = processes.list(call.sessionId);
        if (list.length === 0) {
          return text(
            'This session has no background processes. Start one with wevir_process_start.',
          );
        }
        return text(
          list
            .map((info) => `- ${describe(info)} · ${status(info)} · log ${info.logPath}`)
            .join('\n'),
        );
      },
    },
    {
      name: 'wevir_process_output',
      title: 'Read background process output',
      description:
        'Read the output (stdout and stderr together, terminal colours removed) of a background process. By ' +
        'default the last 50 lines; lines sets how many. since returns only what was written after an earlier ' +
        'call (pass the next value it returned). grep lists the matching lines of the current log with line ' +
        'numbers. For anything else read the log file directly with rg, sed or tail.',
      inputSchema: objectSchema(
        {
          id: { type: 'string' },
          lines: { type: 'integer', minimum: 1, maximum: PROCESS_OUTPUT_MAX_LINES },
          since: { type: 'integer', minimum: 0 },
          grep: { type: 'string' },
        },
        ['id'],
      ),
      annotations: READ,
      async call(args, call) {
        const id = requiredString(args, 'id');
        const info = processes.info(call.sessionId, id);
        const header = `${describe(info)} · ${status(info)} · ${formatBytes(info.bytes)} written · log ${info.logPath}`;
        const grep = pattern(args, 'grep');
        if (grep !== undefined) {
          const content = await readFile(info.logPath, 'utf8').catch(() => '');
          const matches: string[] = [];
          let total = 0;
          content.split(/\r?\n/).forEach((raw, index) => {
            const line = stripAnsi(raw.slice(raw.lastIndexOf('\r') + 1));
            grep.lastIndex = 0;
            if (!grep.test(line)) return;
            total += 1;
            if (matches.length < PROCESS_GREP_MAX) matches.push(`${index + 1}: ${line}`);
          });
          const more =
            total > matches.length
              ? `\n(${total - matches.length} more matches; use rg on the log)`
              : '';
          return text(
            `${header}\n${total} matching lines${total > 0 ? ':' : '.'}\n${matches.join('\n')}${more}`,
          );
        }
        const since = optionalInt(args, 'since', 0, Number.MAX_SAFE_INTEGER);
        if (since !== undefined) {
          const read = await processes.read(call.sessionId, id, since);
          const notes = [
            read.dropped > 0
              ? `(${formatBytes(read.dropped)} before this were rotated to ${info.logPath}.1)`
              : '',
            read.more ? `(more output follows; call again with since=${read.next})` : '',
          ].filter((note) => note !== '');
          return text(
            [
              header,
              `next: ${read.next}`,
              ...notes,
              read.text === '' ? '(no new output)' : read.text,
            ].join('\n'),
          );
        }
        const count =
          optionalInt(args, 'lines', 1, PROCESS_OUTPUT_MAX_LINES) ?? PROCESS_OUTPUT_DEFAULT_LINES;
        const read = await processes.read(call.sessionId, id, Math.max(0, info.bytes - 256 * 1024));
        const lines = read.text.replace(/\n$/, '').split(/\r?\n/);
        const shown = read.text === '' ? [] : lines.slice(-count);
        return text(
          [
            header,
            `next: ${read.next}`,
            shown.length === 0 ? '(no output yet)' : shown.join('\n'),
          ].join('\n'),
        );
      },
    },
    {
      name: 'wevir_process_wait',
      title: 'Wait for a background process',
      description:
        'Wait until a background process exits or, with until, prints a line matching a regular expression ' +
        `(output from before this call does not count). Times out after timeoutMs (default ${WAIT_DEFAULT_MS / 1000} s, ` +
        `at most ${WAIT_MAX_MS / 60_000} min) without stopping the process. What you waited for is not also sent as a message.`,
      inputSchema: objectSchema(
        {
          id: { type: 'string' },
          until: { type: 'string' },
          timeoutMs: { type: 'integer', minimum: 0, maximum: WAIT_MAX_MS },
        },
        ['id'],
      ),
      annotations: READ,
      async call(args, call) {
        const id = requiredString(args, 'id');
        const until = pattern(args, 'until');
        const timeoutMs = optionalInt(args, 'timeoutMs', 0, WAIT_MAX_MS) ?? WAIT_DEFAULT_MS;
        const result = await processes.wait(call.sessionId, id, until, timeoutMs, call.signal);
        return text(
          [
            waitText(result.reason, result.line, until),
            statusText(processes, call.sessionId, id),
          ].join('\n'),
        );
      },
    },
    {
      name: 'wevir_process_write',
      title: 'Write to a background process',
      description:
        'Write text to the stdin of a running background process (include "\\n" to press Enter). eof=true closes ' +
        'stdin afterwards. There is no terminal, so programs that need one (full-screen UIs, password prompts) will ' +
        'not work.',
      inputSchema: objectSchema(
        { id: { type: 'string' }, input: { type: 'string' }, eof: { type: 'boolean' } },
        ['id'],
      ),
      annotations: { ...RUN, destructiveHint: false, openWorldHint: false },
      async call(args, call) {
        const id = requiredString(args, 'id');
        const input = typeof args.input === 'string' ? args.input : '';
        processes.write(call.sessionId, id, input, args.eof === true);
        return text(
          `Wrote ${Buffer.byteLength(input)} bytes to ${id}${args.eof === true ? ' and closed its stdin' : ''}.`,
        );
      },
    },
    {
      name: 'wevir_process_kill',
      title: 'Stop a background process',
      description:
        'Send a signal to a background process and everything it started (its process group). Default SIGTERM; ' +
        'SIGINT is like Ctrl-C, SIGKILL cannot be ignored, SIGHUP / SIGUSR1 / SIGUSR2 ask some servers to reload. ' +
        'Waits up to 5 s for it to exit and reports the result. A process you stop does not send an exit message. ' +
        'Only processes you started: dev servers the user started and checks Wevir runs are left to the user.',
      inputSchema: objectSchema(
        {
          id: { type: 'string' },
          signal: { type: 'string', enum: [...PROCESS_SIGNALS] },
        },
        ['id'],
      ),
      annotations: STOP_OWN,
      async call(args, call) {
        const id = requiredString(args, 'id');
        const signal: ProcessSignal = optionalEnum(args, 'signal', PROCESS_SIGNALS) ?? 'SIGTERM';
        const owner = startedByOther(processes.info(call.sessionId, id));
        if (owner !== undefined) {
          throw new AppToolError(
            `${id} was started by ${owner}, not by you; only the user can stop it (the process list in Wevir).`,
          );
        }
        processes.signal(call.sessionId, id, signal);
        const stops = signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGKILL';
        if (stops) await processes.wait(call.sessionId, id, undefined, 5000, call.signal);
        const info = processes.info(call.sessionId, id);
        const line =
          info.status === 'running'
            ? stops
              ? `Sent ${signal}; ${id} is still running after 5 s. Send SIGKILL to force it.`
              : `Sent ${signal} to ${id}; it is still running.`
            : `Sent ${signal}; ${id} ${status(info)}.`;
        return text(line);
      },
    },
  ];
}

/** 起进程的目录：会话目录或它里面的已有目录。 */
async function processCwd(sessionCwd: string, path: string | undefined): Promise<string> {
  if (path === undefined) return sessionCwd;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(sessionCwd, path);
  const rel = relative(sessionCwd, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new AppToolError(`${path} is not inside this session's folder (${sessionCwd}).`);
  }
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) throw new AppToolError(`${path} is not a folder.`);
  return absolute;
}

/** 正则参数：`pattern` 或 `/pattern/flags`。 */
export function pattern(args: Record<string, unknown>, key: string): RegExp | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  const literal = /^\/(.+)\/([imsu]*)$/s.exec(value);
  try {
    return literal ? new RegExp(literal[1] as string, literal[2]) : new RegExp(value);
  } catch (error) {
    throw new AppToolError(
      `${key} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function envArg(args: Record<string, unknown>): Record<string, string> | undefined {
  const value = args.env;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppToolError('env must be an object of string values.');
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string') {
      throw new AppToolError(`env.${key} must be a string and its name a valid variable name.`);
    }
    if (key.toUpperCase().startsWith('WEVIR_')) {
      throw new AppToolError('env names starting with WEVIR_ are reserved.');
    }
    env[key] = item;
  }
  return env;
}

export function describe(info: ProcessInfo): string {
  const pid = info.pid === undefined ? '' : `, pid ${info.pid}`;
  const label = info.name === info.command.slice(0, 60) ? '' : ` "${info.name}"`;
  return `${info.id}${label} (\`${info.command}\` in ${info.cwd}${pid})`;
}

export function status(info: ProcessInfo, now = Date.now()): string {
  const ran = duration((info.endedAt ?? now) - info.startedAt);
  if (info.error !== undefined) return `failed to start: ${info.error}`;
  if (info.status === 'running') return `running for ${ran}`;
  const by = info.stoppedBy === 'user' ? ' (the user stopped it in Wevir)' : '';
  const how =
    info.signal !== null
      ? `was stopped by ${info.signal}${by}`
      : `exited with code ${info.exitCode}${by}`;
  return `${how} after ${ran}`;
}

function statusText(
  processes: ProcessManager,
  sessionId: SessionId,
  id: string,
  withName = true,
): string {
  const info = processes.info(sessionId, id);
  const tail = processes.tail(sessionId, id, PROCESS_TAIL_LINES);
  return [
    withName ? `${describe(info)} ${status(info)}.` : `It is ${status(info)}.`,
    tail === '' ? '(no output yet)' : `Last lines:\n${tail}`,
  ].join('\n');
}

function waitText(reason: string, line: string | undefined, until: RegExp | undefined): string {
  switch (reason) {
    case 'match':
      return `Matched ${String(until)}: ${line ?? ''}`;
    case 'exit':
      return until === undefined
        ? 'It exited.'
        : `It exited before printing a line matching ${String(until)}.`;
    case 'aborted':
      return 'Stopped waiting (the call was cancelled).';
    default:
      return until === undefined
        ? 'Timed out waiting for it to exit; it is still running.'
        : `Timed out waiting for a line matching ${String(until)}; it is still running.`;
  }
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 通知给模型的文本（app-tools.ts 发回会话）。 */
export function noticeText(notice: ProcessNotice): string {
  const { process: info, matches } = notice;
  const parts =
    notice.event === 'exit'
      ? [`[Wevir] Background process ${describe(info)} ${status(info)}.`]
      : [];
  if (matches !== undefined) {
    const lines = `${matches.count} ${matches.count === 1 ? 'line' : 'lines'}`;
    parts.push(
      notice.event === 'exit'
        ? `Before that, ${lines} matched your notifyOn pattern ${String(matches.pattern)}:`
        : `[Wevir] Background process ${describe(info)} printed ${lines} matching your notifyOn pattern ${String(matches.pattern)}:`,
      matches.lines.join('\n'),
    );
    const more = matches.count - matches.lines.length;
    if (more > 0) parts.push(`(${more} more matching lines not shown; see the log)`);
    if (notice.event === 'match') {
      parts.push(`It is ${status(info)}.`);
      if (matches.remaining === 0) {
        parts.push(
          'That was the last notifyOn message for this process (notifyLimit reached); later matches are not sent. ' +
            'Use wevir_process_wait or wevir_process_output, or start the command again with a higher notifyLimit.',
        );
      }
    }
  }
  return [
    ...parts,
    notice.tail === '' ? '(no output)' : `Last lines:\n${notice.tail}`,
    `Full log: ${info.logPath}`,
  ].join('\n');
}

/** 不是 agent 起的进程是谁起的：用户起的预览、回合后验证的检查；agent 自己起的为 `undefined`。 */
function startedByOther(info: ProcessInfo): string | undefined {
  if (info.check !== undefined) return 'a Wevir check';
  if (info.preview?.startedBy === 'user') return 'the user';
  return undefined;
}
