import { resolve } from 'node:path';
import type { WevirClient } from '@wevir/client-sdk';
import {
  AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  type Automation,
  type AutomationCheck,
  type AutomationCheckResult,
  type AutomationNotify,
  AutomationNotifySchema,
  type AutomationRun,
  type AutomationSchedule,
  type MethodParams,
  type PermissionMode,
  PermissionModeSchema,
  type SessionId,
  SessionIdSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, table, truncate } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import { pickProvider } from './session.js';

/** `create` / `update` 共用的选项；都是命令行原样的字符串，在这里检查与换算。 */
export interface AutomationFlags {
  title?: string;
  /** `update --prompt`；`-` 表示从 stdin 读。 */
  prompt?: string;
  manual?: boolean;
  once?: string;
  every?: string;
  daily?: string;
  days?: string;
  monthly?: string;
  timezone?: string;
  project?: string;
  noProject?: boolean;
  provider?: string;
  model?: string;
  defaultModel?: boolean;
  effort?: string;
  defaultEffort?: boolean;
  permission?: string;
  notify?: string;
  sameSession?: boolean;
  newSession?: boolean;
  /** 发进这个已有会话（0.73.0）。 */
  session?: string;
  /** 检查脚本（0.73.0）。 */
  check?: string;
  wake?: string;
  checkTimeout?: string;
  noCheck?: boolean;
  disabled?: boolean;
}

export interface OutputOptions {
  json?: boolean;
}

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Host 没有 `automations` 功能（0.66.0 之前）时给出明确的说明。 */
export function requireAutomations(client: Pick<WevirClient, 'supports' | 'hello'>): void {
  if (!client.supports('automations')) {
    throw new CliError(
      t('automation.unsupported', { version: client.hello.hostVersion }),
      t('automation.unsupported.hint'),
    );
  }
}

/** 连上 Host、确认支持自动化后执行 `fn`。 */
function withAutomations<T>(ctx: Context, fn: (client: WevirClient) => Promise<T>): Promise<T> {
  return withClient(ctx, async (client) => {
    requireAutomations(client);
    return fn(client);
  });
}

function printJson(ctx: Context, value: unknown): void {
  ctx.print(JSON.stringify(value, null, 2));
}

/**
 * `--monthly 15 09:00` 是两个词；交给 parseArgs 之前并成 `--monthly=15 09:00`，第二个词不被当成指令。
 * 已经写成一个参数（`--monthly "15 09:00"`、`--monthly=15 09:00`）时不动。
 */
export function joinMonthlyArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    const day = args[i + 1];
    const time = args[i + 2];
    if (
      token === '--monthly' &&
      day !== undefined &&
      /^\d{1,2}$/.test(day) &&
      time !== undefined &&
      TIME_OF_DAY.test(time)
    ) {
      out.push(`--monthly=${day} ${time}`);
      i += 2;
    } else {
      out.push(token);
    }
  }
  return out;
}

// ── 选项换算 ─────────────────────────────────────────────────────────

