// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/FilePreviewPanel.tsx（EditableFileSurface、useEditableAfterHighlight、
// createFileEditor）与 useFileSaveCoordinator.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：去掉行内评论与审查意见；保存走 Host 的 `workspace.writeFile`（带修改时间的冲突检查），冲突时停下等用户选“重新载入”或
// “覆盖”；有没写的编辑时不让磁盘上的新内容盖掉它（T3 靠乐观的查询缓存）。
//
// 文件窗格的编辑（0.32.0，desktop-layout.md §19）：文本文件直接在 Pierre 的 File 里编辑（EditProvider），停下 500 ms 自动写回。

import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  type FileContents,
  getFiletypeFromFileName,
} from '@pierre/diffs';
import { Editor, type EditorChangeEvent, type EditorFactory } from '@pierre/diffs/edit';
import { EditProvider, File, useWorkerPool, Virtualizer } from '@pierre/diffs/react';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from '@/changes/diff-rendering';
import { DiffWorkerPoolProvider, PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { Button } from '@/components/ui/button';
import { FileSaveCoordinator } from '@/files/file-save-coordinator';
import { type FileScope, rememberWrittenFile } from '@/files/files-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { useTheme } from '@/theme/theme';
import { SurfaceNotice } from './file-viewers';

const FILE_SAVE_DEBOUNCE_MS = 500;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'failed';

const createFileEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) =>
  new Editor(editorType, options, editStateKey);

function needsWorkerHighlight(workerPool: WorkerPoolManager | undefined, file: FileContents) {
  if (workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === 'text') return false;
  let lines = 1;
  for (
    let index = file.contents.indexOf('\n');
    index !== -1;
    index = file.contents.indexOf('\n', index + 1)
  ) {
    lines += 1;
  }
  return lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/**
 * Pierre highlights an active edit session on the main thread, so each version
 * of the file becomes editable only once it has rendered the worker's
 * highlight. A failed worker highlight falls back to main-thread highlighting.
 */
function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlightedFile, setHighlightedFile] = useState<FileContents | null>(null);
  const needsHighlight = useMemo(() => needsWorkerHighlight(workerPool, file), [file, workerPool]);
  const ready = !needsHighlight || highlightedFile === file;

  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlightedFile(file));
  }, [file, ready, workerPool]);

  const onPostRender = useCallback(
    (renderedFile: FileContents | undefined, phase: string) => {
      if (ready || phase === 'unmount' || renderedFile?.cacheKey !== file.cacheKey) return;
      // The pool caches a result just before the instance renders it, so a
      // render that sees the cache has painted highlighted rows.
      if (workerPool?.getFileResultCache(file) !== undefined) setHighlightedFile(file);
    },
    [file, ready, workerPool],
  );
  return { ready, onPostRender };
}

export function EditableSource(props: {
  scope: FileScope;
  path: string;
  name: string;
  text: string;
  mtimeMs: number | undefined;
  wrap: boolean;
  onStatus: (status: SaveStatus) => void;
  /** 冲突时选“重新载入”：丢掉自己的编辑，重读磁盘。 */
  onReload: () => void;
}) {
  return (
    <DiffWorkerPoolProvider>
      <EditableSurface {...props} />
    </DiffWorkerPoolProvider>
  );
}

