import { describe, expect, it } from 'vitest';
import type { HostConnectionView } from './host-connection';
import { connectionBanner, hostIndicator } from './host-status';

const hello = {} as Extract<HostConnectionView, { status: 'connected' }>['hello'];
const running = {
  phase: 'running',
  ownership: { kind: 'owned', pid: 1, startedAt: '2026-10-14T00:00:00.000Z' },
} as const;

describe('connectionBanner', () => {
  it('连上了不显示；首次连接中交给页面，只有 Host 起不来或在重新启动时才提示', () => {
    expect(connectionBanner({ status: 'connected', hello }, running)).toBeUndefined();
    expect(
      connectionBanner({ status: 'connected', hello }, { phase: 'waiting', pid: 1 }),
    ).toBeUndefined();
    expect(connectionBanner({ status: 'connecting' }, undefined)).toBeUndefined();
    expect(connectionBanner({ status: 'connecting' }, { phase: 'starting' })).toBeUndefined();
    expect(
      connectionBanner(
        { status: 'connecting' },
        { phase: 'restarting', attempt: 1, maxAttempts: 3, reason: 'x' },
      ),
    ).toMatchObject({ tone: 'warning' });
  });

  it('断线时先说明 Host 进程的情况', () => {
    const view: HostConnectionView = { status: 'reconnecting', attempt: 2 };
    expect(
      connectionBanner(view, {
        phase: 'restarting',
        attempt: 2,
        maxAttempts: 3,
        reason: '后台服务意外退出（信号 SIGKILL）',
      }),
    ).toEqual({
      tone: 'warning',
      message: '后台服务意外退出，正在重新启动（第 2/3 次）…',
      detail: '后台服务意外退出（信号 SIGKILL）',
    });
    expect(connectionBanner(view, { phase: 'waiting', pid: 42 })).toMatchObject({
      tone: 'warning',
      message: '后台服务已停止，等待它重新运行…',
      detail: expect.stringContaining('桌面端不会替它启动'),
    });
    expect(
      connectionBanner(view, {
        phase: 'failed',
        error: '重新拉起 3 次都没有成功',
        logPath: '/data/logs/host.log',
      }),
    ).toEqual({
      tone: 'danger',
      message: '后台服务无法启动：重新拉起 3 次都没有成功',
      logPath: '/data/logs/host.log',
      action: 'retry',
    });
  });

  it('Host 进程在运行而连接断了：显示重连次数与“立即重连”；首次失败、连接关闭给“重试”', () => {
    expect(connectionBanner({ status: 'reconnecting', attempt: 3 }, running)).toEqual({
      tone: 'warning',
      message: '连接断开了，正在重连（第 3 次）…',
      detail: '断线期间的消息会在重连后补齐。',
      action: 'reconnect',
    });
    expect(connectionBanner({ status: 'failed', error: '超时' }, running)).toEqual({
      tone: 'danger',
      message: '无法连接后台服务：超时',
      action: 'retry',
    });
    expect(connectionBanner({ status: 'closed', error: '协议不兼容' }, undefined)).toEqual({
      tone: 'danger',
      message: '与后台服务的连接已关闭：协议不兼容',
      action: 'retry',
    });
  });
});

describe('hostIndicator', () => {
  it('与顶部提示一致：断线时先看 Host 进程的情况', () => {
    expect(hostIndicator({ status: 'connected', hello }, undefined)).toEqual({
      tone: 'success',
      text: '已连接',
    });
    const view: HostConnectionView = { status: 'reconnecting', attempt: 4 };
    expect(hostIndicator(view, { phase: 'failed', error: 'x', logPath: '/l' })).toEqual({
      tone: 'danger',
      text: '后台服务无法启动',
    });
    expect(
      hostIndicator(view, { phase: 'restarting', attempt: 2, maxAttempts: 3, reason: 'x' }),
    ).toMatchObject({ text: '后台服务重新启动中（第 2/3 次）', pulse: true });
    expect(hostIndicator(view, { phase: 'waiting', pid: 1 }).text).toBe('后台服务已停止，等待中');
    expect(hostIndicator(view, running)).toMatchObject({ text: '重连中（第 4 次）' });
  });
});