function parseTimeOfDay(flag: string, value: string): string {
  const match = TIME_OF_DAY.exec(value.trim());
  if (!match) throw new UsageError(t('automation.badTime', { flag, value }));
  return `${(match[1] as string).padStart(2, '0')}:${match[2]}`;
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** `mon,wed`、`weekdays`、`weekends` 或 0–6（0 是星期日）。 */
export function parseDays(value: string): number[] {
  const days = new Set<number>();
  for (const raw of value.split(',')) {
    const word = raw.trim().toLowerCase();
    if (word === '') continue;
    if (word === 'weekdays') for (const d of [1, 2, 3, 4, 5]) days.add(d);
    else if (word === 'weekends') for (const d of [0, 6]) days.add(d);
    else if (/^[0-6]$/.test(word)) days.add(Number(word));
    else if (WEEKDAY_NAMES[word] !== undefined) days.add(WEEKDAY_NAMES[word]);
    else throw new UsageError(t('automation.badDays', { value: raw.trim() }));
  }
  if (days.size === 0) throw new UsageError(t('automation.badDays', { value }));
  return [...days].sort((a, b) => a - b);
}

/**
 * 计划选项（`--manual` / `--once` / `--every` / `--daily` / `--monthly`，最多一个）换成 `AutomationSchedule`；
 * 一个都没给时为 undefined。`--once` 不带时区偏移时按本机时间。
 */
export function parseSchedule(
  flags: AutomationFlags,
  now = Date.now(),
): AutomationSchedule | undefined {
  const given = (
    [
      ['--manual', flags.manual === true],
      ['--once', flags.once !== undefined],
      ['--every', flags.every !== undefined],
      ['--daily', flags.daily !== undefined],
      ['--monthly', flags.monthly !== undefined],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([flag]) => flag);
  if (given.length > 1) {
    throw new UsageError(t('automation.manySchedules', { flags: joinList(given) }));
  }
  if (flags.days !== undefined && flags.daily === undefined) {
    throw new UsageError(t('automation.daysNeedDaily'));
  }
  if (flags.manual) return { kind: 'manual' };
  if (flags.once !== undefined) {
    const value = flags.once.trim();
    const at = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)
      ? new Date(value.replace(' ', 'T'))
      : undefined;
    if (at === undefined || Number.isNaN(at.getTime())) {
      throw new UsageError(t('automation.badOnce', { value: flags.once }));
    }
    if (at.getTime() <= now) throw new UsageError(t('automation.oncePast', { value: flags.once }));
    return { kind: 'once', at: at.toISOString() };
  }
  if (flags.every !== undefined) {
    const minutes = Number(flags.every.trim());
    if (!Number.isInteger(minutes) || minutes < AUTOMATION_MIN_INTERVAL_MINUTES) {
      throw new UsageError(
        t('automation.badEvery', { value: flags.every, min: AUTOMATION_MIN_INTERVAL_MINUTES }),
      );
    }
    return { kind: 'interval', minutes };
  }
  if (flags.daily !== undefined) {
    const time = parseTimeOfDay('--daily', flags.daily);
    if (flags.days === undefined) return { kind: 'daily', time };
    const weekdays = parseDays(flags.days);
    return weekdays.length === 7 ? { kind: 'daily', time } : { kind: 'daily', time, weekdays };
  }
  if (flags.monthly !== undefined) {
    const match = /^(\d{1,2})\s+(\S+)$/.exec(flags.monthly.trim());
    const day = match ? Number(match[1]) : Number.NaN;
    if (!match || day < 1 || day > 31) {
      throw new UsageError(t('automation.badMonthly', { value: flags.monthly }));
    }
    return { kind: 'monthly', day, time: parseTimeOfDay('--monthly', match[2] as string) };
  }
  return undefined;
}

export function parsePermission(value: string): PermissionMode {
  const parsed = PermissionModeSchema.safeParse(value.trim().toLowerCase().replaceAll('-', '_'));
  if (!parsed.success) {
    throw new UsageError(
      t('automation.badPermission', { value }),
      t('automation.badPermission.hint'),
    );
  }
  return parsed.data;
}

export function parseNotify(value: string): AutomationNotify {
  const parsed = AutomationNotifySchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new UsageError(t('automation.badNotify', { value }), t('automation.badNotify.hint'));
  }
  return parsed.data;
}

/** `--wake`：`exit-code`（默认）或 `output-changed`。 */
export function parseWake(value: string | undefined): AutomationCheck['wake'] {
  const word = (value ?? 'exit-code').trim().toLowerCase().replaceAll('-', '_');
  if (word === 'exit_code' || word === 'output_changed') return word;
  throw new UsageError(t('automation.badWake', { value: value ?? '' }));
}

/** `--check` / `--wake` / `--check-timeout` 换成 `AutomationCheck`；没给 `--check` 时 undefined。 */
export function parseCheck(flags: AutomationFlags): AutomationCheck | undefined {
  if (flags.check === undefined) {
    if (flags.wake !== undefined || flags.checkTimeout !== undefined) {
      throw new UsageError(t('automation.checkOptionsNeedCheck'));
    }
    return undefined;
  }
  const command = flags.check.trim();
  if (command === '') throw new UsageError(t('automation.missingCheck'));
  let timeoutSeconds: number | undefined;
  if (flags.checkTimeout !== undefined) {
    timeoutSeconds = Number(flags.checkTimeout.trim());
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS
    ) {
      throw new UsageError(
        t('automation.badCheckTimeout', {
          value: flags.checkTimeout,
          max: AUTOMATION_CHECK_MAX_TIMEOUT_SECONDS,
        }),
      );
    }
  }
  return {
    command,
    wake: parseWake(flags.wake),
    ...(timeoutSeconds !== undefined && { timeoutSeconds }),
  };
}

