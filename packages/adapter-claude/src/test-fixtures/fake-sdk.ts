// 假的 Claude Agent SDK（第 1 层契约与映射测试用）：按 prompt 回放 sdk/ 里录下的真实消息（record-sdk.test.ts），审批按
// `canUseTool` 的决定走对应录音的分支，中断、插话、子 agent 的审批与慢回合是照真实消息的形状拼出来的脚本。记下会话（`resume`
// 与 `sessionExists`）和对进程的调用（setModel 等），不起任何进程。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';
import type {
  CanUseTool,
  ClaudeSdk,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '../sdk.js';

const SDK_DIR = join(import.meta.dirname, 'sdk');

interface Recording {
  prompt: string;
  promptUuid: string;
  /** `{ message }` 或 `{ permission }`。 */
  lines: Array<{ message?: Record<string, unknown>; permission?: { toolUseID: string } }>;
}

/** 读一份录音（去掉 `_meta` 与 `prompt` 行）。 */
export function loadRecording(name: string): Recording {
  const raw = readFileSync(join(SDK_DIR, `${name}.jsonl`), 'utf8');
  const recordedUuid = (JSON.parse(raw.split('\n')[1] as string) as { uuid: string }).uuid;
  // 录音里这次 prompt 的 uuid 换成占位符，回放时再换成适配器发的那个。
  const rows = raw
    .replaceAll(recordedUuid, '<prompt>')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const prompt = rows.find((row) => 'prompt' in row) as { prompt: string; uuid: string };
  return {
    prompt: prompt.prompt,
    promptUuid: recordedUuid,
    lines: rows.filter((row) => 'message' in row || 'permission' in row) as Recording['lines'],
  };
}

/** 录音里的消息（不含权限行）。 */
export function recordedMessages(name: string): SDKMessage[] {
  return loadRecording(name).lines.flatMap((line) =>
    line.message === undefined ? [] : [line.message as unknown as SDKMessage],
  );
}

type Step =
  | { kind: 'message'; message: Record<string, unknown> }
  | {
      kind: 'permission';
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
      agentID?: string;
      allow: Step[];
      decline: Step[];
      interrupt: Step[];
    }
  | { kind: 'delay'; ms: number };

interface Script {
  steps: Step[];
  /** 慢回合：每条消息之间停一下，回合里能插话。 */
  delayMs?: number;
}

function messageSteps(lines: Recording['lines']): Step[] {
  return lines.flatMap((line) =>
    line.message === undefined ? [] : [{ kind: 'message' as const, message: line.message }],
  );
}

/** 把录音里的某个字符串（工具调用 ID 等）换成另一个，分支之间对得上。 */
function rename(steps: Step[], from: string, to: string): Step[] {
  return JSON.parse(JSON.stringify(steps).replaceAll(from, to)) as Step[];
}

function splitAtPermission(name: string): {
  before: Step[];
  after: Step[];
  permission: { toolName: string; input: Record<string, unknown>; toolUseID: string };
} {
  const recording = loadRecording(name);
  const index = recording.lines.findIndex((line) => line.permission !== undefined);
  const permission = recording.lines[index]?.permission as unknown as {
    toolName: string;
    input: Record<string, unknown>;
    toolUseID: string;
  };
  return {
    before: messageSteps(recording.lines.slice(0, index)),
    after: messageSteps(recording.lines.slice(index + 1)),
    permission,
  };
}

function approvalScript(): Script {
  const allow = splitAtPermission('approval.allow');
  const decline = splitAtPermission('approval.decline');
  const interrupt = splitAtPermission('approval.interrupt');
  const id = allow.permission.toolUseID;
  return {
    steps: [
      ...allow.before,
      {
        kind: 'permission',
        toolName: allow.permission.toolName,
        input: allow.permission.input,
        toolUseID: id,
        allow: allow.after,
        decline: rename(decline.after, decline.permission.toolUseID, id),
        interrupt: rename(interrupt.after, interrupt.permission.toolUseID, id),
      },
    ],
  };
}

/** 慢回合：照 plain 的形状，文本分很多段输出。 */
function slowScript(): Script {
  const msgId = 'msg_fake_slow_1';
  const words = 'This is a deliberately slow answer that streams in many small pieces.'.split(' ');
  const steps: Step[] = [
    {
      kind: 'message',
      message: streamEvent(
        { type: 'message_start', message: { id: msgId, model: 'claude-haiku-4-5', usage: {} } },
        true,
      ),
    },
    {
      kind: 'message',
      message: streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    },
    ...words.map(
      (word): Step => ({
        kind: 'message',
        message: streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `${word} ` },
        }),
      }),
    ),
    { kind: 'message', message: assistant(msgId, [{ type: 'text', text: `${words.join(' ')} ` }]) },
    { kind: 'message', message: streamEvent({ type: 'content_block_stop', index: 0 }) },
    { kind: 'message', message: result('done') },
  ];
  return { steps, delayMs: 15 };
}

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function streamEvent(event: Record<string, unknown>, first = false): Record<string, unknown> {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: '<session>',
    ...(first && { user_message_uuid: '<prompt>', user_message_uuids: ['<prompt>'] }),
  };
}

