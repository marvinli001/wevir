import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { resolveHome } from '@wevir/host/runtime';
import packageJson from '../package.json' with { type: 'json' };
import {
  accountLogin,
  accountLogout,
  accountStatus,
  parseAccountKind,
} from './commands/account.js';
import { hostStart, hostStatus, hostStop } from './commands/host.js';
import { providerAdd, providerList, providerTest } from './commands/provider.js';
import { sessionAttach, sessionList, sessionNew } from './commands/session.js';
import { webEnable, webKey, webStatus, webTest, webUse } from './commands/web.js';
import { workspaceAdd, workspaceList } from './commands/workspace.js';
import { type CliIO, type Context, createContext } from './context.js';
import { EXIT, UsageError } from './errors.js';
import { padEnd } from './format.js';
import { detectLocale, type PlainMessageKey, setLocale, t } from './i18n/index.js';

export const CLI_VERSION: string = packageJson.version;

type Values = Record<string, string | boolean | undefined>;

interface CommandDef {
  /** 一行概要，出现在总帮助里。 */
  summary: PlainMessageKey;
  /** 用法行（不带“用法：”）。 */
  usage: PlainMessageKey;
  /** 用法行之后的说明与选项（命令帮助）。 */
  help?: PlainMessageKey;
  options: ParseArgsOptionsConfig;
  positionals: { min: number; max: number };
  run(ctx: Context, values: Values, positionals: string[]): Promise<number>;
}

