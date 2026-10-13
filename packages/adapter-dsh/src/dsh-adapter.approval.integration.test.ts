// DshAdapter 审批桥接（T3.3）的真实 dsh 集成测试。dsh 的审批只来自沙箱升级（acp-event-mapping.md §5）：
// 工作区外、且不在系统临时目录的写入先被沙箱拒绝，模型带 sandbox_permissions 重试才请求审批。
// - mock Provider（test-fixtures/mock-model.ts，不需要 Key）：照 T0.3 的 ESC 脚本，一次 allow、一次 deny，
//   另验证写系统临时目录不需要审批（场景 B0）；
// - 真实模型：设了 WEVIR_TEST_API_KEY 才跑（默认 DeepSeek 官方路由，见 realModelOverlay），提示里要求一次
//   工作区外、且不在系统临时目录的写入，并验证模型按沙箱提示升级（ADR-0001 未决事项 3）。

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type ApprovalRequestedEvent,
  isTurnTerminal,
  type ToolFinishedEvent,
  type ToolStartedEvent,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import {
  MOCK_KEY,
  MOCK_KEY_ENV,
  MOCK_MODEL,
  type MockReply,
  type MockRequest,
  startMockModel,
  turnOf,
  writeMockOverlay,
} from './test-fixtures/mock-model.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-approval-it-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function outsideDir(label: string): string {
  const { dir, remove } = makeOutsideDir(label);
  cleanups.push(remove);
  return dir;
}

/** 与 T0.3 的 ESC 提示相同：要求在工作区外的绝对路径写文件，被沙箱拒绝后按提示升级重试。 */
function escalationPrompt(path: string): string {
  return [
    `[wevir:ESC] 请用 write 工具在绝对路径 ${path} 创建文件，内容只有一行：hello。`,
    '这个路径在工作区之外，沙箱会先拒绝；被拒绝后请按工具提示带上 sandbox_permissions',
    '（取最窄的更高权限）和一句 justification 重试一次，这会向我申请审批。',
    '无论结果如何，最后用一句话告诉我文件是否已经写入。',
  ].join('');
}

/** mock 模型的 ESC 脚本（照 T0.3 `spikes/dsh-acp/src/scenarios.ts`）：写 → 沙箱拒绝则升级重试 → 汇报。 */
function escalationScript(request: MockRequest): MockReply {
  const { prompt, toolResults: results } = turnOf(request, '[wevir:ESC]');
  const path = /绝对路径 (\S+?) 创建/.exec(prompt)?.[1] ?? '';
  const write = { file_path: path, content: 'hello\n' };
  if (results.length === 0) return { toolCall: { name: 'write', arguments: write } };
  if (results.length === 1 && /sandbox/i.test(results[0] ?? '')) {
    return {
      toolCall: {
        name: 'write',
        arguments: {
          ...write,
          sandbox_permissions: 'danger-full-access',
          justification: '用户要求在工作区之外创建这个文件。',
        },
      },
    };
  }
  return { text: [`结果：${(results.at(-1) ?? '').slice(0, 120)}`] };
}

interface Setup {
  patches: string[];
  env: Record<string, string>;
  providerId: string;
  modelId: string;
}

async function openSession({ patches, env, providerId, modelId }: Setup) {
  const warnings: string[] = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    patches,
    env,
    streamTap: false,
    logger: { warn: (message) => void warnings.push(message) },
  });
  cleanups.push(() => adapter.dispose());
  const cwd = tempDir('ws');
  const { engineSessionId } = await adapter.createSession({ cwd, providerId, modelId });
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  /** 跑一个回合；每个审批请求交给 `decide`，按它返回的选项回复。 */
  const turn = async (
    text: string,
    decide: (request: ApprovalRequestedEvent) => string,
  ): Promise<AgentEvent[]> => {
    await adapter.send(engineSessionId, { content: [{ type: 'text', text }] });
    const out: AgentEvent[] = [];
    for (;;) {
      const { value, done } = await events.next();
      if (done) throw new Error('订阅在回合结束前结束');
      out.push(value);
      if (value.type === 'approval.requested') {
        await adapter.respondToApproval(engineSessionId, value.requestId, {
          optionId: decide(value),
        });
      }
      if (isTurnTerminal(value)) return out;
    }
  };
  return { adapter, cwd, warnings, turn };
}

