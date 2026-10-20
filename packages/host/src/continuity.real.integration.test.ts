// 记忆管理、记忆来源与修订、接力材料与预览在真实引擎与真实模型上的验收：真实 Host + 真实 codex-app-server（同产品：CodexRuntime、
// 读历史与联网工具），接力的另一端是真实的 opencode，模型都是 DeepSeek。平时跳过，CI 不跑；要跑时：
//
//   WEVIR_CONTINUITY_REAL=1 WEVIR_TEST_PROVIDER=deepseek-official WEVIR_TEST_API_KEY=… \
//     WEVIR_OPENCODE_BIN=/path/to/opencode pnpm vitest run --project host continuity.real
//
// 每个场景跑 WEVIR_CONTINUITY_REPEAT 次（默认 3）；一次运行（一个 vitest 进程）里所有模型请求合计超过
// WEVIR_CONTINUITY_REQUEST_CAP（默认 60）就停掉回合，后面的回合不再发。没有 WEVIR_OPENCODE_BIN 时跳过跨引擎接力。
//
// 判定只看 Host 事件、笔记文件与递交记录，不看模型怎么说；“材料送到了”（Host 与请求体）与“模型照做了”（文件结果）分开记。
// Host 一侧的保证用 expect.soft 判定（失败也接着跑完、写完报告），模型是否照做只记进报告。请求经本地记录代理转发，Key 只在
// 环境变量与请求头里，不进报告与日志。报告写到 WEVIR_CONTINUITY_OUT（默认 .wevir-dev/continuity/<时刻>.json）。

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CODEX_VERSION, CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { OpenCodeAdapter } from '@wevir/adapter-opencode';
import { PROTOCOL_VERSION, type WevirEvent } from '@wevir/protocol';
import { historyToolServer } from '@wevir/runtime-adapter/history-tool';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EngineRouter } from './engine-router.js';
import { homePath } from './home.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import {
  checkHandoffResult,
  HANDOFF_CONSTRAINTS,
  HANDOFF_TASK,
  PROJECT_A,
  type Recorder,
  responsesCatalog,
  seedProjectNote,
  startForwardingRecorder,
  writeProject,
} from './test-fixtures/baseline.js';
import { removeTempDir, TestRpcClient } from './test-utils.js';
import { WebService } from './web/service.js';

const ENABLED = process.env.WEVIR_CONTINUITY_REAL === '1';
const KEY =
  process.env.WEVIR_TEST_PROVIDER === 'deepseek-official'
    ? process.env.WEVIR_TEST_API_KEY || undefined
    : undefined;
const OPENCODE_BIN = process.env.WEVIR_OPENCODE_BIN || undefined;
const REPEAT = Math.max(1, Number(process.env.WEVIR_CONTINUITY_REPEAT ?? 3) || 3);
const REQUEST_CAP = Math.max(1, Number(process.env.WEVIR_CONTINUITY_REQUEST_CAP ?? 60) || 60);
const MODEL = process.env.WEVIR_TEST_MODEL || 'deepseek-flash';
const REPO = resolve(import.meta.dirname, '..', '..', '..');
/** DeepSeek 的地址：Responses（网关的 deepseek-official）与 Chat Completions（OpenAI 兼容、opencode）都在它下面。 */
const DEEPSEEK = 'https://api.deepseek.com';
/** opencode 里接 DeepSeek 的上游与 Key 所在的环境变量（配置里写 `{env:…}`，Key 不进配置文本）。 */
const OPENCODE_UPSTREAM = 'wevir-deepseek';
const OPENCODE_KEY_ENV = 'WEVIR_CONTINUITY_DEEPSEEK_KEY';
const OPENCODE_MODEL = `${OPENCODE_UPSTREAM}/${MODEL}`;
/** 经网关 Chat 转换的 Provider（同本机已登记的“DeepSeek（OpenAI 兼容）”，只是地址换成记录代理）。 */
const GATEWAY_PROVIDER = 'deepseek-chat';

let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  if (ENABLED)
    console.warn('[continuity] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定的 app-server');
}

// ── 报告与请求上限 ────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const report: Json = {
  generatedAt: new Date().toISOString(),
  commit: gitHead(),
  codexVersion: CODEX_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  model: `deepseek/${MODEL}`,
  opencode: OPENCODE_BIN === undefined ? null : openCodeVersion(OPENCODE_BIN),
  repeat: REPEAT,
  requestCap: REQUEST_CAP,
  scenarios: {},
};

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function openCodeVersion(bin: string): string {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return 'unknown';
  }
}

