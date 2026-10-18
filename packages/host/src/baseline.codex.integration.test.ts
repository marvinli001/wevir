// 基线测量：真实 Host + 真实 codex-app-server（同产品：CodexRuntime、读历史与联网工具），固定材料见 test-fixtures/baseline.ts。
// 平时跳过；改动记忆、接力或工具目录前后各跑一次，比较报告：
//
//   WEVIR_BASELINE=1 pnpm vitest run --project host baseline
//
// 本地假模型的部分总是跑（结果是确定的）：每个角色与每种上游协议实际发出的工具数与字节、记忆在 A / B 两个项目间是否串、旧格式
// 笔记能否读、长约定交给新来源时是否被摘要截断。另设 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER=deepseek-official 时加跑真实
// 模型（每个场景 WEVIR_BASELINE_REPEAT 次，默认 3）：C0 修 bug（独立核对文件与测试，不看模型怎么说）、记忆的保存与再用、接力后
// 是否还守最后一条约定。真实模型的请求经本地记录代理转发，Key 只在请求头里，不进报告。报告写到 WEVIR_BASELINE_OUT（默认
// .wevir-dev/baseline/<时刻>.json），摘要打印到标准输出。

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
import {
  defaultMockScript,
  type MockRequestBody,
  type MockScript,
  type MockToolCall,
  type MockView,
  startMockModel,
  viewOf,
} from '@wevir/adapter-codex/testing';
import { PROTOCOL_VERSION, type WevirEvent } from '@wevir/protocol';
import { historyToolServer } from '@wevir/runtime-adapter/history-tool';
import { afterAll, describe, expect, it } from 'vitest';
import { homePath } from './home.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import {
  C0_PROMPT,
  type CatalogStats,
  chatCatalog,
  checkC0,
  checkHandoffResult,
  HANDOFF_CONSTRAINTS,
  HANDOFF_TAIL_MARKER,
  HANDOFF_TASK,
  MEMORY_CORRECTION,
  MEMORY_CROSSTALK,
  MEMORY_FOLLOW_UP,
  MEMORY_KEYWORD,
  messagesCatalog,
  PROJECT_A,
  PROJECT_B,
  reportsLintFailure,
  responsesCatalog,
  STALE_NOTE,
  seedProjectNote,
  startChatRecorder,
  startForwardingRecorder,
  startMessagesRecorder,
  writeProject,
} from './test-fixtures/baseline.js';
import { removeTempDir, TestRpcClient } from './test-utils.js';
import { WebService } from './web/service.js';

const ENABLED = process.env.WEVIR_BASELINE === '1';
const REPEAT = Math.max(1, Number(process.env.WEVIR_BASELINE_REPEAT ?? 3) || 3);
const REPO = resolve(import.meta.dirname, '..', '..', '..');
/** 网关里 DeepSeek 官方的 Responses 地址（model-gateway 的 DEEPSEEK_RESPONSES_BASE_URL）。 */
const DEEPSEEK = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.WEVIR_TEST_MODEL || 'deepseek-flash';
const REAL_KEY =
  process.env.WEVIR_TEST_PROVIDER === 'deepseek-official'
    ? process.env.WEVIR_TEST_API_KEY || undefined
    : undefined;
/** 只认标题请求：交给默认脚本回 JSON 标题。 */
const TITLE_PROMPT = '你为 Wevir 的会话起标题';
const ROLES = ['explorer', 'planner', 'reviewer', 'advisor', 'worker'] as const;

let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  if (ENABLED)
    console.warn('[baseline] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定的 app-server');
}

// ── 报告 ──────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const report: Json = {
  generatedAt: new Date().toISOString(),
  commit: gitHead(),
  codexVersion: CODEX_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  unmeasured: [
    '订阅来源的引擎（Claude、Cursor、OpenCode、Grok、Antigravity、WorkBuddy）：本机没有这些客户端与账号，工具目录与接力未测',
    'ChatGPT 登录的 Codex：未测',
    'Windows、Linux：未测',
  ],
  mock: {},
  ...(REAL_KEY !== undefined && { real: { model: `deepseek-official/${DEEPSEEK_MODEL}` } }),
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

