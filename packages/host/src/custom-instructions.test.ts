// 用户的说明与输出风格（0.78.0）：读提示词、按设置算输入、拼成交给引擎的一段。

import { OUTPUT_STYLES } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  customInputs,
  loadCustomPrompts,
  parsePrompt,
  planCustom,
  styledSession,
  styleReminder,
  writingStyleInput,
} from './custom-instructions.js';

const prompts = loadCustomPrompts();

describe('loadCustomPrompts', () => {
  it('读到全部风格，去掉注释；只有简洁与主动带每回合提醒', () => {
    expect([...prompts.outputStyles.keys()]).toEqual([...OUTPUT_STYLES]);
    for (const prompt of [{ body: prompts.header }, ...prompts.outputStyles.values()]) {
      expect(prompt.body).not.toContain('<!--');
      expect(prompt.body).not.toContain('SPDX');
      expect(prompt.body.startsWith('# ')).toBe(true);
    }
    const reminders = [...prompts.outputStyles].filter(([, prompt]) => prompt.reminder);
    expect(reminders.map(([name]) => name)).toEqual(['concise', 'proactive']);
  });

  it('开头的 --- 块只认 reminder 一行；残留 {{ 报错', () => {
    expect(
      parsePrompt('---\nname: x\nreminder: 先说结果。\n---\n<!-- c -->\n# 正文\n', 'a.md'),
    ).toEqual({ body: '# 正文', reminder: '先说结果。' });
    expect(parsePrompt('# 没有开头块\n', 'b.md')).toEqual({ body: '# 没有开头块' });
    expect(() => parsePrompt('# {{ x }}', 'c.md')).toThrow(/c\.md/);
  });
});

describe('customInputs', () => {
  it('说明与风格都给；空白的说明、default 与不认识的风格不给', () => {
    expect(
      customInputs({ agentInstructions: '回答用中文。', outputStyle: 'friendly' }, true),
    ).toEqual({ instructions: '回答用中文。', outputStyle: 'friendly' });
    expect(customInputs({ agentInstructions: ' \n', outputStyle: 'default' }, true)).toEqual({});
    expect(customInputs({ outputStyle: 'shouty' }, true)).toEqual({});
  });

  it('不是用户直接对话的会话只给说明', () => {
    expect(
      customInputs({ agentInstructions: '回答用中文。', outputStyle: 'learning' }, false),
    ).toEqual({ instructions: '回答用中文。' });
  });
});

describe('planCustom', () => {
  it('开头说明、用户的说明、风格依次排，custom 记下交了哪些', () => {
    const plan = planCustom(prompts, { instructions: '回答用中文。\n', outputStyle: 'concise' });
    const text = plan?.text ?? '';
    expect(text.startsWith(prompts.header)).toBe(true);
    const block = text.indexOf('<user_instructions>\n回答用中文。\n</user_instructions>');
    const style = text.indexOf('# 输出风格：简洁');
    expect(block).toBeGreaterThan(0);
    expect(style).toBeGreaterThan(block);
    expect(plan?.custom).toEqual({
      instructions: true,
      outputStyle: 'concise',
      bytes: Buffer.byteLength(text),
    });
  });

  it('只选了风格也给；什么都没有时 undefined', () => {
    expect(planCustom(prompts, { outputStyle: 'pragmatic' })?.custom).toEqual({
      instructions: false,
      outputStyle: 'pragmatic',
      bytes: expect.any(Number),
    });
    expect(planCustom(prompts, {})).toBeUndefined();
  });

  it('每回合提醒包成 system-reminder；没有提醒的风格与没选风格时 undefined', () => {
    expect(styleReminder(prompts, 'concise')).toMatch(
      /^<system-reminder>\n.*简洁.*\n<\/system-reminder>$/,
    );
    expect(styleReminder(prompts, 'explanatory')).toBeUndefined();
    expect(styleReminder(prompts, undefined)).toBeUndefined();
  });
});

describe('styledSession', () => {
  it('用户开的、从建议开的、不带角色的分支是；子会话、Agent 开的、带角色的、第二意见与自动化不是', () => {
    expect(styledSession({})).toBe(true);
    expect(styledSession({ origin: { kind: 'suggested_task', sessionId: 's', taskId: 't' } })).toBe(
      true,
    );
    expect(styledSession({ origin: { kind: 'fork', sessionId: 's' } })).toBe(true);
    expect(styledSession({ parentSessionId: 's' })).toBe(false);
    expect(styledSession({ origin: { kind: 'agent', sessionId: 's' } })).toBe(false);
    expect(styledSession({ origin: { kind: 'fork', sessionId: 's', role: 'reviewer' } })).toBe(
      false,
    );
    expect(
      styledSession({
        origin: { kind: 'second_opinion', sessionId: 's', opinionId: 'o', role: 'r' },
      }),
    ).toBe(false);
    expect(styledSession({ origin: { kind: 'automation', automationId: 'a', runId: 'r' } })).toBe(
      false,
    );
  });
});

describe('写作风格（0.95.0）', () => {
  it('读到三份提示词，去掉注释', () => {
    for (const body of Object.values(prompts.writingStyle)) {
      expect(body).not.toContain('<!--');
      expect(body).not.toContain('SPDX');
    }
    expect(prompts.writingStyle.none).toContain('wevir_writing_style_setup');
    expect(prompts.writingStyle.apply).toContain('wevir_writing_style_save');
  });

  it('设置关着不给；开着没有档案给建档提示，有档案给用法加档案', () => {
    expect(writingStyleInput({}, '档案')).toBeUndefined();
    expect(writingStyleInput({ writingStyle: true }, undefined)).toEqual({});
    expect(writingStyleInput({ writingStyle: true }, '档案')).toEqual({ profile: '档案' });

    const setup = planCustom(prompts, { writingStyle: {} });
    expect(setup?.text).toContain(prompts.writingStyle.none);
    expect(setup?.custom).toEqual({
      instructions: false,
      writingStyle: 'setup',
      bytes: Buffer.byteLength(setup?.text ?? ''),
    });

    const plan = planCustom(prompts, {
      instructions: '回答用中文。',
      outputStyle: 'concise',
      writingStyle: { profile: '- 句子短。\n' },
    });
    const text = plan?.text ?? '';
    expect(text.indexOf(prompts.writingStyle.apply)).toBeGreaterThan(
      text.indexOf('# 输出风格：简洁'),
    );
    expect(text.endsWith('<writing_style_profile>\n- 句子短。\n</writing_style_profile>')).toBe(
      true,
    );
    expect(plan?.custom.writingStyle).toBe('profile');
  });
});