const REPORT_PATH =
  process.env.WEVIR_CONTINUITY_OUT ||
  join(REPO, '.wevir-dev', 'continuity', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

/** 记下一个场景并立刻写盘：中途停掉也不丢已经跑完的部分。 */
function record(key: string, value: unknown): void {
  (report.scenarios as Json)[key] = value;
  report.requests = requestCounts();
  mkdirSync(resolve(REPORT_PATH, '..'), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

/** 这次运行开过的记录代理：请求上限按它们的合计算。 */
const proxies: { name: string; recorder: Recorder }[] = [];

async function proxy(name: string): Promise<Recorder> {
  const recorder = await startForwardingRecorder(DEEPSEEK);
  proxies.push({ name, recorder });
  return recorder;
}

function requestCounts(): Json {
  const byName: Record<string, number> = {};
  for (const { name, recorder } of proxies)
    byName[name] = (byName[name] ?? 0) + recorder.requests.length;
  return {
    total: proxies.reduce((sum, { recorder }) => sum + recorder.requests.length, 0),
    byName,
  };
}

const overCap = () => (requestCounts().total as number) > REQUEST_CAP;

// ── Host ──────────────────────────────────────────────────────────────

interface Booted {
  home: string;
  client: TestRpcClient;
  workspaceId: string;
  dir: string;
  close(): Promise<void>;
}

/**
 * 起一个产品配置的 Host（CodexRuntime + 读历史 + 联网工具），登记项目 A 与给出的 Provider。给了 `opencode` 时再挂上真实的
 * opencode（数据、配置、缓存都在临时目录里，不碰用户自己的 opencode），只接一个经记录代理到 DeepSeek 的上游。输入建议与离开后
 * 摘要关掉（省请求，与验收无关）。
 */
async function boot(
  providers: Json[],
  options: { deepseekBaseURL?: string; opencodeBaseURL?: string } = {},
): Promise<Booted> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wevir-continuity-')));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  mkdirSync(userHome, { recursive: true });
  const dir = join(root, 'invoice-tools');
  writeProject(dir, PROJECT_A);
  // WEVIR_CONTINUITY_LOG=1 时把 Host 的告警打到标准错误（排查引擎与账号问题；日志会抹掉登记过的密钥）。
  const logger = createLogger(
    process.env.WEVIR_CONTINUITY_LOG === '1'
      ? { level: 'warn', mirror: (line) => process.stderr.write(`${line}\n`) }
      : { level: 'error', mirror: () => {} },
  );
  const web = new WebService({
    settingsFile: homePath(home, 'webFile'),
    mcpDir: homePath(home, 'mcpDir'),
    logger,
  });
  const codex = new CodexRuntime({
    home,
    binary,
    parentEnv: { ...process.env, HOME: userHome },
    logger,
    historyTool: historyToolServer(homePath(home, 'mcpDir'), homePath(home, 'historyDir')),
    webTool: web.tool,
    ...(options.deepseekBaseURL !== undefined && {
      gateway: { deepseekBaseURL: options.deepseekBaseURL },
    }),
  });
  const adapter =
    options.opencodeBaseURL === undefined
      ? codex
      : new EngineRouter([
          {
            name: 'codex',
            adapter: codex,
            kinds: ['deepseek-official', 'openai-compatible', 'google-vertex', 'chatgpt'],
          },
          {
            // 同 engines.ts：opencode 不挂读历史的工具。
            name: 'opencode',
            adapter: new OpenCodeAdapter({
              home,
              logger,
              env: openCodeEnv(join(root, 'opencode'), options.opencodeBaseURL),
            }),
            kinds: ['opencode'],
          },
        ]);
  const host = await startHost({
    home,
    pluginUserHome: userHome,
    adapter,
    engine: 'codex',
    logger,
    web,
  });
  const client = await TestRpcClient.connect(host.url);
  const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
  // 订阅来源（opencode）只对声明了 subscription_kinds 的客户端可见，同桌面端。
  await client.hello(info.token, undefined, {
    provider_kind_chatgpt: true,
    subscription_kinds: true,
  });
  const ping = setInterval(() => void client.call('host.ping').catch(() => {}), 10_000);
  await client.request('settings.update', {
    settings: { promptSuggestions: false, sessionRecap: false },
  });
  for (const provider of providers) await client.request('provider.upsert', provider);
  const workspace = (await client.request('workspace.add', { rootPath: dir })).workspace;
  return {
    home,
    client,
    workspaceId: workspace.id,
    dir: workspace.rootPath,
    close: async () => {
      clearInterval(ping);
      client.ws.terminate();
      await host.shutdown();
      removeTempDir(root);
    },
  };
}

/** 交给 opencode 的环境：同 adapter-opencode 的隔离环境，上游是经记录代理的 DeepSeek（Chat Completions，关掉思考）。 */
function openCodeEnv(root: string, baseURL: string): NodeJS.ProcessEnv {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    lsp: false,
    formatter: false,
    model: OPENCODE_MODEL,
    small_model: OPENCODE_MODEL,
    enabled_providers: [OPENCODE_UPSTREAM],
    provider: {
      [OPENCODE_UPSTREAM]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: { baseURL, apiKey: `{env:${OPENCODE_KEY_ENV}}` },
        models: {
          [MODEL]: {
            name: MODEL,
            tool_call: true,
            reasoning: false,
            limit: { context: 1_000_000, output: 32_000 },
            options: { thinking: { type: 'disabled' } },
          },
        },
      },
    },
  };
  return {
    HOME: root,
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    WEVIR_OPENCODE_BIN: OPENCODE_BIN,
    [OPENCODE_KEY_ENV]: KEY,
  };
}

function deepseek(): Json {
  return {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [
      { id: MODEL, contextWindow: 1_048_576, reasoningEfforts: ['off', 'low', 'high', 'max'] },
    ],
    defaultModelId: MODEL,
    apiKey: KEY,
  };
}

/**
 * 同本机已登记的“DeepSeek（OpenAI 兼容）”（openai-compatible + openai-completions，网关转成 Chat）。地址换成记录代理后网关认不出
 * DeepSeek，所以把它按地址推断的思考格式与回传 reasoning_content 显式写上，其余照旧。
 */
function gatewayProvider(baseURL: string): Json {
  return {
    id: GATEWAY_PROVIDER,
    kind: 'openai-compatible',
    displayName: 'DeepSeek（OpenAI 兼容）',
    api: 'openai-completions',
    baseURL,
    compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
    models: [
      {
        id: MODEL,
        contextWindow: 1_000_000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
    ],
    defaultModelId: MODEL,
    apiKey: KEY,
  };
}

// ── 回合 ──────────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  input: unknown;
  status?: string;
  output?: string;
}