function EditableSurface({
  scope,
  path,
  name,
  text,
  mtimeMs,
  wrap,
  onStatus,
  onReload,
}: Parameters<typeof EditableSource>[0]) {
  const { resolved: theme } = useTheme();
  const { client } = useHostConnection();
  // 编辑基于的那一版；写回成功后换成新的。
  const baseMtime = useRef(mtimeMs);
  const pending = useRef(false);
  const [conflict, setConflict] = useState<string>();
  const [status, setStatus] = useState<SaveStatus>('idle');
  const report = useRef(onStatus);
  report.current = onStatus;
  useEffect(() => report.current(status), [status]);

  // 编辑器拥有草稿：自己写回的内容回到这里时文件身份不变，只有别处的修改（且没有没写的编辑）才换掉它。
  const [externalFile, setExternalFile] = useState<FileContents>(() => ({
    name,
    contents: text,
    cacheKey: `edit:${path}:${mtimeMs ?? 0}`,
  }));
  const [editedContents, setEditedContents] = useState<string | null>(null);
  // 只在读到新的一版时比较（写回之后父组件的 text 还是旧的，不能拿它盖掉刚写的）。
  const [seenText, setSeenText] = useState(text);
  if (text !== seenText) {
    setSeenText(text);
    if (text !== (editedContents ?? externalFile.contents) && !pending.current) {
      baseMtime.current = mtimeMs;
      setExternalFile({ name, contents: text, cacheKey: `edit:${path}:${mtimeMs ?? 0}` });
      setEditedContents(null);
    }
  }
  const { ready: editable, onPostRender } = useEditableAfterHighlight(externalFile);

  const write = useCallback(
    async (contents: string, force: boolean): Promise<boolean> => {
      if (!client) return false;
      setStatus('saving');
      try {
        const result = await client.request('workspace.writeFile', {
          workspaceId: scope.workspaceId,
          ...(scope.sessionId !== undefined && { sessionId: scope.sessionId }),
          path,
          text: contents,
          ...(!force && baseMtime.current !== undefined && { expectedMtimeMs: baseMtime.current }),
        });
        if (result.conflict) {
          setConflict(contents);
          setStatus('conflict');
          return false;
        }
        baseMtime.current = result.mtimeMs;
        rememberWrittenFile(scope, path, contents, result);
        setConflict(undefined);
        return true;
      } catch {
        setStatus('failed');
        return false;
      }
    },
    [client, scope, path],
  );

  const coordinator = useMemo(() => {
    const ref: { current: FileSaveCoordinator | null } = { current: null };
    return {
      change: (contents: string) => ref.current?.change(contents),
      setup: () => {
        const instance = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          canPersist: () => client !== undefined,
          onPendingChange: (value) => {
            pending.current = value;
            if (!value) setStatus('saved');
          },
          persist: (contents) => write(contents, false),
          onConfirmed: () => undefined,
        });
        ref.current = instance;
        return () => {
          ref.current = null;
          instance.dispose();
        };
      },
    };
  }, [client, write]);
  // StrictMode replays effect setup; the replay gets a fresh coordinator instead of reusing a disposed one.
  const setupCoordinator = coordinator.setup;
  useEffect(setupCoordinator, [setupCoordinator]);

  const handleEditChange = useCallback(
    ({ file }: EditorChangeEvent<'file', undefined, undefined>) => {
      // Adopting an external change reports it as an edit; it is already on disk.
      if (file.contents === externalFile.contents && editedContents === null) return;
      setEditedContents(file.contents);
      coordinator.change(file.contents);
    },
    [coordinator, editedContents, externalFile.contents],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-editor">
      {conflict !== undefined && (
        <SurfaceNotice>
          <span className="flex items-center gap-2">
            <span className="flex-1">{t('files.conflict')}</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                pending.current = false;
                setConflict(undefined);
                setStatus('idle');
                setEditedContents(null);
                onReload();
              }}
            >
              {t('files.reload')}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                void write(conflict, true).then((ok) => {
                  if (ok) {
                    pending.current = false;
                    setStatus('saved');
                  }
                })
              }
            >
              {t('files.overwrite')}
            </Button>
          </span>
        </SurfaceNotice>
      )}
      <div className="min-h-0 flex-1 bg-(--code-background)">
        <EditProvider createEditor={createFileEditor}>
          <Virtualizer
            key={`${name}:${theme}`}
            className="h-full min-h-0 overflow-auto"
            config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
          >
            <File
              file={externalFile}
              edit={editable}
              onEditChange={handleEditChange}
              options={{
                disableFileHeader: true,
                overflow: wrap ? 'wrap' : 'scroll',
                theme: resolveDiffThemeName(theme),
                themeType: theme,
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
                onPostRender: (_container, instance, phase) => onPostRender(instance.file, phase),
              }}
              className="min-h-full"
            />
          </Virtualizer>
        </EditProvider>
      </div>
    </div>
  );
}
