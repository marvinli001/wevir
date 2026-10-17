// 会话侧栏“输出”卡片的纯逻辑（desktop-layout.md §12）：这个会话里 Agent 新建、修改、删除的文件与交给用户的文件，每个文件
// 一行，最近动过的在前。只看消息流（成功的修改 / 写文件调用与 0.40.0 的文件卡片），不读 git，不在 git 仓库里也有。

import type { ChatMessage } from '@wevir/client-sdk';
import { toRelativePath } from '@/files/file-path';
import { sharedFilePath } from '@/session/shared-files-model';
import { editStats, type LineStats, type ToolPart } from '@/session/tool-model';

export type OutputKind = 'created' | 'modified' | 'deleted' | 'shared';

export interface OutputFile {
  /** 绝对路径（引擎给的是相对路径时按会话目录补全）。 */
  path: string;
  /** 相对会话目录的路径；在会话目录外时没有。 */
  relative?: string;
  kind: OutputKind;
  /** 增删行数；算不出（一次调用改了几个文件、引擎没给内容）时没有。 */
  lines?: LineStats;
}

interface Touch {
  path: string;
  kind: Exclude<OutputKind, 'shared'>;
  lines?: LineStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absolute(path: string, cwd: string): string {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
    ? path
    : sharedFilePath(cwd, { path: path.replace(/^\.\//, '') });
}

/**
 * 一次成功的修改 / 写文件调用动了哪些文件。Codex 的 `fileChange` 每个文件一项（`changes[]`：add / delete / update，
 * update 带 `move_path` 时算改名后的文件）；其他引擎按展示里的 `paths`，`write` 算新建、`edit` 算修改，只有一个文件时带行数。
 */
function touches(part: ToolPart): Touch[] {
  if (part.status !== 'completed') return [];
  if (part.display.kind !== 'edit' && part.display.kind !== 'write') return [];
  const input = part.input;
  if (isRecord(input) && Array.isArray(input.changes)) {
    return input.changes.flatMap((change): Touch[] => {
      if (!isRecord(change) || typeof change.path !== 'string' || !isRecord(change.kind)) return [];
      const lines = editStats({ ...part, input: { changes: [change] } });
      const type = change.kind.type;
      if (type === 'add') return [{ path: change.path, kind: 'created', ...(lines && { lines }) }];
      if (type === 'delete') return [{ path: change.path, kind: 'deleted' }];
      const moved = typeof change.kind.move_path === 'string' ? change.kind.move_path : undefined;
      const updated: Touch = {
        path: moved ?? change.path,
        kind: 'modified',
        ...(lines && { lines }),
      };
      return moved ? [{ path: change.path, kind: 'deleted' }, updated] : [updated];
    });
  }
  const paths = part.display.paths ?? [];
  const kind = part.display.kind === 'write' ? 'created' : 'modified';
  const lines = paths.length === 1 ? editStats(part) : undefined;
  return paths.map((path) => ({ path, kind, ...(lines && { lines }) }));
}

function addLines(a: LineStats | undefined, b: LineStats | undefined): LineStats | undefined {
  if (!a) return b;
  if (!b) return a;
  return { added: a.added + b.added, removed: a.removed + b.removed };
}

/** 同一个文件先后几次：新建后再改还是新建，新建后又删掉就不算，改了再删是删除，删了又建是修改。 */
function merge(previous: OutputFile | undefined, touch: Touch): OutputFile | undefined {
  const base = { path: touch.path };
  if (!previous || previous.kind === 'shared') {
    return { ...base, kind: touch.kind, ...(touch.lines && { lines: touch.lines }) };
  }
  if (touch.kind === 'deleted') {
    return previous.kind === 'created' ? undefined : { ...base, kind: 'deleted' };
  }
  const kind =
    previous.kind === 'created' ? 'created' : previous.kind === 'deleted' ? 'modified' : touch.kind;
  const lines = previous.kind === 'deleted' ? touch.lines : addLines(previous.lines, touch.lines);
  return { ...base, kind, ...(lines && { lines }) };
}

/** 会话的输出文件，最近动过的在前。 */
export function sessionOutputs(messages: readonly ChatMessage[], cwd: string): OutputFile[] {
  // Map 按插入顺序：每次动到一个文件先删再放回去，末尾就是最近的。
  const files = new Map<string, OutputFile>();
  const put = (file: OutputFile | undefined, key: string) => {
    files.delete(key);
    if (file) files.set(key, file);
  };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type === 'tool') {
        for (const touch of touches(part)) {
          const path = absolute(touch.path, cwd);
          put(merge(files.get(path), { ...touch, path }), path);
        }
      } else if (part.type === 'files') {
        for (const shared of part.files) {
          const path = sharedFilePath(cwd, shared);
          // 交出去的文件本来就是这个会话写的：沿用已有的新建 / 修改，只是挪到最前。
          put(files.get(path) ?? { path, kind: 'shared' }, path);
        }
      }
    }
  }
  return [...files.values()].reverse().map((file) => {
    const relative = toRelativePath(file.path, cwd);
    return relative ? { ...file, relative } : file;
  });
}