function assistant(
  msgId: string,
  content: unknown[],
  parent: string | null = null,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5-20251001',
      content,
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: '<session>',
  };
}

function toolResult(
  toolUseId: string,
  text: string,
  isError: boolean,
  parent: string | null,
  structured?: unknown,
): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }],
    },
    parent_tool_use_id: parent,
    ...(structured !== undefined && { tool_use_result: structured }),
    uuid: uuid(),
    session_id: '<session>',
  };
}

function result(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {
      'claude-haiku-4-5': {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    },
    permission_denials: [],
    user_message_uuid: '<prompt>',
    user_message_uuids: ['<prompt>'],
    queued_turn_count: 0,
    uuid: uuid(),
    session_id: '<session>',
    ...extra,
  };
}

function abortedResult(): Record<string, unknown> {
  return {
    ...result(''),
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    stop_reason: null,
    terminal_reason: 'aborted_streaming',
  };
}

/** 子 agent 先请求一次审批（Write），由子 agent 的 `agentID` 带出来；允许后子 agent 回答，父 agent 收尾。 */
function subagentApprovalScript(): Script {
  const agentId = 'toolu_fake_agent_1';
  const taskId = 'a_fake_task_1';
  const writeId = 'toolu_fake_write_1';
  const before: Step[] = [
    {
      kind: 'message',
      message: streamEvent(
        {
          type: 'message_start',
          message: { id: 'msg_fake_p1', model: 'claude-haiku-4-5', usage: {} },
        },
        true,
      ),
    },
    {
      kind: 'message',
      message: assistant('msg_fake_p1', [
        {
          type: 'tool_use',
          id: agentId,
          name: 'Agent',
          input: {
            description: 'Write a file',
            subagent_type: 'general-purpose',
            prompt: 'Write approve.txt',
          },
        },
      ]),
    },
    {
      kind: 'message',
      message: {
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: agentId,
        description: 'Write a file',
        is_backgrounded: false,
        uuid: uuid(),
        session_id: '<session>',
      },
    },
    {
      kind: 'message',
      message: assistant(
        'msg_fake_c1',
        [
          {
            type: 'tool_use',
            id: writeId,
            name: 'Write',
            input: { file_path: 'approve.txt', content: 'ok' },
          },
        ],
        agentId,
      ),
    },
  ];
  const finishParent = (text: string, isError: boolean): Step[] => [
    { kind: 'message', message: toolResult(agentId, text, isError, null) },
    { kind: 'message', message: assistant('msg_fake_p2', [{ type: 'text', text: 'All done.' }]) },
    { kind: 'message', message: result('All done.') },
  ];
  return {
    steps: [
      ...before,
      {
        kind: 'permission',
        toolName: 'Write',
        input: { file_path: 'approve.txt', content: 'ok' },
        toolUseID: writeId,
        agentID: taskId,
        allow: [
          {
            kind: 'message',
            message: toolResult(writeId, 'File created successfully', false, agentId),
          },
          {
            kind: 'message',
            message: assistant('msg_fake_c2', [{ type: 'text', text: 'Created it.' }], agentId),
          },
          ...finishParent('Created it.', false),
        ],
        decline: [
          {
            kind: 'message',
            message: toolResult(writeId, 'User declined tool execution.', true, agentId),
          },
          ...finishParent('The user declined.', false),
        ],
        interrupt: [
          { kind: 'message', message: toolResult(writeId, 'Interrupted', true, agentId) },
          { kind: 'message', message: toolResult(agentId, 'Interrupted', true, null) },
          { kind: 'message', message: abortedResult() },
        ],
      },
    ],
  };
}

