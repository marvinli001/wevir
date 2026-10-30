// ACP 样本回放（test-fixtures/acp-samples.ts，取自 T3 的 Antigravity 样本）：经 Antigravity 的引擎描述与通用 ACP 适配器的
// 会话队列（SessionEventQueue），看映射出的 AgentEvent；另有模型列表、提问与错误归类。

import { type AcpSessionNotification, SessionEventQueue } from '@wevir/adapter-acp';
import type { RequestPermissionRequest } from '@wevir/adapter-acp/sdk';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_ENGINE,
  classifyAntigravityResumeError,
  classifyAntigravityTurnError,
} from './engine.js';
import {
  antigravityModelsFromSetup,
  antigravityThinkingOption,
  knownEfforts,
  probeThinkingLevels,
  thinkingEfforts,
  thinkingLevelFor,
} from './models.js';
import {
  antigravityQuestion,
  antigravityToolDisplay,
  isAntigravitySubagentTool,
} from './protocol.js';
import {
  LARGE_TOOL_UPDATE,
  PERMISSION_REQUEST,
  QUESTION_REQUEST,
  SESSION,
  SESSION_SETUP,
  SESSION_SETUP_1_4,
  TURN_WITH_COMMAND,
  thinkingOption,
} from './test-fixtures/acp-samples.js';

async function replay(notifications: unknown[]): Promise<AgentEvent[]> {
  const queue = new SessionEventQueue(SESSION, () => {}, ANTIGRAVITY_ENGINE);
  const events: AgentEvent[] = [];
  const reading = (async () => {
    for await (const event of queue.subscribe()) events.push(event);
  })();
  queue.beginTurn();
  for (const notification of notifications) {
    const normalized = ANTIGRAVITY_ENGINE.normalizeUpdate?.(notification as AcpSessionNotification);
    queue.acpUpdate(normalized ?? (notification as AcpSessionNotification));
  }
  queue.endTurn({
    type: 'turn.settled',
    engineSessionId: SESSION,
    outcome: 'completed',
    stopReason: 'end_turn',
  });
  queue.end();
  await reading;
  return events;
}