async function mockSession() {
  const model = await startMockModel(escalationScript);
  cleanups.push(() => model.close());
  return openSession({
    patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
    env: { [MOCK_KEY_ENV]: MOCK_KEY },
    providerId: 'wevir-test',
    modelId: MOCK_MODEL,
  });
}

const approvalsOf = (events: AgentEvent[]) =>
  events.filter((e): e is ApprovalRequestedEvent => e.type === 'approval.requested');
const startedOf = (events: AgentEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolStartedEvent => e.type === 'tool.started' && e.toolCallId === toolCallId,
  );
const finishedOf = (events: AgentEvent[], toolCallId: string) =>
  events.find(
    (e): e is ToolFinishedEvent => e.type === 'tool.finished' && e.toolCallId === toolCallId,
  );
/** dsh 给的选项里第一个指定类别的（allow_* / reject_*）。 */
const pick = (request: ApprovalRequestedEvent, prefix: 'allow_' | 'reject_') => {
  const option = request.options.find((o) => o.kind.startsWith(prefix));
  if (option === undefined) throw new Error(`审批请求没有 ${prefix} 选项`);
  return option.optionId;
};

/** 一次升级审批的公共检查：请求排在升级重试的 tool.started 之后，详情在 rawInput 里，选项与 T0.3 相同。 */
function expectEscalation(events: AgentEvent[], target: string): ApprovalRequestedEvent {
  const [request, ...more] = approvalsOf(events);
  expect(more).toEqual([]);
  if (request === undefined) throw new Error('没有审批请求');
  expect(request.options).toEqual([
    { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', label: 'Reject', kind: 'reject_once' },
  ]);
  const started = startedOf(events, request.toolCallId);
  expect(started).toMatchObject({
    toolName: 'write',
    display: { kind: 'write', paths: [target] },
    input: { file_path: target, sandbox_permissions: 'danger-full-access' },
  });
  expect(events.indexOf(started as AgentEvent)).toBeLessThan(events.indexOf(request));
  const denied = events.find((e) => e.type === 'tool.finished' && e.status === 'failed');
  expect(denied).toMatchObject({
    output: expect.stringContaining('[sandbox: file access denied under workspace-write mode]'),
  });
  expect(events.indexOf(denied as AgentEvent)).toBeLessThan(events.indexOf(request));
  return request;
}

describe('DshAdapter 审批（真实 dsh + mock Provider）', () => {
  it('allow：工作区外的写入经沙箱拒绝、升级、批准后写成', async () => {
    const t = await mockSession();
    const target = join(outsideDir('allow'), 'allowed.txt');
    const events = await t.turn(escalationPrompt(target), (r) => pick(r, 'allow_'));
    const request = expectEscalation(events, target);
    expect(finishedOf(events, request.toolCallId)).toMatchObject({ status: 'completed' });
    expect(events.indexOf(request)).toBeLessThan(
      events.indexOf(finishedOf(events, request.toolCallId) as AgentEvent),
    );
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(await t.adapter.listPendingApprovals()).toEqual([]);
  }, 30_000);

  it('deny：工具以 dsh 的拒绝说明失败，文件没有写入，回合正常结束', async () => {
    const t = await mockSession();
    const target = join(outsideDir('deny'), 'denied.txt');
    const events = await t.turn(escalationPrompt(target), (r) => pick(r, 'reject_'));
    const request = expectEscalation(events, target);
    expect(finishedOf(events, request.toolCallId)).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('the user rejected escalating this operation'),
    });
    expect(existsSync(target)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  }, 30_000);

  it('工作区内与系统临时目录的写入不需要审批（workspace-write，T0.3 场景 A、B0）', async () => {
    const t = await mockSession();
    const targets = [join(t.cwd, 'inside.txt'), join(tempDir('tmp-area'), 'tmp.txt')];
    for (const target of targets) {
      const events = await t.turn(escalationPrompt(target), () => {
        throw new Error(`写 ${target} 不应请求审批`);
      });
      expect(approvalsOf(events)).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe('hello\n');
    }
  }, 30_000);
});