/** 契约的提示词 → 脚本（未知的 prompt 按 plain 回答）。 */
function scriptFor(prompt: string): Script {
  switch (prompt) {
    case DEFAULT_CONTRACT_PROMPTS.toolCall:
      return { steps: messageSteps(loadRecording('tool').lines) };
    case DEFAULT_CONTRACT_PROMPTS.approval:
      return approvalScript();
    case DEFAULT_CONTRACT_PROMPTS.subagent:
      return { steps: messageSteps(loadRecording('subagent').lines) };
    case DEFAULT_CONTRACT_PROMPTS.subagentApproval:
      return subagentApprovalScript();
    case DEFAULT_CONTRACT_PROMPTS.slow:
      return slowScript();
    default:
      return { steps: messageSteps(loadRecording('plain').lines) };
  }
}

/** 一次 `query()` 调用的记录（测试检查交给 SDK 的选项与对进程的调用）。 */
export interface FakeQueryRecord {
  options: Options;
  prompts: SDKUserMessage[];
  calls: Array<{ method: string; args: unknown[] }>;
  closed: boolean;
}

export interface FakeSdkOptions {
  /** 探测会话的 `initializationResult().account`；省略时是已登录的 Max 账号。 */
  account?: Record<string, unknown>;
  /** 探测会话的 `initializationResult()` 抛这个错（`claude` 起不来时）。 */
  initError?: Error;
  /** 按 prompt 换脚本（测试用自己拼的消息）。 */
  script?: (prompt: string) => Script | undefined;
}

export class FakeClaudeSdk implements ClaudeSdk {
  readonly queries: FakeQueryRecord[] = [];
  readonly sessions = new Set<string>();
  readonly forks: Array<{ sessionId: string; upToMessageId?: string; forked: string }> = [];
  readonly #options: FakeSdkOptions;
  readonly #instances: FakeQuery[] = [];

  constructor(options: FakeSdkOptions = {}) {
    this.#options = options;
  }

  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
    const record: FakeQueryRecord = {
      options: params.options ?? {},
      prompts: [],
      calls: [],
      closed: false,
    };
    this.queries.push(record);
    const instance = new FakeQuery(this, record, params.prompt, this.#options);
    this.#instances.push(instance);
    return instance as unknown as Query;
  }

  /** 模拟第 `index` 个进程退出：消息流以错误结束（同真实 SDK 的 “process exited with code 1”）。 */
  crash(index: number, message = 'Claude Code process exited with code 1'): void {
    this.#instances[index]?.crash(message);
  }

  async forkSession(
    sessionId: string,
    options?: { dir?: string; upToMessageId?: string },
  ): Promise<{ sessionId: string }> {
    if (!this.sessions.has(sessionId))
      throw new Error(`No conversation found with session ID: ${sessionId}`);
    const forked = `11111111-1111-4111-8111-${String(this.forks.length + 1).padStart(12, '0')}`;
    this.sessions.add(forked);
    this.forks.push({
      sessionId,
      ...(options?.upToMessageId !== undefined && { upToMessageId: options.upToMessageId }),
      forked,
    });
    return { sessionId: forked };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  scriptFor(prompt: string): Script {
    return this.#options.script?.(prompt) ?? scriptFor(prompt);
  }
}

/** 推给适配器的消息队列。 */
class Outbox {
  readonly #items: SDKMessage[] = [];
  #waiter: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  #ended = false;