function parseSessionId(value: string): SessionId {
  const id = value.trim();
  if (!SessionIdSchema.safeParse(id).success) {
    throw new UsageError(t('automation.badSession', { value }));
  }
  return id as SessionId;
}

interface CommonFields {
  title?: string;
  schedule?: AutomationSchedule;
  permissionMode?: PermissionMode;
  notify?: AutomationNotify;
  sessionId?: SessionId;
  check?: AutomationCheck;
}

/** `create` / `update` 共同的检查与换算；用法错误的下一步指向 `command` 的帮助。 */
function parseCommon(flags: AutomationFlags, command: string): CommonFields {
  try {
    const pairs: Array<[string, boolean, string, boolean]> = [
      ['--project', flags.project !== undefined, '--no-project', flags.noProject === true],
      ['--model', flags.model !== undefined, '--default-model', flags.defaultModel === true],
      ['--effort', flags.effort !== undefined, '--default-effort', flags.defaultEffort === true],
      ['--same-session', flags.sameSession === true, '--new-session', flags.newSession === true],
      ['--session', flags.session !== undefined, '--new-session', flags.newSession === true],
      ['--session', flags.session !== undefined, '--same-session', flags.sameSession === true],
      ['--session', flags.session !== undefined, '--project', flags.project !== undefined],
      ['--session', flags.session !== undefined, '--no-project', flags.noProject === true],
      ['--session', flags.session !== undefined, '--provider', flags.provider !== undefined],
      ['--session', flags.session !== undefined, '--model', flags.model !== undefined],
      ['--session', flags.session !== undefined, '--effort', flags.effort !== undefined],
      ['--check', flags.check !== undefined, '--no-check', flags.noCheck === true],
    ];
    for (const [a, hasA, b, hasB] of pairs) {
      if (hasA && hasB) throw new UsageError(t('automation.conflict', { a, b }));
    }
    const title = flags.title?.trim();
    if (flags.title !== undefined && !title) throw new UsageError(t('automation.missingTitle'));
    const schedule = parseSchedule(flags);
    const check = parseCheck(flags);
    return {
      ...(title !== undefined && { title }),
      ...(schedule !== undefined && { schedule }),
      ...(flags.session !== undefined && { sessionId: parseSessionId(flags.session) }),
      ...(check !== undefined && { check }),
      ...(flags.permission !== undefined && { permissionMode: parsePermission(flags.permission) }),
      ...(flags.notify !== undefined && { notify: parseNotify(flags.notify) }),
    };
  } catch (error) {
    if (error instanceof UsageError && error.hint === t('usage.seeHelp')) {
      throw new UsageError(error.message, t('usage.seeCommandHelp', { command }));
    }
    throw error;
  }
}

async function readStdin(ctx: Context): Promise<string> {
  let text = '';
  for await (const chunk of ctx.io.stdin) text += chunk.toString();
  return text;
}

/** 指令：参数里的词，或（没给、stdin 不是终端时）stdin 的全部内容。 */
async function readPrompt(ctx: Context, words: string[]): Promise<string> {
  const fromArgs = words.join(' ').trim();
  if (fromArgs !== '' && fromArgs !== '-') return fromArgs;
  if (fromArgs === '' && ctx.io.stdin.isTTY) {
    throw new UsageError(t('automation.missingPrompt'), t('automation.missingPrompt.hint'));
  }
  const text = (await readStdin(ctx)).trim();
  if (text === '') {
    throw new UsageError(t('automation.missingPrompt'), t('automation.missingPrompt.hint'));
  }
  return text;
}

