import type { ChatMessage, ChatPart } from '@wevir/client-sdk';
import type { ToolDisplay, TurnId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { sessionOutputs } from './outputs-model';

const CWD = '/work/app';
const TURN = 'trn_1' as TurnId;
let counter = 0;

function tool(display: ToolDisplay, input: unknown, status = 'completed'): ChatPart {
  counter += 1;
  return {
    type: 'tool',
    key: `t${counter}`,
    toolCallId: `c${counter}`,
    toolName: display.kind,
    display,
    status,
    input,
    startedAt: '2026-10-17T00:00:00.000Z',
  } as ChatPart;
}

const patch = (...changes: { path: string; kind: unknown; diff: string }[]) =>
  tool({ kind: 'edit', paths: changes.map((change) => change.path) }, { changes });

const assistant = (...parts: ChatPart[]): ChatMessage =>
  ({ id: `a${counter++}`, role: 'assistant', turnId: TURN, parts }) as unknown as ChatMessage;

describe('sessionOutputs', () => {
  it('Codex 的 fileChange 每个文件一行，带行数与相对路径，最近动过的在前', () => {
    const files = sessionOutputs(
      [
        assistant(
          patch(
            { path: `${CWD}/src/a.ts`, kind: { type: 'add' }, diff: 'x\ny\n' },
            {
              path: `${CWD}/b.ts`,
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-a\n+b\n',
            },
          ),
        ),
        assistant(patch({ path: `${CWD}/old.ts`, kind: { type: 'delete' }, diff: 'gone\n' })),
      ],
      CWD,
    );
    expect(files).toEqual([
      { path: `${CWD}/old.ts`, relative: 'old.ts', kind: 'deleted' },
      {
        path: `${CWD}/b.ts`,
        relative: 'b.ts',
        kind: 'modified',
        lines: { added: 1, removed: 1 },
      },
      {
        path: `${CWD}/src/a.ts`,
        relative: 'src/a.ts',
        kind: 'created',
        lines: { added: 2, removed: 0 },
      },
    ]);
  });

  it('同一文件先后几次合成一行：新建后再改仍是新建、新建后删掉不算、改了再删是删除', () => {
    const files = sessionOutputs(
      [
        assistant(
          patch({ path: `${CWD}/new.ts`, kind: { type: 'add' }, diff: 'a\n' }),
          patch({
            path: `${CWD}/new.ts`,
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1,2 @@\n a\n+b\n',
          }),
          patch({ path: `${CWD}/tmp.ts`, kind: { type: 'add' }, diff: 'a\n' }),
          patch({ path: `${CWD}/tmp.ts`, kind: { type: 'delete' }, diff: 'a\n' }),
          patch({
            path: `${CWD}/keep.ts`,
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-a\n+b\n',
          }),
          patch({ path: `${CWD}/keep.ts`, kind: { type: 'delete' }, diff: 'b\n' }),
        ),
      ],
      CWD,
    );
    expect(files.map((file) => [file.relative, file.kind, file.lines])).toEqual([
      ['keep.ts', 'deleted', undefined],
      ['new.ts', 'created', { added: 2, removed: 0 }],
    ]);
  });

  it('改名：原文件算删除，新文件算修改', () => {
    const files = sessionOutputs(
      [
        assistant(
          patch({
            path: `${CWD}/a.ts`,
            kind: { type: 'update', move_path: `${CWD}/b.ts` },
            diff: '',
          }),
        ),
      ],
      CWD,
    );
    expect(files.map((file) => [file.relative, file.kind])).toEqual([
      ['b.ts', 'modified'],
      ['a.ts', 'deleted'],
    ]);
  });

  it('其他引擎按 paths：write 算新建、edit 算修改；失败的调用不算；会话目录外的没有相对路径', () => {
    const files = sessionOutputs(
      [
        assistant(
          tool({ kind: 'write', paths: ['notes.md'] }, { content: 'a\nb\n' }),
          tool({ kind: 'edit', paths: ['/elsewhere/x.ts'] }, { old_string: 'a', new_string: 'b' }),
          tool({ kind: 'edit', paths: [`${CWD}/fail.ts`] }, {}, 'failed'),
          tool({ kind: 'read', paths: [`${CWD}/read.ts`] }, {}),
        ),
      ],
      CWD,
    );
    expect(files).toEqual([
      { path: '/elsewhere/x.ts', kind: 'modified', lines: { added: 1, removed: 1 } },
      {
        path: `${CWD}/notes.md`,
        relative: 'notes.md',
        kind: 'created',
        lines: { added: 2, removed: 0 },
      },
    ]);
  });

  it('交给用户的文件：没动过的算“交付”，动过的沿用原来的类型并挪到最前', () => {
    const files = sessionOutputs(
      [
        assistant(
          patch({ path: `${CWD}/report.md`, kind: { type: 'add' }, diff: 'a\n' }),
          patch({ path: `${CWD}/other.ts`, kind: { type: 'add' }, diff: 'a\n' }),
          {
            type: 'files',
            key: 'f1',
            files: [
              { path: 'report.md', name: 'report.md', size: 2 },
              { path: 'out/data.csv', name: 'data.csv', size: 10 },
            ],
          },
        ),
      ],
      CWD,
    );
    expect(files.map((file) => [file.relative, file.kind])).toEqual([
      ['out/data.csv', 'shared'],
      ['report.md', 'created'],
      ['other.ts', 'created'],
    ]);
  });
});
