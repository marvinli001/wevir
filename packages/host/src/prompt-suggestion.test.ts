import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from './handoff.js';
import {
  loadSuggestionInstructions,
  parseSuggestion,
  SUGGESTION_INPUT_MAX_BYTES,
  SUGGESTION_ITEM_MAX_CHARS,
  SUGGESTION_MAX_ITEMS,
  suggestionInput,
  suggestionItems,
} from './prompt-suggestion.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

describe('loadSuggestionInstructions', () => {
  it('读仓库里的 prompt-suggestion.md：去掉文件头的注释，没有残留的模板标记', () => {
    const text = loadSuggestionInstructions();
    expect(text).toContain('# 输出');
    expect(text).toContain('"suggestion"');
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('SPDX');
    expect(text).not.toContain('{{');
  });

  it('提示词里残留了 {{ 就报错', () => {
    const dir = join(tempDir(), 'prompts');
    mkdirSync(dir);
    writeFileSync(join(dir, 'prompt-suggestion.md'), '<!-- 注释 -->\n说明 {{ 变量 }}');
    expect(() => loadSuggestionInstructions(dir)).toThrow('{{');
  });
});

describe('parseSuggestion', () => {
  const json = (suggestion: string) => JSON.stringify({ suggestion });

  it('取 JSON 里的 suggestion：折叠空白、去掉首尾引号', () => {
    expect(parseSuggestion(json('跑一下测试'))).toBe('跑一下测试');
    expect(parseSuggestion(json('  “run the\n tests”  '))).toBe('run the tests');
    expect(parseSuggestion(json('「‘继续’」'))).toBe('继续');
  });

  it('模型加了代码块或前后的话：取第一个 { 到最后一个 } 之间', () => {
    expect(parseSuggestion('```json\n{"suggestion": "好的，开始吧"}\n```')).toBe('好的，开始吧');
    expect(parseSuggestion('Here: {"suggestion": "commit it"} done')).toBe('commit it');
  });

  it('没有花括号：整段单行文字当作建议，多行的丢弃', () => {
    expect(parseSuggestion('  跑一下测试  ')).toBe('跑一下测试');
    expect(parseSuggestion('先跑测试\n再提交')).toBeUndefined();
  });

  it('留空与占位词：没有建议', () => {
    for (const value of ['', '   ', '""', '无', 'None', 'n/a', '没有建议', 'null']) {
      expect(parseSuggestion(json(value)), value).toBeUndefined();
    }
    expect(parseSuggestion('')).toBeUndefined();
  });

  it('JSON 不对或没有 suggestion 字符串：没有建议', () => {
    expect(parseSuggestion('{"suggestion": ')).toBeUndefined();
    expect(parseSuggestion('{"suggestion": 3}')).toBeUndefined();
    expect(parseSuggestion('{"title": "x"}')).toBeUndefined();
    expect(parseSuggestion('{}')).toBeUndefined();
    expect(parseSuggestion('[1]')).toBeUndefined();
  });

  it('过长（超过码点或词数上限）丢弃而不截断', () => {
    expect(parseSuggestion(json('字'.repeat(80)))).toBe('字'.repeat(80));
    expect(parseSuggestion(json('字'.repeat(81)))).toBeUndefined();
    expect(parseSuggestion(json(Array.from({ length: 15 }, () => 'go').join(' ')))).toBeDefined();
    expect(parseSuggestion(json(Array.from({ length: 16 }, () => 'go').join(' ')))).toBeUndefined();
  });

  it('提问、助手的口吻、评价与致谢、Markdown：丢弃', () => {
    for (const value of [
      '要不要跑测试？',
      'Should I run the tests?',
      '让我再检查一遍',
      '我来修复它',
      'Let me check that',
      "I'll run it",
      '看起来不错',
      '谢谢！',
      'Looks good to me',
      'Thanks',
      '```npm test```',
      '- 跑测试',
      '**跑测试**',
    ]) {
      expect(parseSuggestion(json(value)), value).toBeUndefined();
    }
  });

  it('像用户说的话：保留，包括命令和标识符', () => {
    for (const value of ['pnpm test', '把 makeTitle 也改了', 'yes, go ahead', '继续', '提交吧']) {
      expect(parseSuggestion(json(value)), value).toBe(value);
    }
  });
});