  push(message: SDKMessage): void {
    if (this.#ended) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ value: message, done: false });
    } else {
      this.#items.push(message);
    }
  }

  end(): void {
    this.#ended = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.#failure = error;
    this.#ended = true;
    const rejecter = this.#rejecter;
    this.#waiter = undefined;
    this.#rejecter = undefined;
    rejecter?.(error);
  }

  #failure: Error | undefined;
  #rejecter: ((error: Error) => void) | undefined;

  next(): Promise<IteratorResult<SDKMessage>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiter = resolve;
      this.#rejecter = reject;
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeQuery {
  readonly #sdk: FakeClaudeSdk;
  readonly #record: FakeQueryRecord;
  readonly #options: FakeSdkOptions;
  readonly #out = new Outbox();
  readonly #sessionId: string;
  #turnAbort: AbortController | undefined;
  #turnRunning = false;
  /** 回合进行中收到的插话（priority next）。 */
  #steers: SDKUserMessage[] = [];
  #closed = false;

  constructor(
    sdk: FakeClaudeSdk,
    record: FakeQueryRecord,
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: FakeSdkOptions,
  ) {
    this.#sdk = sdk;
    this.#record = record;
    this.#options = options;
    const resume = record.options.resume;
    this.#sessionId = resume ?? record.options.sessionId ?? 'fake-probe';
    if (typeof prompt !== 'string') void this.#read(prompt, resume);
    else void this.#oneShot(prompt);
  }

  async #oneShot(prompt: string): Promise<void> {
    await sleep(0);
    this.#emit(
      result('{"title":"Fake title","description":"A fake title"}', {
        structured_output: { title: 'Fake title', description: 'A fake title' },
        user_message_uuid: undefined,
        user_message_uuids: undefined,
      }),
      '',
    );
    void prompt;
    this.#out.end();
  }

