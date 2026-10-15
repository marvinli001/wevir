// 移植的纯函数：启动参数、审批选项、回合结束、提问与退出计划模式（xai.ts），模型（models.ts），工具展示（tool-display.ts），
// 回合失败的归类（engine.ts）。期望值取自 T3 Code 的同名测试与录制的样本。

import type { ApprovalOption } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { classifyResumeError, classifyTurnError } from './engine.js';
import { displayNameFromSlug, modelsFromInitialize, parseGrokModelsOutput } from './models.js';
import { readTranscript } from './test-fixtures/harness.js';
import { grokToolDisplay, resolveToolTitle } from './tool-display.js';
import {
  askUserQuestionResponse,
  completionOf,
  EXIT_PLAN_CAPTURED,
  grokApprovalOptions,
  grokSpawnArgs,
  parseAskUserQuestion,
  parseExitPlanMode,
  promptCompleteOf,
  toUserQuestions,
  XAiPromptFailure,
} from './xai.js';

describe('启动参数与审批选项', () => {
  it('权限模式 → grok 的参数（T3 的 grokAcpSpawnArgs）', () => {
    expect(grokSpawnArgs('on_request')).toEqual(['--permission-mode', 'default', 'agent', 'stdio']);
    expect(grokSpawnArgs('auto_review')).toEqual(['--permission-mode', 'auto', 'agent', 'stdio']);
    expect(grokSpawnArgs('full_access')).toEqual(['agent', '--always-approve', 'stdio']);
  });

  it('去掉对整个项目长期有效的授权，留下本会话允许编辑', () => {
    const options = (pairs: Array<[string, ApprovalOption['kind']]>): ApprovalOption[] =>
      pairs.map(([optionId, kind]) => ({ optionId, label: optionId, kind }));
    expect(
      grokApprovalOptions(
        options([
          ['always-allow', 'allow_always'],
          ['allow-once', 'allow_once'],
          ['reject-once', 'reject_once'],
          ['reject-always', 'reject_always'],
        ]),
      ).map((option) => option.optionId),
    ).toEqual(['allow-once', 'reject-once']);
    expect(
      grokApprovalOptions(
        options([
          ['allow-edits-session', 'allow_always'],
          ['allow-once', 'allow_once'],
          ['reject-once', 'reject_once'],
        ]),
      ).map((option) => option.optionId),
    ).toEqual(['allow-edits-session', 'allow-once', 'reject-once']);
  });
});

describe('引擎报的回合结束', () => {
  it('prompt_complete 与带 prompt_id 的 turn_completed；后台任务的回合不算', () => {
    expect(
      promptCompleteOf('_x.ai/session/prompt_complete', {
        sessionId: 's',
        promptId: 'p1',
        stopReason: 'end_turn',
        agentResult: null,
      }),
    ).toEqual({ sessionId: 's', promptId: 'p1', stopReason: 'end_turn', agentResult: null });
    expect(
      promptCompleteOf('x.ai/session_notification', {
        sessionId: 's',
        update: { sessionUpdate: 'turn_completed', prompt_id: 'p2', stop_reason: 'cancelled' },
      }),
    ).toEqual({ sessionId: 's', promptId: 'p2', stopReason: 'cancelled' });
    expect(
      promptCompleteOf('_x.ai/session_notification', {
        sessionId: 's',
        update: { sessionUpdate: 'turn_completed', prompt_id: 'task-completed-1' },
      }),
    ).toBeUndefined();
    expect(
      promptCompleteOf('_x.ai/session_notification', {
        sessionId: 's',
        update: { sessionUpdate: 'turn_completed' },
      }),
    ).toBeUndefined();
    expect(
      promptCompleteOf('_x.ai/session_notification', {
        sessionId: 's',
        update: { sessionUpdate: 'last_turn_summary', prompt_id: 'p3' },
      }),
    ).toBeUndefined();
    expect(promptCompleteOf('_x.ai/queue/changed', { sessionId: 's' })).toBeUndefined();
  });

  it('停止原因：rate_limit 与 error 是失败，带 Grok 的原文；不认识的按 end_turn', () => {
    expect(completionOf({ sessionId: 's', stopReason: 'max_tokens' })).toEqual({
      stopReason: 'max_tokens',
    });
    expect(completionOf({ sessionId: 's', stopReason: 'paused' })).toEqual({
      stopReason: 'end_turn',
    });
    const error = completionOf({ sessionId: 's', stopReason: 'error', agentResult: 'boom' });
    expect('error' in error && error.error).toMatchObject({ message: 'boom', code: -32603 });
    const limit = completionOf({ sessionId: 's', stopReason: 'rate_limit' });
    expect('error' in limit && classifyTurnError(limit.error)).toMatchObject({
      category: 'provider',
      code: -32003,
    });
  });
});