/** `--project`：工作区 ID 原样使用；否则是目录，未登记时登记为工作区（与 `session new` 相同）。 */
async function resolveProject(
  ctx: Context,
  client: WevirClient,
  project: string,
): Promise<WorkspaceId> {
  if (WorkspaceIdSchema.safeParse(project).success) return project as WorkspaceId;
  const { workspace, created } = await client.request('workspace.add', {
    rootPath: resolve(ctx.io.cwd, project),
  });
  if (created) {
    ctx.print(
      ctx.styles.dim(
        t('session.workspaceAdded', { name: workspace.displayName, path: workspace.rootPath }),
      ),
    );
  }
  return workspace.id;
}

/** 完整的自动化 ID 原样使用；否则按前缀（可省略 `aut_`）在列表里找唯一的一个。 */
async function resolveAutomation(client: WevirClient, id: string): Promise<Automation> {
  const { automations } = await client.request('automation.list');
  const exact = automations.find((a) => a.id === id);
  if (exact) return exact;
  const matches = automations.filter((a) => a.id.startsWith(id) || a.id.startsWith(`aut_${id}`));
  if (matches.length === 1) return matches[0] as Automation;
  if (matches.length === 0) {
    throw new CliError(t('automation.notFound', { id }), t('automation.notFound.hint'));
  }
  throw new CliError(
    t('automation.ambiguous', { id, ids: joinList(matches.slice(0, 5).map((a) => a.id)) }),
    t('automation.ambiguous.hint'),
  );
}

// ── 显示 ─────────────────────────────────────────────────────────────

export function scheduleLabel(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'manual':
      return t('automation.schedule.manual');
    case 'once':
      return t('automation.schedule.once', { at: formatTime(schedule.at) });
    case 'interval':
      return t('automation.schedule.every', { minutes: schedule.minutes });
    case 'daily': {
      const days = schedule.weekdays;
      if (days === undefined || days.length === 7) {
        return t('automation.schedule.daily', { time: schedule.time });
      }
      if (days.join() === '1,2,3,4,5') {
        return t('automation.schedule.weekdays', { time: schedule.time });
      }
      return t('automation.schedule.weekly', {
        days: joinList(days.map((d) => t(`weekday.${d as 0 | 1 | 2 | 3 | 4 | 5 | 6}`))),
        time: schedule.time,
      });
    }
    case 'monthly':
      return t('automation.schedule.monthly', { day: schedule.day, time: schedule.time });
  }
}

function checkText(check: AutomationCheck): string {
  return `${check.command}${t('common.parenAfter', { text: t(`automation.wake.${check.wake}`) })}`;
}

const runStatusLabel = (run: AutomationRun): string =>
  run.quiet && run.status === 'completed'
    ? t('automation.run.quiet')
    : t(`automation.run.${run.status}`);

const stateText = (automation: Automation): string =>
  automation.enabled
    ? t('automation.state.enabled')
    : automation.autoPausedAt !== undefined
      ? t('automation.state.autoPaused')
      : t('automation.state.disabled');

function modelText(automation: Automation): string {
  return `${automation.providerId}/${automation.modelId ?? t('automation.defaultModel')}`;
}