describe('Antigravity 样本回放', () => {
  it('逐字增量合成一块、命令工具带命令与输出、回合内顺序与引擎写出的一致', async () => {
    const events = await replay(TURN_WITH_COMMAND);
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'assistant.delta',
      'assistant.thought',
      'assistant.stream_ended',
      'assistant.delta',
      'assistant.delta',
      'assistant.message',
      'assistant.stream_ended',
      'tool.started',
      'tool.finished',
      'assistant.delta',
      // available_commands_update 只映射成 engine.raw，不截断流式中的一块（session-events.ts），块到回合结束才提交。
      'engine.raw',
      'assistant.message',
      'assistant.stream_ended',
      'turn.settled',
    ]);
    const message = events.find((event) => event.type === 'assistant.message');
    expect(message).toMatchObject({ text: '{"title":"Repair login"}' });
    expect(message?.type === 'assistant.message' && message.replaces).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject({
      toolName: 'run_command',
      toolCallId: 'fc28d0af6ad14be8bbba20f4258d4d3e',
      display: { kind: 'shell', command: 'cat probe.txt', summary: 'cat probe.txt' },
      input: { CommandLine: 'cat probe.txt', Cwd: '/workspace' },
    });
    expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
      status: 'completed',
      output: 'after\n',
    });
    // available_commands_update 没有对应的 Wevir 事件，原样保留。
    expect(events.find((event) => event.type === 'engine.raw')).toMatchObject({
      kind: 'available_commands_update',
    });
  });

  it('工具负载进事件库之前截断、去掉图片数据', async () => {
    const events = await replay([LARGE_TOOL_UPDATE]);
    const finished = events.find((event) => event.type === 'tool.finished');
    expect(finished?.type === 'tool.finished' && finished.output?.length).toBeLessThan(8_100);
    expect(finished?.type === 'tool.finished' && finished.output?.endsWith('tail')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('AAAAAAAAAA');
    expect(JSON.stringify(events)).not.toContain('BBBBBBBBBB');
  });

  it('失败的原因在 rawOutput 里（字符串或 error 字段）时作为工具输出，不再是“无输出”', async () => {
    const failed = (toolCallId: string, title: string, rawOutput: unknown, content?: unknown) => [
      {
        sessionId: SESSION,
        update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'other', status: 'pending' },
      },
      {
        sessionId: SESSION,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          rawOutput,
          ...(content !== undefined && { content }),
        },
      },
    ];
    const events = await replay([
      // T3 的 antigravitySubagentOutput 按字符串读 start_subagent 的 rawOutput。
      ...failed('sub-1', 'Running start_subagent', 'missing required argument: Prompt'),
      ...failed('read-1', 'view_file', {
        error: { message: 'open instructions.md: no such file' },
      }),
      ...failed('cmd-1', 'run_command', { exitCode: 1, error: 'chdir: no such file or directory' }),
      // 已有文本内容时以它为准。
      ...failed('mcp-1', 'Running wevir_models', 'raw text', [
        { type: 'content', content: { type: 'text', text: 'from content' } },
      ]),
      ...failed('empty-1', 'run_command', { exitCode: 1 }),
    ]);
    const outputs = Object.fromEntries(
      events.flatMap((event) =>
        event.type === 'tool.finished' ? [[event.toolCallId, event.output]] : [],
      ),
    );
    expect(outputs).toEqual({
      'sub-1': 'missing required argument: Prompt',
      'read-1': 'open instructions.md: no such file',
      'cmd-1': 'chdir: no such file or directory',
      'mcp-1': 'from content',
      'empty-1': undefined,
    });
  });

  it('模型列表来自 configOptions 的 model 选项：分组摊平、去重、当前值是默认', () => {
    expect(antigravityModelsFromSetup(SESSION_SETUP)).toEqual({
      models: [
        { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
        { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash (High)' },
        { id: 'gemini-3.7-flash-medium', displayName: 'Gemini 3.7 Flash (Medium)' },
        { id: 'gemini-pro-agent', displayName: 'Gemini 3.1 Pro (High)' },
      ],
      defaultModelId: 'gemini-3.7-flash-high',
    });
    // 没有 model 选项时退回 ACP 的 models。
    expect(antigravityModelsFromSetup({ models: SESSION_SETUP.models })?.defaultModelId).toBe(
      'gemini-3.7-flash-high',
    );
    expect(antigravityModelsFromSetup({ configOptions: [] })).toBeUndefined();
  });

  it('1.4 的思考档位：当前模型取 thought_level 选项，别的模型用记下的档位，没记过的与没有档位的是固定档位', () => {
    const known = new Map<string, readonly string[]>([
      ['claude', ['low']],
      ['plain', []],
    ]);
    expect(antigravityModelsFromSetup(SESSION_SETUP_1_4, known)).toEqual({
      models: [
        { id: 'gemini', displayName: 'Gemini', reasoningEfforts: ['low', 'high'] },
        { id: 'claude', displayName: 'Claude', reasoningEfforts: ['low'] },
        { id: 'plain', displayName: 'Plain' },
        { id: 'unseen', displayName: 'Unseen' },
      ],
      defaultModelId: 'gemini',
    });
    // 当前模型以会话报的为准，记下的旧值不顶替。
    expect(
      antigravityModelsFromSetup(SESSION_SETUP_1_4, new Map([['gemini', ['minimal']]]))?.models[0],
    ).toMatchObject({ reasoningEfforts: ['low', 'high'] });
    // 当前模型没有档位选项：固定档位。
    const withoutThinking = { configOptions: SESSION_SETUP_1_4.configOptions.slice(0, 1) };
    expect(antigravityModelsFromSetup(withoutThinking)?.models[0]).toEqual({
      id: 'gemini',
      displayName: 'Gemini',
    });
    // 存下的档位读回来就是下一次的 known。
    expect(knownEfforts(antigravityModelsFromSetup(SESSION_SETUP_1_4, known))).toEqual(
      new Map([
        ['gemini', ['low', 'high']],
        ['claude', ['low']],
      ]),
    );
  });

  it('运行体档位与 Wevir 推理档位：extra_high 记作 xhigh，表外的不要；反过来先找同名再找 extra_high', () => {
    expect(
      thinkingEfforts(['minimal', 'low', 'medium', 'high', 'extra_high', 'max', 'turbo', 'high']),
    ).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(thinkingEfforts(['xhigh', 'extra_high'])).toEqual(['xhigh']);
    expect(thinkingLevelFor('xhigh', ['low', 'extra_high'])).toBe('extra_high');
    expect(thinkingLevelFor('xhigh', ['extra_high', 'xhigh'])).toBe('xhigh');
    expect(thinkingLevelFor('high', ['low', 'high'])).toBe('high');
    expect(thinkingLevelFor('medium', ['low', 'high'])).toBeUndefined();
    expect(thinkingLevelFor('off', ['low', 'high'])).toBeUndefined();
    expect(antigravityThinkingOption(SESSION_SETUP_1_4.configOptions)).toEqual({
      id: 'thinking_level',
      currentValue: 'high',
      values: ['low', 'high'],
    });
    // 1.3 没有这个选项。
    expect(antigravityThinkingOption(SESSION_SETUP.configOptions)).toBeUndefined();
  });

  it('逐个选一遍模型读档位：跳过当前模型，选不上的不写；1.3 没有档位选项时不探测', async () => {
    const selected: string[] = [];
    const models = await probeThinkingLevels(SESSION_SETUP_1_4, async (modelId) => {
      selected.push(modelId);
      if (modelId === 'unseen') throw new Error('PERMISSION_DENIED');
      const [model, ...rest] = SESSION_SETUP_1_4.configOptions;
      return [
        { ...model, currentValue: modelId },
        ...(modelId === 'claude' ? [thinkingOption('low', ['low', 'medium', 'extra_high'])] : []),
        ...rest.slice(1),
      ];
    });
    expect(selected).toEqual(['claude', 'plain', 'unseen']);
    expect(models?.models).toEqual([
      { id: 'gemini', displayName: 'Gemini', reasoningEfforts: ['low', 'high'] },
      { id: 'claude', displayName: 'Claude', reasoningEfforts: ['low', 'medium', 'xhigh'] },
      { id: 'plain', displayName: 'Plain' },
      { id: 'unseen', displayName: 'Unseen' },
    ]);
    expect(models?.defaultModelId).toBe('gemini');

    const untouched: string[] = [];
    await probeThinkingLevels(SESSION_SETUP, async (modelId) => {
      untouched.push(modelId);
      return [];
    });
    expect(untouched).toEqual([]);
  });

  it('interaction_* 是单选题：按选项 ID 或 label 回答，重名的 label 带选项 ID，答不上的保持未决', () => {
    const question = antigravityQuestion(QUESTION_REQUEST as RequestPermissionRequest);
    expect(question?.questions).toEqual([
      {
        id: 'interaction_9960062f',
        header: 'Question',
        question: 'Which result label should be used for the verification?',
        options: [{ label: 'Verified' }, { label: 'Needs review' }],
        multiSelect: false,
        allowOther: false,
      },
    ]);
    for (const answer of ['1', 'Verified']) {
      expect(question?.respond({ interaction_9960062f: [answer] })).toEqual({
        outcome: { outcome: 'selected', optionId: '1' },
      });
    }
    expect(question?.respond({ interaction_9960062f: ['nope'] })).toBeUndefined();
    expect(question?.respond({})).toBeUndefined();

    const duplicate = antigravityQuestion({
      ...QUESTION_REQUEST,
      options: QUESTION_REQUEST.options.map((option) => ({ ...option, name: 'Same' })),
    } as RequestPermissionRequest);
    expect(duplicate?.questions[0]?.options).toEqual([
      { label: 'Same (1)' },
      { label: 'Same (2)' },
    ]);
    expect(duplicate?.respond({ interaction_9960062f: ['Same (2)'] })).toEqual({
      outcome: { outcome: 'selected', optionId: '2' },
    });
    // 普通审批不是提问。
    expect(antigravityQuestion(PERMISSION_REQUEST as RequestPermissionRequest)).toBeUndefined();
  });

  it('子 agent 的标题：start_subagent 与 1.4 的 invoke_subagent，运行中与等审批两种写法；别的标题与 MCP 工具不算', () => {
    for (const title of [
      'Running start_subagent',
      'Run start_subagent?',
      'Running invoke_subagent',
      'Run invoke_subagent?',
    ]) {
      expect(isAntigravitySubagentTool(title, 'other', {})).toBe(true);
      expect(isAntigravitySubagentTool(title, undefined, undefined)).toBe(true);
      expect(isAntigravitySubagentTool(title, 'other', { is_mcp_tool_call: true })).toBe(false);
      expect(isAntigravitySubagentTool(title, 'execute', {})).toBe(false);
    }
    for (const title of ['Running invoke_subagents', 'Run invoke_subagent', 'invoke_subagent']) {
      expect(isAntigravitySubagentTool(title, 'other', {})).toBe(false);
    }
    expect(
      antigravityToolDisplay(
        'Run invoke_subagent?',
        { Description: 'Check the build' },
        { kind: 'other' },
      ),
    ).toEqual({ kind: 'sub_agent', summary: 'Check the build' });
  });

  it('工具的展示类型：按 ACP kind，start_subagent 是子 agent（MCP 的同名工具不是）', () => {
    expect(
      antigravityToolDisplay('Read file', {}, { kind: 'read', locations: [{ path: 'a.ts' }] }),
    ).toEqual({ kind: 'read', paths: ['a.ts'], summary: 'a.ts' });
    expect(antigravityToolDisplay('Running start_subagent', {}, { kind: 'other' })).toEqual({
      kind: 'sub_agent',
      summary: 'start_subagent',
    });
    expect(
      antigravityToolDisplay(
        'Running start_subagent',
        { Description: 'Verify the smoke test\nthen report', Prompt: 'long prompt' },
        { kind: 'other' },
      ),
    ).toEqual({ kind: 'sub_agent', summary: 'Verify the smoke test' });
    // 标题是“Running <工具>”的句子：摘要只写工具名；涉及的路径放在 paths，不顶替工具名。
    expect(
      antigravityToolDisplay(
        'Running wevir_share_file',
        { path: 'a.md' },
        { kind: 'other', _meta: { is_mcp_tool_call: true }, locations: [{ path: '/w/a.md' }] },
      ),
    ).toEqual({ kind: 'unknown', summary: 'wevir_share_file', paths: ['/w/a.md'] });
    expect(antigravityToolDisplay('Run generate_image?', {}, { kind: 'other' })).toEqual({
      kind: 'unknown',
      summary: 'generate_image',
    });
    expect(antigravityToolDisplay('Running the tests', {}, { kind: 'other' })).toEqual({
      kind: 'unknown',
      summary: 'Running the tests',
    });
    expect(
      antigravityToolDisplay(
        'Running start_subagent',
        {},
        { kind: 'other', _meta: { is_mcp_tool_call: true } },
      ),
    ).toMatchObject({ kind: 'unknown' });
    expect(
      antigravityToolDisplay('read_url', { url: 'https://example.com' }, { kind: 'fetch' }),
    ).toEqual({
      kind: 'fetch',
      summary: 'https://example.com',
      url: 'https://example.com',
    });
  });

  it('错误归类：要登录、订阅与额度、找不到的会话', () => {
    expect(
      classifyAntigravityTurnError({ code: -32000, message: 'Authentication required.' }),
    ).toMatchObject({
      category: 'missing_credentials',
    });
    expect(
      classifyAntigravityTurnError({
        code: -32603,
        message: 'Internal error',
        data: { details: 'SUBSCRIPTION_REQUIRED' },
      }),
    ).toMatchObject({ category: 'provider', message: 'Internal error: SUBSCRIPTION_REQUIRED' });
    expect(classifyAntigravityTurnError(new Error('boom'))).toMatchObject({ category: 'unknown' });
    expect(
      classifyAntigravityResumeError({ code: -32602, message: 'Session not found: abc' }).failure,
    ).toEqual({
      kind: 'lost',
      reason: 'not_found',
    });
    expect(classifyAntigravityResumeError(new Error('socket closed')).failure).toEqual({
      kind: 'unknown',
    });
  });
});