describe('suggestionItems / suggestionInput', () => {
  const sessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>): WevirEvent => {
    seq += 1;
    return {
      seq,
      sessionId,
      ts: '2026-10-18T00:00:00.000Z',
      source: 'host',
      type,
      payload,
    } as unknown as WevirEvent;
  };
  const user = (turnId: string, text: string) =>
    ev('user.message', { turnId, content: [{ type: 'text', text }] });
  const assistant = (turnId: string, text: string) =>
    ev('assistant.message', { turnId, messageId: `m${seq + 1}`, text });

  it('没有这个回合的助手回答：不值得预测', () => {
    expect(suggestionItems([user('t1', '你好')], 't1')).toBeUndefined();
    expect(suggestionItems([user('t1', '你好'), assistant('t0', '旧的')], 't1')).toBeUndefined();
  });

  it('留下消息、命令、文件改动、错误，从最近的往前至多 8 条', () => {
    const events: WevirEvent[] = [];
    for (let index = 0; index < 6; index += 1) {
      events.push(user(`t${index}`, `问题 ${index}`), assistant(`t${index}`, `回答 ${index}`));
    }
    const items = suggestionItems(events, 't5');
    expect(items).toHaveLength(SUGGESTION_MAX_ITEMS);
    expect(items?.at(-1)).toMatchObject({ kind: 'assistant_message', text: '回答 5' });
    expect(items?.[0]).toMatchObject({ kind: 'user_message', text: '问题 2' });
  });

  it('输入：转义，用户 / 助手 / 动作各有标签，按先后排列', () => {
    const items: HistoryItem[] = [
      { itemId: 'e1', seq: 1, role: 'user', kind: 'user_message', text: '改 <a> & b' },
      { itemId: 'e2', seq: 2, role: 'assistant', kind: 'command', text: 'Command: pnpm test' },
      {
        itemId: 'e3',
        seq: 3,
        role: 'assistant',
        kind: 'assistant_message',
        text: '改好了\n全部通过',
      },
    ];
    expect(suggestionInput(items)).toBe(
      [
        '<conversation>',
        '<message role="user">改 &lt;a&gt; &amp; b</message>',
        '<action>Command: pnpm test</action>',
        '<message role="assistant">改好了 全部通过</message>',
        '</conversation>',
      ].join('\n'),
    );
  });

  it('单条过长：助手的回答留结尾，用户的消息留开头', () => {
    const body = '甲'.repeat(SUGGESTION_ITEM_MAX_CHARS - 2);
    const user = suggestionInput([
      { itemId: 'e1', seq: 1, role: 'user', kind: 'user_message', text: `头${body}${body}尾` },
    ]);
    expect(user).toContain(`<message role="user">头${body}…</message>`);
    const assistant = suggestionInput([
      {
        itemId: 'e1',
        seq: 1,
        role: 'assistant',
        kind: 'assistant_message',
        text: `头${body}${body}尾`,
      },
    ]);
    expect(assistant).toContain(`<message role="assistant">…${body}尾</message>`);
  });

  it('总长超过上限：丢掉更早的，最后一条总在，不切开转义序列', () => {
    const items: HistoryItem[] = Array.from({ length: 8 }, (_, index) => ({
      itemId: `e${index}`,
      seq: index,
      role: 'user',
      kind: 'user_message',
      text: `${index}`.repeat(SUGGESTION_ITEM_MAX_CHARS - 10) + '界'.repeat(10),
    }));
    const out = suggestionInput(items);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(SUGGESTION_INPUT_MAX_BYTES + 60);
    expect(out).toContain('7777');
    expect(out).not.toContain('0000');

    // 最后一条单独就超过上限（全是要转义的字符）时再截一次，转义序列保持完整。
    const hostile = suggestionInput([
      { itemId: 'e1', seq: 1, role: 'assistant', kind: 'assistant_message', text: '&'.repeat(900) },
    ]);
    expect(Buffer.byteLength(hostile, 'utf8')).toBeLessThanOrEqual(SUGGESTION_INPUT_MAX_BYTES + 60);
    const inner = hostile.match(/<message role="assistant">…(.*)<\/message>/u)?.[1];
    expect(inner).toBeDefined();
    expect(inner?.replaceAll('&amp;', '')).toBe('');
  });
});