export async function automationList(ctx: Context, options: OutputOptions): Promise<number> {
  const { automations } = await withAutomations(ctx, (client) => client.request('automation.list'));
  if (options.json) {
    printJson(ctx, automations);
    return EXIT.ok;
  }
  if (automations.length === 0) {
    ctx.print(t('automation.none'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      [
        'ID',
        t('automation.col.state'),
        t('automation.col.title'),
        t('automation.col.schedule'),
        t('automation.col.next'),
        t('automation.col.last'),
      ],
      automations.map((a) => [
        a.id,
        stateText(a),
        truncate(a.title, 30),
        scheduleLabel(a.schedule),
        a.nextRunAt === undefined ? '-' : formatTime(a.nextRunAt),
        a.lastRun === undefined
          ? '-'
          : `${runStatusLabel(a.lastRun)} ${formatTime(a.lastRun.startedAt)}`,
      ]),
    ),
  );
  return EXIT.ok;
}

export async function automationShow(
  ctx: Context,
  id: string,
  options: OutputOptions,
): Promise<number> {
  return withAutomations(ctx, async (client) => {
    const found = await resolveAutomation(client, id);
    const { automation, runs } = await client.request('automation.get', {
      automationId: found.id,
    });
    if (options.json) {
      printJson(ctx, { automation, runs });
      return EXIT.ok;
    }
    let project = t('automation.noProject');
    if (automation.workspaceId !== undefined) {
      const { workspaces } = await client.request('workspace.list');
      const workspace = workspaces.find((w) => w.id === automation.workspaceId);
      project = workspace
        ? `${workspace.displayName}${t('common.parenAfter', { text: workspace.rootPath })}`
        : automation.workspaceId;
    }
    const rows: Array<[string, string]> = [
      [t('automation.field.state'), stateText(automation)],
      [t('automation.field.schedule'), scheduleLabel(automation.schedule)],
      [t('automation.field.timezone'), automation.timezone],
      [
        t('automation.field.next'),
        automation.nextRunAt === undefined ? '-' : formatTime(automation.nextRunAt),
      ],
      [t('automation.field.project'), project],
      [t('automation.field.model'), modelText(automation)],
      ...(automation.reasoningEffort === undefined
        ? []
        : [[t('automation.field.effort'), automation.reasoningEffort] as [string, string]]),
      [t('automation.field.permission'), t(`permission.${automation.permissionMode}`)],
      [
        t('automation.field.runsIn'),
        automation.newSessionEachRun
          ? t('automation.runsIn.new')
          : automation.sessionId === undefined
            ? t('automation.runsIn.same')
            : `${t('automation.runsIn.same')} ${automation.sessionId}`,
      ],
      [t('automation.field.notify'), t(`automation.notify.${automation.notify}`)],
      [
        t('automation.field.check'),
        automation.check === undefined ? '-' : checkText(automation.check),
      ],
      [
        t('automation.field.creator'),
        automation.createdBy.kind === 'user'
          ? t('automation.creator.user')
          : t('automation.creator.agent', { id: automation.createdBy.sessionId }),
      ],
      [t('automation.field.created'), formatTime(automation.createdAt)],
      [t('automation.field.runCount'), String(automation.runCount)],
    ];
    ctx.print(ctx.styles.bold(`${automation.title}  ${ctx.styles.dim(automation.id)}`));
    ctx.print(table(['', ''], rows).split('\n').slice(1).join('\n'));
    ctx.print();
    ctx.print(ctx.styles.bold(t('automation.field.prompt')));
    for (const line of automation.prompt.split('\n')) ctx.print(`  ${line}`);
    ctx.print();
    ctx.print(ctx.styles.bold(t('automation.runs')));
    if (runs.length === 0) {
      ctx.print(t('automation.noRuns'));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          t('automation.col.started'),
          t('automation.col.trigger'),
          t('automation.col.status'),
          t('automation.col.session'),
          t('automation.col.result'),
        ],
        runs
          .slice(0, 10)
          .map((run) => [
            formatTime(run.startedAt),
            t(`automation.trigger.${run.trigger}`),
            runStatusLabel(run),
            run.sessionId ?? '-',
            truncate(run.error ?? run.summary ?? run.check?.output.trim() ?? '', 50),
          ]),
      ),
    );
    if (runs.length > 10) {
      ctx.print(ctx.styles.dim(t('automation.moreRuns', { count: runs.length - 10 })));
    }
    return EXIT.ok;
  });
}

function printSaved(ctx: Context, automation: Automation, created: boolean): void {
  const params = { title: automation.title, id: automation.id };
  ctx.print(created ? t('automation.created', params) : t('automation.updated', params));
  ctx.print(
    ctx.styles.dim(
      automation.nextRunAt === undefined
        ? `${scheduleLabel(automation.schedule)} · ${stateText(automation)}`
        : `${scheduleLabel(automation.schedule)} · ${t('automation.nextRun', {
            time: formatTime(automation.nextRunAt),
          })}`,
    ),
  );
  if (automation.permissionMode === 'full_access') {
    ctx.print(ctx.styles.yellow(t('automation.fullAccessWarning')));
  }
}