const str = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const COMMANDS: Record<string, Record<string, CommandDef>> = {
  host: {
    start: {
      summary: 'cmd.host.start.summary',
      usage: 'cmd.host.start.usage',
      help: 'cmd.host.start.help',
      options: { adapter: { type: 'string' }, 'log-level': { type: 'string' } },
      positionals: { min: 0, max: 0 },
      run: (ctx, v) => {
        const adapter = str(v.adapter);
        const logLevel = str(v['log-level']);
        return hostStart(ctx, {
          ...(adapter !== undefined && { adapter }),
          ...(logLevel !== undefined && { logLevel }),
        });
      },
    },
    status: {
      summary: 'cmd.host.status.summary',
      usage: 'cmd.host.status.usage',
      help: 'cmd.host.status.help',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => hostStatus(ctx),
    },
    stop: {
      summary: 'cmd.host.stop.summary',
      usage: 'cmd.host.stop.usage',
      help: 'cmd.host.stop.help',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => hostStop(ctx),
    },
  },
  workspace: {
    add: {
      summary: 'cmd.workspace.add.summary',
      usage: 'cmd.workspace.add.usage',
      help: 'cmd.workspace.add.help',
      options: { name: { type: 'string' } },
      positionals: { min: 1, max: 1 },
      run: (ctx, v, [path]) => {
        const name = str(v.name);
        return workspaceAdd(ctx, path as string, name === undefined ? {} : { name });
      },
    },
    list: {
      summary: 'cmd.workspace.list.summary',
      usage: 'cmd.workspace.list.usage',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => workspaceList(ctx),
    },
  },
  provider: {
    add: {
      summary: 'cmd.provider.add.summary',
      usage: 'cmd.provider.add.usage',
      help: 'cmd.provider.add.help',
      options: {
        kind: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        api: { type: 'string' },
        'base-url': { type: 'string' },
        model: { type: 'string' },
        'context-window': { type: 'string' },
        'no-key': { type: 'boolean' },
      },
      positionals: { min: 0, max: 0 },
      run: (ctx, v) => {
        const flags: Record<string, string | boolean> = {};
        const map = {
          kind: 'kind',
          id: 'id',
          name: 'name',
          api: 'api',
          'base-url': 'baseUrl',
          model: 'model',
          'context-window': 'contextWindow',
          'no-key': 'noKey',
        } as const;
        for (const [option, key] of Object.entries(map)) {
          const value = v[option];
          if (value !== undefined) flags[key] = value;
        }
        return providerAdd(ctx, flags);
      },
    },
    list: {
      summary: 'cmd.provider.list.summary',
      usage: 'cmd.provider.list.usage',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => providerList(ctx),
    },
    test: {
      summary: 'cmd.provider.test.summary',
      usage: 'cmd.provider.test.usage',
      help: 'cmd.provider.test.help',
      options: { model: { type: 'string' } },
      positionals: { min: 0, max: 1 },
      run: (ctx, v, [id]) => {
        const model = str(v.model);
        return providerTest(ctx, id, model === undefined ? {} : { model });
      },
    },
    login: {
      summary: 'cmd.provider.login.summary',
      usage: 'cmd.provider.login.usage',
      help: 'cmd.provider.login.help',
      options: {},
      positionals: { min: 0, max: 1 },
      run: (ctx, _v, [kind]) => accountLogin(ctx, parseAccountKind(kind)),
    },
    status: {
      summary: 'cmd.provider.status.summary',
      usage: 'cmd.provider.status.usage',
      options: {},
      positionals: { min: 0, max: 1 },
      run: (ctx, _v, [kind]) => accountStatus(ctx, parseAccountKind(kind)),
    },
    logout: {
      summary: 'cmd.provider.logout.summary',
      usage: 'cmd.provider.logout.usage',
      help: 'cmd.provider.logout.help',
      options: {},
      positionals: { min: 0, max: 1 },
      run: (ctx, _v, [kind]) => accountLogout(ctx, parseAccountKind(kind)),
    },
  },
  web: {
    status: {
      summary: 'cmd.web.status.summary',
      usage: 'cmd.web.status.usage',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => webStatus(ctx),
    },
    on: {
      summary: 'cmd.web.on.summary',
      usage: 'cmd.web.on.usage',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => webEnable(ctx, true),
    },
    off: {
      summary: 'cmd.web.off.summary',
      usage: 'cmd.web.off.usage',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => webEnable(ctx, false),
    },
    use: {
      summary: 'cmd.web.use.summary',
      usage: 'cmd.web.use.usage',
      options: {},
      positionals: { min: 1, max: 1 },
      run: (ctx, _v, [service]) => webUse(ctx, service as string),
    },
    key: {
      summary: 'cmd.web.key.summary',
      usage: 'cmd.web.key.usage',
      help: 'cmd.web.key.help',
      options: { remove: { type: 'boolean' } },
      positionals: { min: 0, max: 1 },
      run: (ctx, v, [service]) => webKey(ctx, service, { remove: v.remove === true }),
    },
    test: {
      summary: 'cmd.web.test.summary',
      usage: 'cmd.web.test.usage',
      options: {},
      positionals: { min: 0, max: 1 },
      run: (ctx, _v, [service]) => webTest(ctx, service),
    },
  },
  session: {
    new: {
      summary: 'cmd.session.new.summary',
      usage: 'cmd.session.new.usage',
      help: 'cmd.session.new.help',
      options: {
        workspace: { type: 'string', short: 'w' },
        provider: { type: 'string' },
        model: { type: 'string' },
        detach: { type: 'boolean' },
      },
      positionals: { min: 0, max: Number.POSITIVE_INFINITY },
      run: (ctx, v, positionals) => {
        const workspace = str(v.workspace);
        if (workspace === undefined) {
          throw new UsageError(t('usage.missingWorkspace'), t('usage.missingWorkspace.hint'));
        }
        const provider = str(v.provider);
        const model = str(v.model);
        const prompt = positionals.length > 0 ? positionals.join(' ') : undefined;
        return sessionNew(ctx, prompt, {
          workspace,
          ...(provider !== undefined && { provider }),
          ...(model !== undefined && { model }),
          ...(v.detach === true && { detach: true }),
        });
      },
    },
    list: {
      summary: 'cmd.session.list.summary',
      usage: 'cmd.session.list.usage',
      help: 'cmd.session.list.help',
      options: { workspace: { type: 'string', short: 'w' } },
      positionals: { min: 0, max: 0 },
      run: (ctx, v) => {
        const workspace = str(v.workspace);
        return sessionList(ctx, workspace === undefined ? {} : { workspace });
      },
    },
    attach: {
      summary: 'cmd.session.attach.summary',
      usage: 'cmd.session.attach.usage',
      help: 'cmd.session.attach.help',
      options: {},
      positionals: { min: 1, max: 1 },
      run: (ctx, _v, [id]) => sessionAttach(ctx, id as string),
    },
  },
};

const GROUP_TITLES: Record<string, PlainMessageKey> = {
  host: 'group.host',
  workspace: 'group.workspace',
  provider: 'group.provider',
  web: 'group.web',
  session: 'group.session',
};

/** 总帮助里的一行：用法 + 概要。 */
function commandLine(def: CommandDef): string {
  return `  ${padEnd(t(def.usage), 52)} ${t(def.summary)}`;
}

/** 命令帮助：用法行、概要，再接必要的说明与选项。 */
function commandHelp(def: CommandDef): string {
  const head = `${t('cli.usage', { usage: t(def.usage) })}\n\n${t(def.summary)}`;
  return def.help === undefined ? head : `${head}\n\n${t(def.help)}`;
}

function groupTitle(group: string): string {
  const key = GROUP_TITLES[group];
  return key === undefined ? group : t(key);
}

