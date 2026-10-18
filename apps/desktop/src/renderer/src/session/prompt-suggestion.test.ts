import type { PromptSuggestion } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  ghostText,
  isAcceptKey,
  type SuggestionContext,
  suggestionsEnabled,
  visibleSuggestion,
} from './prompt-suggestion';

const suggestion: PromptSuggestion = {
  turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR',
  text: ' 跑一下测试 ',
};
const ready: SuggestionContext = {
  supported: true,
  enabled: true,
  state: 'idle',
  disabled: false,
  planBusy: false,
  awaitingInput: false,
};

describe('suggestionsEnabled', () => {
  it('旧 Host 的设置里没有这一项：当作开；只有明确 false 才是关', () => {
    expect(suggestionsEnabled({})).toBe(true);
    expect(suggestionsEnabled({ promptSuggestions: true })).toBe(true);
    expect(suggestionsEnabled({ promptSuggestions: false })).toBe(false);
  });
});

describe('visibleSuggestion', () => {
  it('条件都满足：去掉首尾空白后显示', () => {
    expect(visibleSuggestion(suggestion, ready)).toBe('跑一下测试');
  });

  it('没有建议、Host 不支持、设置关着：不显示', () => {
    expect(visibleSuggestion(undefined, ready)).toBeUndefined();
    expect(visibleSuggestion(suggestion, { ...ready, supported: false })).toBeUndefined();
    expect(visibleSuggestion(suggestion, { ...ready, enabled: false })).toBeUndefined();
  });

  it('会话不是空闲（进行中、等审批、出错、关闭）或输入框不能用：不显示', () => {
    for (const state of [
      'running',
      'awaiting_approval',
      'cancelling',
      'error',
      'closed',
    ] as const) {
      expect(visibleSuggestion(suggestion, { ...ready, state }), state).toBeUndefined();
    }
    expect(visibleSuggestion(suggestion, { ...ready, state: undefined })).toBeUndefined();
    expect(visibleSuggestion(suggestion, { ...ready, disabled: true })).toBeUndefined();
  });

  it('计划流程里、有待回答的问题：不显示', () => {
    expect(visibleSuggestion(suggestion, { ...ready, planBusy: true })).toBeUndefined();
    expect(visibleSuggestion(suggestion, { ...ready, awaitingInput: true })).toBeUndefined();
  });

  it('全是空白的建议：不显示', () => {
    expect(visibleSuggestion({ ...suggestion, text: '  ' }, ready)).toBeUndefined();
  });
});

describe('ghostText', () => {
  const empty = { text: '', imageCount: 0, menuOpen: false };

  it('输入框完全空着才显示', () => {
    expect(ghostText('跑一下测试', empty)).toBe('跑一下测试');
    expect(ghostText('跑一下测试', { ...empty, text: 'a' })).toBeUndefined();
    expect(ghostText('跑一下测试', { ...empty, text: ' ' })).toBeUndefined();
    expect(ghostText('跑一下测试', { ...empty, imageCount: 1 })).toBeUndefined();
    expect(ghostText('跑一下测试', { ...empty, menuOpen: true })).toBeUndefined();
    expect(ghostText(undefined, empty)).toBeUndefined();
  });
});

describe('isAcceptKey', () => {
  const key = (name: string, extra: Record<string, boolean> = {}) => ({
    key: name,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    composing: false,
    ...extra,
  });

  it('Tab 与 → 接受', () => {
    expect(isAcceptKey(key('Tab'))).toBe(true);
    expect(isAcceptKey(key('ArrowRight'))).toBe(true);
  });

  it('带修饰键（Shift+Tab 是计划模式开关）、输入法合成中、别的键：不接受', () => {
    expect(isAcceptKey(key('Tab', { shiftKey: true }))).toBe(false);
    expect(isAcceptKey(key('ArrowRight', { altKey: true }))).toBe(false);
    expect(isAcceptKey(key('ArrowRight', { metaKey: true }))).toBe(false);
    expect(isAcceptKey(key('Tab', { ctrlKey: true }))).toBe(false);
    expect(isAcceptKey(key('ArrowRight', { composing: true }))).toBe(false);
    for (const other of ['Enter', 'ArrowLeft', 'ArrowDown', 'a', 'Escape']) {
      expect(isAcceptKey(key(other)), other).toBe(false);
    }
  });
});
