import type { HostProcess } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  bufferFromPage,
  droppedBefore,
  hasEarlier,
  OUTPUT_MAX_CHARS,
  type OutputPage,
  outputLines,
  prependPage,
  processKey,
  sortProcesses,
  stopTarget,
  visibleRange,
  wrapRows,
} from './process-model';

const page = (from: number, text: string, start = 0): OutputPage => ({
  text,
  from,
  next: from + text.length,
  start,
  bytes: from + text.length,
  more: false,
});

const proc = (patch: Partial<HostProcess>): HostProcess => ({
  id: 'p1',
  workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
  source: { kind: 'agent', sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
  name: 'dev',
  command: 'pnpm dev',
  cwd: '/p',
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt: '2026-10-20T08:00:00.000Z',
  bytes: 0,
  stopSignals: ['SIGINT', 'SIGTERM', 'SIGKILL'],
  ...patch,
});

describe('输出缓冲', () => {
  it('往后接、往前补，偏移量按块记；超出上限丢另一头的整块', () => {
    let buffer = bufferFromPage(page(100, 'b\n', 50));
    expect(hasEarlier(buffer)).toBe(true);
    buffer = appendPage(buffer, page(102, 'c\n', 50));
    buffer = prependPage(buffer, page(50, `${'a'.repeat(49)}\n`, 50));
    expect(buffer).toMatchObject({ from: 50, next: 104, detached: false });
    expect(hasEarlier(buffer)).toBe(false);
    expect(droppedBefore(buffer)).toBe(true);
    expect(outputLines(buffer)).toEqual(['a'.repeat(49), 'b', 'c']);
    // 重复的一页不再接。
    expect(appendPage(buffer, page(102, 'c\n', 50)).next).toBe(104);

    const big = 'x'.repeat(OUTPUT_MAX_CHARS);
    const appended = appendPage(bufferFromPage(page(0, 'head\n')), page(5, `${big}\n`));
    expect(appended.from).toBe(5);
    expect(appended.chunks).toHaveLength(1);
    const prepended = prependPage(
      bufferFromPage(page(1000, 'tail\n')),
      page(0, big.slice(0, 1000)),
    );
    expect(prepended.from).toBe(0);
    expect(prepended.detached).toBe(false);
    const dropped = prependPage(
      bufferFromPage(page(OUTPUT_MAX_CHARS, 'tail\n')),
      page(0, 'y'.repeat(OUTPUT_MAX_CHARS)),
    );
    expect(dropped).toMatchObject({ detached: true, next: OUTPUT_MAX_CHARS });
  });

  it('拆行：CRLF、\\r 覆写的进度条、制表符', () => {
    const buffer = bufferFromPage(page(0, 'one\r\n10%\r50%\r100%\nt\tab\nlast'));
    expect(outputLines(buffer)).toEqual(['one', '100%', 't    ab', 'last']);
    expect(outputLines(bufferFromPage(page(0, '')))).toEqual([]);
  });

  it('折行与可见范围：超长的一行折成很多等高的显示行', () => {
    const rows = wrapRows(['short', 'L'.repeat(250)], 100);
    expect(rows.map((row) => [row.text.length, row.continued])).toEqual([
      [5, false],
      [100, false],
      [100, true],
      [50, true],
    ]);
    expect(wrapRows(['abc'], 3)).toHaveLength(1);
    expect(visibleRange(180, 90, 18, 1000, 2)).toEqual({ first: 8, last: 17 });
    expect(visibleRange(0, 90, 18, 3)).toEqual({ first: 0, last: 3 });
  });
});

describe('进程列表', () => {
  it('在跑的在前（最近起的在前），已结束的按结束时刻；同一个 ID 按启动时刻区分', () => {
    const a = proc({ id: 'p1', startedAt: '2026-10-20T08:00:00.000Z' });
    const b = proc({ id: 'p2', startedAt: '2026-10-20T08:01:00.000Z' });
    const c = proc({
      id: 'p3',
      status: 'exited',
      exitCode: 0,
      endedAt: '2026-10-20T08:05:00.000Z',
      stopSignals: [],
    });
    const d = proc({
      id: 'p4',
      status: 'exited',
      exitCode: 1,
      endedAt: '2026-10-20T08:02:00.000Z',
      stopSignals: [],
    });
    const sorted = sortProcesses([a, c, b, d]);
    expect(sorted.running.map((item) => item.id)).toEqual(['p2', 'p1']);
    expect(sorted.exited.map((item) => item.id)).toEqual(['p3', 'p4']);
    expect(processKey(a)).not.toBe(processKey({ ...a, startedAt: '2026-10-21T00:00:00.000Z' }));
  });

  it('停止的对象：进程组、进程树（只能 SIGKILL）、检查', () => {
    expect(stopTarget(proc({}))).toBe('group');
    expect(stopTarget(proc({ stopSignals: ['SIGKILL'] }))).toBe('tree');
    expect(
      stopTarget(
        proc({
          source: {
            kind: 'check',
            sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
            runId: 'vrn_01JA2B3C4D5E6F7G8H9JKMNPQR',
            checkId: 'chk_01JA2B3C4D5E6F7G8H9JKMNPQR',
            trigger: 'manual',
          },
          stopSignals: ['SIGTERM'],
        }),
      ),
    ).toBe('check');
  });
});
