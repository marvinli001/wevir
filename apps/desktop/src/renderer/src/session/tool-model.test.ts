import type { ChatPart } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import {
  aggregateCounts,
  groupParts,
  outputSummary,
  type ToolPart,
  toolLifecycle,
  toolSummary,
} from './tool-model';

const TS = '2026-10-13T08:00:00.000Z';

function tool(
  id: string,
  kind: ToolPart['display']['kind'],
  extra: Partial<ToolPart> = {},
): ToolPart {
  return {
    type: 'tool',
    key: `t:${id}`,
    toolCallId: id,
    toolName: kind,
    display: { kind },
    status: 'completed',
    input: {},
    startedAt: TS,
    ...extra,
  };
}

const text = (key: string): ChatPart => ({ type: 'text', key, text: key, state: 'done' });
const thought = (key: string): ChatPart => ({ type: 'reasoning', key, text: key, state: 'done' });

describe('toolLifecycle', () => {
  it('未收尾的工具只在回合进行中算运行中 / 等待审批，否则状态未知', () => {
    expect(toolLifecycle(tool('a', 'shell', { status: 'running' }), true)).toBe('running');
    expect(toolLifecycle(tool('a', 'shell', { status: 'awaiting_approval' }), true)).toBe(
      'awaiting_approval',
    );
    expect(toolLifecycle(tool('a', 'shell', { status: 'running' }), false)).toBe('unknown');
    expect(toolLifecycle(tool('a', 'shell', { status: 'awaiting_approval' }), false)).toBe(
      'unknown',
    );
  });

  it('审批被拒的工具显示被拒绝；其余收尾状态原样', () => {
    const approval = { approvalId: 'apr_x' as const, status: 'denied' as const, options: [] };
    expect(toolLifecycle(tool('a', 'write', { status: 'failed', approval }), true)).toBe('denied');
    expect(toolLifecycle(tool('a', 'write', { status: 'failed' }), true)).toBe('failed');
    expect(toolLifecycle(tool('a', 'write', { status: 'cancelled' }), false)).toBe('cancelled');
    expect(toolLifecycle(tool('a', 'write', { status: 'unknown' }), true)).toBe('unknown');
  });
});

describe('toolSummary / outputSummary', () => {
  it('摘要依次取 summary、command、paths、query、url，再退到输入里的第一个字符串', () => {
    expect(
      toolSummary(tool('a', 'shell', { display: { kind: 'shell', command: 'ls\n-la' } })),
    ).toBe('ls');
    expect(toolSummary(tool('a', 'read', { display: { kind: 'read', paths: ['a', 'b'] } }))).toBe(
      'a b',
    );
    expect(toolSummary(tool('a', 'unknown', { input: { n: 1, note: ' 第一行\n第二行' } }))).toBe(
      '第一行',
    );
    expect(toolSummary(tool('a', 'unknown'))).toBeUndefined();
  });

  it('结果摘要是第一行非空文字', () => {
    const output = { text: '\n\n  Found 5 matches\nmore', truncated: false };
    expect(outputSummary(tool('a', 'search', { output }))).toBe('Found 5 matches');
    expect(outputSummary(tool('a', 'search'))).toBeUndefined();
  });
});

describe('groupParts', () => {
  it('连续的读取 / 搜索（中间夹思考）聚合成一项，串尾的思考不进组', () => {
    const parts = [
      thought('r0'),
      tool('1', 'read'),
      thought('r1'),
      tool('2', 'search'),
      tool('3', 'read'),
      thought('r2'),
      text('answer'),
    ];
    const items = groupParts(parts);
    expect(items.map((item) => (item.kind === 'part' ? item.part.key : item.key))).toEqual([
      'r0',
      'g:t:1',
      'r2',
      'answer',
    ]);
    const group = items[1];
    expect(group?.kind === 'aggregate' && group.entries.map((entry) => entry.key)).toEqual([
      't:1',
      'r1',
      't:2',
      't:3',
    ]);
  });

  it('只有一个读取、被其他工具或正文打断、等待审批中的工具都不聚合', () => {
    const items = groupParts([
      tool('1', 'read'),
      thought('r'),
      tool('2', 'shell'),
      tool('3', 'read'),
      text('x'),
      tool('4', 'read'),
      tool('5', 'read', { status: 'awaiting_approval' }),
    ]);
    expect(items.every((item) => item.kind === 'part')).toBe(true);
    expect(items).toHaveLength(7);
  });
});

describe('aggregateCounts', () => {
  it('读取按不同路径计文件数，没有路径时按次数；搜索按次数', () => {
    expect(
      aggregateCounts([
        tool('1', 'read', { display: { kind: 'read', paths: ['a.csv'] } }),
        tool('2', 'read', { display: { kind: 'read', paths: ['a.csv'] } }),
        tool('3', 'read', { display: { kind: 'read', paths: ['b.csv'] } }),
        tool('4', 'search'),
      ]),
    ).toEqual({ files: 2, searches: 1 });
    expect(aggregateCounts([tool('1', 'read'), tool('2', 'read')])).toEqual({
      files: 2,
      searches: 0,
    });
  });
});