const REPORT_PATH =
  process.env.WEVIR_BASELINE_OUT ||
  join(REPO, '.wevir-dev', 'baseline', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

/** 记下一节并立刻写盘：中途停掉（超时、手动中止）也不丢已经跑完的部分。 */
function section(path: 'mock' | 'real', key: string, value: unknown): void {
  (report[path] as Json)[key] = value;
  mkdirSync(resolve(REPORT_PATH, '..'), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

/** 真实模型每次运行（一个 Host）最多发多少个模型请求，超过就停掉回合：防止压缩循环一类的失控烧掉额度。 */
const REAL_REQUEST_CAP = Math.max(1, Number(process.env.WEVIR_BASELINE_REQUEST_CAP ?? 30) || 30);

// ── Host ──────────────────────────────────────────────────────────────

interface Project {
  id: string;
  dir: string;
}

interface Booted {
  home: string;
  client: TestRpcClient;
  a: Project;
  b: Project;
  close(): Promise<void>;
}

/** 起一个产品配置的 Host（CodexRuntime + 读历史 + 联网工具），登记项目 A、B 与给出的 Provider。 */
async function boot(
  providers: Json[],
  options: { deepseekBaseURL?: string } = {},
): Promise<Booted> {
  const root = mkdirTemp();
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  mkdirSync(userHome, { recursive: true });
  const dirA = join(root, 'invoice-tools');
  const dirB = join(root, 'reading-list');
  writeProject(dirA, PROJECT_A);
  writeProject(dirB, PROJECT_B);
  const logger = createLogger({ level: 'error', mirror: () => {} });
  const web = new WebService({
    settingsFile: homePath(home, 'webFile'),
    mcpDir: homePath(home, 'mcpDir'),
    logger,
  });
  const adapter = new CodexRuntime({
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
  await client.hello(info.token);
  // 真实模型的回合常超过连接租约（45 s 没有消息就断开），同真正的客户端一样定时 ping。
  const ping = setInterval(() => void client.call('host.ping').catch(() => {}), 10_000);
  for (const provider of providers) await client.request('provider.upsert', provider);
  const a = (await client.request('workspace.add', { rootPath: dirA })).workspace;
  const b = (await client.request('workspace.add', { rootPath: dirB })).workspace;
  return {
    home,
    client,
    a: { id: a.id, dir: a.rootPath },
    b: { id: b.id, dir: b.rootPath },
    close: async () => {
      clearInterval(ping);
      client.ws.terminate();
      await host.shutdown();
      removeTempDir(root);
    },
  };
}

function mkdirTemp(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'wevir-baseline-')));
}

interface TurnResult {
  turnId: string;
  outcome: string;
  durationMs: number;
  approvals: number;
  questions: number;
  /** 超时时最后几条事件的类型。 */
  lastEvents?: string[];
  finalText: string;
  commands: string[];
  tools: { name: string; input: unknown }[];
}

const subscriptions = new WeakMap<TestRpcClient, Map<string, string>>();

/** 发一条消息、等回合结束；途中的审批一律选允许、问题一律跳过（记下次数）；超时时停掉回合，结果记成 `timeout`。 */
async function runTurn(
  client: TestRpcClient,
  sessionId: string,
  text: string,
  timeoutMs: number,
  abortIf?: () => boolean,
): Promise<TurnResult> {
  let byClient = subscriptions.get(client);
  if (byClient === undefined) {
    byClient = new Map();
    subscriptions.set(client, byClient);
  }
  let subscriptionId = byClient.get(sessionId);
  if (subscriptionId === undefined) {
    subscriptionId = (await client.request('events.subscribe', { sessionId, sinceSeq: 0 }))
      .subscriptionId as string;
    byClient.set(sessionId, subscriptionId);
  }
  const id = subscriptionId;
  const { turnId } = await client.request('session.send', {
    sessionId,
    content: [{ type: 'text', text }],
  });
  const answered = new Set<string>();
  const questions = new Set<string>();
  const all = () => client.events(id);
  const ofTurn = () =>
    all().filter((event) => (event.payload as { turnId?: string }).turnId === turnId);
  /** 回合里的审批一律选允许，问题一律跳过（审批与问题的 turnId 在负载里面一层）。 */
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
        if (question.turnId !== turnId || questions.has(question.id)) continue;
        questions.add(question.id);
        void client
          .request('question.respond', { questionId: question.id, answers: {} })
          .catch(() => {});
      }
    }
  };
  let finished: WevirEvent | undefined;
  let aborted = false;
  try {
    await client.until(
      () => {
        respond();
        finished = ofTurn().find((event) => event.type === 'turn.finished');
        if (finished === undefined && abortIf?.() === true) aborted = true;
        return finished ?? (aborted ? true : undefined);
      },
      `turn ${turnId}`,
      timeoutMs,
    );
  } catch {
    // 超时：下面停掉回合，如实记成 timeout（附最后几条事件），不让一次卡住拖垮整份报告。
  }
  if (finished === undefined) {
    await client.request('session.cancel', { sessionId }).catch(() => {});
  }
  const events = ofTurn();
  const started = events.filter(
    (event): event is Extract<WevirEvent, { type: 'tool.started' }> =>
      event.type === 'tool.started',
  );
  const messages = events.filter(
    (event): event is Extract<WevirEvent, { type: 'assistant.message' }> =>
      event.type === 'assistant.message',
  );
  const done = finished as WevirEvent | undefined;
  const payload =
    done?.type === 'turn.finished'
      ? done.payload
      : { outcome: aborted ? 'aborted_request_cap' : 'timeout', durationMs: timeoutMs };
  return {
    turnId,
    outcome: payload.outcome,
    durationMs: payload.durationMs,
    approvals: answered.size,
    questions: questions.size,
    ...(finished === undefined && {
      lastEvents: all()
        .slice(-12)
        .map((event) => event.type),
    }),
    finalText: messages.at(-1)?.payload.text ?? '',
    commands: started.flatMap((event) =>
      event.payload.display.command === undefined ? [] : [event.payload.display.command],
    ),
    tools: started.map((event) => ({ name: event.payload.toolName, input: event.payload.input })),
  };
}