describe('回合失败与 resume 失败的归类', () => {
  it('Grok 的原文在 data.message；要认证是 missing_credentials', () => {
    expect(
      classifyTurnError({
        code: -32603,
        message: 'Internal error',
        data: { message: 'API error (status 400 Bad Request): x', http_status: 400 },
      }),
    ).toEqual({
      category: 'provider',
      code: -32603,
      message: 'API error (status 400 Bad Request): x',
    });
    expect(classifyTurnError({ code: -32000, message: 'Authentication required' })).toMatchObject({
      category: 'missing_credentials',
    });
    expect(classifyTurnError(new XAiPromptFailure('something odd', -32603))).toMatchObject({
      category: 'unknown',
      message: 'something odd',
    });
  });

  it('只有明说会话不存在的才算丢了', () => {
    expect(classifyResumeError({ code: -32602, message: 'Session not found: x' }).failure).toEqual({
      kind: 'lost',
      reason: 'not_found',
    });
    expect(classifyResumeError(new Error('connection closed')).failure).toEqual({
      kind: 'unknown',
    });
  });
});

describe('提问与退出计划模式', () => {
  const request = readTranscript('plan_questions').find(
    (entry) => entry.frame?.method === '_x.ai/ask_user_question' && entry.frame.kind === 'request',
  )?.frame?.params;

  it('解析包了一层的 ask_user_question，转成 Wevir 的问题', () => {
    const parsed = parseAskUserQuestion(request);
    expect(parsed).toMatchObject({
      sessionId: 'grok-replay-session-1',
      toolCallId: 'ask-user-question-tool-call-1',
    });
    expect(toUserQuestions(parsed?.questions ?? [])).toEqual([
      {
        id: 'schema_vs_ui_flexibility',
        question: 'For this fixture, should the plan prefer strict schemas or UI flexibility?',
        options: [
          {
            label: 'Strict schemas (Recommended)',
            description: 'Favor precise contracts and validation.',
          },
          { label: 'UI flexibility', description: 'Favor looser fixture shapes.' },
        ],
        allowOther: true,
      },
    ]);
    expect(parseAskUserQuestion({ sessionId: 's' })).toBeUndefined();
  });

  it('回答：选项 label 原样，自己写的记为 Other 加备注；没回答的不出现', () => {
    const questions = [
      { id: 'a', question: 'Pick one?', options: [{ label: 'X', preview: 'px' }, { label: 'Y' }] },
      { question: 'Free?', options: [{ label: 'Z' }] },
      { id: 'c', question: 'Skipped?', options: [{ label: 'W' }] },
    ];
    expect(askUserQuestionResponse(questions, { a: ['X'], 'Free?': ['my own words'] })).toEqual({
      outcome: 'accepted',
      answers: { 'Pick one?': ['X'], 'Free?': ['Other'] },
      annotations: { 'Pick one?': { preview: 'px' }, 'Free?': { notes: 'my own words' } },
    });
  });

  it('退出计划模式：取出计划，回复放弃这道关、等用户（0.36.0）', () => {
    expect(
      parseExitPlanMode({
        method: 'x.ai/exit_plan_mode',
        params: { sessionId: 's', toolCallId: 't', planContent: '# Plan' },
      }),
    ).toEqual({ sessionId: 's', toolCallId: 't', planContent: '# Plan' });
    expect(EXIT_PLAN_CAPTURED.outcome).toBe('abandoned');
    expect(EXIT_PLAN_CAPTURED.feedback).toMatch(/captured your proposed plan/);
  });
});

