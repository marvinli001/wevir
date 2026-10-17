import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ApprovalRequestedEvent } from '@wevir/runtime-adapter';
import { isAdapterError, isTurnTerminal } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAccounts } from './account.js';
import { ClaudeAdapter, claudeProposedPlan, PLAN_CAPTURED_MESSAGE } from './claude-adapter.js';
import { SIDE_BOUNDARY_NOTE } from './side.js';
import { FakeClaudeSdk, loadRecording } from './test-fixtures/fake-sdk.js';
import {
  FAKE_CLAUDE,
  type FakeHarness,
  newFakeAdapter,
  removeHome,
} from './test-fixtures/harness.js';

const CONFIG = { cwd: process.cwd(), providerId: 'claude', modelId: 'claude-haiku-4-5' } as const;

let harnesses: FakeHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses) {
    await harness.adapter.dispose();
    removeHome(harness.home);
  }
  harnesses = [];
});

function harness(options: Parameters<typeof newFakeAdapter>[0] = {}): FakeHarness {
  const created = newFakeAdapter(options);
  harnesses.push(created);
  return created;
}

/** 收一个会话的事件，`until` 等到满足条件为止。 */
function collect(adapter: ClaudeAdapter, id: string) {
  const events: AgentEvent[] = [];
  const listeners = new Set<() => void>();
  void (async () => {
    for await (const event of adapter.subscribe(id)) {
      events.push(event);
      for (const listener of listeners) listener();
    }
  })();
  const until = (match: (event: AgentEvent) => boolean, from = 0): Promise<AgentEvent> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; saw ${events.map((e) => e.type).join(', ')}`)),
        3000,
      );
      const check = () => {
        const found = events.slice(from).find(match);
        if (found !== undefined) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
        }
      };
      listeners.add(check);
      check();
    });
  return { events, until };
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** 会话的 query（去掉账号探测与生成标题的那几次）。 */
function sessionQueries(sdk: FakeClaudeSdk) {
  return sdk.queries.filter((query) => query.options.canUseTool !== undefined);
}

describe('一问一答（录音 plain）', () => {
  it('思考与文本先增量后提交，替换对得上；用量与结算；交给 SDK 的选项照 T3', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId, engineVersion } = await adapter.createSession(CONFIG);
    expect(engineVersion).toBe('2.1.287');
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Reply with exactly the word hello.'));
    await log.until(isTurnTerminal);

    const types = log.events.map((event) => event.type);
    expect(types.filter((type) => type === 'assistant.delta').length).toBeGreaterThan(3);
    const thought = log.events.find((event) => event.type === 'assistant.thought');
    const message = log.events.find((event) => event.type === 'assistant.message');
    expect(thought).toMatchObject({ replaces: [{ blockIndex: 0 }] });
    expect(message).toMatchObject({ text: 'hello', replaces: [{ blockIndex: 1 }] });
    const usage = log.events.filter((event) => event.type === 'usage.updated');
    expect(usage[0]).toMatchObject({ contextSize: 200_000 });
    expect(usage.at(-1)).toMatchObject({ totalTokens: expect.any(Number) });
    expect(log.events.at(-1)).toMatchObject({
      type: 'turn.settled',
      outcome: 'completed',
      stopReason: 'end_turn',
    });
    // engine.raw 只留不认识的消息（初始化、command_lifecycle、thinking_tokens 等都不进来）。
    expect(log.events.some((event) => event.type === 'engine.raw')).toBe(false);

    const options = sessionQueries(sdk)[0]?.options;
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: FAKE_CLAUDE,
      sessionId: engineSessionId,
      model: 'claude-haiku-4-5',
      permissionMode: 'default',
      includePartialMessages: true,
      forwardSubagentText: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      cwd: CONFIG.cwd,
    });
    expect(options?.resume).toBeUndefined();
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(sessionQueries(sdk)[0]?.prompts[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'Reply with exactly the word hello.' },
    });
  });

  it('同一个进程接着下一回合；关闭后再发报 session_closed，恢复后以 resume 重起进程', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hi'));
    await log.until(isTurnTerminal);
    const from = log.events.length;
    await adapter.send(engineSessionId, text('again'));
    await log.until(isTurnTerminal, from);
    expect(sessionQueries(sdk)).toHaveLength(1);

    await adapter.close(engineSessionId);
    expect(sessionQueries(sdk)[0]?.closed).toBe(true);
    await expect(adapter.send(engineSessionId, text('x'))).rejects.toMatchObject({
      code: 'session_closed',
    });
    await adapter.resumeSession(engineSessionId, CONFIG);
    const resumed = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('after resume'));
    await resumed.until(isTurnTerminal);
    expect(sessionQueries(sdk)[1]?.options).toMatchObject({ resume: engineSessionId });
    expect(sessionQueries(sdk)[1]?.options.sessionId).toBeUndefined();
  });

  it('Host 重启后恢复：磁盘上没有的会话是 session_lost（not_found），有的照常', async () => {
    const { adapter, sdk } = harness();
    const id = '22222222-2222-4222-8222-222222222222';
    await expect(adapter.resumeSession(id, CONFIG)).rejects.toMatchObject({
      code: 'session_lost',
      lostReason: 'not_found',
    });
    sdk.sessions.add(id);
    expect((await adapter.resumeSession(id, CONFIG)).engineSessionId).toBe(id);
  });
});

describe('图片（0.28.0）', () => {
  it('图片在前（base64 图片块），文本在后；只有文本时照旧是字符串', async () => {
    const { adapter, sdk } = harness();
    expect(adapter.acceptsImages()).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'wevir-claude-image-'));
    try {
      const path = join(dir, 'shot.png');
      writeFileSync(path, Buffer.from('fake png bytes'));
      const { engineSessionId } = await adapter.createSession(CONFIG);
      const log = collect(adapter, engineSessionId);
      await adapter.send(engineSessionId, {
        content: [
          { type: 'text', text: 'Reply with exactly the word hello.' },
          { type: 'image', path, mimeType: 'image/png' },
        ],
      });
      await log.until(isTurnTerminal);
      expect(sessionQueries(sdk)[0]?.prompts[0]?.message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from('fake png bytes').toString('base64'),
          },
        },
        { type: 'text', text: 'Reply with exactly the word hello.' },
      ]);
      expect(log.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('工具（录音 tool）', () => {
  it('Read：tool.started 带展示与原始输入，tool.finished 带输出', async () => {
    const { adapter } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Please call a tool'));
    await log.until(isTurnTerminal);
    const started = log.events.find((event) => event.type === 'tool.started');
    expect(started).toMatchObject({
      toolName: 'Read',
      display: { kind: 'read', paths: [expect.stringContaining('hello.txt')] },
      input: { file_path: expect.stringContaining('hello.txt') },
    });
    const finished = log.events.find((event) => event.type === 'tool.finished');
    expect(finished).toMatchObject({
      status: 'completed',
      output: expect.stringContaining('wevir fixture'),
    });
  });
});

describe('审批（录音 approval.*）', () => {
  async function approval(adapter: ClaudeAdapter) {
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(
      engineSessionId,
      text('Please approve writing a file outside the workspace'),
    );
    const request = (await log.until(
      (event) => event.type === 'approval.requested',
    )) as ApprovalRequestedEvent;
    return { engineSessionId, log, request };
  }

  it('四个选项照 Codex；审批之前先有同一工具调用的 tool.started', async () => {
    const { adapter } = harness();
    const { log, request } = await approval(adapter);
    expect(request.options.map((option) => [option.optionId, option.kind])).toEqual([
      ['accept', 'allow_accept'],
      ['acceptForSession', 'allow_accept_for_session'],
      ['decline', 'reject_decline'],
      ['cancel', 'reject_cancel'],
    ]);
    const startedAt = log.events.findIndex(
      (event) => event.type === 'tool.started' && event.toolCallId === request.toolCallId,
    );
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeLessThan(log.events.indexOf(request));
  });

  it('本会话不再询问：规则只记在会话里', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId, request } = await approval(adapter);
    const canUseTool = sessionQueries(sdk)[0]?.options.canUseTool;
    expect(canUseTool).toBeDefined();
    // 直接看 acceptForSession 交回给 SDK 的结果：另起一次请求。
    const pending = canUseTool?.(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'toolu_extra',
        requestId: 'req',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    );
    await adapter.respondToApproval(engineSessionId, 'toolu_extra', {
      optionId: 'acceptForSession',
    });
    expect(await pending).toMatchObject({
      behavior: 'allow',
      decisionClassification: 'user_permanent',
      updatedPermissions: [{ type: 'addRules', destination: 'session' }],
    });
    await adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'accept' });
  });

  it('拒绝并停止：Claude 中断回合，按取消结算', async () => {
    const { adapter } = harness();
    const { engineSessionId, log, request } = await approval(adapter);
    await adapter.respondToApproval(engineSessionId, request.requestId, { optionId: 'cancel' });
    const terminal = await log.until(isTurnTerminal);
    expect(terminal).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    expect(log.events.find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'failed',
    });
  });

  it('完全访问：bypassPermissions 带 allowDangerouslySkipPermissions，canUseTool 直接允许', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession({
      ...CONFIG,
      permissionMode: 'full_access',
    });
    const log = collect(adapter, engineSessionId);
    await adapter.send(
      engineSessionId,
      text('Please approve writing a file outside the workspace'),
    );
    const terminal = await log.until(isTurnTerminal);
    expect(terminal).toMatchObject({ outcome: 'completed' });
    expect(log.events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(sessionQueries(sdk)[0]?.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('自动批准：auto 模式（Claude 的分类器），拿不准的照样问', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession({
      ...CONFIG,
      permissionMode: 'auto_review',
    });
    const log = collect(adapter, engineSessionId);
    await adapter.send(
      engineSessionId,
      text('Please approve writing a file outside the workspace'),
    );
    await log.until((event) => event.type === 'approval.requested');
    expect(sessionQueries(sdk)[0]?.options.permissionMode).toBe('auto');
    await adapter.cancel(engineSessionId);
  });
});

describe('子 agent（录音 subagent）', () => {
  it('Agent 工具：父会话报 subagent.started，子会话的回合由引擎开始，Agent 的结果结算子回合', async () => {
    const { adapter } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const parent = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Please start a subagent'));
    const started = await parent.until((event) => event.type === 'subagent.started');
    expect(started).toMatchObject({
      title: expect.stringMatching(/pong/i),
      role: 'general-purpose',
      prompt: expect.stringContaining('pong'),
    });
    if (started.type !== 'subagent.started') throw new Error('unreachable');
    const child = collect(adapter, started.childEngineSessionId);
    await child.until(isTurnTerminal);
    expect(child.events[0]).toMatchObject({ type: 'turn.started', input: [{ type: 'text' }] });
    expect(child.events.find((event) => event.type === 'assistant.message')).toMatchObject({
      text: 'pong',
    });
    expect(child.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    await parent.until(isTurnTerminal);
    expect(parent.events.find((event) => event.type === 'tool.started')).toMatchObject({
      toolName: 'Agent',
      display: { kind: 'sub_agent' },
    });
    expect(parent.events.every((event) => event.engineSessionId === engineSessionId)).toBe(true);
    await expect(adapter.send(started.childEngineSessionId, text('x'))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('会话中换设置、支线、补说明、标题', () => {
  it('换模型、档位与权限：下一次发消息时在进程里改；换到完全访问要重起进程', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hi'));
    await log.until(isTurnTerminal);

    await adapter.configureSession(engineSessionId, {
      modelId: 'claude-opus-4-7',
      reasoningEffort: 'xhigh',
      permissionMode: 'auto_review',
    });
    let from = log.events.length;
    await adapter.send(engineSessionId, text('next'));
    await log.until(isTurnTerminal, from);
    expect(sessionQueries(sdk)).toHaveLength(1);
    // Opus 4.7 的 xhigh 交给 Claude Code 时是 max（T3 清单的 effortMap）。
    expect(sessionQueries(sdk)[0]?.calls).toEqual([
      { method: 'setModel', args: ['claude-opus-4-7'] },
      { method: 'applyFlagSettings', args: [{ effortLevel: 'max' }] },
      { method: 'setPermissionMode', args: ['auto'] },
    ]);

    await adapter.configureSession(engineSessionId, {
      modelId: 'claude-opus-4-7',
      reasoningEffort: 'xhigh',
      permissionMode: 'full_access',
    });
    from = log.events.length;
    await adapter.send(engineSessionId, text('third'));
    // 旧进程关掉不影响新回合：照常完成。
    expect(await log.until(isTurnTerminal, from)).toMatchObject({ outcome: 'completed' });
    expect(
      log.events
        .filter(isTurnTerminal)
        .every((event) => event.type === 'turn.settled' && event.outcome === 'completed'),
    ).toBe(true);
    expect(sessionQueries(sdk)).toHaveLength(2);
    expect(sessionQueries(sdk)[0]?.closed).toBe(true);
    expect(sessionQueries(sdk)[1]?.options).toMatchObject({
      resume: engineSessionId,
      model: 'claude-opus-4-7',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
  });

  it('支线：从最近一个完成的回合分出，第一条消息前面是边界说明，不写会话记录', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    await expect(adapter.fork(engineSessionId, CONFIG)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hi'));
    await log.until(isTurnTerminal);
    const lastAssistant = [...loadRecording('plain').lines]
      .reverse()
      .find((line) => line.message?.type === 'assistant')?.message?.uuid;

    const side = await adapter.fork(engineSessionId, CONFIG);
    expect(sdk.forks).toEqual([
      { sessionId: engineSessionId, upToMessageId: lastAssistant, forked: side.engineSessionId },
    ]);
    const sideLog = collect(adapter, side.engineSessionId);
    await adapter.send(side.engineSessionId, text('a side question'));
    await sideLog.until(isTurnTerminal);
    const sideQuery = sessionQueries(sdk).at(-1);
    expect(sideQuery?.options).toMatchObject({
      resume: side.engineSessionId,
      persistSession: false,
    });
    expect(sideQuery?.prompts[0]?.message.content).toBe(`${SIDE_BOUNDARY_NOTE}\n\na side question`);
  });

  it('injectNote：shouldQuery: false 的消息随下一条消息交给模型', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    await adapter.injectNote(engineSessionId, 'note before the process starts');
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hi'));
    await log.until(isTurnTerminal);
    await adapter.injectNote(engineSessionId, 'note while idle');
    expect(
      sessionQueries(sdk)[0]?.prompts.map((prompt) => [prompt.message.content, prompt.shouldQuery]),
    ).toEqual([
      ['note before the process starts', false],
      ['hi', undefined],
      ['note while idle', false],
    ]);
  });

  it('generateTitle：一次性的 query，不给工具、不写记录，返回结构化输出', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const title = await adapter.generateTitle(engineSessionId, {
      instructions: 'Make a title',
      input: '<user_prompt>hi</user_prompt>',
      outputSchema: { type: 'object' },
    });
    expect(JSON.parse(title)).toEqual({ title: 'Fake title', description: 'A fake title' });
    expect(
      sdk.queries.find((query) => query.options.outputFormat !== undefined)?.options,
    ).toMatchObject({
      tools: [],
      persistSession: false,
      settingSources: [],
      permissionMode: 'dontAsk',
      systemPrompt: 'Make a title',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
  });
});

describe('压缩上下文（0.24.0）', () => {
  const status = (value: 'compacting' | null, extra: Record<string, unknown> = {}) => ({
    kind: 'message' as const,
    message: {
      type: 'system',
      subtype: 'status',
      status: value,
      uuid: value === null ? 'status-done' : 'status-compacting',
      session_id: '<session>',
      ...extra,
    },
  });
  const boundary = (trigger: 'manual' | 'auto') => ({
    kind: 'message' as const,
    message: {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger, pre_tokens: 1500, post_tokens: 400 },
      uuid: 'boundary-1',
      session_id: '<session>',
    },
  });
  // `/compact` 的结果不带这条消息的 uuid（T3 的录音同样没有）。
  const compactResult = {
    kind: 'message' as const,
    message: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      num_turns: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      user_message_uuids: ['some-other-uuid'],
      uuid: 'result-compact',
      session_id: '<session>',
    },
  };

  it('compact 发 /compact；status compacting 与 compact_boundary → manual 的压缩事件，用量换成 post_tokens', async () => {
    const { adapter, sdk } = harness({
      script: (prompt) =>
        prompt === '/compact'
          ? { steps: [status('compacting'), boundary('manual'), status(null), compactResult] }
          : undefined,
    });
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.compact(engineSessionId);
    await log.until(isTurnTerminal);
    expect(sessionQueries(sdk)[0]?.prompts[0]).toMatchObject({
      message: { role: 'user', content: '/compact' },
    });
    expect(log.events.map((event) => event.type)).toEqual([
      'context.compacting',
      'context.compacted',
      'usage.updated',
      'turn.settled',
    ]);
    expect(log.events[0]).toMatchObject({ compactionId: 'status-compacting', trigger: 'manual' });
    expect(log.events[1]).toMatchObject({ compactionId: 'status-compacting', trigger: 'manual' });
    expect(log.events[2]).toMatchObject({ contextUsed: 400 });
    expect(log.events[3]).toMatchObject({ outcome: 'completed' });
  });

  it('Claude 在回合中自己压缩：auto；压缩失败的不报完成', async () => {
    const plain = loadRecording('plain').lines.flatMap((line) =>
      line.message === undefined ? [] : [{ kind: 'message' as const, message: line.message }],
    );
    const { adapter } = harness({
      script: (prompt) =>
        prompt === 'auto'
          ? { steps: [status('compacting'), boundary('auto'), status(null), ...plain] }
          : prompt === 'failed'
            ? {
                steps: [status('compacting'), status(null, { compact_result: 'failed' }), ...plain],
              }
            : undefined,
    });
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('auto'));
    await log.until(isTurnTerminal);
    expect(log.events.find((event) => event.type === 'context.compacting')).toMatchObject({
      trigger: 'auto',
    });
    expect(log.events.find((event) => event.type === 'context.compacted')).toMatchObject({
      trigger: 'auto',
    });
    const from = log.events.length;
    await adapter.send(engineSessionId, text('failed'));
    await log.until(isTurnTerminal, from);
    const second = log.events.slice(from).map((event) => event.type);
    expect(second).toContain('context.compacting');
    expect(second).not.toContain('context.compacted');
    expect(log.events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  });
});

describe('清单与提问', () => {
  const todoScript = (prompt: string) =>
    prompt === 'todo'
      ? {
          steps: [
            {
              kind: 'message' as const,
              message: {
                type: 'assistant',
                message: {
                  id: 'msg_t',
                  model: 'claude-haiku-4-5',
                  content: [
                    {
                      type: 'tool_use',
                      id: 'toolu_todo',
                      name: 'TodoWrite',
                      input: { todos: [{ content: 'Step one', status: 'in_progress' }] },
                    },
                    {
                      type: 'tool_use',
                      id: 'toolu_task',
                      name: 'TaskCreate',
                      input: { subject: 'Ship it' },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: 'a1',
              },
            },
            {
              kind: 'message' as const,
              message: {
                type: 'user',
                message: {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: 'toolu_task', content: 'Task #7 created' },
                  ],
                },
                tool_use_result: { task: { id: '7', subject: 'Ship it' } },
                parent_tool_use_id: null,
                uuid: 'u1',
              },
            },
            {
              kind: 'message' as const,
              message: {
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: '',
                stop_reason: 'end_turn',
                modelUsage: {},
                user_message_uuids: ['<prompt>'],
              },
            },
          ],
        }
      : undefined;

  it('TodoWrite 给完整清单；TaskCreate 按结果里的 ID 加一条', async () => {
    const { adapter } = harness({ script: todoScript });
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('todo'));
    await log.until(isTurnTerminal);
    const todos = log.events.filter((event) => event.type === 'todo.updated');
    expect(todos).toEqual([
      expect.objectContaining({
        toolCallId: 'toolu_todo',
        items: [{ content: 'Step one', status: 'in_progress' }],
      }),
      expect.objectContaining({
        toolCallId: 'toolu_task',
        items: [{ content: 'Ship it', status: 'pending' }],
      }),
    ]);
  });

  it('AskUserQuestion：question.requested，回答作为工具的输入交回', async () => {
    const { adapter, sdk } = harness();
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(
      engineSessionId,
      text('Please approve writing a file outside the workspace'),
    );
    await log.until((event) => event.type === 'approval.requested');
    const canUseTool = sessionQueries(sdk)[0]?.options.canUseTool;
    const input = {
      questions: [
        {
          question: 'Which color?',
          header: 'Color',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: true,
        },
      ],
    };
    const pending = canUseTool?.('AskUserQuestion', input, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_q',
      requestId: 'req-q',
    });
    const asked = await log.until((event) => event.type === 'question.requested');
    expect(asked).toMatchObject({
      requestId: 'toolu_q',
      questions: [{ id: 'Which color?', header: 'Color', multiSelect: true, allowOther: true }],
    });
    await adapter.respondToQuestion(engineSessionId, 'toolu_q', {
      'Which color?': ['Red', 'Blue'],
    });
    expect(await pending).toMatchObject({
      behavior: 'allow',
      updatedInput: { questions: input.questions, answers: { 'Which color?': 'Red, Blue' } },
    });
    await adapter.cancel(engineSessionId);
  });
});

describe('计划模式（0.36.0）', () => {
  const PLAN = '# Export button\n\n- Add it to the toolbar';
  const exitInput = { plan: `${PLAN}\n` };
  const planScript = (prompt: string) =>
    prompt === 'plan it'
      ? {
          steps: [
            {
              kind: 'message' as const,
              message: {
                type: 'assistant',
                message: {
                  id: 'msg_p',
                  model: 'claude-haiku-4-5',
                  content: [
                    { type: 'text', text: 'I read the toolbar code.' },
                    { type: 'tool_use', id: 'toolu_exit', name: 'ExitPlanMode', input: exitInput },
                  ],
                },
                parent_tool_use_id: null,
                uuid: 'a1',
              },
            },
            {
              kind: 'permission' as const,
              toolName: 'ExitPlanMode',
              input: exitInput,
              toolUseID: 'toolu_exit',
              allow: [],
              interrupt: [],
              decline: [
                {
                  kind: 'message' as const,
                  message: {
                    type: 'user',
                    message: {
                      role: 'user',
                      content: [
                        {
                          type: 'tool_result',
                          tool_use_id: 'toolu_exit',
                          is_error: true,
                          content: 'The client captured your proposed plan.',
                        },
                      ],
                    },
                    parent_tool_use_id: null,
                    uuid: 'u1',
                  },
                },
                {
                  kind: 'message' as const,
                  message: {
                    type: 'result',
                    subtype: 'success',
                    is_error: false,
                    result: '',
                    stop_reason: 'end_turn',
                    modelUsage: {},
                    user_message_uuids: ['<prompt>'],
                  },
                },
              ],
            },
          ],
        }
      : undefined;

  it('计划回合用权限模式 plan；ExitPlanMode → plan.proposed 并拒掉，工具本身不显示；下一个默认回合换回 default', async () => {
    const { adapter, sdk } = harness({ script: planScript });
    expect(adapter.planMode).toBe(true);
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, { ...text('plan it'), collaborationMode: 'plan' });
    expect(await log.until(isTurnTerminal)).toMatchObject({ outcome: 'completed' });
    expect(sessionQueries(sdk)[0]?.options).toMatchObject({ permissionMode: 'plan' });
    expect(log.events.filter((event) => event.type === 'plan.proposed')).toEqual([
      { type: 'plan.proposed', engineSessionId, planId: 'toolu_exit', text: PLAN },
    ]);
    const shown = log.events.filter(
      (event) =>
        (event.type === 'tool.started' || event.type === 'tool.finished') &&
        event.toolCallId === 'toolu_exit',
    );
    expect(shown).toEqual([]);
    expect(log.events.some((event) => event.type === 'approval.requested')).toBe(false);

    const from = log.events.length;
    await adapter.send(engineSessionId, text('go'));
    await log.until(isTurnTerminal, from);
    expect(sessionQueries(sdk)).toHaveLength(1);
    expect(sessionQueries(sdk)[0]?.calls).toEqual([
      { method: 'setPermissionMode', args: ['default'] },
    ]);
  });

  it('ExitPlanMode 的拒绝带 T3 的说明；完全访问的会话里照样拦下；计划是空的不报', async () => {
    const holdScript = (prompt: string) =>
      prompt === 'hold'
        ? {
            steps: [
              { kind: 'delay' as const, ms: 2000 },
              {
                kind: 'message' as const,
                message: {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  result: '',
                  stop_reason: 'end_turn',
                  modelUsage: {},
                  user_message_uuids: ['<prompt>'],
                },
              },
            ],
          }
        : undefined;
    const { adapter, sdk } = harness({ script: holdScript });
    const { engineSessionId } = await adapter.createSession({
      ...CONFIG,
      permissionMode: 'full_access',
    });
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, { ...text('hold'), collaborationMode: 'plan' });
    // 完全访问的启动参数照旧带上，回到默认模式不用重起。
    expect(sessionQueries(sdk)[0]?.options).toMatchObject({
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: true,
    });
    const canUseTool = sessionQueries(sdk)[0]?.options.canUseTool;
    const decide = (toolUseID: string, input: unknown) =>
      canUseTool?.('ExitPlanMode', input as Record<string, unknown>, {
        signal: new AbortController().signal,
        toolUseID,
        requestId: `req-${toolUseID}`,
      });
    expect(await decide('toolu_x', { plan: '# P' })).toEqual({
      behavior: 'deny',
      message: PLAN_CAPTURED_MESSAGE,
      toolUseID: 'toolu_x',
    });
    expect(await decide('toolu_empty', { plan: '  ' })).toMatchObject({ behavior: 'deny' });
    const plans = log.events.filter((event) => event.type === 'plan.proposed');
    expect(plans).toEqual([
      { type: 'plan.proposed', engineSessionId, planId: 'toolu_x', text: '# P' },
    ]);
    await adapter.cancel(engineSessionId);
  });

  it('claudeProposedPlan：取 plan，认 T3 的 record 包装，空的是 undefined', () => {
    expect(claudeProposedPlan({ plan: ' # A ' })).toBe('# A');
    expect(claudeProposedPlan({ type: 'record', value: { plan: '# B' } })).toBe('# B');
    expect(claudeProposedPlan({ plan: '' })).toBeUndefined();
    expect(claudeProposedPlan(undefined)).toBeUndefined();
  });
});

describe('失败与登录', () => {
  it('没登录：建会话报 missing_credentials；没装：engine_unavailable', async () => {
    const { home } = harness();
    const sdk = new FakeClaudeSdk({ account: { tokenSource: 'none', apiKeySource: 'none' } });
    const signedOut = new ClaudeAdapter({
      home,
      sdk,
      accounts: new ClaudeAccounts({
        sdk,
        workDir: join(home, 'engines', 'claude'),
        findExecutable: () => FAKE_CLAUDE,
        probeVersion: async () => ({ ok: true, version: '2.1.287' }),
      }),
    });
    const error = await signedOut.createSession(CONFIG).catch((caught: unknown) => caught);
    expect(isAdapterError(error, 'missing_credentials')).toBe(true);
    await signedOut.dispose();

    const missing = new ClaudeAdapter({
      home,
      sdk,
      accounts: new ClaudeAccounts({
        sdk,
        workDir: join(home, 'engines', 'claude'),
        findExecutable: () => undefined,
      }),
    });
    const notInstalled = await missing.createSession(CONFIG).catch((caught: unknown) => caught);
    expect(isAdapterError(notInstalled, 'engine_unavailable')).toBe(true);
    await missing.dispose();
  });

  it('认证失败的回合：turn.failed（missing_credentials），账号标成没登录', async () => {
    const authScript = (prompt: string) =>
      prompt === 'auth'
        ? {
            steps: [
              {
                kind: 'message' as const,
                message: {
                  type: 'assistant',
                  error: 'authentication_failed',
                  message: {
                    id: 'msg_a',
                    model: '<synthetic>',
                    content: [{ type: 'text', text: 'Invalid API key · Please run /login' }],
                  },
                  parent_tool_use_id: null,
                  uuid: 'a1',
                },
              },
              {
                kind: 'message' as const,
                message: {
                  type: 'result',
                  subtype: 'success',
                  is_error: true,
                  api_error_status: 401,
                  result: 'Invalid API key · Please run /login',
                  stop_reason: 'stop_sequence',
                  modelUsage: {},
                  user_message_uuids: ['<prompt>'],
                },
              },
            ],
          }
        : undefined;
    const { adapter } = harness({ script: authScript });
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const states: string[] = [];
    adapter.accounts.onChange((state) => states.push(state.status));
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('auth'));
    const terminal = await log.until(isTurnTerminal);
    expect(terminal).toMatchObject({
      type: 'turn.failed',
      category: 'missing_credentials',
      message: 'Invalid API key · Please run /login',
      code: 401,
    });
    // CLI 生成的错误消息不当回答显示。
    expect(log.events.some((event) => event.type === 'assistant.message')).toBe(false);
    expect(states).toContain('signed_out');
  });

  it('回合中进程没了：turn.failed，下次发消息以 resume 重起', async () => {
    const { adapter, sdk } = harness({
      script: (prompt) =>
        prompt === 'hang' ? { steps: [{ kind: 'delay', ms: 10_000 }] } : undefined,
    });
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('hang'));
    sdk.crash(sdk.queries.indexOf(sessionQueries(sdk)[0] as (typeof sdk.queries)[number]));
    expect(await log.until(isTurnTerminal)).toMatchObject({
      type: 'turn.failed',
      category: 'unknown',
      message: 'Claude Code process exited with code 1',
    });
    const from = log.events.length;
    await adapter.send(engineSessionId, text('hi'));
    expect(await log.until(isTurnTerminal, from)).toMatchObject({ outcome: 'completed' });
    expect(sessionQueries(sdk)[1]?.options).toMatchObject({ resume: engineSessionId });
  });
});

describe('读历史的工具（0.25.0）', () => {
  it('给了 historyTool 时每个会话的 query 挂上 wevir_history，工具不用审批；脚本写进数据目录', async () => {
    const plain = harness();
    await plain.adapter.createSession(CONFIG);
    expect(plain.adapter.historyTool).toBe(false);

    const probe = harness();
    const server = {
      script: join(probe.home, 'mcp', 'wevir-history.mjs'),
      node: '/usr/bin/node',
      historyDir: join(probe.home, 'history'),
    };
    const { adapter, sdk } = harness({ historyTool: server });
    expect(adapter.historyTool).toBe(true);
    const { engineSessionId } = await adapter.createSession(CONFIG);
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Reply with exactly the word hello.'));
    await log.until(isTurnTerminal);
    const options = sessionQueries(sdk)[0]?.options;
    expect(options?.mcpServers).toEqual({
      wevir_history: {
        type: 'stdio',
        command: '/usr/bin/node',
        args: [server.script, server.historyDir],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    });
    expect(options?.allowedTools).toEqual(['mcp__wevir_history__read_session_history']);
    expect(existsSync(server.script)).toBe(true);
    const plainOptions = sessionQueries(plain.sdk)[0]?.options;
    expect(plainOptions?.mcpServers).toBeUndefined();
  });
});

describe('应用级工具（0.30.0）', () => {
  it('会话带 appTools 时挂上 HTTP 的 wevir 服务，只读的工具放进 allowedTools；没有时不挂', async () => {
    const { adapter, sdk } = harness();
    expect(adapter.appTools).toBe(true);
    const appTools = { url: 'http://127.0.0.1:4100/mcp', token: 'session-token' };
    const { engineSessionId } = await adapter.createSession({ ...CONFIG, appTools });
    const log = collect(adapter, engineSessionId);
    await adapter.send(engineSessionId, text('Reply with exactly the word hello.'));
    await log.until(isTurnTerminal);
    const options = sessionQueries(sdk)[0]?.options;
    expect(options?.mcpServers).toEqual({
      wevir: {
        type: 'http',
        url: appTools.url,
        headers: { Authorization: 'Bearer session-token' },
      },
    });
    expect(options?.allowedTools).toEqual([
      'mcp__wevir__wevir_session_list',
      'mcp__wevir__wevir_session_read',
      'mcp__wevir__wevir_session_wait',
      'mcp__wevir__wevir_models',
      'mcp__wevir__wevir_show',
      'mcp__wevir__wevir_share_file',
      'mcp__wevir__wevir_plugins_list',
      // 0.47.0：后台进程的列出、读输出与等待。
      'mcp__wevir__wevir_process_list',
      'mcp__wevir__wevir_process_output',
      'mcp__wevir__wevir_process_wait',
      // 0.33.0：只读的浏览器工具。
      'mcp__wevir__browser_list_tabs',
      'mcp__wevir__browser_snapshot',
      'mcp__wevir__browser_screenshot',
      'mcp__wevir__browser_wait',
      'mcp__wevir__browser_logs',
      // 0.48.0：查元素与网络记录。
      'mcp__wevir__browser_query',
      'mcp__wevir__browser_network',
    ]);
  });
});
