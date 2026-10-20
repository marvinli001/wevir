// coding 评测的一次运行：起一个产品配置的 Host（CodexRuntime + 读历史 + 联网工具，同 wevir-host 与基线），网关向上游的请求经
// recorder.ts 的 `fetch` 记下；写出样本仓库、建会话、发提示词、按样本处理审批 / 取消 / 中途改文件，回合结束后分类与验收，
// 得到一条运行记录。每次运行一个新 Host 与新的临时目录，跑完删掉。

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_VERSION, CodexRuntime } from '@wevir/adapter-codex';
import type { WevirEvent } from '@wevir/protocol';
import { historyToolServer } from '@wevir/runtime-adapter/history-tool';
import { homePath } from '../../home.js';
import { startHost } from '../../host-process.js';
import { createLogger } from '../../logger.js';
import { removeTempDir, TestRpcClient } from '../../test-utils.js';
import { WebService } from '../../web/service.js';
import {
  admitsFailure,
  type Classified,
  claimsSuccess,
  classify,
  type EditOutcome,
  toolCalls,
} from './classify.js';
import {
  type EvalRequest,
  type EvalUsage,
  missingUsageReason,
  recordingFetch,
} from './recorder.js';
import type { Sample, SampleContext } from './samples.js';
import { carriesToolOutput, prepare, type Verification, verify } from './verify.js';

type Json = Record<string, unknown>;

/** 一个被比较的配置：Provider（经 `provider.upsert` 登记）与要记进报告的元数据。 */
export interface EvalConfig {
  id: string;
  /** `provider.upsert` 的参数（含 Key；Key 不进报告）。 */
  provider: Json;
  model: string;
  /** 记录用：实际的上游地址（不含 Key）。 */
  endpoint: string;
  /** 网关之后的上游协议：`openai-responses`、`openai-completions`、`anthropic-messages`。 */
  upstreamProtocol: string;
  /** `deepseek-official` 的 Responses 地址（假模型测试指向本地）。 */
  deepseekBaseURL?: string;
  reasoningEffort?: string;
}

export interface RunOptions {
  sample: Sample;
  config: EvalConfig;
  /** 仓库根目录（找 TypeScript、放工作区之外的目录）。 */
  repo: string;
  codexBinary: string;
  /** 一次运行最多多少个模型请求，超过就停掉回合。 */
  requestCap: number;
  turnTimeoutMs: number;
  /** 第几次（报告用）。 */
  run: number;
}

export interface TurnSummary {
  turnId: string;
  outcome: string;
  durationMs: number;
}

export interface RunRecord {
  sample: string;
  config: string;
  run: number;
  startedAt: string;
  wallMs: number;
  turns: TurnSummary[];
  reasoningEffort: string | null;
  /** 三层结果。 */
  layers: {
    /** 协议与工具参数往返：每个调用都有输出、参数按约定到达、回合没因网关失败。 */
    roundTrip: { ok: boolean; unmatchedCalls: number; toolArgErrors: number };
    /** 编辑正确应用：没有非预期修改与破坏、编辑断言都过、该改的确实改了。 */
    edit: { ok: boolean; checks: Record<string, boolean> };
    /** 任务通过独立断言（验收测试 + 结构断言 + 回答断言）。 */
    task: { ok: boolean; checks: Record<string, boolean>; acceptance?: Verification['acceptance'] };
  };
  /** 三层都过（且环境可用）。 */
  success: boolean;
  /** 环境不可用（例如没有语言服务器）：不算模型失败，不进成功率的分母。 */
  environmentUnavailable?: string;
  counts: {
    editAttempts: number;
    editsApplied: number;
    shellEdits: number;
    patchFormatErrors: number;
    preimageMismatches: number;
    targetMissing: number;
    toolArgErrors: number;
    permissionDenied: number;
    toolOrGatewayFailures: number;
    unexpectedChanges: number;
    destructive: number;
    recoveredAfterRetry: number;
    unrecoveredEditFailures: number;
  };
  /** 失败实例：哪个文件、哪类错误。 */
  failures: Array<{ category: string; file?: string; detail?: string }>;
  /** 回答说做完了 / 通过了，验收却没过。 */
  possibleFalsePass: boolean;
  requests: {
    total: number;
    agent: number;
    auxiliary: number;
    withUsage: number;
    /** 网关在响应开始之前就取消的请求（Codex 取消了输入建议一类的辅助请求），没有用量是正常的。 */
    cancelledBeforeResponse: number;
    httpErrors: number;
    /**
     * 用量是在下游（Codex → 网关）中断连接之前收到的：基线的转发代理在中断时不再解析，这些请求在基线报告里会缺用量。
     */
    usageAfterDownstreamAbort: number;
  };
  /** 报了用量的请求之和；没报的单列在 `missingUsage`，不混进来。 */
  usage: EvalUsage;
  missingUsage: Array<{
    request: number;
    agent: boolean;
    reason: string;
    events: Record<string, number>;
  }>;
  tools: string[];
  commands: string[];
  approvals: { requested: number; denied: number };
  /** 最后一次成功编辑之后跑过测试；没有编辑时为 null。 */
  checkedAfterLastEdit: boolean | null;
  edits: Classified['edits'];
  changes: { added: string[]; modified: string[]; deleted: string[] };
  midTurn?: { injected: boolean; atRequest?: number };
  cancel?: { cancelled: boolean; latencyMs?: number; firstOutcome?: string };
  lsp?: { available: boolean; detail: string; used: boolean };
  finalText: string;
}

