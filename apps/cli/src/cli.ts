import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { resolveHome } from '@wevir/host/runtime';
import packageJson from '../package.json' with { type: 'json' };
import { hostStart, hostStatus, hostStop } from './commands/host.js';
import { providerAdd, providerList, providerTest } from './commands/provider.js';
import { sessionAttach, sessionList, sessionNew } from './commands/session.js';
import { workspaceAdd, workspaceList } from './commands/workspace.js';
import { type CliIO, type Context, createContext } from './context.js';
import { EXIT, UsageError } from './errors.js';
import { padEnd } from './format.js';

export const CLI_VERSION: string = packageJson.version;

type Values = Record<string, string | boolean | undefined>;

interface CommandDef {
  /** 一行概要，出现在总帮助里。 */
  summary: string;
  /** 用法行与说明（命令帮助）。 */
  help: string;
  options: ParseArgsOptionsConfig;
  positionals: { min: number; max: number };
  run(ctx: Context, values: Values, positionals: string[]): Promise<number>;
}

const str = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const COMMANDS: Record<string, Record<string, CommandDef>> = {
  host: {
    start: {
      summary: '在后台启动本机 Host（关闭终端也不停止）',
      help: `用法：wevir host start [选项]

以分离方式启动 Host：不持有终端，CLI 退出、终端关闭都不影响它；桌面端之后附着到它，退出时也不会停止它。
已有 Host 在运行时只报告它的状态。

选项：
  --adapter <dsh|codex|echo>
                         引擎适配器，默认 dsh；codex 是 codex-app-server（先在仓库根目录运行
                         bash scripts/fetch-codex.sh，或用 WEVIR_CODEX_BIN 指定）；echo 是开发用的假引擎
  --log-level <级别>     debug | info | warn | error，默认 info（日志在 <数据目录>/logs/host.log）`,
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
      summary: '查看 Host 是否在运行',
      help: `用法：wevir host status

读取 <数据目录>/run/host.json 并连上 Host 探活。Host 没有在运行时退出码为 1。`,
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => hostStatus(ctx),
    },
    stop: {
      summary: '让 Host 优雅退出',
      help: `用法：wevir host stop

经 host.shutdown 请求 Host 优雅退出（运行中的回合会被取消），等它的进程结束。Host 没有在运行时什么也不做。`,
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => hostStop(ctx),
    },
  },
  workspace: {
    add: {
      summary: '登记一个本地文件夹为工作区',
      help: `用法：wevir workspace add <路径> [--name <名称>]

Host 按真实路径去重：同一个目录再次添加时返回已有的工作区。

选项：
  --name <名称>   显示名称，默认取目录名`,
      options: { name: { type: 'string' } },
      positionals: { min: 1, max: 1 },
      run: (ctx, v, [path]) => {
        const name = str(v.name);
        return workspaceAdd(ctx, path as string, name === undefined ? {} : { name });
      },
    },
    list: {
      summary: '列出工作区',
      help: '用法：wevir workspace list',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => workspaceList(ctx),
    },
  },
  provider: {
    add: {
      summary: '添加或更新 Provider（Key 不回显、不进 shell 历史）',
      help: `用法：wevir provider add [选项]

没给的选项在终端里逐项询问。API Key 只在终端里不回显地输入，不接受命令行参数，不会写进 shell 历史；
stdin 不是终端时从 stdin 读一行作为 Key。同一个 ID 再次添加即更新（直接回车保留已存的 Key）。

选项：
  --kind <类型>            deepseek-official（DeepSeek 官方）或 openai-compatible（OpenAI 兼容地址）
  --id <ID>                openai-compatible 的 ID（小写字母开头，可含数字与 -；创建后不能改）
  --name <名称>            显示名称
  --api <协议>             openai-completions（默认）或 openai-responses
  --base-url <地址>        服务地址，例如 https://api.moonshot.cn/v1
  --model <模型 ID>        默认模型
  --context-window <数>    模型的上下文长度（token）
  --no-key                 不设置 Key（保留已存的）

示例：
  wevir provider add --kind deepseek-official
  wevir provider add --kind openai-compatible --id kimi --base-url https://api.moonshot.cn/v1 --model kimi-k2.6`,
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
      summary: '列出 Provider',
      help: '用法：wevir provider list',
      options: {},
      positionals: { min: 0, max: 0 },
      run: (ctx) => providerList(ctx),
    },
    test: {
      summary: '用一次最小请求测试 Provider 的连接',
      help: `用法：wevir provider test [<ID>] [--model <模型 ID>]

只有一个 Provider 时可以省略 ID。会真实地向服务发一次很小的请求。

选项：
  --model <模型 ID>   测试这个模型，默认是 Provider 的默认模型`,
      options: { model: { type: 'string' } },
      positionals: { min: 0, max: 1 },
      run: (ctx, v, [id]) => {
        const model = str(v.model);
        return providerTest(ctx, id, model === undefined ? {} : { model });
      },
    },
  },
  session: {
    new: {
      summary: '新建会话、发送提示并进入 attach',
      help: `用法：wevir session new -w <路径> [选项] "<提示>"

目录还不是工作区时自动登记。默认发送后进入 attach（实时输出、交互式审批、继续对话）。

选项：
  -w, --workspace <路径>   会话的工作区目录（必填）
  --provider <ID>          使用的 Provider；只有一个时可省略
  --model <模型 ID>        默认用 Provider 的默认模型
  --detach                 只创建并发送，不进入 attach`,
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
          throw new UsageError(
            '缺少 -w <路径>',
            '例如 wevir session new -w . "汇总这个目录下的 CSV"',
          );
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
      summary: '列出会话',
      help: `用法：wevir session list [-w <路径>]

选项：
  -w, --workspace <路径>   只列这个工作区的会话`,
      options: { workspace: { type: 'string', short: 'w' } },
      positionals: { min: 0, max: 0 },
      run: (ctx, v) => {
        const workspace = str(v.workspace);
        return sessionList(ctx, workspace === undefined ? {} : { workspace });
      },
    },
    attach: {
      summary: '连到会话：实时输出、审批、继续对话',
      help: `用法：wevir session attach <会话 ID>

从头回放会话历史，然后实时显示助手输出与工具调用；遇到审批时在输入框里选择（另一端先处理时显示处理者）。
会话空闲时在输入框里输入并回车即继续对话。会话 ID 可以只写开头几位（唯一即可）。

按键：
  Enter    发送消息 / 回答审批
  Ctrl-C   回合运行中：第一次取消当前运行，第二次退出 attach；空闲时连按两次退出
  Ctrl-D   退出 attach（会话保留在 Host 中）`,
      options: {},
      positionals: { min: 1, max: 1 },
      run: (ctx, _v, [id]) => sessionAttach(ctx, id as string),
    },
  },
};

