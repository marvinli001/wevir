import type { ApprovalOption } from '@wevir/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseApprovalChoice, parseQuestionAnswer, questionPrompt } from './attach.js';
import { setLocale } from './i18n/index.js';

beforeEach(() => setLocale('zh'));

const options: ApprovalOption[] = [
  { optionId: 'allow-once', label: 'Allow', kind: 'allow_once', category: 'allow' },
  { optionId: 'reject', label: 'Reject', kind: 'reject_once', category: 'reject' },
];

describe('parseApprovalChoice', () => {
  it('a / g 只在有“总是允许”时认，带 remember', () => {
    const always = options[0];
    expect(parseApprovalChoice(options, 'a', always)).toEqual({
      option: always,
      remember: 'project',
    });
    expect(parseApprovalChoice(options, ' G ', always)).toEqual({
      option: always,
      remember: 'global',
    });
    expect(parseApprovalChoice(options, 'a')).toBeUndefined();
    expect(parseApprovalChoice(options, '2', always)).toEqual({ option: options[1] });
    expect(parseApprovalChoice(options, 'y')).toEqual({ option: options[0] });
  });
});

describe('parseQuestionAnswer', () => {
  const single = {
    options: [{ label: 'UI only' }, { label: 'Full stack' }],
    allowOther: true,
  };
  const multi = {
    options: [{ label: 'macOS' }, { label: 'Windows' }, { label: 'Linux' }],
    multiSelect: true,
  };

  it('空行跳过；序号与选项原文选选项；其余文字原样作答', () => {
    expect(parseQuestionAnswer(single, '  ')).toEqual([]);
    expect(parseQuestionAnswer(single, '2')).toEqual(['Full stack']);
    expect(parseQuestionAnswer(single, 'ui ONLY')).toEqual(['UI only']);
    expect(parseQuestionAnswer(single, 'Docs only')).toEqual(['Docs only']);
  });

  it('单选题不接受多个序号；序号超出范围不认', () => {
    expect(parseQuestionAnswer(single, '1,2')).toBeUndefined();
    expect(parseQuestionAnswer(single, '3')).toBeUndefined();
  });

  it('多选题：逗号、顿号或空格分隔，去重', () => {
    expect(parseQuestionAnswer(multi, '1, 3')).toEqual(['macOS', 'Linux']);
    expect(parseQuestionAnswer(multi, '3、1 3')).toEqual(['Linux', 'macOS']);
  });

  it('不能自己填写时只认选项；没有选项的题收任何文字', () => {
    expect(parseQuestionAnswer({ options: single.options }, 'something')).toBeUndefined();
    expect(parseQuestionAnswer(multi, 'something')).toBeUndefined();
    expect(parseQuestionAnswer({ options: [] }, '42')).toEqual(['42']);
  });
});

describe('questionPrompt', () => {
  it('说明第几题与能怎样回答', () => {
    expect(
      questionPrompt(
        { options: [{ label: 'a' }, { label: 'b' }], allowOther: true },
        { index: 1, total: 2 },
      ),
    ).toBe('回答 1/2 [1–2 / 文字 / 回车跳过] › ');
    expect(
      questionPrompt({ options: [{ label: 'a' }], multiSelect: true }, { index: 2, total: 2 }),
    ).toBe('回答 2/2 [1–1 可多选 / 回车跳过] › ');
    expect(questionPrompt({ options: [] }, { index: 1, total: 1 })).toBe(
      '回答 1/1 [文字 / 回车跳过] › ',
    );
  });
});
