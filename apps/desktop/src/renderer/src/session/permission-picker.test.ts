import { describe, expect, it } from 'vitest';
import { effectivePermissionMode, PERMISSION_MODES } from './permission-picker';

describe('effectivePermissionMode', () => {
  const all = PERMISSION_MODES;
  it('选的模式引擎支持或不知道引擎时照旧', () => {
    expect(effectivePermissionMode('auto_review', undefined, all)).toBe('auto_review');
    expect(effectivePermissionMode('on_request', all, all)).toBe('on_request');
  });

  it('引擎不支持时换成它支持、又能选的最严的模式：Windows 上的 Cursor 是完全访问，Copilot 没有自动批准时是请求批准', () => {
    expect(effectivePermissionMode('on_request', ['full_access'], all)).toBe('full_access');
    expect(effectivePermissionMode('auto_review', ['full_access'], all)).toBe('full_access');
    expect(effectivePermissionMode('auto_review', ['on_request', 'full_access'], all)).toBe(
      'on_request',
    );
  });

  it('引擎支持的在设置里都关掉了：照旧，发出去由引擎说明原因', () => {
    expect(effectivePermissionMode('on_request', ['full_access'], ['on_request'])).toBe(
      'on_request',
    );
  });
});
