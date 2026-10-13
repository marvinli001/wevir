import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionLifecycle, type FailureClass, type LifecycleState } from './lifecycle.js';

class AuthError extends Error {}
class FatalError extends Error {}

/** 由测试逐个决定每次尝试成功还是失败的生命周期。 */
function harness({ ignoreAbort = false } = {}) {
  const states: Array<LifecycleState<string>> = [];
  const attempts: Array<{
    resolve(value: string): void;
    reject(error: unknown): void;
    signal: AbortSignal;
  }> = [];
  const discarded: string[] = [];
  const lifecycle = new ConnectionLifecycle<string>({
    attempt: (signal) =>
      new Promise((resolve, reject) => {
        attempts.push({ resolve, reject, signal });
        if (!ignoreAbort) signal.addEventListener('abort', () => reject(signal.reason));
      }),
    discard: (connection) => discarded.push(connection),
    classify: (error): FailureClass =>
      error instanceof FatalError
        ? { retry: false }
        : error instanceof AuthError
          ? { retry: 'auth', reason: 'unauthorized' }
          : { retry: 'normal', reason: 'connection_lost' },
    onStateChange: (state) => states.push(state),
    backoff: {
      initialDelayMs: 1000,
      maxDelayMs: 10_000,
      authInitialDelayMs: 5000,
      authMaxDelayMs: 60_000,
    },
  });
  const phases = () =>
    states.map((s) =>
      s.phase === 'reconnecting' ? `reconnecting#${s.attempt}:${s.delayMs}:${s.reason}` : s.phase,
    );
  return { lifecycle, states, attempts, discarded, phases };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionLifecycle', () => {
  it('首次连接失败：进入 closed（带错误），start() 以该错误 reject，不重试', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    const error = new Error('ECONNREFUSED');
    h.attempts[0]?.reject(error);
    await expect(started).rejects.toBe(error);
    expect(h.phases()).toEqual(['connecting', 'closed']);
    expect(h.lifecycle.state).toEqual({ phase: 'closed', error });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(1);
  });

  it('断开后按普通退避重试：1 s 起翻倍、10 s 封顶；连上即重置', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    h.attempts[0]?.resolve('c1');
    expect(await started).toBe('c1');
    h.lifecycle.lost('c1', 'connection_lost');
    for (let i = 1; i <= 6; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.attempts[i]?.reject(new Error('refused'));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    h.attempts[7]?.resolve('c2');
    await vi.advanceTimersByTimeAsync(0);
    h.lifecycle.lost('c2', 'heartbeat_timeout');
    expect(h.phases()).toEqual([
      'connecting',
      'connected',
      'reconnecting#1:1000:connection_lost',
      'reconnecting#2:2000:connection_lost',
      'reconnecting#3:4000:connection_lost',
      'reconnecting#4:8000:connection_lost',
      'reconnecting#5:10000:connection_lost',
      'reconnecting#6:10000:connection_lost',
      'reconnecting#7:10000:connection_lost',
      'connected',
      'reconnecting#1:1000:heartbeat_timeout',
    ]);
  });

  it('鉴权类失败走慢速退避（5 s 起、60 s 封顶），与普通退避各自计算', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    h.attempts[0]?.resolve('c1');
    await started;
    h.lifecycle.lost('c1', 'connection_lost');
    await vi.advanceTimersByTimeAsync(1000);
    h.attempts[1]?.reject(new AuthError());
    await vi.advanceTimersByTimeAsync(5000);
    h.attempts[2]?.reject(new AuthError());
    await vi.advanceTimersByTimeAsync(10_000);
    h.attempts[3]?.reject(new Error('refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.phases().slice(2)).toEqual([
      'reconnecting#1:1000:connection_lost',
      'reconnecting#2:5000:unauthorized',
      'reconnecting#3:10000:unauthorized',
      'reconnecting#4:2000:connection_lost',
    ]);
  });

  it('不可恢复的失败直接 closed', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    h.attempts[0]?.resolve('c1');
    await started;
    h.lifecycle.lost('c1', 'connection_lost');
    await vi.advanceTimersByTimeAsync(1000);
    const fatal = new FatalError('incompatible');
    h.attempts[1]?.reject(fatal);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lifecycle.state).toEqual({ phase: 'closed', error: fatal });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(2);
  });

  it('reconnectNow：重置退避并立即重试；连着或已有尝试在跑时不另起；换代前的尝试报的鉴权失败按普通退避', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    h.attempts[0]?.resolve('c1');
    await started;
    h.lifecycle.reconnectNow();
    expect(h.attempts).toHaveLength(1);

    h.lifecycle.lost('c1', 'connection_lost');
    await vi.advanceTimersByTimeAsync(1000);
    h.attempts[1]?.reject(new AuthError());
    await vi.advanceTimersByTimeAsync(0);
    // 正在等 5 s 的慢速重试：换代后立刻重试。
    h.lifecycle.reconnectNow();
    expect(h.attempts).toHaveLength(3);
    h.lifecycle.reconnectNow();
    expect(h.attempts).toHaveLength(3);
    // 这次尝试发起之后又换了一代：它的鉴权失败说明的是旧令牌。
    h.lifecycle.reconnectNow();
    h.attempts[2]?.reject(new AuthError());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.phases().slice(-1)).toEqual(['reconnecting#3:1000:unauthorized']);
  });

  it('close()：中止进行中的尝试、清掉重试计时器；尝试在关闭后才成功的连接被丢弃', async () => {
    const h = harness();
    const started = h.lifecycle.start();
    h.attempts[0]?.resolve('c1');
    await started;
    h.lifecycle.lost('c1', 'connection_lost');
    h.lifecycle.close();
    expect(h.lifecycle.state).toEqual({ phase: 'closed' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.attempts).toHaveLength(1);

    const g = harness();
    const pending = g.lifecycle.start();
    g.lifecycle.close();
    await expect(pending).rejects.toMatchObject({ kind: 'client_closed' });
    expect(g.attempts[0]?.signal.aborted).toBe(true);
    // 没有响应中止信号、照样成功的尝试。
    const late = harness({ ignoreAbort: true });
    const lateStart = late.lifecycle.start();
    late.lifecycle.close();
    late.attempts[0]?.resolve('c-late');
    await expect(lateStart).rejects.toMatchObject({ kind: 'client_closed' });
    expect(late.discarded).toEqual(['c-late']);
  });
});
