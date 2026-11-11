import type { ChatPartOf } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import { DETAIL_TEXT_MAX, failureSummary, filePreviews, toolDetail } from './tool-detail';

type ToolPart = ChatPartOf<'tool'>;

function tool(patch: Partial<Record<keyof ToolPart, unknown>>): ToolPart {
  return {
    type: 'tool',
    key: 'tool1',
    toolCallId: 'call1',
    toolName: 'exec_command',
    display: { kind: 'shell', command: 'pnpm test' },
    status: 'completed',
    input: { command: 'pnpm test' },
    startedAt: '2026-11-11T10:00:00.000Z',
    ...patch,
  } as ToolPart;
}

describe('toolDetail：参数与结果', () => {
  it('Codex 的命令只留命令、目录与理由；带退出码与输出', () => {
    const detail = toolDetail(
      tool({
        toolName: 'commandExecution',
        input: { type: 'commandExecution', command: 'ls', cwd: '/w', id: 'x', status: 'done' },
        output: { text: 'a\nb' },
        exitCode: 1,
        status: 'failed',
      }),
    );
    expect(detail).toEqual({
      kind: 'io',
      input: { text: JSON.stringify({ command: 'ls', cwd: '/w' }, null, 2) },
      showOutput: true,
      output: { text: 'a\nb' },
      exitCode: 1,
    });
  });

  it('MCP 工具是它的参数；Host 截断过的参数与输出带原长', () => {
    const detail = toolDetail(
      tool({
        input: {
          type: 'mcpToolCall',
          arguments: { $truncated: true, originalLength: 9000, preview: '{"q":' },
        },
        output: { text: 'abc', truncated: true, originalLength: 5000 },
      }),
    );
    expect(detail).toMatchObject({
      input: { text: '{"q":', truncatedFrom: 9000 },
      output: { text: 'abc', truncatedFrom: 5000 },
    });
  });

  it('太长的输出只给开头；托管的网页搜索没有结果时不写结果一段', () => {
    const long = toolDetail(tool({ output: { text: 'x'.repeat(DETAIL_TEXT_MAX + 5) } }));
    expect(long).toMatchObject({ output: { truncatedFrom: DETAIL_TEXT_MAX + 5 } });
    if (long.kind === 'io') expect(long.output?.text).toHaveLength(DETAIL_TEXT_MAX);
    const search = toolDetail(
      tool({
        toolName: 'webSearch',
        input: { type: 'webSearch', query: 'q', action: { type: 'search', query: 'wevir' } },
      }),
    );
    expect(search).toMatchObject({
      input: { text: JSON.stringify({ type: 'search', query: 'wevir' }, null, 2) },
      showOutput: false,
    });
  });
});

describe('filePreviews：改动预览', () => {
  it('Codex 的 fileChange：统一 diff 带新旧行号与段间隔，新建是全文', () => {
    const part = tool({
      display: { kind: 'edit' },
      input: {
        changes: [
          {
            path: 'a.ts',
            kind: { type: 'update' },
            diff: '--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n@@ -20 +20 @@\n-x\n',
          },
          { path: 'b.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' },
        ],
      },
    });
    expect(filePreviews(part)).toEqual([
      {
        path: 'a.ts',
        lines: [
          { kind: 'context', text: 'keep', number: 3 },
          { kind: 'remove', text: 'old', number: 4 },
          { kind: 'add', text: 'new', number: 4 },
          { kind: 'remove', text: 'x', number: 20, gap: true },
        ],
      },
      {
        path: 'b.ts',
        lines: [
          { kind: 'add', text: 'one', number: 1 },
          { kind: 'add', text: 'two', number: 2 },
        ],
      },
    ]);
    expect(toolDetail(part).kind).toBe('previews');
  });

  it('替换一段文字没有行号；失败时另带结果', () => {
    const part = tool({
      display: { kind: 'edit', paths: ['src/x.ts'] },
      status: 'failed',
      input: { old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      output: { text: 'old_string not found' },
    });
    expect(toolDetail(part)).toEqual({
      kind: 'previews',
      previews: [
        {
          path: 'src/x.ts',
          lines: [
            { kind: 'context', text: 'a' },
            { kind: 'remove', text: 'b' },
            { kind: 'add', text: 'B' },
            { kind: 'context', text: 'c' },
          ],
        },
      ],
      output: 'old_string not found',
    });
  });

  it('没有内容的修改不算预览，退回参数与结果', () => {
    const part = tool({ display: { kind: 'edit' }, input: { locations: ['a'] } });
    expect(filePreviews(part)).toBeUndefined();
    expect(toolDetail(part).kind).toBe('io');
  });
});

describe('failureSummary', () => {
  it('取结果第一行非空文字；命令以非零退出码失败时不写', () => {
    expect(
      failureSummary(tool({ status: 'failed', output: { text: '\n  denied: no\nmore' } })),
    ).toBe('denied: no');
    expect(
      failureSummary(tool({ status: 'failed', exitCode: 2, output: { text: 'ok so far' } })),
    ).toBeUndefined();
    expect(failureSummary(tool({ status: 'failed' }))).toBeUndefined();
  });
});
