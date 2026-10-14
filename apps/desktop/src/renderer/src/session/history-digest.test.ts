import type { AssistantChatMessage, ChatPart, UserChatMessage } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import { historyDigest } from './history-digest';

const TS = '2026-10-14T00:00:00.000Z';

function text(value: string, type: 'text' | 'reasoning' = 'text'): ChatPart {
  return { type, key: value, text: value, state: 'done' };
}

function user(id: string, value: string): UserChatMessage {
  return {
    id,
    role: 'user',
    turnId: `trn_${id}`,
    sentBy: { clientKind: 'desktop', deviceId: 'd', clientId: 'c' },
    ts: TS,
    parts: [text(value)],
    seqRange: [1, 1],
  };
}

function assistant(id: string, parts: ChatPart[]): AssistantChatMessage {
  return { id, role: 'assistant', turnId: `trn_${id}`, parts, seqRange: [2, 2] };
}

describe('historyDigest', () => {
  it('收用户消息与助手正文（不含思考），工具各一行摘要；会话级提示不收；结尾留“接下来：”', () => {
    const digest = historyDigest({
      title: '季度汇总',
      messages: [
        user('u1', '汇总 data/ 下的 CSV'),
        assistant('a1', [
          text('先看看有哪些文件', 'reasoning'),
          {
            type: 'tool',
            key: 't1',
            toolCallId: 't1',
            toolName: 'glob',
            display: { kind: 'search', summary: 'data/*.csv' },
            status: 'completed',
            input: {},
            startedAt: TS,
          },
          text('已写入 summary.md。'),
        ]),
        {
          id: 's1',
          role: 'system',
          parts: [{ type: 'notice', key: 'n', notice: { kind: 'closed' } }],
          seqRange: [3, 3],
        },
      ],
    });
    expect(digest).toBe(
      [
        '以下是会话“季度汇总”的对话记录。该会话已无法继续，请在此基础上继续完成任务。',
        '【用户】\n汇总 data/ 下的 CSV',
        '【助手】\n已写入 summary.md。\n（使用的工具：glob data/*.csv）',
        '接下来：',
      ].join('\n\n'),
    );
  });

  it('超出上限时保留最近的对话，注明省略了多少条；最近一条本身超长只留结尾', () => {
    const messages = [user('u1', 'a'.repeat(50)), user('u2', 'b'.repeat(50)), user('u3', 'c')];
    const digest = historyDigest({ title: '', messages }, 80);
    expect(digest).toContain('（更早的 1 条消息已省略）');
    expect(digest).not.toContain('a');
    expect(digest).toContain('b'.repeat(50));
    expect(digest).toContain('“未命名会话”');

    const long = historyDigest({ title: 't', messages: [user('u1', 'x'.repeat(100))] }, 20);
    expect(long).toContain(`\n…${'x'.repeat(20)}\n`);
    expect(long).not.toContain('【用户】');
  });
});
