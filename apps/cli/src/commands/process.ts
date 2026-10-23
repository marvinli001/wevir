import type { WevirClient } from '@wevir/client-sdk';
import {
  type HostProcess,
  type MethodParams,
  type ProcessId,
  type ProcessStopSignal,
  ProcessStopSignalSchema,
  type UsageAggregate,
} from '@wevir/protocol';
import { type Context, findWorkspace, requireFeature, withClient } from '../context.js';
import { EXIT, UsageError } from '../errors.js';
import { formatDuration, formatTime, table, truncate } from '../format.js';
import { intlLocale, joinList, t } from '../i18n/index.js';
import { resolveSessionId } from './session.js';

// `wevir process`（0.83.0，Host 功能 `process_output`）：Agent 在后台起的命令、检查与开发服务器，看输出、停下。
// `wevir usage`（0.62.0，Host 功能 `usage_stats`）：模型请求的 token 与估算成本。

function withProcesses<T>(ctx: Context, fn: (client: WevirClient) => Promise<T>): Promise<T> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'process_output');
    return fn(client);
  });
}

function statusText(process: HostProcess): string {
  if (process.status === 'running') return t('process.running');
  if (process.error !== undefined) return t('process.failed');
  if (process.signal !== null) return t('process.signalled', { signal: process.signal });
  return t('process.exited', { code: process.exitCode ?? '-' });
}

/** `wevir process list [-w <路径> | --session <ID>] [--json]`。 */
export async function processList(
  ctx: Context,
  options: { workspace?: string; session?: string; json?: boolean },
): Promise<number> {
  return withProcesses(ctx, async (client) => {
    let filter: MethodParams<'process.list'> = {};
    if (options.workspace !== undefined) {
      const { workspaces } = await client.request('workspace.list');
      filter = { workspaceId: (await findWorkspace(ctx, workspaces, options.workspace)).id };
    }
    if (options.session !== undefined) {
      filter = { ...filter, sessionId: await resolveSessionId(client, options.session) };
    }
    const { processes } = await client.request('process.list', filter);
    if (options.json) {
      ctx.print(JSON.stringify(processes, null, 2));
      return EXIT.ok;
    }
    if (processes.length === 0) {
      ctx.print(t('process.none'));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          'ID',
          t('process.col.name'),
          t('process.col.status'),
          t('process.col.started'),
          t('process.col.command'),
        ],
        processes.map((process) => [
          process.id,
          truncate(
            process.preview?.url ? `${process.name} ${process.preview.url}` : process.name,
            30,
          ),
          statusText(process),
          formatTime(process.startedAt),
          truncate(process.command, 50),
        ]),
      ),
    );
    return EXIT.ok;
  });
}

/** `wevir process output <ID> [--all]`：默认最后一页；`--all` 从还留着的最早输出读到末尾。 */
export async function processOutput(
  ctx: Context,
  id: string,
  options: { all?: boolean },
): Promise<number> {
  return withProcesses(ctx, async (client) => {
    const processId = id as ProcessId;
    let page = await client.request('process.output', {
      processId,
      ...(options.all && { offset: 0 }),
    });
    if (page.from > 0 && !options.all) {
      ctx.io.stderr.write(`${ctx.styles.dim(t('process.earlierOmitted'))}\n`);
    }
    ctx.io.stdout.write(page.text);
    while (options.all && page.more) {
      page = await client.request('process.output', { processId, offset: page.next });
      ctx.io.stdout.write(page.text);
    }
    if (page.text !== '' && !page.text.endsWith('\n')) ctx.io.stdout.write('\n');
    return EXIT.ok;
  });
}

/** `wevir process stop <ID> [--signal SIGINT|SIGTERM|SIGKILL]`。 */
export async function processStop(
  ctx: Context,
  id: string,
  options: { signal?: string },
): Promise<number> {
  let signal: ProcessStopSignal | undefined;
  if (options.signal !== undefined) {
    const upper = options.signal.toUpperCase();
    const parsed = ProcessStopSignalSchema.safeParse(
      upper.startsWith('SIG') ? upper : `SIG${upper}`,
    );
    if (!parsed.success) {
      throw new UsageError(
        t('process.badSignal', { signal: options.signal }),
        t('process.badSignal.hint', { signals: joinList(ProcessStopSignalSchema.options) }),
      );
    }
    signal = parsed.data;
  }
  return withProcesses(ctx, async (client) => {
    const { process } = await client.request('process.stop', {
      processId: id as ProcessId,
      ...(signal !== undefined && { signal }),
    });
    ctx.print(t('process.stopped', { id: process.id, status: statusText(process) }));
    return EXIT.ok;
  });
}

const DAY_MS = 86_400_000;

/** `wevir usage [--days <天数>] [--json]`：最近几天（默认 7 天）的请求数、token 与估算成本，按 Provider 与模型。 */
export async function usageSummary(
  ctx: Context,
  options: { days?: string; json?: boolean },
): Promise<number> {
  const days = options.days === undefined ? 7 : Number(options.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new UsageError(t('stats.badDays', { days: options.days ?? '' }));
  }
  return withClient(ctx, async (client) => {
    requireFeature(client, 'usage_stats');
    const now = Date.now();
    const result = await client.request('usage.summary', { edges: [now - days * DAY_MS, now] });
    if (options.json) {
      ctx.print(JSON.stringify(result, null, 2));
      return EXIT.ok;
    }
    const { totals } = result;
    ctx.print(ctx.styles.bold(t('stats.title', { days })));
    if (totals.requests === 0) {
      ctx.print(t('stats.none'));
      return EXIT.ok;
    }
    ctx.print(t('stats.totals', { ...aggregateParts(totals) }));
    if (result.byProvider.length > 0) {
      ctx.print();
      ctx.print(
        table(
          ['Provider', t('stats.col.requests'), t('stats.col.tokens'), t('stats.col.cost')],
          result.byProvider.map((row) => [
            row.providerName || row.providerId,
            String(row.requests),
            tokenText(row),
            costText(row),
          ]),
        ),
      );
    }
    if (result.byModel.length > 0) {
      ctx.print();
      ctx.print(
        table(
          [
            t('stats.col.model'),
            t('stats.col.requests'),
            t('stats.col.tokens'),
            t('stats.col.cost'),
          ],
          result.byModel.map((row) => [
            row.model,
            String(row.requests),
            tokenText(row),
            costText(row),
          ]),
        ),
      );
    }
    if (result.pricing.fetchedAt === undefined) {
      ctx.print(ctx.styles.dim(t('stats.noPricing')));
    } else if (totals.unpriced > 0) {
      ctx.print(ctx.styles.dim(t('stats.unpriced', { count: totals.unpriced })));
    }
    return EXIT.ok;
  });
}

const number = (value: number): string => value.toLocaleString(intlLocale());

function tokenText(row: UsageAggregate): string {
  const { input, output, cacheRead, cacheWrite } = row.tokens;
  return number(input + output + cacheRead + cacheWrite);
}

const costText = (row: UsageAggregate): string =>
  row.requests === row.unpriced ? '-' : `$${row.cost.toFixed(row.cost < 1 ? 4 : 2)}`;

function aggregateParts(row: UsageAggregate) {
  const { timing } = row;
  return {
    requests: row.requests,
    input: number(row.tokens.input),
    output: number(row.tokens.output),
    cache: number(row.tokens.cacheRead),
    cost: costText(row),
    duration:
      timing.timedRequests === 0
        ? '-'
        : formatDuration(Math.round(timing.durationMs / timing.timedRequests)),
  };
}
