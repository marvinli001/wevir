import { describe, expect, it } from 'vitest';
import { filePreviews, livePreviewKey } from './file-preview-model';
import type { ReasoningPart, ToolPart } from './tool-model';

const TS = '2026-10-17T08:00:00.000Z';

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

const patch = (...changes: Array<{ path: string; kind: string; diff: string }>) => ({
  type: 'fileChange',
  changes: changes.map(({ path, kind, diff }) => ({ path, kind: { type: kind }, diff })),
});

describe('filePreviews', () => {
  it('Codex 新建的文件是全文的新增，行号从 1 起，结尾的换行不多出一行', () => {
    const part = tool('a', 'write', {
      input: patch({ path: '/w/notes.md', kind: 'add', diff: '# Notes\n\n- one\n' }),
    });
    expect(filePreviews(part)).toEqual([
      {
        path: '/w/notes.md',
        lines: [
          { kind: 'add', text: '# Notes', number: 1 },
          { kind: 'add', text: '', number: 2 },
          { kind: 'add', text: '- one', number: 3 },
        ],
      },
    ]);
  });

  it('Codex 删除的文件是全文的删除', () => {
    const part = tool('a', 'edit', {
      input: patch({ path: 'old.ts', kind: 'delete', diff: 'x\ny' }),
    });
    expect(filePreviews(part)?.[0]?.lines).toEqual([
      { kind: 'remove', text: 'x', number: 1 },
      { kind: 'remove', text: 'y', number: 2 },
    ]);
  });

  it('Codex 修改的文件按统一 diff：@@ 定新旧行号，文件头与“无换行”标记不要，第二段之前标出间隔', () => {
    const diff = [
      'diff --git a/mod.ts b/mod.ts',
      '--- a/mod.ts',
      '+++ b/mod.ts',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '',
      '@@ -10,2 +10,3 @@ function tail() {',
      ' a',
      '+b',
      ' c',
      '\\ No newline at end of file',
    ].join('\n');
    const part = tool('a', 'edit', { input: patch({ path: 'mod.ts', kind: 'update', diff }) });
    expect(filePreviews(part)?.[0]?.lines).toEqual([
      { kind: 'context', text: 'keep', number: 1 },
      { kind: 'remove', text: 'old', number: 2 },
      { kind: 'add', text: 'new', number: 2 },
      { kind: 'context', text: '', number: 3 },
      { kind: 'context', text: 'a', number: 10, gap: true },
      { kind: 'add', text: 'b', number: 11 },
      { kind: 'context', text: 'c', number: 12 },
    ]);
  });

  it('不带行号的 @@（Codex 写补丁时的进度）照样分出增删，没有行号', () => {
    const part = tool('a', 'edit', {
      input: patch({
        path: 'mod.ts',
        kind: 'update',
        diff: '@@ fn main\n-a\n+b\n*** End of File\n',
      }),
    });
    expect(filePreviews(part)?.[0]?.lines).toEqual([
      { kind: 'remove', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });

  it('一次补丁里的几个文件各一份；没有内容的文件不列', () => {
    const part = tool('a', 'edit', {
      input: patch(
        { path: 'a.ts', kind: 'add', diff: 'x\n' },
        { path: 'b.ts', kind: 'update', diff: '' },
      ),
    });
    expect(filePreviews(part)?.map((preview) => preview.path)).toEqual(['a.ts']);
    expect(
      filePreviews(tool('b', 'edit', { input: patch({ path: 'b.ts', kind: 'update', diff: '' }) })),
    ).toBeUndefined();
  });

  it('dsh / Claude 的替换：首尾相同的行是上下文，中间是删除与新增，没有行号；路径取展示里的', () => {
    const part = tool('a', 'edit', {
      display: { kind: 'edit', paths: ['/w/src/a.ts'] },
      input: { file_path: '/w/src/a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' },
    });
    expect(filePreviews(part)).toEqual([
      {
        path: '/w/src/a.ts',
        lines: [
          { kind: 'context', text: 'a' },
          { kind: 'remove', text: 'b' },
          { kind: 'add', text: 'B' },
          { kind: 'add', text: 'B2' },
          { kind: 'context', text: 'c' },
        ],
      },
    ]);
  });

  it('写文件是全文的新增；展示里没有路径时取输入的 file_path / path', () => {
    const claude = tool('a', 'write', { input: { file_path: '/w/x.md', content: 'one\ntwo\n' } });
    expect(filePreviews(claude)).toEqual([
      {
        path: '/w/x.md',
        lines: [
          { kind: 'add', text: 'one', number: 1 },
          { kind: 'add', text: 'two', number: 2 },
        ],
      },
    ]);
    expect(
      filePreviews(tool('b', 'write', { input: { path: 'y.md', content: 'z' } }))?.[0]?.path,
    ).toBe('y.md');
  });

  it('没有内容时没有预览：只有位置（Antigravity）、空文件、被截断的整个输入、不是修改的工具', () => {
    expect(
      filePreviews(
        tool('a', 'edit', {
          display: { kind: 'edit', paths: ['/w/a.ts'] },
          input: { locations: [{ path: '/w/a.ts' }] },
        }),
      ),
    ).toBeUndefined();
    expect(filePreviews(tool('b', 'write', { input: { content: '' } }))).toBeUndefined();
    expect(
      filePreviews(
        tool('c', 'edit', { input: { $truncated: true, originalLength: 200_000, preview: '{' } }),
      ),
    ).toBeUndefined();
    expect(filePreviews(tool('d', 'read', { input: { content: 'x' } }))).toBeUndefined();
  });
});

describe('livePreviewKey', () => {
  const write = (id: string, extra: Partial<ToolPart> = {}) =>
    tool(id, 'write', { input: patch({ path: `${id}.md`, kind: 'add', diff: 'x\n' }), ...extra });
  const thought: ReasoningPart = {
    type: 'reasoning',
    key: 'r',
    text: '',
    state: 'done',
    startedAt: TS,
    endedAt: TS,
  };

  it('取列出来的最近一次成功的修改，后面跟着别的工具也是它', () => {
    expect(livePreviewKey([write('a'), write('b'), tool('c', 'shell'), thought])).toBe('t:b');
  });

  it('失败的、还在运行的、没有内容的修改不算；都没有时为 undefined', () => {
    expect(
      livePreviewKey([
        write('a'),
        write('b', { status: 'failed' }),
        write('c', { status: 'running' }),
        tool('d', 'edit', { display: { kind: 'edit', paths: ['d.ts'] } }),
      ]),
    ).toBe('t:a');
    expect(livePreviewKey([tool('x', 'read'), thought])).toBeUndefined();
  });
});
