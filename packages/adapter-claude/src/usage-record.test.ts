import { describe, expect, it } from 'vitest';
import { claudeUsageRecords, mergeClaudeUsage } from './usage-record.js';

describe('advisor 用量', () => {
  const advisor = {
    type: 'advisor_message',
    model: 'claude-fable-5-1',
    input_tokens: 54204,
    output_tokens: 4229,
    cache_read_input_tokens: 120,
    cache_creation_input_tokens: 60,
  };
  const request = {
    id: 'msg_executor',
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 4,
      output_tokens: 4506,
      cache_read_input_tokens: 118320,
      cache_creation_input_tokens: 2676,
      iterations: [{ type: 'message', input_tokens: 4, output_tokens: 4506 }, advisor, advisor],
    },
    startedAt: 100,
    endedAt: 300,
    ttftMs: 50,
  };

  it('执行模型总量保持原值，每次 advisor 调用按自己的模型与独立 requestId 记账，不继承主请求时长', () => {
    expect(claudeUsageRecords('session', request)).toEqual([
      {
        type: 'usage.recorded',
        engineSessionId: 'session',
        requestId: 'msg_executor',
        model: 'claude-opus-5-5',
        inputTokens: 4,
        outputTokens: 4506,
        cacheReadTokens: 118320,
        cacheWriteTokens: 2676,
        durationMs: 250,
        firstTokenMs: 50,
      },
      ...[1, 2].map((index) => ({
        type: 'usage.recorded',
        engineSessionId: 'session',
        requestId: `msg_executor:advisor:${index}`,
        model: 'claude-fable-5-1',
        inputTokens: 54204,
        outputTokens: 4229,
        cacheReadTokens: 120,
        cacheWriteTokens: 60,
      })),
    ]);
  });

  it('最终用量合并保留 iterations，忽略普通 message、缺少模型和格式错误的项', () => {
    const merged = { id: 'msg', usage: {} };
    mergeClaudeUsage(merged, request.usage);
    mergeClaudeUsage(merged, { output_tokens: 4600, iterations: null });
    expect(claudeUsageRecords('session', merged)).toHaveLength(3);
    const invalid = [
      null,
      'advisor_message',
      { ...advisor, model: '' },
      { ...advisor, model: '<synthetic>' },
      { type: 'advisor_message' },
    ];
    expect(
      claudeUsageRecords('session', { ...request, usage: { iterations: invalid } }),
    ).toHaveLength(1);
    expect(claudeUsageRecords('session', { ...request, usage: { input_tokens: 4 } })).toHaveLength(
      1,
    );
  });
});
