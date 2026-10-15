import { describe, expect, it } from 'vitest';
import { t } from './index';
import { zhCN } from './zh-CN';

describe('文案模块', () => {
  it('取源语言（简体中文）文案并替换参数', () => {
    expect(t('sidebar.settings')).toBe('设置');
    expect(t('host.reconnecting', { attempt: 3 })).toBe('重连中（第 3 次）');
    expect(t('notFound.workspace', { id: 'ws_x' })).toBe('项目“ws_x”不存在');
  });

  it('参数值里的花括号不会被再次替换', () => {
    expect(t('notFound.page', { path: '/a/{path}' })).toBe('页面不存在：/a/{path}');
  });

  it('文案都是非空字符串，占位符只用 {name} 形式', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value, key).not.toBe('');
      expect(value.replace(/\{\w+\}/g, ''), key).not.toMatch(/[{}]/);
    }
  });
});
