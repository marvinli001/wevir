import { describe, expect, it } from 'vitest';
import type { UpdatePhase, UpdateState } from '../../../shared/desktop-api.js';
import { updateEntry } from './update-model';

const base = { currentVersion: '0.1.0', channel: 'stable' } as const;
const state = (phase: UpdatePhase) => ({ ...base, ...phase }) as UpdateState;

describe('updateEntry', () => {
  it('没有新版本、更新关闭、正在检查、连不上服务器时不显示', () => {
    expect(updateEntry(undefined)).toBeUndefined();
    expect(updateEntry(state({ phase: 'idle' }))).toBeUndefined();
    expect(updateEntry(state({ phase: 'checking' }))).toBeUndefined();
    expect(updateEntry(state({ phase: 'latest' }))).toBeUndefined();
    expect(updateEntry(state({ phase: 'disabled', reason: 'development' }))).toBeUndefined();
    expect(updateEntry(state({ phase: 'error', code: 'unreachable' }))).toBeUndefined();
  });

  it('新版本 → 下载进度 → 重启以更新 → 正在安装', () => {
    expect(updateEntry(state({ phase: 'available', version: '0.2.0' }))).toEqual({
      kind: 'available',
      version: '0.2.0',
    });
    expect(
      updateEntry(
        state({ phase: 'downloading', version: '0.2.0', percent: 42.7, bytesPerSecond: 1 }),
      ),
    ).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42 });
    expect(updateEntry(state({ phase: 'downloaded', version: '0.2.0' }))).toEqual({
      kind: 'restart',
      version: '0.2.0',
    });
    expect(updateEntry(state({ phase: 'installing', version: '0.2.0' }))).toEqual({
      kind: 'installing',
      version: '0.2.0',
    });
  });

  it('下载或安装失败时显示“更新失败”', () => {
    expect(updateEntry(state({ phase: 'error', code: 'download', version: '0.2.0' }))).toEqual({
      kind: 'failed',
      version: '0.2.0',
    });
  });
});