const GROUP_TITLES: Record<string, string> = {
  host: 'Host',
  workspace: '工作区',
  provider: 'Provider（模型服务）',
  session: '会话',
};

const GLOBAL_HELP = `全局选项：
  --home <目录>    数据目录，与 Host 相同；环境变量 WEVIR_HOME 优先。默认 macOS ~/Library/Application Support/Wevir，
                   Windows %APPDATA%\\Wevir
  -h, --help       显示帮助（wevir <命令> --help 查看命令的选项）
  -v, --version    显示版本`;

/** 总帮助里的一行：用法 + 概要。 */
function commandLine(def: CommandDef): string {
  const usage = (def.help.split('\n')[0] ?? '').replace(/^用法：/, '');
  return `  ${padEnd(usage, 52)} ${def.summary}`;
}

export function mainHelp(): string {
  const sections = Object.entries(COMMANDS).map(
    ([group, commands]) =>
      `${GROUP_TITLES[group]}\n${Object.values(commands)
        .map((def) => commandLine(def))
        .join('\n')}`,
  );
  return `wevir —— Wevir 命令行客户端 ${CLI_VERSION}

用法：wevir <命令> [选项]

${sections.join('\n\n')}

${GLOBAL_HELP}

先运行 wevir host start 启动 Host，再 wevir provider add 配置模型服务。`;
}

function groupHelp(group: string): string {
  const commands = COMMANDS[group] ?? {};
  return `${GROUP_TITLES[group]}\n${Object.values(commands)
    .map((def) => commandLine(def))
    .join('\n')}\n\n运行 wevir ${group} <子命令> --help 查看选项。`;
}

/** 翻译 `parseArgs` 的报错。 */
function usageFromParseError(error: unknown, group: string, name: string): UsageError {
  const { code, message } = error as { code?: string; message: string };
  const option = /'([^']+)'/.exec(message)?.[1];
  const hint = `运行 wevir ${group} ${name} --help 查看用法`;
  switch (code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return new UsageError(`未知选项：${option ?? message}`, hint);
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      return new UsageError(`选项 ${option ?? ''} 缺少值或不需要值`, hint);
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return new UsageError(`多余的参数：${option ?? message}`, hint);
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
      if (value === undefined) throw new UsageError('--home 缺少目录');
      result.home = value;
      i += 1;
    } else if (token.startsWith('--home=')) result.home = token.slice('--home='.length);
    else if (token.startsWith('-')) throw new UsageError(`未知选项：${token}`);
    else break;
  }
  result.rest = argv.slice(i);
  return result;
}

/** `wevir` 的主流程，返回退出码（调用方负责 `process.exit`）。 */
export async function runCli(io: CliIO): Promise<number> {
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
    if (!commands) throw new UsageError(`未知命令：${group}`);
    if (name === undefined || name.startsWith('-')) {
      const asked = leading.help || name === '-h' || name === '--help';
      (asked ? io.stdout : io.stderr).write(`${groupHelp(group)}\n`);
      return asked ? EXIT.ok : EXIT.usage;
    }
    const def = commands[name];
    if (!def) {
      throw new UsageError(`未知命令：wevir ${group} ${name}`, `运行 wevir ${group} --help 查看`);
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
      io.stdout.write(`${def.help}\n`);
      return EXIT.ok;
    }
    if (positionals.length < def.positionals.min) {
      throw new UsageError('缺少参数', `运行 wevir ${group} ${name} --help 查看用法`);
    }
    if (positionals.length > def.positionals.max) {
      throw new UsageError(
        `多余的参数：${positionals.slice(def.positionals.max).join(' ')}`,
        `运行 wevir ${group} ${name} --help 查看用法`,
      );
    }
    const homeOption = str(values.home) ?? leading.home;
    if (homeOption === '') throw new UsageError('--home 不能为空');
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
