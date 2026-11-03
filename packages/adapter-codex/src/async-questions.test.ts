import { describe, expect, it } from 'vitest';
import { asyncAnswerText, asyncQuestions } from './async-questions.js';
import { CodexEventMapper } from './mapping.js';

// 不挂起回合的提问（0.156.0，codex-event-mapping.md §6.6）：形状照 codex-rs 的 request_user_input_async 处理器
// （core/src/tools/handlers/request_user_input_async.rs）与回复信封（context-fragments/src/answered_question.rs）。

const id = 'thread-1';
const turnId = 'turn-1';
const callId = 'call_d9968c0ac71149df94e5f302632df79e';

const item = {
  type: 'agentMessage',
  id: callId,
  text: '删除会话时，任务记录如何处理？\n- 仅保留置顶记录\n- 全部随会话删除',
  phase: 'final_answer',
  memoryCitation: null,
  delivery: 'async',
  questions: [
    { title: '删除会话时，任务记录如何处理？', options: ['仅保留置顶记录', '全部随会话删除'] },
  ],
};

describe('request_user_input_async', () => {
  it('async 的 agentMessage 报成不挂起回合的提问，不当助手消息', () => {
    const mapper = new CodexEventMapper(id);
    expect(mapper.map('item/started', { threadId: id, turnId, item })).toEqual([]);
    const events = mapper.map('item/completed', { threadId: id, turnId, item });
    expect(events).toEqual([
      {
        type: 'question.requested',
        engineSessionId: id,
        requestId: callId,
        toolCallId: callId,
        async: true,
        questions: [
          {
            id: JSON.stringify(['request_user_input_async', callId, 0]),
            question: '删除会话时，任务记录如何处理？',
            options: [{ label: '仅保留置顶记录' }, { label: '全部随会话删除' }],
            allowOther: true,
          },
        ],
      },
    ]);
    // 同一 item 再完成一次（重放）不再报。
    expect(mapper.map('item/completed', { threadId: id, turnId, item })).toEqual([]);
  });

  it('普通的、没有可用题目的 agentMessage 照常是助手消息', () => {
    const mapper = new CodexEventMapper(id);
    for (const message of [
      { type: 'agentMessage', id: 'm1', text: 'hi', delivery: null, questions: null },
      { type: 'agentMessage', id: 'm2', text: 'progress', delivery: 'async', questions: null },
      { ...item, id: 'm3', questions: [{ title: '  ' }] },
    ]) {
      expect(mapper.map('item/completed', { threadId: id, turnId, item: message })).toMatchObject([
        { type: 'assistant.message', messageId: message.id, text: message.text },
      ]);
    }
  });

  it('题目：去掉空的与重复的选项，没有选项的只能自己填，题号按原来的位置', () => {
    expect(
      asyncQuestions('c1', [
        { title: '' },
        { title: 'Which?', options: ['A', '', 'A', 'B'] },
        { title: 'Why?' },
      ]),
    ).toEqual([
      {
        id: '["request_user_input_async","c1",1]',
        question: 'Which?',
        options: [{ label: 'A' }, { label: 'B' }],
        allowOther: true,
      },
      {
        id: '["request_user_input_async","c1",2]',
        question: 'Why?',
        options: [],
        allowOther: true,
      },
    ]);
  });

  it('回答写成 Codex 的回复信封：只写有回答的题，题目截到 512 字节、换行变空格', () => {
    const questions = asyncQuestions('c1', [
      { title: `第一题\n${'é'.repeat(400)}`, options: ['A'] },
      { title: '第二题' },
    ]);
    const text = asyncAnswerText(questions, {
      [questions[0]?.id as string]: ['A'],
      [questions[1]?.id as string]: [],
    });
    const match =
      /^<send_user_message_question_reply>\n(.*)\n<\/send_user_message_question_reply>$/s.exec(
        text,
      );
    const replies = JSON.parse(match?.[1] ?? 'null') as Record<string, string>[];
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      answer: 'A',
      questionItemId: '["request_user_input_async","c1",0]',
    });
    const question = replies[0]?.question ?? '';
    expect(question.startsWith('第一题 é')).toBe(true);
    expect(Buffer.byteLength(question)).toBeLessThanOrEqual(512);
    expect(question).not.toContain('\n');
  });
});
