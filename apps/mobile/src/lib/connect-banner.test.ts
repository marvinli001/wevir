import { describe, expect, it } from 'vitest';
import type { LinkSnapshot, LinkStatus, SessionsState } from './computer-link';
import {
  BANNER_MIN_SHOW_MS,
  BANNER_RESULT_MS,
  BANNER_SHOW_DELAY_MS,
  type BannerEnvironment,
  ConnectBanner,
} from './connect-banner';
import { record, session } from './test-utils';

/** 手动推进的时钟。 */
class FakeClock implements BannerEnvironment {
  time = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  #next = 0;
  now() {
    return this.time;
  }
  setTimer(callback: () => void, ms: number) {
    this.#next += 1;
    this.#timers.set(this.#next, { at: this.time + ms, callback });
    return this.#next;
  }
  clearTimer(handle: unknown) {
    this.#timers.delete(handle as number);
  }
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = end;
  }
}

const READY: SessionsState = { kind: 'ready', sessions: [session('a', '2026-10-23T10:00:00Z')] };

function snap(name: string, status: LinkStatus, sessions: SessionsState = READY): LinkSnapshot {
  return {
    record: record({ name, hostName: undefined }),
    status,
    sessions,
    lastOnlineAt: undefined,
  };
}

const paused = (name = 'studio') => snap(name, { kind: 'paused' }, { kind: 'none' });
const connecting = (name = 'studio') => snap(name, { kind: 'connecting' }, { kind: 'none' });
const loading = (name = 'studio') =>
  snap(name, { kind: 'online', route: 'direct' }, { kind: 'loading' });
const online = (name = 'studio') => snap(name, { kind: 'online', route: 'direct' });
const offline = (name = 'studio') => snap(name, { kind: 'offline', reason: 'unreachable' });

function setup() {
  const clock = new FakeClock();
  const banner = new ConnectBanner(clock);
  return { clock, banner };
}