/** `wevir automation create --title <名称> [选项] "<指令>"`。 */
export async function automationCreate(
  ctx: Context,
  words: string[],
  flags: AutomationFlags,
  options: OutputOptions,
): Promise<number> {
  const parsed = parseCommon(flags, 'automation create');
  const { title, permissionMode, notify, sessionId, check } = parsed;
  if (title === undefined) {
    throw new UsageError(
      t('automation.missingTitle'),
      t('usage.seeCommandHelp', { command: 'automation create' }),
    );
  }
  const schedule = parsed.schedule ?? { kind: 'manual' };
  const prompt = await readPrompt(ctx, words);
  return withAutomations(ctx, async (client) => {
    if (
      (sessionId !== undefined || check !== undefined) &&
      !client.supports('automation_conditions')
    ) {
      throw new CliError(
        t('automation.conditionsUnsupported', { version: client.hello.hostVersion }),
        t('automation.unsupported.hint'),
      );
    }
    const workspaceId =
      flags.project === undefined ? undefined : await resolveProject(ctx, client, flags.project);
    let providerId: string | undefined;
    if (sessionId === undefined) {
      const { providers } = await client.request('provider.list');
      providerId = pickProvider(providers, flags.provider).id;
    }
    const params: MethodParams<'automation.create'> = {
      title,
      prompt,
      schedule,
      ...(providerId !== undefined && { providerId }),
      ...(sessionId !== undefined && { sessionId }),
      ...(check !== undefined && { check }),
      ...(flags.timezone !== undefined && { timezone: flags.timezone }),
      ...(flags.disabled === true && { enabled: false }),
      ...(workspaceId !== undefined && { workspaceId }),
      ...(flags.model !== undefined && { modelId: flags.model }),
      ...(flags.effort !== undefined && { reasoningEffort: flags.effort }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(flags.sameSession === true && { newSessionEachRun: false }),
      ...(notify !== undefined && { notify }),
    };
    const { automation } = await client.request('automation.create', params);
    if (options.json) printJson(ctx, automation);
    else printSaved(ctx, automation, true);
    return EXIT.ok;
  });
}

/** `wevir automation update <ID> [选项]`：只改给出的选项。 */
export async function automationUpdate(
  ctx: Context,
  id: string,
  flags: AutomationFlags,
  options: OutputOptions,
): Promise<number> {
  const { title, schedule, permissionMode, notify, sessionId, check } = parseCommon(
    flags,
    'automation update',
  );
  const prompt = flags.prompt === undefined ? undefined : await readPrompt(ctx, [flags.prompt]);
  return withAutomations(ctx, async (client) => {
    const found = await resolveAutomation(client, id);
    const workspaceId =
      flags.project === undefined ? undefined : await resolveProject(ctx, client, flags.project);
    const params: MethodParams<'automation.update'> = {
      automationId: found.id,
      ...(title !== undefined && { title }),
      ...(prompt !== undefined && { prompt }),
      ...(schedule !== undefined && { schedule }),
      ...(flags.timezone !== undefined && { timezone: flags.timezone }),
      ...(workspaceId !== undefined && { workspaceId }),
      ...(flags.noProject === true && { workspaceId: null }),
      ...(flags.provider !== undefined && { providerId: flags.provider }),
      ...(flags.model !== undefined && { modelId: flags.model }),
      ...(flags.defaultModel === true && { modelId: null }),
      ...(flags.effort !== undefined && { reasoningEffort: flags.effort }),
      ...(flags.defaultEffort === true && { reasoningEffort: null }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(flags.sameSession === true && { newSessionEachRun: false }),
      ...(flags.newSession === true && { newSessionEachRun: true }),
      ...(flags.newSession === true &&
        client.supports('automation_conditions') && { sessionId: null }),
      ...(sessionId !== undefined && { sessionId }),
      ...(check !== undefined && { check }),
      ...(flags.noCheck === true && { check: null }),
      ...(notify !== undefined && { notify }),
    };
    if (Object.keys(params).length === 1) {
      throw new UsageError(
        t('automation.nothingToUpdate'),
        t('usage.seeCommandHelp', { command: 'automation update' }),
      );
    }
    const { automation } = await client.request('automation.update', params);
    if (options.json) printJson(ctx, automation);
    else printSaved(ctx, automation, false);
    return EXIT.ok;
  });
}

export async function automationSetEnabled(
  ctx: Context,
  id: string,
  enabled: boolean,
  options: OutputOptions,
): Promise<number> {
  return withAutomations(ctx, async (client) => {
    const found = await resolveAutomation(client, id);
    const { automation } = await client.request('automation.update', {
      automationId: found.id,
      enabled,
    });
    if (options.json) {
      printJson(ctx, automation);
      return EXIT.ok;
    }
    const params = { title: automation.title };
    ctx.print(enabled ? t('automation.enabled', params) : t('automation.disabled', params));
    if (automation.nextRunAt !== undefined) {
      ctx.print(
        ctx.styles.dim(t('automation.nextRun', { time: formatTime(automation.nextRunAt) })),
      );
    }
    return EXIT.ok;
  });
}

/** `wevir automation run <ID>`：立即运行一次；开会话或发送失败时退出码 1。 */
export async function automationRun(
  ctx: Context,
  id: string,
  options: OutputOptions,
): Promise<number> {
  return withAutomations(ctx, async (client) => {
    const found = await resolveAutomation(client, id);
    const { run } = await client.request('automation.run', { automationId: found.id });
    const failed = run.status === 'failed';
    if (options.json) {
      printJson(ctx, run);
      return failed ? EXIT.failure : EXIT.ok;
    }
    if (failed) {
      throw new CliError(t('automation.runFailed', { error: run.error ?? run.status }));
    }
    ctx.print(
      t(run.status === 'checking' ? 'automation.runChecking' : 'automation.runStarted', {
        title: found.title,
        id: run.id,
      }),
    );
    if (run.sessionId !== undefined) {
      ctx.print(ctx.styles.dim(t('error.hint', { hint: `wevir session attach ${run.sessionId}` })));
    }
    return EXIT.ok;
  });
}

export async function automationDelete(ctx: Context, id: string): Promise<number> {
  return withAutomations(ctx, async (client) => {
    const found = await resolveAutomation(client, id);
    await client.request('automation.delete', { automationId: found.id });
    ctx.print(t('automation.deleted', { title: found.title, id: found.id }));
    return EXIT.ok;
  });
}

function printCheckResult(ctx: Context, result: AutomationCheckResult): void {
  ctx.print(
    `${t(`automation.check.${result.decision}`)}  ${ctx.styles.dim(
      t('automation.check.detail', {
        exit: result.exitCode === null ? '-' : String(result.exitCode),
        seconds: (result.durationMs / 1000).toFixed(1),
      }),
    )}`,
  );
  if (result.error !== undefined) ctx.print(ctx.styles.dim(result.error));
  if (result.output.trim() !== '') {
    ctx.print();
    if (result.truncated === true) ctx.print(ctx.styles.dim(t('automation.check.truncated')));
    for (const line of result.output.replace(/\n$/, '').split('\n')) ctx.print(`  ${line}`);
  }
}

/**
 * `wevir automation test-check <ID> [--check <命令> --wake <规则> --check-timeout <秒>]`：试跑检查脚本（自动化的，或给出的），
 * 不唤醒 Agent、不记运行。结论是失败时退出码 1。
 */
export async function automationTestCheck(
  ctx: Context,
  id: string,
  flags: AutomationFlags,
  options: OutputOptions,
): Promise<number> {
  const given = parseCheck(flags);
  return withAutomations(ctx, async (client) => {
    if (!client.supports('automation_conditions')) {
      throw new CliError(
        t('automation.conditionsUnsupported', { version: client.hello.hostVersion }),
        t('automation.unsupported.hint'),
      );
    }
    const found = await resolveAutomation(client, id);
    const check = given ?? found.check;
    if (check === undefined) {
      throw new UsageError(
        t('automation.noCheck', { title: found.title }),
        t('usage.seeCommandHelp', { command: 'automation test-check' }),
      );
    }
    const { result } = await client.request('automation.testCheck', {
      check,
      automationId: found.id,
    });
    if (options.json) printJson(ctx, result);
    else printCheckResult(ctx, result);
    return result.decision === 'failed' ? EXIT.failure : EXIT.ok;
  });
}
