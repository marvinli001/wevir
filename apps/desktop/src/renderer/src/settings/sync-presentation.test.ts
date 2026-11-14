import { describe, expect, it } from 'vitest';
import { syncErrorText } from '../host/error-text';
import { syncVersionLabel } from './sync-presentation';

describe('sync presentation', () => {
  it('shows device and local date without exposing operation identifiers', () => {
    const label = syncVersionLabel(
      {
        opId: 'operation_private',
        deviceId: 'device_private',
        clientTime: '2026-11-13T00:00:00.000Z',
      },
      { device_private: 'Test laptop' },
      undefined,
      0,
    );
    expect(label).toContain('Test laptop');
    expect(label).toContain('2026');
    expect(label).not.toMatch(/operation_private|device_private/);
  });
  it('distinguishes versions without metadata without exposing identifiers', () => {
    const first = syncVersionLabel({ opId: 'operation_private' }, {}, undefined, 0);
    const second = syncVersionLabel({ opId: 'other_private' }, {}, undefined, 1);
    expect(first).not.toBe(second);
    expect(first).not.toContain('operation_private');
    expect(
      syncVersionLabel({ opId: 'operation_private', deviceId: 'constructor' }, {}, undefined, 0),
    ).toContain('远端版本');
  });
  it('localizes known sync errors and keeps unknown codes out of user copy', () => {
    expect(syncErrorText('RATE_LIMITED')).toBe('请求受限，稍后重试');
    expect(syncErrorText('AUTH_REQUIRED')).toBe('需重新登录');
    expect(syncErrorText('unrecognized_private_identifier')).toBe('同步失败');
    expect(syncErrorText('constructor')).toBe('同步失败');
  });
});
