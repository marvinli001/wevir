import { describe, expect, it } from 'vitest';
import { customRows, globalStyle } from './personalization-model';

describe('personalization-model', () => {
  it('风格：省略与不认识的按默认显示', () => {
    expect(globalStyle(undefined)).toBe('default');
    expect(globalStyle('learning')).toBe('learning');
    expect(globalStyle('friendly')).toBe('friendly');
    expect(globalStyle('future_style')).toBe('default');
  });

  it('侧栏卡片：说明与风格各一行，不认识的风格不列', () => {
    expect(customRows({ instructions: true, outputStyle: 'concise', bytes: 10 })).toEqual([
      { key: 'instructions', label: 'settings.personalization.instructions', value: 'rules.wevir' },
      { key: 'style', label: 'settings.personalization.outputStyle', value: 'outputStyle.concise' },
    ]);
    expect(customRows({ instructions: false, outputStyle: 'future', bytes: 1 })).toEqual([]);
  });

  it('侧栏卡片：写作风格一行，不认识的值不列', () => {
    expect(customRows({ instructions: false, writingStyle: 'profile', bytes: 10 })).toEqual([
      {
        key: 'writing',
        label: 'settings.personalization.writingStyle',
        value: 'settings.personalization.writingProfile.ready',
      },
    ]);
    expect(customRows({ instructions: false, writingStyle: 'setup', bytes: 10 })[0]?.value).toBe(
      'settings.personalization.writingProfile.missing',
    );
    expect(customRows({ instructions: false, writingStyle: 'future', bytes: 1 })).toEqual([]);
  });
});
