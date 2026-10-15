import type { Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { UpdatePhase, UpdateState } from '../../../shared/desktop-api.js';
import { hasActiveTurn, shouldInstallNow, updateEntry } from './update-model';

const base = { currentVersion: '0.1.0', channel: 'stable' } as const;
const state = (phase: UpdatePhase) => ({ ...base, ...phase }) as UpdateState;

describe('updateEntry', () => {
  it('没有新版本、更新关闭、正在检查、连不上服务器时不显示', () => {
    expect(updateEntry(undefined, false)).toBeUndefined();
    expect(updateEntry(state({ phase: 'idle' }), false)).toBeUndefined();
    expect(updateEntry(state({ phase: 'checking' }), false)).toBeUndefined();
    expect(updateEntry(state({ phase: 'latest' }), false)).toBeUndefined();
    expect(updateEntry(state({ phase: 'disabled', reason: 'development' }), false)).toBeUndefined();
    expect(updateEntry(state({ phase: 'error', code: 'unreachable' }), false)).toBeUndefined();
  });

  it('新版本 → 下载进度 → 有回合在跑时“重启以更新”，没有时直接显示“正在安装”', () => {
    expect(updateEntry(state({ phase: 'available', version: '0.2.0' }), false)).toEqual({
      kind: 'available',
      version: '0.2.0',
    });
    expect(
      updateEntry(
        state({ phase: 'downloading', version: '0.2.0', percent: 42.7, bytesPerSecond: 1 }),
        false,
      ),
    ).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42 });
    const downloaded = state({ phase: 'downloaded', version: '0.2.0' });
    expect(updateEntry(downloaded, true)).toEqual({ kind: 'restart', version: '0.2.0' });
    expect(updateEntry(downloaded, false)).toEqual({ kind: 'installing', version: '0.2.0' });
    expect(shouldInstallNow(downloaded, false)).toBe(true);
    expect(shouldInstallNow(downloaded, true)).toBe(false);
    expect(shouldInstallNow(state({ phase: 'available', version: '0.2.0' }), false)).toBe(false);
  });

  it('下载或安装失败时显示“更新失败”', () => {
    expect(
      updateEntry(state({ phase: 'error', code: 'download', version: '0.2.0' }), false),
    ).toEqual({
      kind: 'failed',
      version: '0.2.0',
    });
  });
});

describe('hasActiveTurn', () => {
  const session = (state: Session['state']) => ({ state }) as Session;
  it('运行中、取消中、等审批算；空闲、出错、已关闭不算', () => {
    expect(hasActiveTurn([session('idle'), session('error'), session('closed')])).toBe(false);
    for (const active of ['running', 'cancelling', 'awaiting_approval'] as const) {
      expect(hasActiveTurn([session('idle'), session(active)])).toBe(true);
    }
  });
});