export function mainHelp(): string {
  const sections = Object.entries(COMMANDS).map(
    ([group, commands]) =>
      `${groupTitle(group)}\n${Object.values(commands)
        .map((def) => commandLine(def))
        .join('\n')}`,
  );
  return `${t('cli.title', { version: CLI_VERSION })}

${t('cli.usage', { usage: t('cli.mainUsage') })}

${sections.join('\n\n')}

${t('cli.globalHelp')}`;
}

function groupHelp(group: string): string {
  const commands = COMMANDS[group] ?? {};
  return `${groupTitle(group)}\n${Object.values(commands)
    .map((def) => commandLine(def))
    .join('\n')}`;
}

/** 翻译 `parseArgs` 的报错。 */
function usageFromParseError(error: unknown, group: string, name: string): UsageError {
  const { code, message } = error as { code?: string; message: string };
  const option = /'([^']+)'/.exec(message)?.[1];
  const hint = t('usage.seeCommandHelp', { command: `${group} ${name}` });
  switch (code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return new UsageError(t('usage.unknownOption', { option: option ?? message }), hint);
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return new UsageError(t('usage.badOptionValue', { option: option ?? '' }), hint);
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return new UsageError(t('usage.extraArgs', { args: option ?? message }), hint);
    default:
      return new UsageError(message, hint);
  }
}

interface Leading {
  home?: string;
  help: boolean;
  version: boolean;
  rest: string[];
}

/** 命令之前的全局选项。 */
function parseLeading(argv: readonly string[]): Leading {
  const result: Leading = { help: false, version: false, rest: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === '-h' || token === '--help') result.help = true;
    else if (token === '-v' || token === '--version') result.version = true;
    else if (token === '--home') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(t('usage.homeMissing'));
      result.home = value;
      i += 1;
    } else if (token.startsWith('--home=')) result.home = token.slice('--home='.length);
    else if (token.startsWith('-'))
      throw new UsageError(t('usage.unknownOption', { option: token }));
    else break;
  }
  result.rest = argv.slice(i);
  return result;
}

/** `wevir` 的主流程，返回退出码（调用方负责 `process.exit`）。 */
export async function runCli(io: CliIO): Promise<number> {
  setLocale(detectLocale(io.env));
  let ctx: Context | undefined;
  try {
    const leading = parseLeading(io.argv);
    const [group, name, ...rest] = leading.rest;
    if (group === undefined || group === 'help') {
      if (leading.version && group === undefined) {
        io.stdout.write(`${CLI_VERSION}\n`);
        return EXIT.ok;
      }
      io.stdout.write(`${mainHelp()}\n`);
      return EXIT.ok;
    }
    const commands = COMMANDS[group];
    if (!commands) throw new UsageError(t('usage.unknownCommand', { command: group }));
    if (name === undefined || name.startsWith('-')) {
      const asked = leading.help || name === '-h' || name === '--help';
      (asked ? io.stdout : io.stderr).write(`${groupHelp(group)}\n`);
      return asked ? EXIT.ok : EXIT.usage;
    }
    const def = commands[name];
    if (!def) {
      throw new UsageError(
        t('usage.unknownCommand', { command: `wevir ${group} ${name}` }),
        t('usage.seeGroupHelp', { group }),
      );
    }
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        options: {
          ...def.options,
          home: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (error) {
      throw usageFromParseError(error, group, name);
    }
    const { values, positionals } = parsed;
    if (leading.help || values.help) {
      io.stdout.write(`${commandHelp(def)}\n`);
      return EXIT.ok;
    }
    if (positionals.length < def.positionals.min) {
      throw new UsageError(
        t('usage.missingArgs'),
        t('usage.seeCommandHelp', { command: `${group} ${name}` }),
      );
    }
    if (positionals.length > def.positionals.max) {
      throw new UsageError(
        t('usage.extraArgs', { args: positionals.slice(def.positionals.max).join(' ') }),
        t('usage.seeCommandHelp', { command: `${group} ${name}` }),
      );
    }
    const homeOption = str(values.home) ?? leading.home;
    if (homeOption === '') throw new UsageError(t('usage.homeEmpty'));
    const home = resolveHome({
      ...(homeOption !== undefined && { home: homeOption }),
      env: io.env,
      cwd: io.cwd,
    });
    ctx = createContext(io, home);
    return await def.run(ctx, values, positionals);
  } catch (error) {
    if (ctx) ctx.printError(error);
    else createContext(io, '').printError(error);
    return (error as { exitCode?: number }).exitCode ?? EXIT.failure;
  }
}
