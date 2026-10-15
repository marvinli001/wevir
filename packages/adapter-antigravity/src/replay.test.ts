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
import { antigravityModelsFromSetup } from './models.js';
import { antigravityQuestion, antigravityToolDisplay } from './protocol.js';
import {
  LARGE_TOOL_UPDATE,
  PERMISSION_REQUEST,
  QUESTION_REQUEST,
  SESSION,
  SESSION_SETUP,
  TURN_WITH_COMMAND,
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

  it('工具的展示类型：按 ACP kind，start_subagent 是子 agent（MCP 的同名工具不是）', () => {
    expect(
      antigravityToolDisplay('Read file', {}, { kind: 'read', locations: [{ path: 'a.ts' }] }),
    ).toEqual({ kind: 'read', paths: ['a.ts'], summary: 'a.ts' });
    expect(antigravityToolDisplay('Running start_subagent', {}, { kind: 'other' })).toMatchObject({
      kind: 'sub_agent',
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