describe('ConnectBanner', () => {
  it('stays hidden when the connection settles within the show delay', () => {
    const { clock, banner } = setup();
    banner.update([paused()]);
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS - 100);
    banner.update([loading()]);
    banner.update([online()]);
    clock.advance(5_000);
    expect(banner.view).toBeUndefined();
  });

  it('appears after the delay and stays for the minimum time once connected', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    expect(banner.view).toBeUndefined();
    clock.advance(BANNER_SHOW_DELAY_MS);
    expect(banner.view).toEqual({ kind: 'connecting', stage: 'connecting', names: ['studio'] });
    banner.update([loading()]);
    expect(banner.view).toEqual({ kind: 'connecting', stage: 'loading', names: ['studio'] });
    clock.advance(200);
    banner.update([online()]);
    expect(banner.view?.kind).toBe('connecting');
    clock.advance(BANNER_MIN_SHOW_MS - 200 - 1);
    expect(banner.view?.kind).toBe('connecting');
    clock.advance(1);
    expect(banner.view).toBeUndefined();
  });

  it('hides right away when the minimum time has already passed', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS + BANNER_MIN_SHOW_MS + 500);
    banner.update([online()]);
    clock.advance(0);
    expect(banner.view).toBeUndefined();
  });

  it('treats a cached list on a fresh connection as still loading', () => {
    const { clock, banner } = setup();
    const cached: SessionsState = { ...READY, cachedAt: '2026-10-22T10:00:00Z' };
    banner.update([snap('studio', { kind: 'online', route: 'relay' }, cached)]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    expect(banner.view).toMatchObject({ kind: 'connecting', stage: 'loading' });
  });

  it('shows the offline reason briefly when the attempt fails, even a fast one', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    clock.advance(100);
    banner.update([snap('studio', { kind: 'offline', reason: 'remote_disabled' })]);
    expect(banner.view).toEqual({ kind: 'offline', reason: 'remote_disabled', names: ['studio'] });
    clock.advance(BANNER_RESULT_MS);
    expect(banner.view).toBeUndefined();
  });

  it('keeps the spinner for the minimum time before showing a failure', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    banner.update([offline()]);
    expect(banner.view?.kind).toBe('connecting');
    clock.advance(BANNER_MIN_SHOW_MS);
    expect(banner.view).toMatchObject({ kind: 'offline', reason: 'unreachable' });
    clock.advance(BANNER_RESULT_MS);
    expect(banner.view).toBeUndefined();
  });

  it('keeps background retries quiet and announces the reconnection', () => {
    const { clock, banner } = setup();
    banner.update([online()]);
    // 连接断了：WevirClient 第一次重连时显示“正在连接”。
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS + BANNER_MIN_SHOW_MS);
    banner.update([offline()]);
    expect(banner.view?.kind).toBe('offline');
    clock.advance(BANNER_RESULT_MS);
    expect(banner.view).toBeUndefined();
    // 自己的重试：不弹出。
    banner.update([connecting()]);
    clock.advance(5_000);
    expect(banner.view).toBeUndefined();
    banner.update([offline()]);
    banner.update([connecting()]);
    clock.advance(5_000);
    expect(banner.view).toBeUndefined();
    banner.update([online()]);
    expect(banner.view).toEqual({ kind: 'connected', names: ['studio'] });
    clock.advance(BANNER_RESULT_MS);
    expect(banner.view).toBeUndefined();
  });

  it('starts a fresh round after the app was in the background', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    clock.advance(10);
    banner.update([offline()]);
    clock.advance(BANNER_RESULT_MS);
    banner.update([paused()]);
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    expect(banner.view?.kind).toBe('connecting');
    banner.update([online()]);
    clock.advance(BANNER_MIN_SHOW_MS);
    // 回到前台重新连上不算“重新连上”。
    expect(banner.view).toBeUndefined();
  });

  it('switches from a result straight back to the spinner without the delay', () => {
    const { clock, banner } = setup();
    banner.update([online('a'), connecting('b')]);
    clock.advance(10);
    banner.update([online('a'), offline('b')]);
    expect(banner.view?.kind).toBe('offline');
    // 另一台断了。
    banner.update([connecting('a'), offline('b')]);
    expect(banner.view).toEqual({ kind: 'connecting', stage: 'connecting', names: ['a'] });
  });

  it('waits for every computer and reports only the ones that failed', () => {
    const { clock, banner } = setup();
    banner.update([connecting('a'), connecting('b')]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    expect(banner.view).toMatchObject({ kind: 'connecting', names: ['a', 'b'] });
    banner.update([online('a'), connecting('b')]);
    expect(banner.view).toMatchObject({ kind: 'connecting', names: ['b'] });
    banner.update([
      online('a'),
      snap('b', { kind: 'offline', reason: 'relay', relay: { kind: 'unavailable' } as never }),
    ]);
    clock.advance(BANNER_MIN_SHOW_MS);
    expect(banner.view).toEqual({ kind: 'offline', reason: 'relay', names: ['b'] });
  });

  it('drops the reason when the failed computers disagree', () => {
    const { clock, banner } = setup();
    banner.update([connecting('a'), connecting('b')]);
    clock.advance(10);
    banner.update([
      snap('a', { kind: 'offline', reason: 'host_mismatch' }),
      snap('b', { kind: 'offline', reason: 'unreachable' }),
    ]);
    expect(banner.view).toEqual({ kind: 'offline', names: ['a', 'b'] });
  });

  it('ignores removed computers and those already offline at launch', () => {
    const { clock, banner } = setup();
    banner.update([snap('a', { kind: 'removed' }, { kind: 'none' })]);
    clock.advance(5_000);
    expect(banner.view).toBeUndefined();
    banner.update([offline('b')]);
    clock.advance(5_000);
    expect(banner.view).toBeUndefined();
  });

  it('hides when the app goes to the background mid-connection', () => {
    const { clock, banner } = setup();
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    banner.update([paused()]);
    clock.advance(BANNER_MIN_SHOW_MS);
    expect(banner.view).toBeUndefined();
  });

  it('names computers by their display name', () => {
    const { clock, banner } = setup();
    banner.update([
      { ...connecting('studio-2'), record: record({ name: 'studio-2', hostName: 'Studio' }) },
    ]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    expect(banner.view).toMatchObject({ names: ['Studio'] });
  });

  it('notifies listeners only when the view changes', () => {
    const { clock, banner } = setup();
    let calls = 0;
    banner.subscribe(() => {
      calls += 1;
    });
    banner.update([connecting()]);
    clock.advance(BANNER_SHOW_DELAY_MS);
    banner.update([connecting()]);
    expect(calls).toBe(1);
  });
});
