// 开发服务器预览的应用级工具（0.84.0，ADR-0013 决策 8）：`wevir_preview_list` 只读，`wevir_preview_start` 按名字启动（带 `command`
// 时先保存这项配置），就绪后经浏览器提供方在这个会话的浏览器窗格里打开。启动会执行命令，按会话的权限模式走引擎的审批（同
// `wevir_process_start`）；停止与读日志用已有的 `wevir_process_*`。

import type { PreviewConfig, SessionId, TurnId } from '@wevir/protocol';
import { PreviewInputSchema } from '@wevir/protocol';
import { type AppTool, AppToolError, type AppToolResult } from './app-mcp.js';
import {
  objectSchema,
  optionalInt,
  optionalString,
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
} from './app-tools.js';
import type { BrowserBroker } from './browser-broker.js';
import { HostError } from './errors.js';
import type { PreviewService } from './preview/service.js';
import { PROCESS_TAIL_LINES, type ProcessInfo, type ProcessManager } from './processes.js';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RUN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export interface PreviewToolsOptions {
  previews: PreviewService;
  processes: ProcessManager;
  /** 内置浏览器：有它时就绪后打开。 */
  browser?: BrowserBroker;
  /** 会话此刻进行中的回合。 */
  turnOf?: (sessionId: SessionId) => TurnId | undefined;
}

const text = (value: string): AppToolResult => ({ content: [{ type: 'text', text: value }] });

/** Host 的错误换成给模型看的（会话不在了、配置没有）。 */
async function asTool<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof HostError) throw new AppToolError(error.message);
    throw error;
  }
}

function describeConfig(config: Pick<PreviewConfig, 'command' | 'cwd' | 'port' | 'url'>): string {
  const parts = [`\`${config.command}\``];
  if (config.cwd !== '') parts.push(`cwd ${config.cwd}`);
  if (config.port !== undefined) parts.push(`port ${config.port}`);
  if (config.url !== undefined) parts.push(`url ${config.url}`);
  return parts.join(', ');
}

function describePreview(info: ProcessInfo, sessionId: SessionId): string {
  const preview = info.preview;
  const state =
    info.status !== 'running'
      ? `exited${info.exitCode !== null ? ` with code ${info.exitCode}` : info.signal !== null ? ` (${info.signal})` : ''}`
      : preview?.ready === true
        ? `ready at ${preview.url ?? '(no URL)'}`
        : `starting${preview?.url !== undefined ? ` (${preview.url})` : ''}`;
  const owner = info.sessionId === sessionId ? `process ${info.id}` : 'started by another session';
  return `${state}; ${owner}`;
}