interface TurnResult {
  turnId: string;
  outcome: string;
  /** 回合里第一条与最后一条事件的 seq。 */
  fromSeq: number;
  toSeq: number;
  finalText: string;
  tools: ToolCall[];
  approvals: number;
  lastEvents?: string[];
}

const subscriptions = new WeakMap<TestRpcClient, Map<string, string>>();

async function subscribe(client: TestRpcClient, sessionId: string): Promise<string> {
  let byClient = subscriptions.get(client);
  if (byClient === undefined) {
    byClient = new Map();
    subscriptions.set(client, byClient);
  }
  let id = byClient.get(sessionId);
  if (id === undefined) {
    id = (await client.request('events.subscribe', { sessionId, sinceSeq: 0 }))
      .subscriptionId as string;
    byClient.set(sessionId, id);
  }
  return id;
}

async function eventsOf(client: TestRpcClient, sessionId: string): Promise<WevirEvent[]> {
  return client.events(await subscribe(client, sessionId));
}

/** 发一条消息、等回合结束；审批一律允许、问题一律跳过；超过请求上限或超时时停掉回合。 */
async function runTurn(
  client: TestRpcClient,
  sessionId: string,
  text: string,
  options: { clientMessageId?: string; timeoutMs?: number } = {},
): Promise<TurnResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const id = await subscribe(client, sessionId);
  const { turnId } = await client.request('session.send', {
    sessionId,
    content: [{ type: 'text', text }],
    ...(options.clientMessageId !== undefined && { clientMessageId: options.clientMessageId }),
  });
  const answered = new Set<string>();
  const all = () => client.events(id);
  const ofTurn = () =>
    all().filter((event) => (event.payload as { turnId?: string }).turnId === turnId);
  const respond = () => {
    for (const event of all()) {
      if (event.type === 'approval.requested') {
        const { approval } = event.payload;
        if (approval.turnId !== turnId || answered.has(approval.id)) continue;
        answered.add(approval.id);
        const option = approval.options.find((entry) => entry.category === 'allow');
        if (option !== undefined) {
          void client
            .request('approval.respond', { approvalId: approval.id, optionId: option.optionId })
            .catch(() => {});
        }
      } else if (event.type === 'question.requested') {
        const { question } = event.payload;
        if (question.turnId !== turnId || answered.has(question.id)) continue;
        answered.add(question.id);
        void client
          .request('question.respond', { questionId: question.id, answers: {} })
          .catch(() => {});
      }
    }
  };
  let finished: WevirEvent | undefined;
  let capped = false;
  try {
    await client.until(
      () => {
        respond();
        finished = ofTurn().find((event) => event.type === 'turn.finished');
        if (finished === undefined && overCap()) capped = true;
        return finished ?? (capped ? true : undefined);
      },
      `turn ${turnId}`,
      timeoutMs,
    );
  } catch {
    // 超时：下面停掉回合，如实记成 timeout。
  }
  if (finished === undefined) await client.request('session.cancel', { sessionId }).catch(() => {});
  const events = ofTurn();
  const finishedTools = new Map<string, { status: string; output?: string }>();
  for (const event of events) {
    if (event.type !== 'tool.finished') continue;
    finishedTools.set(event.payload.toolCallId, {
      status: event.payload.status,
      ...(event.payload.output !== undefined && {
        output: event.payload.output.text.slice(0, 600),
      }),
    });
  }
  const tools: ToolCall[] = events.flatMap((event) =>
    event.type === 'tool.started'
      ? [
          {
            name: event.payload.toolName,
            // Codex 的 MCP 调用把参数放在 `arguments` 里。
            input:
              (event.payload.input as { arguments?: unknown } | null)?.arguments ??
              event.payload.input,
            ...finishedTools.get(event.payload.toolCallId),
          },
        ]
      : [],
  );
  const messages = events.filter(
    (event): event is Extract<WevirEvent, { type: 'assistant.message' }> =>
      event.type === 'assistant.message',
  );
  const userMessage = all().find(
    (event) =>
      event.type === 'user.message' && (event.payload as { turnId?: string }).turnId === turnId,
  );
  return {
    turnId,
    outcome:
      finished?.type === 'turn.finished'
        ? finished.payload.outcome
        : capped
          ? 'aborted_request_cap'
          : 'timeout',
    fromSeq: userMessage?.seq ?? events[0]?.seq ?? 0,
    toSeq: events.at(-1)?.seq ?? 0,
    finalText: messages.at(-1)?.payload.text.slice(0, 800) ?? '',
    tools,
    approvals: answered.size,
    ...(finished === undefined && {
      lastEvents: all()
        .slice(-12)
        .map((event) => event.type),
    }),
  };
}

async function newSession(client: TestRpcClient, workspaceId: string, providerId: string) {
  const { session } = await client.request('session.create', {
    workspaceId,
    providerId,
    permissionMode: 'on_request',
  });
  return session.id as string;
}

/** 调用并取错误码与数据；成功时 `ok: true`。 */
async function attempt(client: TestRpcClient, method: string, params: unknown) {
  try {
    return { ok: true as const, result: await client.request(method, params) };
  } catch (error) {
    const { code, data, message } = error as { code?: number; data?: unknown; message: string };
    return { ok: false as const, code, data, message };
  }
}

