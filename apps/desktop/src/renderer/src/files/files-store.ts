// 文件窗格（U32）的界面状态：要跳到的行（打开同一个文件再点别的行也会跳过去）、记在本机的显示偏好与上次用的外部编辑器。
// 入口（助手消息里的文件链接、文件树、@ 提及的文件）经 openFile 打开窗格。

import type { PaneController } from '@/layout/pane-controller';
import { createPersistedStore, createStore } from '@/lib/store';
import { platformApi } from '@/platform/platform';
import type { EditorInfo } from '../../../shared/desktop-api.js';

export interface FileReveal {
  line: number;
  /** 每次请求加一，同一行再点也会跳过去。 */
  id: number;
}

const reveals = createStore<ReadonlyMap<string, FileReveal>>(new Map());
let revealCounter = 0;

export function useFileReveal(path: string): FileReveal | undefined {
  return reveals.use().get(path);
}

/** 打开文件窗格（同一个文件已开着就切过去），可带要跳到的行。 */
export function openFile(panes: PaneController | undefined, path: string, line?: number): void {
  if (line !== undefined) {
    reveals.set((current) => new Map(current).set(path, { line, id: ++revealCounter }));
  }
  panes?.open({ kind: 'file', params: { path } });
}

/** 打开文件树。 */
export function openFiles(panes: PaneController | undefined): void {
  panes?.open({ kind: 'files' });
}

export interface FilePrefs {
  /** 长行自动换行，默认不换。 */
  wrap: boolean;
  /** Markdown 显示渲染后的样子，默认是。 */
  renderMarkdown: boolean;
  /** 网页显示渲染后的样子（0.32.0，照 T3 默认是）。 */
  renderHtml: boolean;
  /** CSV / TSV 显示成表格（0.32.0，照 T3 默认是）。 */
  renderTable: boolean;
  /** 预览引擎装好时办公文档显示成页面（0.138.0，转成的 PDF），默认是；否则显示抽出的文字或表格。 */
  renderOffice: boolean;
  /** 上次用的外部编辑器（`EditorInfo.id`）。 */
  editor?: string;
}

export const filePrefs = createPersistedStore<FilePrefs>(
  'wevir.files.v1',
  { wrap: false, renderMarkdown: true, renderHtml: true, renderTable: true, renderOffice: true },
  (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const value = raw as Partial<Record<keyof FilePrefs, unknown>>;
    return {
      wrap: value.wrap === true,
      renderMarkdown: value.renderMarkdown !== false,
      renderHtml: value.renderHtml !== false,
      renderTable: value.renderTable !== false,
      renderOffice: value.renderOffice !== false,
      ...(typeof value.editor === 'string' && { editor: value.editor }),
    };
  },
);

/** 本机的外部编辑器（主进程查一次）；查完之前是 undefined。 */
const editors = createStore<readonly EditorInfo[] | undefined>(undefined);
let loadingEditors = false;

export function useEditors(): readonly EditorInfo[] | undefined {
  const list = editors.use();
  if (list === undefined && !loadingEditors) {
    loadingEditors = true;
    void platformApi()
      .listEditors()
      .then((found) => editors.set(found))
      .catch(() => editors.set([]));
  }
  return list;
}

/** 用外部编辑器打开文件或文件夹，并记下它作为首选；文件窗格的“打开方式”与侧栏菜单共用。 */
export function openInEditor(editorId: string, path: string, line?: number): void {
  filePrefs.set((current) => ({ ...current, editor: editorId }));
  void platformApi()
    .openInEditor(editorId, path, line)
    .catch(() => undefined);
}

/** 首选的编辑器：上次用的，没有就是表里的第一个。 */
export function preferredEditor(
  list: readonly EditorInfo[] | undefined,
  last: string | undefined,
): EditorInfo | undefined {
  return list?.find((editor) => editor.id === last) ?? list?.[0];
}