export function previewTools({
  previews,
  processes,
  browser,
  turnOf,
}: PreviewToolsOptions): AppTool[] {
  return [
    {
      name: 'wevir_preview_list',
      title: 'List run configurations',
      description:
        "Read-only: this project's run configurations (dev servers the user or you saved in Wevir, with command, " +
        "folder, port and URL), which ones are running for this session's folder, and candidates found in package.json " +
        'scripts and .claude/launch.json that are not saved yet. Start one with wevir_preview_start.',
      inputSchema: objectSchema({}, []),
      annotations: READ,
      async call(_args, call) {
        const list = await asTool(() => previews.list(call.sessionId));
        const running = previews.previews(list.root).filter((info) => info.status === 'running');
        const lines: string[] = [];
        if (list.configs.length === 0) lines.push('No run configurations saved for this project.');
        else {
          lines.push('Run configurations (saved in Wevir for this project):');
          for (const config of list.configs) {
            const live = running.find((info) => info.preview?.name === config.name);
            lines.push(
              `- ${config.name}: ${describeConfig(config)}${live === undefined ? '' : ` — ${describePreview(live, call.sessionId)}`}`,
            );
          }
        }
        if (list.candidates.length > 0) {
          lines.push(
            '',
            'Candidates (not saved; pass the command, cwd and port to wevir_preview_start to save and start one):',
          );
          for (const candidate of list.candidates) {
            lines.push(
              `- ${candidate.name}: ${describeConfig(candidate)} (from ${candidate.file})`,
            );
          }
        }
        return text(lines.join('\n'));
      },
    },
    {
      name: 'wevir_preview_start',
      title: 'Start a dev server preview',
      description:
        "Start one of this project's run configurations (a dev server) in the background and open it in the Wevir " +
        'browser pane next to this conversation when it is ready, so the user can see the app. Pass name to start a ' +
        'saved configuration. Pass command (with name, cwd relative to your folder, and port or url when known) to ' +
        'save or update that configuration first, so the user can start it with one click later. Wevir waits until ' +
        'the port accepts connections (or, without a port, until the output prints a local URL), up to timeoutMs. ' +
        'If the same configuration is already running for this folder it is reused instead of starting a second ' +
        'copy. It is not started when the project environment is not ready (missing dependencies) or the port is ' +
        'taken by another process. Read its output with wevir_process_output and stop it with wevir_process_kill ' +
        '(process id in the result).',
      inputSchema: objectSchema(
        {
          name: { type: 'string', description: 'Configuration name, for example "web".' },
          command: { type: 'string', description: 'Shell command that starts the server.' },
          cwd: {
            type: 'string',
            description: "Folder to run in, relative to this session's folder.",
          },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          url: {
            type: 'string',
            description: 'URL to open, when it is not http://localhost:<port>.',
          },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          open: {
            type: 'boolean',
            description: 'Open it in the browser pane when ready (default true).',
          },
          timeoutMs: { type: 'integer', minimum: 0, maximum: WAIT_MAX_MS },
        },
        [],
      ),
      annotations: RUN,
      async call(args, call) {
        const sessionId = call.sessionId;
        const command = optionalString(args, 'command');
        let name = optionalString(args, 'name')?.trim();
        const timeoutMs = optionalInt(args, 'timeoutMs', 0, WAIT_MAX_MS) ?? WAIT_DEFAULT_MS;
        const lines: string[] = [];
        const list = await asTool(() => previews.list(sessionId));
        const record = list.root;
        if (command !== undefined) {
          const parsed = PreviewInputSchema.safeParse({
            name: name ?? 'dev',
            command,
            ...(args.cwd !== undefined && { cwd: args.cwd }),
            ...(args.port !== undefined && { port: args.port }),
            ...(args.url !== undefined && { url: args.url }),
            ...(args.env !== undefined && { env: args.env }),
          });
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new AppToolError(
              `Invalid ${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'not valid'}.`,
            );
          }
          name = parsed.data.name.trim();
          const workspaceId = previews.workspaceOf(sessionId);
          await asTool(() => previews.save(workspaceId, parsed.data, { addedBy: 'agent' }));
          lines.push(`Saved run configuration "${name}".`);
        } else if (name === undefined) {
          if (list.configs.length !== 1) {
            throw new AppToolError(
              list.configs.length === 0
                ? 'No run configurations are saved for this project. Pass command (and name, cwd, port) to save and start one; wevir_preview_list shows candidates.'
                : `Pass name: ${list.configs.map((config) => config.name).join(', ')}.`,
            );
          }
          name = list.configs[0]?.name as string;
        }
        const turnId = turnOf?.(sessionId);
        const started = await asTool(() =>
          previews.start({
            sessionId,
            name: name as string,
            startedBy: 'agent',
            ...(turnId !== undefined && { turnId }),
          }),
        );
        if (started.status === 'blocked') {
          const items = started.readiness
            .map(
              (item) =>
                `${item.name}${item.path !== '' ? ` (${item.path})` : ''}: ${item.reason ?? item.status}`,
            )
            .join('; ');
          throw new AppToolError(
            `Not started: the project environment is not ready — ${items}. Install what is missing (the user can ` +
              'use the Dependencies card in Wevir; wevir_workspace_readiness shows the plan), then call again.',
          );
        }
        if (started.status === 'port_in_use') {
          throw new AppToolError(
            `Not started: port ${started.port} is already in use by another process that Wevir did not start. If it ` +
              `is this project's dev server, open ${started.url} with wevir_show; otherwise stop it or use another port.`,
          );
        }
        const info =
          started.process.sessionId === sessionId
            ? await previews.waitReady(sessionId, started.process.id, timeoutMs, call.signal)
            : (processes.find(started.process.id) ?? started.process);
        lines.push(
          `${started.status === 'reused' ? 'Already running' : 'Started'} "${name}": ${describePreview(info, sessionId)}.`,
        );
        if (info.sessionId === sessionId) lines.push(`log: ${info.logPath}`);
        const url = info.preview?.url;
        if (info.status !== 'running') {
          lines.push(
            'Last output:',
            processes.tail(info.sessionId, info.id, PROCESS_TAIL_LINES) || '(no output)',
          );
          return { ...text(lines.join('\n')), isError: true };
        }
        if (info.preview?.ready !== true) {
          lines.push(
            `Not ready after ${Math.round(timeoutMs / 1000)} s; it keeps running. Check the output with wevir_process_output, or call wevir_preview_start again to wait longer.`,
          );
          if (info.sessionId === sessionId) {
            const tail = processes.tail(sessionId, info.id, 10);
            if (tail !== '') lines.push('Last output:', tail);
          }
        } else if (url !== undefined && args.open !== false && browser !== undefined) {
          const shown = await browser.execute({
            sessionId,
            cwd: record,
            command: { command: 'show', args: { url } },
            signal: call.signal,
          });
          lines.push(
            shown.ok
              ? shown.result.command === 'show' && shown.result.shown
                ? 'Opened it in the browser pane.'
                : 'Opened it in a browser tab (the user is not viewing this session right now).'
              : `Could not open it in the browser: ${shown.error.message}`,
          );
        }
        return text(lines.join('\n'));
      },
    },
  ];
}