/**
 * 真实模型的 overlay，只写 Key 的环境变量名。默认 dsh acp profile 自带的 DeepSeek 官方路由（`deepseek-official`，
 * llm-deepseek）；设了 WEVIR_TEST_BASE_URL 时改走 OpenAI 兼容服务（llm-pi-ai），模型取 WEVIR_TEST_MODEL。
 */
function realModelSetup(key: string): Setup {
  const keyEnv = 'WEVIR_PROVIDER_WEVIR_REAL_KEY';
  const baseURL = process.env.WEVIR_TEST_BASE_URL;
  const model = process.env.WEVIR_TEST_MODEL;
  const file = join(tempDir('overlay'), 'provider.yml');
  if (baseURL === undefined) {
    const lines = ['- id: llm-deepseek', '  config:', `    apiKeyEnv: ${keyEnv}`];
    if (model !== undefined) {
      lines.push(
        '- id: acp',
        '  config:',
        '    provider: deepseek-official',
        `    model: ${model}`,
      );
    }
    writeFileSync(file, `${lines.join('\n')}\n`);
    return {
      patches: [file],
      env: { [keyEnv]: key },
      providerId: 'deepseek-official',
      modelId: model ?? 'deepseek-v4-flash',
    };
  }
  if (model === undefined) throw new Error('设了 WEVIR_TEST_BASE_URL 时要同时设 WEVIR_TEST_MODEL');
  const deepseek = /(^|\.)deepseek\.com$/.test(new URL(baseURL).hostname);
  writeFileSync(
    file,
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      wevir-real:',
      `        apiKeyEnv: ${keyEnv}`,
      '        api: openai-completions',
      `        baseURL: ${baseURL}`,
      '        compat:',
      '          supportsDeveloperRole: false',
      '          maxTokensField: max_tokens',
      // DeepSeek 的 OpenAI 兼容端点（T0.3 §6.2）。
      ...(deepseek
        ? [
            '          thinkingFormat: deepseek',
            '          requiresReasoningContentOnAssistantMessages: true',
          ]
        : []),
      '        models:',
      `          - id: ${model}`,
      '- id: acp',
      '  config:',
      '    provider: wevir-real',
      `    model: ${model}`,
      '',
    ].join('\n'),
  );
  return { patches: [file], env: { [keyEnv]: key }, providerId: 'wevir-real', modelId: model };
}

const REAL_KEY = process.env.WEVIR_TEST_API_KEY;

describe.skipIf(REAL_KEY === undefined || REAL_KEY === '')('DshAdapter 审批（真实模型）', () => {
  it('模型按沙箱提示升级：工作区外、且不在系统临时目录的写入出现审批，批准后写成', async () => {
    const t = await openSession(realModelSetup(REAL_KEY as string));
    const target = join(outsideDir('real'), 'allowed.txt');
    const events = await t.turn(escalationPrompt(target), (r) => pick(r, 'allow_'));
    const tools = events
      .filter((e) => e.type === 'tool.finished')
      .map((e) => (e as ToolFinishedEvent).output?.slice(0, 300));
    const [request] = approvalsOf(events);
    // 失败时带上工具结果，看模型是没有升级，还是升级参数不对。
    expect(request, JSON.stringify(tools)).toBeDefined();
    if (request === undefined) return;
    expect(startedOf(events, request.toolCallId)?.input).toMatchObject({
      sandbox_permissions: expect.any(String),
    });
    expect(finishedOf(events, request.toolCallId)).toMatchObject({ status: 'completed' });
    expect(readFileSync(target, 'utf8').trim()).toBe('hello');
    expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  }, 180_000);
});