async function newSession(
  client: TestRpcClient,
  workspaceId: string,
  providerId: string,
  permissionMode = 'on_request',
): Promise<string> {
  const { session } = await client.request('session.create', {
    workspaceId,
    providerId,
    permissionMode,
  });
  return session.id as string;
}

/** 回合里调过的记忆工具：`save` / `read` / `list` / `delete` 与参数里的名字。 */
function memoryCalls(turn: TurnResult): string[] {
  return turn.tools.flatMap((tool) => {
    const match = /wevir_memory_(\w+)/.exec(tool.name);
    if (!match) return [];
    const input = (tool.input ?? {}) as { scope?: string; name?: string };
    return [`${match[1]}${input.name === undefined ? '' : ` ${input.scope}/${input.name}`}`];
  });
}

/** 请求体里第一段含 `marker` 的文本，从 `marker` 起；没有时是 `undefined`。 */
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

/** 请求里记忆索引（工具说明后面那一段）的字节数与条目名；没有时是 0 与空表。 */
function memoryIndexOf(body: unknown): { bytes: number; names: string[] } {
  const found = textFrom(body, 'Saved memory from earlier sessions');
  if (found === undefined) return { bytes: 0, names: [] };
  const names = [...found.matchAll(/^- \[(global|project)\] ([a-z0-9-]+) /gm)].map(
    (match) => `${match[1]}/${match[2]}`,
  );
  return { bytes: Buffer.byteLength(found), names };
}

