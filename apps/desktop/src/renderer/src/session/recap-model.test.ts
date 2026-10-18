import { SESSION_RECAP_MIN_AWAY_MS, type SessionRecap } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AwayMap,
  clearRecap,
  dismissRecap,
  isActiveState,
  markLeft,
  markReturned,
  type RecapMap,
  recapEnabled,
  receiveRecap,
  visibleRecap,
} from './recap-model';

const MIN = SESSION_RECAP_MIN_AWAY_MS;
const recap = (throughSeq: number, text = '摘要'): SessionRecap => ({
  text,
  generatedAt: '2026-10-18T09:30:00.000Z',
  throughSeq,
});

describe('离开与回来', () => {
  it('离开够久回来：要摘要，带离开时看到的位置与离开了多久，并清掉这一段离开', () => {
    const left = markLeft({}, 'a', 1_000, 12);
    expect(left).toEqual({ a: { leftAt: 1_000, seenSeq: 12 } });
    const back = markReturned(left, 'a', 1_000 + MIN);
    expect(back.request).toEqual({ seenSeq: 12, awayMs: MIN });
    expect(back.map).toEqual({});
  });

  it('离开不够久：不要，但这一段离开照样清掉', () => {
    const back = markReturned(markLeft({}, 'a', 0, 5), 'a', MIN - 1);
    expect(back.request).toBeUndefined();
    expect(back.map).toEqual({});
  });

  it('没离开过（刚打开的会话）：什么都不做', () => {
    const map: AwayMap = { b: { leftAt: 0, seenSeq: 1 } };
    expect(markReturned(map, 'a', 10 * MIN)).toEqual({ map });
  });

  it('一段离开只记最早的那次：窗口先失焦、之后又切走会话，起点不变', () => {
    const first = markLeft({}, 'a', 1_000, 12);
    expect(markLeft(first, 'a', 5_000, 30)).toBe(first);
    expect(markReturned(first, 'a', 1_000 + MIN).request?.seenSeq).toBe(12);
  });

  it('各会话互不影响；系统睡眠让时钟往前跳也照常算离开', () => {
    let map = markLeft({}, 'a', 0, 1);
    map = markLeft(map, 'b', 10, 2);
    const back = markReturned(map, 'a', 8 * 60 * 60_000);
    expect(back.request).toEqual({ seenSeq: 1, awayMs: 8 * 60 * 60_000 });
    expect(back.map).toEqual({ b: { leftAt: 10, seenSeq: 2 } });
    // 时钟倒退（校时）不出负数。
    expect(markReturned(markLeft({}, 'c', 100, 1), 'c', 50).request).toBeUndefined();
  });
});

describe('摘要的显示', () => {
  it('收到的摘要显示出来，用户关闭后不再显示', () => {
    const map = receiveRecap({}, 'a', recap(41), 'idle');
    expect(visibleRecap(map, 'a', 'idle')?.text).toBe('摘要');
    const closed = dismissRecap(map, 'a');
    expect(visibleRecap(closed, 'a', 'idle')).toBeUndefined();
    // 关闭一个没有的、或已关闭的：原样。
    expect(dismissRecap(closed, 'a')).toBe(closed);
    expect(dismissRecap(closed, 'zzz')).toBe(closed);
  });

  it('同一个位置的摘要再来一次：保持原样，关掉的不会冒出来；新位置替换旧的', () => {
    const closed = dismissRecap(receiveRecap({}, 'a', recap(41), 'idle'), 'a');
    expect(receiveRecap(closed, 'a', recap(41, '重复'), 'idle')).toBe(closed);
    const next = receiveRecap(closed, 'a', recap(60, '新的'), 'idle');
    expect(visibleRecap(next, 'a', 'idle')?.text).toBe('新的');
  });

  it('会话在回合里不显示；收到时会话已经开始回合了就当场算关闭', () => {
    const map = receiveRecap({}, 'a', recap(41), 'idle');
    for (const state of ['running', 'awaiting_approval', 'cancelling'] as const) {
      expect(visibleRecap(map, 'a', state)).toBeUndefined();
      expect(isActiveState(state)).toBe(true);
    }
    for (const state of ['idle', 'error', 'closed', undefined] as const) {
      expect(isActiveState(state)).toBe(false);
    }
    const late = receiveRecap({}, 'a', recap(41), 'running');
    expect(visibleRecap(late, 'a', 'idle')).toBeUndefined();
  });

  it('新的一段离开要摘要时清掉上一段的；别的会话不动', () => {
    const map: RecapMap = {
      ...receiveRecap({}, 'a', recap(41), 'idle'),
      ...receiveRecap({}, 'b', recap(7), 'idle'),
    };
    const cleared = clearRecap(map, 'a');
    expect(visibleRecap(cleared, 'a', 'idle')).toBeUndefined();
    expect(visibleRecap(cleared, 'b', 'idle')).toBeDefined();
    expect(clearRecap(cleared, 'a')).toBe(cleared);
  });
});

describe('recapEnabled', () => {
  const base = {
    featureSupported: true,
    settingOn: undefined,
    variant: 'main',
    side: undefined,
    parentSessionId: undefined,
  } as const;

  it('Host 有功能、设置没关、主窗格的顶层会话才追踪', () => {
    expect(recapEnabled(base)).toBe(true);
    expect(recapEnabled({ ...base, settingOn: true })).toBe(true);
    expect(recapEnabled({ ...base, settingOn: false })).toBe(false);
    expect(recapEnabled({ ...base, featureSupported: false })).toBe(false);
    expect(recapEnabled({ ...base, variant: 'pane' })).toBe(false);
    expect(recapEnabled({ ...base, side: true })).toBe(false);
    expect(recapEnabled({ ...base, parentSessionId: 'ses_parent' })).toBe(false);
  });
});