describe('模型', () => {
  it('grok models 的输出（T3 的注释里的样子）', () => {
    expect(
      parseGrokModelsOutput(
        [
          'You are logged in with grok.com.',
          'Default model: grok-4.6',
          'Available models:',
          '  * grok-4.6 (default)',
          '  - grok-4.5',
        ].join('\n'),
      ),
    ).toEqual({
      authenticated: true,
      models: {
        models: [
          { id: 'grok-4.6', displayName: 'Grok 4.6' },
          { id: 'grok-4.5', displayName: 'Grok 4.5' },
        ],
        defaultModelId: 'grok-4.6',
      },
    });
    expect(parseGrokModelsOutput('Not authenticated.').authenticated).toBe(false);
    expect(parseGrokModelsOutput('???')).toEqual({ authenticated: null, models: { models: [] } });
    expect(displayNameFromSlug('grok-4.7-build-fast')).toBe('Grok 4.7 build fast');
  });

  it('initialize 的 modelState（录制的 1.0.41）', () => {
    const initialize = readTranscript('simple').find(
      (entry) => entry.frame?.method === 'initialize' && entry.frame.kind === 'response',
    )?.frame?.result;
    const models = modelsFromInitialize(initialize);
    expect(models?.defaultModelId).toBe('grok-4.7');
    expect(models?.models.find((model) => model.id === 'grok-4.5')).toEqual({
      id: 'grok-4.5',
      displayName: 'Grok 4.5',
      contextWindow: 500_000,
      reasoningEfforts: ['high', 'medium', 'low'],
    });
    expect(modelsFromInitialize({ _meta: {} })).toBeUndefined();
  });
});

describe('工具展示（录制的 tool_call 与 tool_call_update）', () => {
  const updates = ['todo_list', 'tool_call_read_only_on_request', 'grok_background_bash'].flatMap(
    (name) =>
      readTranscript(name).flatMap((entry) => {
        const update = entry.frame?.params?.update as Record<string, unknown> | undefined;
        return entry.frame?.method === 'session/update' &&
          (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') &&
          typeof update.title === 'string'
          ? [update as { sessionUpdate: string; title: string; rawInput?: unknown }]
          : [];
      }),
  );
  const display = (title: string) => {
    const update = updates.find((candidate) => candidate.title === title);
    if (update === undefined) throw new Error(`没有 ${title}`);
    return grokToolDisplay(update.title, update.rawInput, update);
  };

  it('tool_call 的标题是工具名', () => {
    expect(display('run_terminal_command')).toEqual({
      kind: 'shell',
      command: 'for i in 1 2 3; do sleep 8; echo tock $i; done',
      summary: 'for i in 1 2 3; do sleep 8; echo tock $i; done',
    });
    expect(display('write')).toEqual({
      kind: 'write',
      paths: ['<workspace>/.codex-probe-write-action.txt'],
      summary: '<workspace>/.codex-probe-write-action.txt',
    });
    expect(display('list_dir')).toMatchObject({ kind: 'read', paths: ['<workspace>'] });
    expect(display('search_tool')).toMatchObject({ kind: 'search', query: 'update_plan' });
    expect(display('todo_write').kind).toBe('plan');
  });

  it('tool_call_update 的标题是给人看的，工具名取自 _meta["x.ai/tool"]', () => {
    expect(display('Updating plan').kind).toBe('plan');
    expect(display('Read `<workspace>/package.json`')).toMatchObject({
      kind: 'read',
      paths: ['<workspace>/package.json'],
    });
    expect(display('Write `<workspace>/.codex-probe-write-action.txt`').kind).toBe('write');
  });

  it('没有工具名时按 ACP kind 与 variant 兜底；Tool 这种标题换成描述（T3 的 resolveXAiAcpToolTitle）', () => {
    expect(
      grokToolDisplay(
        'Tool',
        { variant: 'Bash', command: 'ls' },
        { sessionUpdate: 'tool_call', kind: 'execute' },
      ),
    ).toEqual({
      kind: 'shell',
      command: 'ls',
      summary: 'ls',
    });
    expect(
      grokToolDisplay(
        'Tool',
        { url: 'https://x.ai' },
        { sessionUpdate: 'tool_call', kind: 'fetch' },
      ),
    ).toEqual({
      kind: 'fetch',
      url: 'https://x.ai',
      summary: 'https://x.ai',
    });
    expect(resolveToolTitle('Tool', { variant: 'monitor', description: 'watch logs' })).toBe(
      'Monitor: watch logs',
    );
    expect(resolveToolTitle('Tool', { variant: 'TaskOutput' })).toBe('Task output');
    expect(
      grokToolDisplay('mcp__github__search', { query: 'x' }, { sessionUpdate: 'tool_call' }),
    ).toEqual({
      kind: 'unknown',
      mcpServer: 'github',
      summary: 'x',
    });
  });
});