/** 带工具的请求（Agent 的回合）；标题、输入建议这类辅助请求不带工具。 */
const agentRequests = <T extends { body: unknown }>(requests: readonly T[]): T[] =>
  requests.filter((request) => {
    const tools = (request.body as Json).tools;
    return Array.isArray(tools) && tools.length > 0;
  });

function summarize(stats: CatalogStats, withNames = false): Json {
  const byGroup: Record<string, number> = {};
  for (const name of stats.names) {
    const group = /^mcp__([a-z0-9_]+?)__/.exec(name)?.[1] ?? 'engine';
    byGroup[group] = (byGroup[group] ?? 0) + 1;
  }
  return {
    tools: stats.tools,
    toolBytes: stats.toolBytes,
    instructionBytes: stats.instructionBytes,
    requestBytes: stats.requestBytes,
    byGroup,
    ...(withNames && { names: stats.names }),
  };
}

// ── 假模型的脚本 ──────────────────────────────────────────────────────

function findTool(view: MockView, name: string): Pick<MockToolCall, 'name' | 'namespace'> {
  for (const tool of view.body.tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = (tool.tools as Array<{ name?: string }>).find((entry) => entry.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(name)) return { name: tool.name };
  }
  throw new Error(`mock: 请求里没有工具 ${name}`);
}

const call = (view: MockView, name: string, args: Json): MockToolCall => ({
  kind: 'function',
  ...findTool(view, name),
  args,
});

/** 认得几个标记：`[spawn-role:<角色>]` 开角色会话，`[save-notes]` / `[read-stale]` / `[list-notes]` 调记忆工具，其余回“ok”。 */
const script: MockScript = (view) => {
  if (JSON.stringify(view.body).includes(TITLE_PROMPT)) return defaultMockScript(view);
  const prompt = view.lastUserText;
  const done = view.toolOutputs.length > 0;
  const role = /\[spawn-role:([a-z]+)\]/.exec(prompt)?.[1];
  if (role !== undefined && !prompt.includes('[role-probe')) {
    if (done) return { text: ['opened'] };
    return {
      toolCalls: [
        call(view, 'wevir_session_create', {
          role,
          message: `[role-probe:${role}] Reply ok.`,
        }),
      ],
    };
  }
  if (prompt.includes('[save-notes]') && !done) {
    return {
      toolCalls: [
        call(view, 'wevir_memory_save', {
          scope: 'project',
          name: 'invoice-cents',
          type: 'feedback',
          description: 'Discounts are computed in integer cents; round once at the end',
          content:
            'Compute discounts in integer cents and round once, at the end.\nWhy: the user corrected this.\nHow to apply: applyDiscount and new helpers.',
        }),
        call(view, 'wevir_memory_save', {
          scope: 'global',
          name: 'reply-language',
          type: 'user',
          description: 'The user prefers answers in Chinese',
          content: 'Answer in Chinese unless asked otherwise.',
        }),
      ],
    };
  }
  if (prompt.includes('[read-stale]') && !done) {
    return {
      toolCalls: [call(view, 'wevir_memory_read', { scope: 'project', name: STALE_NOTE.name })],
    };
  }
  if (prompt.includes('[list-notes]') && !done) {
    return { toolCalls: [call(view, 'wevir_memory_list', {})] };
  }
  return { text: ['ok'] };
};

const lastUser = (body: unknown) => viewOf(body as MockRequestBody, 0).lastUserText;