// ── 请求体 ────────────────────────────────────────────────────────────

/** 带工具的请求（Agent 的回合）；标题这类辅助请求不带工具。 */
const agentRequests = (recorder: Recorder, from = 0) =>
  recorder.requests.slice(from).filter((request) => {
    const tools = request.body.tools;
    return Array.isArray(tools) && tools.length > 0;
  });

/** 请求体里第一段含 `marker` 的文本，从 `marker` 起。 */
function textFrom(body: unknown, marker: string): string | undefined {
  let found: string | undefined;
  const walk = (value: unknown) => {
    if (found !== undefined) return;
    if (typeof value === 'string') {
      const at = value.indexOf(marker);
      if (at >= 0) found = value.slice(at);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(body);
  return found;
}

/** 请求里的记忆索引：字节数与条目名。 */
function memoryIndexOf(body: unknown): { bytes: number; names: string[] } {
  const found = textFrom(body, 'Saved memory from earlier sessions');
  if (found === undefined) return { bytes: 0, names: [] };
  const names = [...found.matchAll(/^- \[(global|project)\] ([a-z0-9-]+) /gm)].map(
    (match) => `${match[1]}/${match[2]}`,
  );
  return { bytes: Buffer.byteLength(found), names };
}

/** 请求体里的接力材料（到 `User message:` 为止）。 */
function materialOf(body: unknown): string | undefined {
  const text = textFrom(body, 'Context handoff');
  if (text === undefined) return undefined;
  const end = text.indexOf('\n\nUser message:');
  return end < 0 ? text : text.slice(0, end);
}

function noteFile(home: string, workspaceId: string, name: string): string | undefined {
  try {
    return readFileSync(join(home, 'memory', 'projects', workspaceId, `${name}.md`), 'utf8');
  } catch {
    return undefined;
  }
}

function noteNames(home: string, workspaceId: string): string[] {
  try {
    return readdirSync(join(home, 'memory', 'projects', workspaceId))
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

function frontmatter(text: string | undefined): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text ?? '')?.[1] ?? '';
  return Object.fromEntries(
    block
      .split('\n')
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .flatMap((match) => (match === null ? [] : [[match[1], match[2]]])),
  );
}

const memoryCalls = (turn: TurnResult) =>
  turn.tools.filter((tool) => /wevir_memory_/.test(tool.name));

/** 一条新格式的项目笔记（同 MemoryStore 写的格式，没有来源字段）。 */
function note(name: string, description: string, content: string, disabled = false) {
  return {
    name,
    text: [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'type: project',
      'updated: 2026-10-01T09:00:00.000Z',
      ...(disabled ? ['disabled: true'] : []),
      '---',
      '',
      content,
      '',
    ].join('\n'),
  };
}

// ── 场景 ──────────────────────────────────────────────────────────────

const ACK_ONLY = '只回复“ok”两个字母，不要调用任何工具，也不要改文件。';
const REVIVE_PROMPT =
  '请用 wevir_memory_save 保存一条项目笔记：scope 为 project，name 必须是 release-checklist，type 为 project，description 写“发布前先跑 npm test”，content 写“发布前先跑 npm test，全部通过再打 tag。”。名字只能用 release-checklist，不要换别的名字；如果保存失败，就把失败原因原样告诉我，不要再试别的办法，不要改文件。';
const SAVE_PROMPT =
  '请把这条约定存成项目笔记（用 wevir_memory_save，scope 为 project，name 用 rounding-rule，type 为 project）：折扣先换算成整数分再计算，四舍五入只在最后一步做一次。存好后回复“已保存”，不要改文件。';
const OVERWRITE_PROMPT =
  '把项目笔记 rounding-rule 更新一下：description 改成“折扣与税额都按整数分计算”，content 也照此改写。请直接调用 wevir_memory_save 写入，先不要读它；如果工具返回冲突，就按提示先用 wevir_memory_read 读出最新内容，合并后再保存。不要改文件。';
const TAX_NOTE = note(
  'tax-rate',
  'Tax rate constant: TAX_RATE_BPS = 600 (basis points)',
  '税率写成常量 `const TAX_RATE_BPS = 600;`（基点，即 6%），税额 = 金额（分）× TAX_RATE_BPS / 10000，最后一步四舍五入。\nWhy: 以后税率要按地区配置。\nHow to apply: 新的税额函数都用这个常量，不要写 0.06。',
);
const BACK_PROMPT =
  '用一两句话说明刚才在另一个来源里对 src/invoice.js 做了什么，不要改文件，不要调用工具。';
const CODENAME = 'amber-heron';
const CODENAME_NOTE = note(
  'release-codename',
  `The next release is code-named ${CODENAME}; release notes titles start with it`,
  `下一个版本的代号是 ${CODENAME}，发布说明的标题必须以这个代号开头。`,
);
const CODENAME_PROMPT =
  '下一个版本的代号是什么？发布说明的标题应该怎么开头？只根据你已经知道的信息回答，不要调用任何工具，不要改文件。';

const run = ENABLED && KEY !== undefined && binary !== undefined && process.platform !== 'win32';

describe.skipIf(!run)(`真实引擎验收：deepseek/${MODEL}`, () => {
  afterAll(() => {
    report.requests = requestCounts();
    console.log(`\n[continuity] 报告：${REPORT_PATH}\n${JSON.stringify(report, null, 2)}`);
  });

  it(`记忆管理：停用的笔记不进索引、Agent 不能同名复活、关掉自动记忆后没有工具与索引 ×${REPEAT}`, {
    timeout: REPEAT * 900_000,
  }, async () => {
    const runs: Json[] = [];
    for (let i = 0; i < REPEAT && !overCap(); i++) {
      const recorder = await proxy('memory-manage');
      const host = await boot([deepseek()], { deepseekBaseURL: recorder.baseURL });
      try {
        const { client, home, workspaceId } = host;
        seedProjectNote(
          home,
          workspaceId,
          note('integer-cents', 'Amounts are integer cents', '金额一律用整数分。'),
        );
        seedProjectNote(
          home,
          workspaceId,
          note('release-checklist', 'Old release steps (replaced)', '发布前手动打包再上传。'),
        );
        await client.request('memory.setEnabled', {
          scope: 'project',
          workspaceId,
          name: 'release-checklist',
          enabled: false,
        });
        const disabledBefore = noteFile(home, workspaceId, 'release-checklist');
        const namesBefore = noteNames(home, workspaceId);

        const session = await newSession(client, workspaceId, 'deepseek-official');
        const ack = await runTurn(client, session, ACK_ONLY);
        const index = memoryIndexOf(agentRequests(recorder)[0]?.body);
        expect.soft(index.names).toContain('project/integer-cents');
        expect.soft(index.names).not.toContain('project/release-checklist');

        const revive = await runTurn(client, session, REVIVE_PROMPT);
        const disabledAfter = noteFile(home, workspaceId, 'release-checklist');
        expect.soft(disabledAfter).toBe(disabledBefore);
        const saves = memoryCalls(revive).filter((tool) => tool.name.endsWith('wevir_memory_save'));

        await client.request('settings.update', { settings: { autoMemory: false } });
        const before = recorder.requests.length;
        const off = await runTurn(
          client,
          await newSession(client, workspaceId, 'deepseek-official'),
          ACK_ONLY,
        );
        const offRequest = agentRequests(recorder, before)[0]?.body;
        const offTools = responsesCatalog(offRequest ?? {}).names.filter((name) =>
          name.includes('wevir_memory_'),
        );
        const offIndex = memoryIndexOf(offRequest);
        expect.soft(offRequest).toBeDefined();
        expect.soft(offTools).toEqual([]);
        expect.soft(offIndex.bytes).toBe(0);
        await client.request('settings.update', { settings: { autoMemory: true } });

        runs.push({
          disabledNotInIndex: {
            indexNames: index.names,
            pass:
              index.names.includes('project/integer-cents') &&
              !index.names.includes('project/release-checklist'),
            outcome: ack.outcome,
          },
          reviveBlocked: {
            /** Agent 试过同名保存（模型行为，不作判定）。 */
            attempted: saves.some(
              (tool) => (tool.input as { name?: string })?.name === 'release-checklist',
            ),
            saves: saves.map(({ input, status, output }) => ({ input, status, output })),
            /** Host 的判定：停用笔记的文件逐字节不变（仍停用、正文没变）。 */
            fileUnchanged: disabledAfter === disabledBefore,
            stillDisabled: /\ndisabled: true\n/.test(disabledAfter ?? ''),
            notesBefore: namesBefore,
            notesAfter: noteNames(home, workspaceId),
            finalText: revive.finalText,
            outcome: revive.outcome,
          },
          autoMemoryOff: {
            requestFound: offRequest !== undefined,
            memoryTools: offTools,
            indexBytes: offIndex.bytes,
            pass: offRequest !== undefined && offTools.length === 0 && offIndex.bytes === 0,
            outcome: off.outcome,
          },
          requests: recorder.requests.length,
        });
        record('memoryManage', { partial: true, runs });
      } finally {
        await host.close();
        await recorder.close();
      }
    }
    record('memoryManage', { runs });
  });

  it(`记忆来源与修订：Agent 写入的来源、用户改后旧版本冲突、撤回与删除的来源状态 ×${REPEAT}`, {
    timeout: REPEAT * 900_000,
  }, async () => {
    const runs: Json[] = [];
    for (let i = 0; i < REPEAT && !overCap(); i++) {
      const recorder = await proxy('memory-source');
      const host = await boot([deepseek()], { deepseekBaseURL: recorder.baseURL });
      try {
        const { client, home, workspaceId } = host;
        const target = { scope: 'project', workspaceId, name: 'rounding-rule' };
        const session = await newSession(client, workspaceId, 'deepseek-official');
        const save = await runTurn(client, session, SAVE_PROMPT);
        const saved = await attempt(client, 'memory.read', target);
        const origin = saved.ok ? saved.result.note.origin : undefined;
        const originOk =
          origin?.by === 'agent' &&
          origin.sessionId === session &&
          origin.turnId === save.turnId &&
          typeof origin.seq === 'number' &&
          origin.seq >= save.fromSeq &&
          origin.seq <= save.toSeq;
        expect.soft(saved.ok).toBe(true);
        if (saved.ok) expect.soft(originOk).toBe(true);
        const savedFile = frontmatter(noteFile(home, workspaceId, 'rounding-rule'));

        // 用户在管理端改：带当前版本写入，记成用户编辑。
        const userLine = '用户补充：税额同样按整数分计算。';
        const edited = saved.ok
          ? await client.request('memory.update', {
              ...target,
              revision: saved.result.note.revision,
              content: `${saved.result.note.content.trimEnd()}\n${userLine}`,
            })
          : undefined;
        expect.soft(edited?.conflict).toBeUndefined();
        expect.soft(edited?.note.lastEdit?.by).toBe('user');

        const overwrite = await runTurn(client, session, OVERWRITE_PROMPT);
        const calls = memoryCalls(overwrite);
        const firstSave = calls.findIndex((tool) => tool.name.endsWith('wevir_memory_save'));
        const conflictAt = calls.findIndex(
          (tool) =>
            tool.name.endsWith('wevir_memory_save') &&
            /read it|wevir_memory_read|changed|last saved|conflict/i.test(tool.output ?? ''),
        );
        const okSaveAfter = calls.findIndex(
          (tool, index) =>
            index > conflictAt &&
            tool.name.endsWith('wevir_memory_save') &&
            tool.status === 'completed' &&
            !/read it|wevir_memory_read first|conflict/i.test(tool.output ?? ''),
        );
        const readBetween =
          conflictAt >= 0 &&
          calls.some(
            (tool, index) =>
              index > conflictAt &&
              (okSaveAfter < 0 || index < okSaveAfter) &&
              tool.name.endsWith('wevir_memory_read'),
          );
        const afterOverwrite = await attempt(client, 'memory.read', target);
        const lastEdit = afterOverwrite.ok ? afterOverwrite.result.note.lastEdit : undefined;
        /** 冲突被触发（模型没先读就写）时，Host 必须拒绝那次写入；后来写成功的那一次必须在重读之后。 */
        const conflictExercised = firstSave >= 0 && firstSave === conflictAt;
        if (conflictExercised && okSaveAfter >= 0) expect.soft(readBetween).toBe(true);

        // 撤回：撤销最近的回合（Agent 最近一次写入所在的回合）；删除：归档后删掉会话。
        const undo = await attempt(client, 'session.undo', { sessionId: session });
        const afterUndo = await attempt(client, 'memory.read', target);
        const agentWroteLast = lastEdit?.by === 'agent' && lastEdit.turnId === overwrite.turnId;
        if (undo.ok && agentWroteLast && afterUndo.ok) {
          expect.soft(afterUndo.result.note.lastEdit?.status).toBe('withdrawn');
          expect.soft(afterUndo.result.note.origin?.status ?? 'available').toBe('available');
        }
        await client.request('session.archive', { sessionId: session, archived: true });
        const deleted = await attempt(client, 'session.delete', {
          sessionId: session,
          force: true,
        });
        const afterDelete = await attempt(client, 'memory.read', target);
        if (deleted.ok && afterDelete.ok)
          expect.soft(afterDelete.result.note.origin?.status).toBe('deleted');

        runs.push({
          agentWrite: {
            saveCalls: memoryCalls(save).map(({ name, status }) => ({ name, status })),
            origin,
            turn: { turnId: save.turnId, fromSeq: save.fromSeq, toSeq: save.toSeq },
            frontmatter: savedFile,
            pass: originOk,
          },
          userEdit: { conflict: edited?.conflict ?? false, lastEditBy: edited?.note.lastEdit?.by },
          staleRevision: {
            calls: calls.map(({ name, input, status, output }) => ({
              name,
              input,
              status,
              output,
            })),
            /** 模型没先读就写（模型行为）。没触发时冲突路径这一轮没验到。 */
            conflictExercised,
            conflictReturned: conflictAt >= 0,
            rereadBeforeWrite: readBetween,
            savedAfterReread: okSaveAfter >= 0,
            lastEdit,
            /** 合并后用户那一句是否原样留下（模型行为）。 */
            userLineVerbatim:
              afterOverwrite.ok && afterOverwrite.result.note.content.includes(userLine),
            outcome: overwrite.outcome,
          },
          withdrawn: {
            undo: undo.ok ? 'ok' : undo.message,
            applicable: agentWroteLast,
            lastEdit: afterUndo.ok ? afterUndo.result.note.lastEdit : afterUndo.message,
            origin: afterUndo.ok ? afterUndo.result.note.origin : undefined,
          },
          deleted: {
            delete: deleted.ok ? 'ok' : deleted.message,
            origin: afterDelete.ok ? afterDelete.result.note.origin : afterDelete.message,
            lastEdit: afterDelete.ok ? afterDelete.result.note.lastEdit : undefined,
          },
          requests: recorder.requests.length,
        });
        record('memorySource', { partial: true, runs });
      } finally {
        await host.close();
        await recorder.close();
      }
    }
    record('memorySource', { runs });
  });

  it.skipIf(OPENCODE_BIN === undefined)(
    `跨引擎接力：Codex → OpenCode 全量（必须项、选入笔记、预览过期、重试），OpenCode → Codex 增量 ×${REPEAT}`,
    { timeout: REPEAT * 1_200_000 },
    async () => {
      const runs: Json[] = [];
      for (let i = 0; i < REPEAT && !overCap(); i++) {
        const codexProxy = await proxy('handoff-codex');
        const openCodeProxy = await proxy('handoff-opencode');
        const host = await boot([deepseek()], {
          deepseekBaseURL: codexProxy.baseURL,
          opencodeBaseURL: openCodeProxy.baseURL,
        });
        try {
          const { client, home, workspaceId, dir } = host;
          seedProjectNote(home, workspaceId, TAX_NOTE);
          // 启动时后台读一遍 opencode 的账号，接上了上游就建好 Provider。
          await vi
            .waitFor(
              async () => {
                const { providers } = await client.request('provider.list');
                expect((providers as { id: string }[]).map((provider) => provider.id)).toContain(
                  'opencode',
                );
              },
              { timeout: 120_000, interval: 1_000 },
            )
            .catch(async (error: unknown) => {
              const accounts = await attempt(client, 'account.list', {});
              record('handoffSetup', { error: String(error), accounts });
              throw error;
            });
          const session = await newSession(client, workspaceId, 'deepseek-official');
          const ack = await runTurn(client, session, HANDOFF_CONSTRAINTS);
          const noteRevision = (
            await client.request('memory.read', {
              scope: 'project',
              workspaceId,
              name: TAX_NOTE.name,
            })
          ).note.revision as string;
          const handoff = {
            constraints: [HANDOFF_CONSTRAINTS],
            notes: [{ scope: 'project', name: TAX_NOTE.name }],
          };
          const toOpenCode = {
            sessionId: session,
            providerId: 'opencode',
            modelId: OPENCODE_MODEL,
          };

          const first = await client.request('session.handoffPreview', {
            sessionId: session,
            providerId: 'opencode',
            handoff,
          });
          // 预览之后插入一个新事件（改标题）：旧预览不得原样通过。
          await client.request('session.rename', { sessionId: session, title: '接力验收' });
          const stale = await attempt(client, 'session.configure', {
            ...toOpenCode,
            handoff: { ...handoff, binding: first.binding },
          });
          expect.soft(stale.ok).toBe(false);
          if (!stale.ok) {
            expect.soft(stale.code).toBe(-32026);
            expect.soft((stale.data as { reasons?: string[] })?.reasons).toContain('events');
          }
          const eventsAfterStale = (await eventsOf(client, session)).filter(
            (event) => event.type === 'session.handoff',
          ).length;
          const fresh = await client.request('session.handoffPreview', {
            sessionId: session,
            providerId: 'opencode',
            handoff,
          });
          const preview = fresh.preview;
          await client.request('session.configure', {
            ...toOpenCode,
            handoff: { ...handoff, binding: fresh.binding },
          });
          const handoffEvents = (await eventsOf(client, session)).filter(
            (event): event is Extract<WevirEvent, { type: 'session.handoff' }> =>
              event.type === 'session.handoff',
          );
          const toB = handoffEvents.at(-1)?.payload;
          expect.soft(eventsAfterStale).toBe(0);
          expect.soft(preview.strategy).toBe('full_thread_summary');
          expect.soft(preview.historyTool).toBe(false);
          expect.soft(preview.context ?? '').toContain(HANDOFF_CONSTRAINTS);
          expect
            .soft(preview.notes)
            .toEqual([{ scope: 'project', name: TAX_NOTE.name, revision: noteRevision }]);
          expect.soft(toB?.strategy).toBe('full_thread_summary');
          expect.soft(toB?.hash).toBe(preview.hash);
          expect.soft(toB?.context).toBe(preview.context);
          expect.soft(toB?.notes).toEqual(preview.notes);
          expect.soft(toB?.historyTool).toBe(false);

          const beforeTask = openCodeProxy.requests.length;
          const clientMessageId = `continuity-task-${i}`;
          const task = await runTurn(client, session, HANDOFF_TASK, {
            clientMessageId,
            timeoutMs: 540_000,
          });
          const delivered = materialOf(openCodeProxy.requests[beforeTask]?.body);
          // opencode 每个请求都带着整段对话，材料随第一条用户消息出现在之后的每个请求里；重复附加是指一个请求里出现两份。
          const materialCopies = openCodeProxy.requests
            .slice(beforeTask)
            .map((request) => JSON.stringify(request.body).split('Context handoff').length - 1);
          // 重试：同一 clientMessageId 再发一次，返回原回合，不再发给引擎、不重复附加。
          const afterTask = openCodeProxy.requests.length;
          const retry = await client.request('session.send', {
            sessionId: session,
            content: [{ type: 'text', text: HANDOFF_TASK }],
            clientMessageId,
          });
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          const userMessages = (await eventsOf(client, session)).filter(
            (event) => event.type === 'user.message',
          ).length;
          const retryOk =
            retry.turnId === task.turnId && openCodeProxy.requests.length === afterTask;
          expect.soft(retryOk).toBe(true);
          const marker = `[memory; scope=project; name=${TAX_NOTE.name}; revision=${noteRevision}]`;
          const deliveredChecks = {
            found: delivered !== undefined,
            equalsPreview: delivered === preview.context,
            constraintWhole: delivered?.includes(HANDOFF_CONSTRAINTS) === true,
            mustCarry:
              delivered?.includes(`[user; must_carry; constraint=1]\n${HANDOFF_CONSTRAINTS}`) ===
              true,
            noteWithRevision: delivered?.includes(marker) === true,
            mentionsHistoryTool: delivered?.includes('read_session_history') === true,
            copiesPerRequest: materialCopies,
          };
          expect.soft(deliveredChecks.constraintWhole).toBe(true);
          expect.soft(deliveredChecks.noteWithRevision).toBe(true);
          expect.soft(deliveredChecks.mentionsHistoryTool).toBe(false);
          expect.soft(materialCopies.every((copies) => copies === 1)).toBe(true);
          const result = checkHandoffResult(dir);
          const code = readFileSync(join(dir, 'src', 'invoice.js'), 'utf8');

          // 换回 Codex：接着用以前的引擎会话，只交换过去之后的新内容。
          const backPreview = await client.request('session.handoffPreview', {
            sessionId: session,
            providerId: 'deepseek-official',
          });
          await client.request('session.configure', {
            sessionId: session,
            providerId: 'deepseek-official',
            modelId: MODEL,
            handoff: { binding: backPreview.binding },
          });
          const back = (await eventsOf(client, session))
            .filter(
              (event): event is Extract<WevirEvent, { type: 'session.handoff' }> =>
                event.type === 'session.handoff',
            )
            .at(-1)?.payload;
          const beforeBack = codexProxy.requests.length;
          const backTurn = await runTurn(client, session, BACK_PROMPT);
          const backMaterial = materialOf(agentRequests(codexProxy, beforeBack)[0]?.body);
          // 增量：从 Codex 最后看到的事件（确认回合结束）之后起，含 OpenCode 上的那个回合。
          const fromSeq = back?.covered?.fromSeq ?? 0;
          const coversDelta = fromSeq > ack.toSeq && fromSeq <= task.fromSeq;
          expect.soft(backPreview.preview.strategy).toBe('delta_since_target_last_seen');
          expect.soft(backPreview.preview.historyTool).toBe(true);
          expect.soft(back?.strategy).toBe('delta_since_target_last_seen');
          expect.soft(coversDelta).toBe(true);
          expect.soft(backMaterial).toBe(back?.context);

          runs.push({
            ack: { outcome: ack.outcome, text: ack.finalText.slice(0, 200) },
            stalePreview: {
              rejected: !stale.ok,
              code: stale.ok ? undefined : stale.code,
              reasons: stale.ok ? undefined : (stale.data as { reasons?: string[] })?.reasons,
              handoffEventsWritten: eventsAfterStale,
            },
            toOpenCode: {
              preview: {
                strategy: preview.strategy,
                resumed: preview.resumed,
                historyTool: preview.historyTool,
                bytes: preview.bytes,
                items: preview.items,
                omittedItems: preview.omittedItems,
                constraints: preview.constraints,
                notes: preview.notes,
              },
              event: toB && {
                strategy: toB.strategy,
                historyTool: toB.historyTool,
                bytes: toB.bytes,
                hash: toB.hash,
                notes: toB.notes,
                constraints: toB.constraints,
                matchesPreview: toB.hash === preview.hash && toB.context === preview.context,
              },
              delivered: deliveredChecks,
              /** 目标模型是否照做（只记录，不作 Host 判定）。 */
              followed: {
                ...result,
                constraintFollowed: result.snakeCase && result.specComment,
                noteFollowed: /TAX_RATE_BPS\s*=\s*600/.test(code),
                usesFloatRate: /0\.06/.test(code),
              },
              task: {
                outcome: task.outcome,
                tools: task.tools.map((tool) => tool.name),
                approvals: task.approvals,
              },
              retry: {
                sameTurn: retry.turnId === task.turnId,
                newRequests: openCodeProxy.requests.length - afterTask,
                userMessages,
                pass: retryOk,
              },
            },
            backToCodex: {
              preview: {
                strategy: backPreview.preview.strategy,
                resumed: backPreview.preview.resumed,
                historyTool: backPreview.preview.historyTool,
                covered: backPreview.preview.covered,
              },
              event: back && {
                strategy: back.strategy,
                covered: back.covered,
                historyTool: back.historyTool,
                bytes: back.bytes,
              },
              coversDelta,
              codexLastSeen: ack.toSeq,
              openCodeTurnFrom: task.fromSeq,
              deliveredEqualsEvent: backMaterial !== undefined && backMaterial === back?.context,
              outcome: backTurn.outcome,
              answer: backTurn.finalText.slice(0, 300),
            },
            requests: {
              codex: codexProxy.requests.length,
              opencode: openCodeProxy.requests.length,
            },
          });
          record('handoff', { partial: true, runs });
        } finally {
          await host.close();
          await Promise.all([codexProxy.close(), openCodeProxy.close()]);
        }
      }
      record('handoff', { runs });
    },
  );

  it(`网关模型：记忆材料经 Chat 转换送到模型，回答体现材料 ×${REPEAT}`, {
    timeout: REPEAT * 600_000,
  }, async () => {
    const runs: Json[] = [];
    for (let i = 0; i < REPEAT && !overCap(); i++) {
      const recorder = await proxy('gateway-chat');
      const host = await boot([gatewayProvider(recorder.baseURL)]);
      try {
        const { client, home, workspaceId } = host;
        seedProjectNote(home, workspaceId, CODENAME_NOTE);
        const session = await newSession(client, workspaceId, GATEWAY_PROVIDER);
        const turn = await runTurn(client, session, CODENAME_PROMPT);
        const request = agentRequests(recorder)[0];
        const messages = (request?.body.messages ?? []) as { role?: string; content?: unknown }[];
        const system = JSON.stringify(messages.filter((message) => message.role === 'system'));
        const delivered = {
          chatRequest: request?.path ?? null,
          mcpNotesInSystem: system.includes('# Instructions from MCP servers'),
          indexInSystem: system.includes('Saved memory from earlier sessions'),
          noteInIndex: system.includes('release-codename'),
          codenameInRequest: system.includes(CODENAME),
        };
        expect.soft(delivered.mcpNotesInSystem).toBe(true);
        expect.soft(delivered.noteInIndex).toBe(true);
        runs.push({
          delivered,
          reflected: {
            mentionsCodename: turn.finalText.includes(CODENAME),
            answer: turn.finalText.slice(0, 300),
          },
          tools: turn.tools.map((tool) => tool.name),
          outcome: turn.outcome,
          requests: recorder.requests.length,
        });
        record('gateway', { partial: true, runs });
      } finally {
        await host.close();
        await recorder.close();
      }
    }
    record('gateway', { runs });
  });
});