  async #read(prompt: AsyncIterable<SDKUserMessage>, resume: string | undefined): Promise<void> {
    if (resume !== undefined && !this.#sdk.sessions.has(resume)) {
      await sleep(0);
      this.#out.push({
        ...(abortedResult() as object),
        subtype: 'error_during_execution',
        errors: [`No conversation found with session ID: ${resume}`],
        terminal_reason: undefined,
        user_message_uuid: undefined,
        user_message_uuids: undefined,
        session_id: resume,
      } as unknown as SDKMessage);
      this.#out.end();
      return;
    }
    for await (const message of prompt) {
      if (this.#closed) break;
      this.#record.prompts.push(message);
      if (message.shouldQuery === false) continue;
      if (this.#sessionId !== 'fake-probe') this.#sdk.sessions.add(this.#sessionId);
      if (this.#turnRunning) {
        this.#steers.push(message);
        continue;
      }
      void this.#runTurn(message);
    }
  }

  async #runTurn(message: SDKUserMessage): Promise<void> {
    this.#turnRunning = true;
    const abort = new AbortController();
    this.#turnAbort = abort;
    const { content } = message.message;
    const text =
      typeof content === 'string'
        ? content
        : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n');
    const prompt =
      text.includes('\n\n') && text.startsWith('---')
        ? text.slice(text.lastIndexOf('\n\n') + 2)
        : text;
    const script = this.#sdk.scriptFor(prompt);
    const promptUuid = message.uuid ?? '';
    try {
      await this.#run(script.steps, script.delayMs ?? 0, promptUuid, abort.signal);
      // 插话（priority next，实测见 steer.next 录音）：这一轮照常答完，再以排队的消息开下一轮，帧与结果带它的 uuid。
      for (const steer of this.#steers.splice(0)) {
        const steerUuid = steer.uuid ?? '';
        const msgId = `msg_fake_${steerUuid}`;
        await sleep(script.delayMs ?? 0);
        this.#emit(
          streamEvent({ type: 'message_start', message: { id: msgId, usage: {} } }, true),
          steerUuid,
        );
        this.#emit(
          assistant(msgId, [{ type: 'text', text: 'And the weather: sunny.' }]),
          steerUuid,
        );
        this.#emit(result('And the weather: sunny.'), steerUuid);
      }
    } finally {
      this.#turnRunning = false;
      this.#turnAbort = undefined;
    }
  }

  async #run(
    steps: Step[],
    delayMs: number,
    promptUuid: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (const step of steps) {
      if (this.#closed) return;
      if (signal.aborted) {
        this.#emit(abortedResult(), promptUuid);
        return;
      }
      await sleep(delayMs);
      if (signal.aborted) {
        this.#emit(abortedResult(), promptUuid);
        return;
      }
      if (step.kind === 'delay') {
        await sleep(step.ms);
      } else if (step.kind === 'message') {
        this.#emit(step.message, promptUuid);
      } else {
        const decision = await this.#permission(step, signal);
        const branch =
          decision.behavior === 'allow'
            ? step.allow
            : decision.interrupt === true || signal.aborted
              ? step.interrupt
              : step.decline;
        await this.#run(branch, delayMs, promptUuid, new AbortController().signal);
        return;
      }
    }
  }

  #permission(
    step: Extract<Step, { kind: 'permission' }>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const canUseTool = this.#record.options.canUseTool as CanUseTool | undefined;
    if (canUseTool === undefined) return Promise.resolve({ behavior: 'allow' });
    const callbackAbort = new AbortController();
    signal.addEventListener('abort', () => callbackAbort.abort(), { once: true });
    return canUseTool(step.toolName, step.input, {
      signal: callbackAbort.signal,
      toolUseID: step.toolUseID,
      requestId: `req-${step.toolUseID}`,
      ...(step.agentID !== undefined && { agentID: step.agentID }),
    }) as Promise<PermissionResult>;
  }

  #emit(message: Record<string, unknown>, promptUuid: string): void {
    const json = JSON.stringify(message)
      .replaceAll('<prompt>', promptUuid)
      .replaceAll('<session>', this.#sessionId);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    parsed.session_id = this.#sessionId;
    this.#out.push(parsed as unknown as SDKMessage);
  }

  // ── Query 的接口 ──

  next(): Promise<IteratorResult<SDKMessage>> {
    return this.#out.next();
  }

  async return(): Promise<IteratorResult<SDKMessage>> {
    this.close();
    return { value: undefined, done: true };
  }

  async throw(error: unknown): Promise<IteratorResult<SDKMessage>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async interrupt(): Promise<undefined> {
    this.#record.calls.push({ method: 'interrupt', args: [] });
    this.#turnAbort?.abort();
    return undefined;
  }

  crash(message: string): void {
    this.#closed = true;
    this.#turnAbort?.abort();
    this.#out.fail(new Error(message));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#record.closed = true;
    this.#turnAbort?.abort();
    this.#out.end();
  }

  async setModel(model?: string): Promise<void> {
    this.#record.calls.push({ method: 'setModel', args: [model] });
  }

  async applyFlagSettings(settings: unknown): Promise<void> {
    this.#record.calls.push({ method: 'applyFlagSettings', args: [settings] });
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.#record.calls.push({ method: 'setPermissionMode', args: [mode] });
  }

  async stopTask(taskId: string): Promise<void> {
    this.#record.calls.push({ method: 'stopTask', args: [taskId] });
  }

  async initializationResult(): Promise<Record<string, unknown>> {
    if (this.#options.initError !== undefined) throw this.#options.initError;
    return {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: [],
      models: [],
      account: this.#options.account ?? {
        email: 'me@example.com',
        subscriptionType: 'max20',
        tokenSource: 'claude.ai',
        apiProvider: 'firstParty',
      },
    };
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<
    Record<string, unknown>
  > {
    return {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 3, resets_at: '2026-10-15T18:00:00Z' },
        seven_day: { utilization: 56, resets_at: '2026-10-20T00:00:00Z' },
      },
    };
  }
}