// ── 测量 ──────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED || binary === undefined || process.platform === 'win32')(
  '基线测量（真实 Host + 真实 codex-app-server）',
  () => {
    afterAll(() => {
      console.log(`\n[baseline] 报告：${REPORT_PATH}\n${JSON.stringify(report, null, 2)}`);
    });

    it('工具目录：每个角色与每种上游协议实际发出的工具（假模型）', {
      timeout: 240_000,
    }, async () => {
      const mock = await startMockModel(script);
      const chat = await startChatRecorder();
      const messages = await startMessagesRecorder();
      const host = await boot([
        mockProvider('mock', mock.baseURL),
        compatible('chat', 'openai-completions', chat.baseURL, 'baseline-chat'),
        compatible('messages', 'anthropic-messages', messages.baseURL, 'baseline-messages'),
      ]);
      try {
        const { client, a } = host;
        const probe = async (providerId: string, recorder: { requests: { body: unknown }[] }) => {
          const before = recorder.requests.length;
          const session = await newSession(client, a.id, providerId);
          await runTurn(client, session, '[probe] Reply ok.', 60_000);
          const first = agentRequests(recorder.requests.slice(before))[0];
          expect(first, `${providerId} 的请求`).toBeDefined();
          return (first?.body ?? {}) as Json;
        };
        const roles: Json = {};
        const plain = await probe('mock', mock);
        roles.default = summarize(responsesCatalog(plain), true);
        // 每个角色一个开它的会话：角色会话的回合结束后会回报给开它的会话，那个会话随即又忙起来。
        for (const role of ROLES) {
          const parent = await newSession(client, a.id, 'mock', 'full_access');
          await runTurn(client, parent, `[spawn-role:${role}]`, 60_000);
          const request = await client.until(
            () =>
              mock.requests.find((entry) => lastUser(entry.body).includes(`[role-probe:${role}]`)),
            `${role} 会话的请求`,
            60_000,
          );
          roles[role] = summarize(responsesCatalog(request.body as unknown as Json), true);
        }
        section('mock', 'catalogByRole', roles);
        section('mock', 'catalogByProtocol', {
          'openai-responses': summarize(responsesCatalog(plain)),
          'openai-completions': summarize(chatCatalog(await probe('chat', chat))),
          'anthropic-messages': summarize(messagesCatalog(await probe('messages', messages))),
        });
      } finally {
        await host.close();
        await Promise.all([mock.close(), chat.close(), messages.close()]);
      }
    });

    it('记忆：A / B 项目隔离、旧格式笔记、索引体积（假模型）', { timeout: 240_000 }, async () => {
      const mock = await startMockModel(script);
      const host = await boot([mockProvider('mock', mock.baseURL)]);
      try {
        const { client, a, b, home } = host;
        seedProjectNote(home, a.id, STALE_NOTE);
        const firstRequestOf = async (workspace: Project, text: string) => {
          const before = mock.requests.length;
          const session = await newSession(client, workspace.id, 'mock');
          const turn = await runTurn(client, session, text, 60_000);
          return { turn, requests: agentRequests(mock.requests.slice(before)) };
        };
        const saved = await firstRequestOf(a, '[save-notes]');
        const inA = await firstRequestOf(a, '[read-stale]');
        const inB = await firstRequestOf(b, '[list-notes]');
        const indexA = memoryIndexOf(inA.requests[0]?.body);
        const indexB = memoryIndexOf(inB.requests[0]?.body);
        const staleOutput = JSON.stringify(inA.requests[1]?.body.input ?? '');
        const listOutputB = JSON.stringify(inB.requests[1]?.body.input ?? '');
        // 用户停用一条、再关掉自动记忆之后的新会话（旧 Host 没有这两项时如实记下“不支持”与仍然发出的工具和索引）。
        const disable = await client
          .request('memory.setEnabled', {
            scope: 'project',
            workspaceId: a.id,
            name: 'invoice-cents',
            enabled: false,
          })
          .then(
            () => 'ok',
            (error: Error) => error.message,
          );
        const afterDisable = memoryIndexOf((await firstRequestOf(a, '[probe]')).requests[0]?.body);
        const switched = (
          await client.request('settings.update', { settings: { autoMemory: false } })
        ).settings.autoMemory;
        const offRequest = (await firstRequestOf(a, '[probe]')).requests[0]?.body;
        const offTools = responsesCatalog((offRequest ?? {}) as Json).names.filter((name) =>
          name.includes('wevir_memory_'),
        );
        section('mock', 'memory', {
          saveCalls: memoryCalls(saved.turn),
          indexInA: indexA,
          indexInB: indexB,
          projectNotesLeakToB: indexB.names.some((name) => name.startsWith('project/')),
          listInBShowsProjectA:
            listOutputB.includes('invoice-cents') || listOutputB.includes(STALE_NOTE.name),
          staleNoteReadable: staleOutput.includes('npm run test:unit'),
          indexBeforeSave: memoryIndexOf(saved.requests[0]?.body),
          disableNote: disable,
          indexAfterDisable: afterDisable.names,
          autoMemoryOff: {
            setting: switched ?? 'not supported',
            indexNames: memoryIndexOf(offRequest).names,
            memoryTools: offTools,
          },
        });
      } finally {
        await host.close();
        await mock.close();
      }
    });

    it('接力：第一条消息里的长约定交给新来源时是否完整（假模型）', {
      timeout: 240_000,
    }, async () => {
      const mock = await startMockModel(script);
      const host = await boot([
        mockProvider('mock-a', mock.baseURL),
        mockProvider('mock-b', mock.baseURL, 'wevir-mock-b'),
      ]);
      try {
        const { client, a } = host;
        const session = await newSession(client, a.id, 'mock-a');
        await runTurn(client, session, HANDOFF_CONSTRAINTS, 60_000);
        await client.request('session.configure', { sessionId: session, providerId: 'mock-b' });
        const before = mock.requests.length;
        await runTurn(client, session, HANDOFF_TASK, 60_000);
        const first = agentRequests(mock.requests.slice(before)).find(
          (request) => request.body.model === 'wevir-mock-b',
        );
        section('mock', 'handoff', handoffMaterial(first?.body as Json | undefined));
      } finally {
        await host.close();
        await mock.close();
      }
    });

    describe.skipIf(REAL_KEY === undefined)(`真实模型：deepseek-official/${DEEPSEEK_MODEL}`, () => {
      it(`C0：修 bug 并如实报告检查结果 ×${REPEAT}`, { timeout: REPEAT * 600_000 }, async () => {
        const runs: Json[] = [];
        for (let run = 0; run < REPEAT; run++) {
          const proxy = await startForwardingRecorder(DEEPSEEK);
          const host = await boot([deepseek()], { deepseekBaseURL: proxy.baseURL });
          try {
            const { client, a, home } = host;
            seedProjectNote(home, a.id, STALE_NOTE);
            const session = await newSession(client, a.id, 'deepseek-official');
            const started = Date.now();
            const turn = await runTurn(
              client,
              session,
              C0_PROMPT,
              540_000,
              () => proxy.requests.length > REAL_REQUEST_CAP,
            );
            const check = checkC0(a.dir);
            const agent = agentRequests(proxy.requests);
            runs.push({
              outcome: turn.outcome,
              wallMs: Date.now() - started,
              requests: { agent: agent.length, other: proxy.requests.length - agent.length },
              catalog: agent[0] === undefined ? null : summarize(responsesCatalog(agent[0].body)),
              approvals: turn.approvals,
              questions: turn.questions,
              ...(turn.lastEvents !== undefined && { lastEvents: turn.lastEvents }),
              commands: turn.commands,
              memoryCalls: memoryCalls(turn),
              staleNoteUsed: turn.commands.some((command) => STALE_NOTE.misuse.test(command)),
              check,
              reportsLintFailure: reportsLintFailure(turn.finalText),
              finalText: turn.finalText.slice(0, 800),
            });
            section('real', 'c0', { partial: true, runs });
          } finally {
            await host.close();
            await proxy.close();
          }
        }
        section('real', 'c0', {
          prompt: C0_PROMPT,
          runs,
          successRate: `${runs.filter((run) => (run.check as { success: boolean }).success).length}/${runs.length}`,
        });
      });

      it(`记忆：保存纠正、新会话再用、B 项目不串 ×${REPEAT}`, {
        timeout: REPEAT * 600_000,
      }, async () => {
        const runs: Json[] = [];
        for (let run = 0; run < REPEAT; run++) {
          const proxy = await startForwardingRecorder(DEEPSEEK);
          const host = await boot([deepseek()], { deepseekBaseURL: proxy.baseURL });
          try {
            const { client, a, b, home } = host;
            seedProjectNote(home, a.id, STALE_NOTE);
            const correction = await runTurn(
              client,
              await newSession(client, a.id, 'deepseek-official'),
              MEMORY_CORRECTION,
              300_000,
              () => proxy.requests.length > REAL_REQUEST_CAP,
            );
            const notes = {
              global: listNotes(join(home, 'memory', 'global')),
              projectA: listNotes(join(home, 'memory', 'projects', a.id)),
              projectB: listNotes(join(home, 'memory', 'projects', b.id)),
            };
            const followBefore = proxy.requests.length;
            const followUp = await runTurn(
              client,
              await newSession(client, a.id, 'deepseek-official'),
              MEMORY_FOLLOW_UP,
              300_000,
              () => proxy.requests.length > REAL_REQUEST_CAP,
            );
            const followIndex = memoryIndexOf(
              agentRequests(proxy.requests.slice(followBefore))[0]?.body,
            );
            const crossBefore = proxy.requests.length;
            const crosstalk = await runTurn(
              client,
              await newSession(client, b.id, 'deepseek-official'),
              MEMORY_CROSSTALK,
              300_000,
              () => proxy.requests.length > REAL_REQUEST_CAP,
            );
            const crossIndex = memoryIndexOf(
              agentRequests(proxy.requests.slice(crossBefore))[0]?.body,
            );
            runs.push({
              correction: { memoryCalls: memoryCalls(correction), notes },
              followUp: {
                indexNames: followIndex.names,
                memoryCalls: memoryCalls(followUp),
                usesCorrection: MEMORY_KEYWORD.test(followUp.finalText),
                mentionsStaleCommand: STALE_NOTE.misuse.test(followUp.finalText),
                mentionsCurrentCommand: /npm test|node --test/.test(followUp.finalText),
                finalText: followUp.finalText.slice(0, 800),
              },
              crosstalkInB: {
                indexNames: crossIndex.names,
                projectNotesInIndex: crossIndex.names.filter((name) => name.startsWith('project/')),
                memoryCalls: memoryCalls(crosstalk),
                mentionsCorrection: MEMORY_KEYWORD.test(crosstalk.finalText),
                finalText: crosstalk.finalText.slice(0, 500),
              },
              requests: {
                agent: agentRequests(proxy.requests).length,
                other: proxy.requests.length - agentRequests(proxy.requests).length,
              },
            });
            section('real', 'memory', { partial: true, runs });
          } finally {
            await host.close();
            await proxy.close();
          }
        }
        section('real', 'memory', {
          prompts: [MEMORY_CORRECTION, MEMORY_FOLLOW_UP, MEMORY_CROSSTALK],
          runs,
        });
      });

      it(`接力：换来源之后是否还守最后一条约定 ×${REPEAT}`, {
        timeout: REPEAT * 600_000,
      }, async () => {
        const runs: Json[] = [];
        for (let run = 0; run < REPEAT; run++) {
          const first = await startForwardingRecorder(DEEPSEEK);
          const second = await startForwardingRecorder(DEEPSEEK);
          const host = await boot(
            [
              deepseek(),
              {
                ...compatible('deepseek-b', 'openai-responses', second.baseURL, DEEPSEEK_MODEL),
                // 同官方那一个：按 DeepSeek 实际的窗口登记。按 128k 登记时，DeepSeek 回报的缓存输入（约 12 万 token）让 Codex
                // 每个请求后都自动压缩，回合停不下来（2026-10-18 测到）。
                models: (deepseek().models as Json[]).slice(0, 1),
                compat: { toolChoice: 'auto_only' },
                apiKey: REAL_KEY,
              },
            ],
            { deepseekBaseURL: first.baseURL },
          );
          try {
            const { client, a } = host;
            const session = await newSession(client, a.id, 'deepseek-official');
            const overCap = () => first.requests.length + second.requests.length > REAL_REQUEST_CAP;
            const ack = await runTurn(client, session, HANDOFF_CONSTRAINTS, 300_000, overCap);
            await client.request('session.configure', {
              sessionId: session,
              providerId: 'deepseek-b',
            });
            const task = await runTurn(client, session, HANDOFF_TASK, 540_000, overCap);
            const result = checkHandoffResult(a.dir);
            const followed = result.snakeCase && result.specComment;
            runs.push({
              ack: ack.finalText.slice(0, 200),
              material: handoffMaterial(agentRequests(second.requests)[0]?.body),
              readHistory: task.tools.filter((tool) => /read_session_history/.test(tool.name))
                .length,
              result,
              followed,
              /** 守不住就得再说一遍：自动化的代理指标，人工试用另记。 */
              reExplanationsNeeded: followed ? 0 : 1,
              outcome: task.outcome,
              ackOutcome: ack.outcome,
              approvals: ack.approvals + task.approvals,
              ...(task.lastEvents !== undefined && { lastEvents: task.lastEvents }),
              requests: {
                before: agentRequests(first.requests).length,
                after: agentRequests(second.requests).length,
              },
            });
            section('real', 'handoff', { partial: true, runs });
          } finally {
            await host.close();
            await Promise.all([first.close(), second.close()]);
          }
        }
        section('real', 'handoff', { constraints: HANDOFF_CONSTRAINTS, task: HANDOFF_TASK, runs });
      });
    });
  },
);