interface Booted {
  client: TestRpcClient;
  close(): Promise<void>;
}

async function boot(
  root: string,
  options: RunOptions,
  fetch: typeof globalThis.fetch,
): Promise<Booted> {
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  mkdirSync(userHome, { recursive: true });
  const logger = createLogger({ level: 'error', mirror: () => {} });
  const web = new WebService({
    settingsFile: homePath(home, 'webFile'),
    mcpDir: homePath(home, 'mcpDir'),
    logger,
  });
  const adapter = new CodexRuntime({
    home,
    binary: options.codexBinary,
    parentEnv: { ...process.env, HOME: userHome },
    logger,
    historyTool: historyToolServer(homePath(home, 'mcpDir'), homePath(home, 'historyDir')),
    webTool: web.tool,
    gateway: {
      fetch,
      ...(options.config.deepseekBaseURL !== undefined && {
        deepseekBaseURL: options.config.deepseekBaseURL,
      }),
    },
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
  // 真实模型的回合常超过连接租约，同真正的客户端一样定时 ping。
  const ping = setInterval(() => void client.call('host.ping').catch(() => {}), 10_000);
  await client.request('provider.upsert', options.config.provider);
  return {
    client,
    close: async () => {
      clearInterval(ping);
      client.ws.terminate();
      await host.shutdown();
    },
  };
}

/** 带工具的请求是 Agent 的请求；标题、输入建议这类辅助请求不带工具。 */
export function isAgentRequest(request: EvalRequest): boolean {
  const tools = request.body.tools;
  return Array.isArray(tools) && tools.length > 0;
}

/** 跑一个样本一次。 */
export async function runSample(options: RunOptions): Promise<RunRecord> {
  const { sample, config } = options;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wevir-eval-')));
  // 工作区之外、沙箱也写不到的目录：临时目录（$TMPDIR、/tmp）是 Codex 默认可写的，所以放在仓库的 .wevir-dev 下。
  const outsideDir = join(
    options.repo,
    '.wevir-dev',
    'coding-eval',
    `outside-${process.pid}-${Date.now()}`,
  );
  mkdirSync(outsideDir, { recursive: true });
  const ctx: SampleContext = { outsideDir };
  const dir = join(root, 'project');
  const prepared = prepare(dir, sample, options.repo);
  const original =
    sample.midTurn === undefined ? undefined : readFileSync(join(dir, sample.midTurn.path), 'utf8');
  const midTurn: NonNullable<RunRecord['midTurn']> = { injected: false };
  const recorder = recordingFetch({
    beforeForward: (request) => {
      if (sample.midTurn === undefined || midTurn.injected || !carriesToolOutput(request.body))
        return;
      const path = join(dir, sample.midTurn.path);
      if (readFileSync(path, 'utf8') !== original) return;
      writeFileSync(path, sample.midTurn.apply(original ?? ''));
      midTurn.injected = true;
      midTurn.atRequest = request.index;
    },
  });
  const startedAt = new Date();
  const started = Date.now();
  const host = await boot(root, options, recorder.fetch);
  const turns: TurnSummary[] = [];
  const events: WevirEvent[] = [];
  let reasoningEffort: string | null = null;
  let cancel: RunRecord['cancel'];
  try {
    const { client } = host;
    const workspace = (await client.request('workspace.add', { rootPath: dir })).workspace;
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: config.provider.id,
      modelId: config.model,
      permissionMode: 'on_request',
      ...(config.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    });
    reasoningEffort = (session.reasoningEffort as string | undefined) ?? null;
    const subscriptionId = (
      await client.request('events.subscribe', { sessionId: session.id, sinceSeq: 0 })
    ).subscriptionId as string;
    const driver = new TurnDriver(
      client,
      session.id as string,
      subscriptionId,
      sample,
      () => recorder.requests.length > options.requestCap,
    );
    const first = await driver.run(
      sample.prompt(ctx),
      options.turnTimeoutMs,
      sample.cancelThenResume !== undefined,
    );
    turns.push(first.summary);
    if (sample.cancelThenResume !== undefined) {
      cancel = {
        cancelled: first.cancelLatencyMs !== undefined,
        firstOutcome: first.summary.outcome,
        ...(first.cancelLatencyMs !== undefined && { latencyMs: first.cancelLatencyMs }),
      };
      if (first.summary.outcome !== 'aborted_request_cap') {
        const second = await driver.run(sample.cancelThenResume, options.turnTimeoutMs, false);
        turns.push(second.summary);
      }
    }
    events.push(...client.events(subscriptionId));
  } finally {
    await host.close().catch(() => {});
  }
  await recorder.settled();
  const finalText = lastAssistantText(events);
  const verification = verify({
    dir,
    sample,
    snapshot: prepared.snapshot,
    ctx,
    finalText,
    externalInjected: midTurn.injected,
  });
  const classified = classify({ requests: recorder.requests, events, root: dir });
  const record = buildRecord({
    options,
    startedAt,
    wallMs: Date.now() - started,
    turns,
    reasoningEffort,
    classified,
    verification,
    requests: recorder.requests,
    finalText,
    ...(sample.midTurn !== undefined && { midTurn }),
    ...(cancel !== undefined && { cancel }),
    ...(prepared.lsp !== undefined && { lsp: prepared.lsp }),
  });
  removeTempDir(root);
  rmSync(outsideDir, { recursive: true, force: true });
  return record;
}

function lastAssistantText(events: readonly WevirEvent[]): string {
  const messages = events.filter(
    (event): event is Extract<WevirEvent, { type: 'assistant.message' }> =>
      event.type === 'assistant.message',
  );
  return messages.at(-1)?.payload.text ?? '';
}

/** 发一条消息、等回合结束；审批按样本允许或拒绝，问题一律跳过；可在第一次工具调用结束后取消；超出请求上限就停。 */
class TurnDriver {
  readonly #answered = new Set<string>();

  constructor(
    private readonly client: TestRpcClient,
    private readonly sessionId: string,
    private readonly subscriptionId: string,
    private readonly sample: Sample,
    private readonly overCap: () => boolean,
  ) {}

  async run(
    text: string,
    timeoutMs: number,
    cancelAfterFirstTool: boolean,
  ): Promise<{ summary: TurnSummary; cancelLatencyMs?: number }> {
    const { client, sessionId } = this;
    const { turnId } = await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text }],
    });
    const ofTurn = () =>
      client
        .events(this.subscriptionId)
        .filter((event) => (event.payload as { turnId?: string }).turnId === turnId);
    let cancelAt: number | undefined;
    let capped = false;
    let finished: Extract<WevirEvent, { type: 'turn.finished' }> | undefined;
    try {
      await client.until(
        () => {
          this.#respond(turnId);
          const events = ofTurn();
          finished = events.find(
            (event): event is Extract<WevirEvent, { type: 'turn.finished' }> =>
              event.type === 'turn.finished',
          );
          if (finished !== undefined) return finished;
          if (
            cancelAfterFirstTool &&
            cancelAt === undefined &&
            events.some((event) => event.type === 'tool.finished')
          ) {
            cancelAt = Date.now();
            void client.request('session.cancel', { sessionId }).catch(() => {});
          }
          if (!capped && this.overCap()) {
            capped = true;
            void client.request('session.cancel', { sessionId }).catch(() => {});
          }
          return undefined;
        },
        `turn ${turnId}`,
        timeoutMs,
      );
    } catch {
      // 超时：停掉回合，如实记成 timeout。
      await client.request('session.cancel', { sessionId }).catch(() => {});
    }
    const done = finished as Extract<WevirEvent, { type: 'turn.finished' }> | undefined;
    const outcome = capped ? 'aborted_request_cap' : (done?.payload.outcome ?? 'timeout');
    return {
      summary: { turnId, outcome, durationMs: done?.payload.durationMs ?? timeoutMs },
      ...(cancelAt !== undefined &&
        done !== undefined && { cancelLatencyMs: Date.parse(done.ts) - cancelAt }),
    };
  }

  #respond(turnId: string): void {
    for (const event of this.client.events(this.subscriptionId)) {
      if (event.type === 'approval.requested') {
        const { approval } = event.payload;
        if (approval.turnId !== turnId || this.#answered.has(approval.id)) continue;
        this.#answered.add(approval.id);
        const option = this.sample.denyApprovals
          ? (approval.options.find((entry) => entry.kind === 'reject_decline') ??
            approval.options.find((entry) => entry.category === 'reject'))
          : approval.options.find((entry) => entry.category === 'allow');
        if (option !== undefined)
          void this.client
            .request('approval.respond', { approvalId: approval.id, optionId: option.optionId })
            .catch(() => {});
      } else if (event.type === 'question.requested') {
        const { question } = event.payload;
        if (question.turnId !== turnId || this.#answered.has(question.id)) continue;
        this.#answered.add(question.id);
        void this.client
          .request('question.respond', { questionId: question.id, answers: {} })
          .catch(() => {});
      }
    }
  }
}