// ── Provider 与小工具 ─────────────────────────────────────────────────

function mockProvider(id: string, baseURL: string, model = 'wevir-mock'): Json {
  return compatible(id, 'openai-responses', baseURL, model);
}

function compatible(id: string, api: string, baseURL: string, model: string): Json {
  return {
    id,
    kind: 'openai-compatible',
    displayName: id,
    api,
    baseURL,
    models: [{ id: model, contextWindow: 128_000 }],
    defaultModelId: model,
    apiKey: 'baseline-not-a-secret',
  };
}

function deepseek(): Json {
  return {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [
      {
        id: DEEPSEEK_MODEL,
        contextWindow: 1_048_576,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
    ],
    defaultModelId: DEEPSEEK_MODEL,
    apiKey: REAL_KEY,
  };
}

function listNotes(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
}

/** 新来源第一个请求里的接力材料：多长、选了几条省了几条、最后一条约定在不在。 */
function handoffMaterial(body: Json | undefined): Json {
  const text = textFrom(body?.input, 'Context handoff');
  if (text === undefined) return { found: false };
  const end = text.indexOf('\n\nUser message:');
  const context = end < 0 ? text : text.slice(0, end);
  const counts = /Selected (\d+) items; omitted (\d+)/.exec(context);
  return {
    found: true,
    bytes: Buffer.byteLength(context),
    selected: Number(counts?.[1] ?? 0),
    omitted: Number(counts?.[2] ?? 0),
    constraintChars: Array.from(HANDOFF_CONSTRAINTS).length,
    constraintKeptWhole: context.includes(HANDOFF_CONSTRAINTS),
    tailConstraintKept: context.includes(HANDOFF_TAIL_MARKER),
  };
}