const FAILED_EDIT: readonly EditOutcome[] = [
  'patch-format',
  'preimage-mismatch',
  'target-missing',
  'tool-args',
  'permission',
  'apply-error',
  'unknown',
];

function buildRecord(input: {
  options: RunOptions;
  startedAt: Date;
  wallMs: number;
  turns: TurnSummary[];
  reasoningEffort: string | null;
  classified: Classified;
  verification: Verification;
  requests: readonly EvalRequest[];
  finalText: string;
  midTurn?: RunRecord['midTurn'];
  cancel?: RunRecord['cancel'];
  lsp?: { available: boolean; detail: string };
}): RunRecord {
  const { options, classified: c, verification: v, requests, finalText } = input;
  const { sample } = options;
  const edits = c.edits;
  const count = (outcome: EditOutcome) => edits.filter((edit) => edit.outcome === outcome).length;
  const failedEdits = edits.filter((edit) => FAILED_EDIT.includes(edit.outcome));
  const deniedShell = c.shell.filter((call) => call.denied);
  const permissionIds = new Set([
    ...deniedShell.map((call) => call.callId),
    ...edits.filter((edit) => edit.outcome === 'permission').map((edit) => edit.callId),
  ]);
  const permissionDenied = Math.max(permissionIds.size, c.approvals.denied);
  const shellEdits = c.shell.filter((call) => call.writes && !call.denied).length;
  const applied = count('applied');
  const turnFailed = input.turns.some((turn) => turn.outcome === 'failed');
  // LSP：工具说语言服务器不可用，或准备时就没有 TypeScript，都记“环境不可用”。
  const lspCalls = c.toolNames.filter((name) => name.startsWith('lsp_'));
  // lsp/manager.ts 的 LspUnavailableError：找不到服务器、启动失败、短时间内失败太多次。
  const lspUnavailable = toolCalls(requests).some(
    (call) =>
      call.name.startsWith('lsp_') &&
      /No TypeScript found|No language server for|Could not start|language server for .+ failed \d+ times|not found\. Install/.test(
        call.output ?? '',
      ),
  );
  const lspMissing = input.lsp !== undefined && (!input.lsp.available || lspUnavailable);
  const environmentUnavailable = lspMissing
    ? `language server unavailable (${input.lsp?.available ? 'reported by the lsp tools' : input.lsp?.detail})`
    : undefined;
  const expectsEdit = sample.readOnly !== true && sample.denyApprovals !== true;
  const editChecks = {
    ...v.editChecks,
    ...(expectsEdit && { editMade: applied + shellEdits > 0 }),
    noUnexpectedChanges: v.unexpected.length === 0,
    noDestructiveEdits: v.destructive.length === 0,
  };
  // 文件末尾被加了换行：工具的规范化，单列，不算第二层失败（见 samples.ts 的 whitespace-crlf）。
  const strictEditChecks = Object.entries(editChecks).filter(
    ([name]) => name !== 'finalNewlineUnchanged',
  );
  const editOk = strictEditChecks.every(([, ok]) => ok);
  // 最后一次成功编辑之后有没有跑测试（按调用先后）。
  const lastEdit = Math.max(
    -1,
    ...edits.filter((edit) => edit.outcome === 'applied').map((edit) => edit.order),
    ...c.shell.filter((call) => call.writes && !call.denied).map((call) => call.order),
  );
  const checkedAfterEdit = c.shell.some(
    (call) => call.order > lastEdit && /npm (run )?test|node\s+--test/.test(call.command),
  );
  const taskChecks = {
    ...v.taskChecks,
    ...(sample.checkAfterEdit === true && {
      testsRanAfterLastEdit: lastEdit >= 0 && checkedAfterEdit,
    }),
    ...v.answerChecks,
    ...(v.acceptance !== undefined && { acceptance: v.acceptance.ok }),
  };
  const taskOk = Object.values(taskChecks).every(Boolean);
  const roundTripOk = c.toolArgErrors.length === 0 && c.unmatchedCalls.length === 0 && !turnFailed;
  const failures: RunRecord['failures'] = [
    ...failedEdits.map((edit) => ({
      category:
        edit.outcome === 'permission'
          ? 'permission-denied'
          : `edit:${edit.outcome}${edit.recovered ? ' (recovered)' : ''}`,
      ...(edit.files[0] !== undefined && { file: edit.files.join(', ') }),
      ...(edit.detail !== undefined && { detail: edit.detail.slice(0, 300) }),
    })),
    ...c.toolArgErrors.map((error) => ({
      category: 'tool-args',
      detail: `${error.name}: ${error.detail}`,
    })),
    ...c.gatewayFailures.map((failure) => ({
      category: `gateway:${failure.kind}`,
      detail: failure.detail,
    })),
    ...c.unmatchedCalls.map((callId) => ({ category: 'unmatched-call', detail: callId })),
    ...v.unexpected.map((path) => ({ category: 'unexpected-change', file: path })),
    ...v.destructive.map((entry) => ({
      category: `destructive:${entry.kind}`,
      ...(entry.path !== undefined && { file: entry.path }),
      ...(entry.detail !== undefined && { detail: entry.detail }),
    })),
    ...Object.entries({ ...v.editChecks, ...taskChecks })
      .filter(([name, ok]) => !ok && name !== 'acceptance')
      .map(([name]) => ({
        category: name === 'finalNewlineUnchanged' ? 'engine-normalization' : 'check',
        detail: name,
      })),
    ...(v.acceptance !== undefined && !v.acceptance.ok
      ? [
          {
            category: 'acceptance',
            detail: `${v.acceptance.passed} passed, ${v.acceptance.failed} failed; not passing: ${v.acceptance.missing.join(' | ')}`,
          },
        ]
      : []),
    ...input.turns
      .filter(
        (turn) =>
          turn.outcome !== 'completed' && !(input.cancel?.cancelled && turn === input.turns[0]),
      )
      .filter((turn) => !(sample.denyApprovals && turn.outcome === 'cancelled'))
      .map((turn) => ({ category: `turn:${turn.outcome}` })),
  ];
  const withUsage = requests.filter((request) => request.usage !== undefined);
  const usage = withUsage.reduce<EvalUsage>(
    (sum, request) => ({
      input: sum.input + (request.usage?.input ?? 0),
      cachedInput: sum.cachedInput + (request.usage?.cachedInput ?? 0),
      output: sum.output + (request.usage?.output ?? 0),
    }),
    { input: 0, cachedInput: 0, output: 0 },
  );
  const agent = requests.filter(isAgentRequest).length;
  return {
    sample: sample.id,
    config: options.config.id,
    run: options.run,
    startedAt: input.startedAt.toISOString(),
    wallMs: input.wallMs,
    turns: input.turns,
    reasoningEffort: input.reasoningEffort,
    layers: {
      roundTrip: {
        ok: roundTripOk,
        unmatchedCalls: c.unmatchedCalls.length,
        toolArgErrors: c.toolArgErrors.length,
      },
      edit: { ok: editOk, checks: editChecks },
      task: {
        ok: taskOk,
        checks: taskChecks,
        ...(v.acceptance !== undefined && { acceptance: v.acceptance }),
      },
    },
    success: roundTripOk && editOk && taskOk && environmentUnavailable === undefined,
    ...(environmentUnavailable !== undefined && { environmentUnavailable }),
    counts: {
      editAttempts: edits.length,
      editsApplied: applied,
      shellEdits,
      patchFormatErrors: count('patch-format'),
      preimageMismatches: count('preimage-mismatch'),
      targetMissing: count('target-missing'),
      toolArgErrors: c.toolArgErrors.length,
      permissionDenied,
      toolOrGatewayFailures:
        c.gatewayFailures.length + count('apply-error') + c.unmatchedCalls.length,
      unexpectedChanges: v.unexpected.length,
      destructive: v.destructive.length,
      recoveredAfterRetry: failedEdits.filter((edit) => edit.recovered).length,
      unrecoveredEditFailures: failedEdits.filter(
        (edit) => !edit.recovered && edit.outcome !== 'permission',
      ).length,
    },
    failures,
    possibleFalsePass:
      !taskOk && finalText !== '' && claimsSuccess(finalText) && !admitsFailure(finalText),
    requests: {
      total: requests.length,
      agent,
      auxiliary: requests.length - agent,
      withUsage: withUsage.length,
      cancelledBeforeResponse: requests.filter(
        (request) => request.status === undefined && request.ended === 'aborted',
      ).length,
      httpErrors: requests.filter((request) => (request.status ?? 0) >= 400).length,
      usageAfterDownstreamAbort: withUsage.filter((request) => request.ended === 'aborted').length,
    },
    usage,
    // 只列拿到了 2xx 响应却没在流里找到用量的请求；HTTP 错误与响应前就被取消的另计。
    missingUsage: requests
      .filter(
        (request) =>
          request.usage === undefined && request.status !== undefined && request.status < 400,
      )
      .map((request) => ({
        request: request.index,
        agent: isAgentRequest(request),
        reason: missingUsageReason(request),
        events: request.events,
      })),
    tools: c.toolNames,
    commands: c.shell.map((call) => call.command.slice(0, 200)),
    approvals: c.approvals,
    checkedAfterLastEdit: lastEdit >= 0 ? checkedAfterEdit : null,
    edits,
    changes: { added: v.added, modified: v.modified, deleted: v.deleted },
    ...(input.midTurn !== undefined && { midTurn: input.midTurn }),
    ...(input.cancel !== undefined && { cancel: input.cancel }),
    ...(input.lsp !== undefined && { lsp: { ...input.lsp, used: lspCalls.length > 0 } }),
    finalText: finalText.slice(0, 1200),
  };
}

/** 报告的头部：版本与环境（不含任何 Key）。 */
export function environmentInfo(repo: string, commit: string): Json {
  return {
    commit,
    engine: `codex-app-server ${CODEX_VERSION}`,
    gateway: `@wevir/model-gateway ${packageVersion(repo, 'packages/model-gateway')} @ ${commit}`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

function packageVersion(repo: string, dir: string): string {
  try {
    return (
      JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return 'unknown';
  }
}
