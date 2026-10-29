// 文件窗格与 @ 提及的数据（0.22.0，host-api.md §3.1 的 `workspace.files` / `listDir` / `readFile`；0.32.0 起还有
// `workspace.fileUrl` 的流式地址与 `workspace.writeFile` 的写回）。Host 每次现读；目录与
// 文件内容在窗格显示时读，之后窗口获得焦点、会话的回合结束（`refreshKey` 变了）、点“刷新”时重读。最近一次读到的留在内存里
// （最近用过的一批，有上限），换回来时先显示它。

import { hostSupports } from '@wevir/client-sdk';
import type {
  SessionId,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceFileUrlResult,
  WorkspaceId,
  WorkspaceOfficePdfResult,
  WorkspaceReadFileResult,
  WorkspaceWriteFileResult,
} from '@wevir/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describe, type HostConnectionView, useHostConnection } from '@/host/host-connection';
import { LruMap } from '@/lib/lru';

/** 读哪个目录：会话的目录（环境会话的 worktree），没有会话时是工作区的根目录。 */
export interface FileScope {
  workspaceId: WorkspaceId;
  sessionId?: SessionId;
  /** 这个目录的绝对路径（给外部编辑器与访达）。 */
  root: string;
}

export function scopeKey(scope: Pick<FileScope, 'workspaceId' | 'sessionId'>): string {
  return `${scope.workspaceId}:${scope.sessionId ?? ''}`;
}

function scopeParams(scope: FileScope): { workspaceId: WorkspaceId; sessionId?: SessionId } {
  return {
    workspaceId: scope.workspaceId,
    ...(scope.sessionId !== undefined && { sessionId: scope.sessionId }),
  };
}

/** Host 声明了 `workspace_files`（0.22.0）。 */
export function useFilesSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'workspace_files');
}

interface Loaded<T> {
  key?: string;
  value?: T;
  error?: string;
}

/** 读一个值：`key` 变了换成缓存里的旧值再读，焦点回来、`refreshKey` 变了、`refresh()` 时重读。 */
function useHostRead<T>(
  key: string | undefined,
  cache: Map<string, T>,
  read: (() => Promise<T>) | undefined,
  refreshKey: unknown,
): { value: T | undefined; error: string | undefined; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<Loaded<T>>(() =>
    key === undefined ? {} : { key, value: cache.get(key) },
  );
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read 每次渲染都是新的，按 key 判断；refreshKey 与 manual 只触发重读。
  useEffect(() => {
    if (key === undefined) return;
    setState((current) => (current.key === key ? current : { key, value: cache.get(key) }));
    if (!read) return;
    let stopped = false;
    const run = () => {
      setLoading(true);
      read()
        .then((value) => {
          cache.set(key, value);
          if (!stopped) setState({ key, value });
        })
        .catch((error: unknown) => {
          if (!stopped) setState((current) => ({ ...current, key, error: describe(error) }));
        })
        .finally(() => {
          if (!stopped) setLoading(false);
        });
    };
    run();
    window.addEventListener('focus', run);
    return () => {
      stopped = true;
      window.removeEventListener('focus', run);
    };
  }, [key, read === undefined, refreshKey, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);
  const current = state.key === key ? state : {};
  return { value: current.value, error: current.error, loading, refresh };
}

/** 留在内存里的文件内容最多这么多字符（文本与图片的 base64 合计）。 */
const FILES_MAX_CHARS = 32 * 1024 * 1024;

const directories = new LruMap<string, readonly WorkspaceEntry[]>(500);
const files = new LruMap<string, WorkspaceReadFileResult>(64, {
  maxWeight: FILES_MAX_CHARS,
  weigh: (file) => (file.text?.length ?? 0) + (file.image?.data.length ?? 0),
});

/** 一个目录的直接子项；`enabled` 为 false（折叠着）时不读。 */
export function useDirectory(
  scope: FileScope,
  path: string,
  enabled: boolean,
  refreshKey: unknown,
) {
  const { client } = useHostConnection();
  const supported = useFilesSupported();
  const key = enabled ? `${scopeKey(scope)}:${path}` : undefined;
  const read =
    client && supported && enabled
      ? () =>
          client
            .request('workspace.listDir', { ...scopeParams(scope), path })
            .then((result) => result.entries as readonly WorkspaceEntry[])
      : undefined;
  return useHostRead(key, directories, read, refreshKey);
}

/** 一个文件的内容；`enabled` 为 false（窗格从流式地址加载它）时不读。 */
export function useFileContents(
  scope: FileScope,
  path: string,
  refreshKey: unknown,
  enabled = true,
) {
  const { client } = useHostConnection();
  const supported = useFilesSupported();
  const key = enabled ? `${scopeKey(scope)}:${path}` : undefined;
  const read =
    client && supported && enabled
      ? () => client.request('workspace.readFile', { ...scopeParams(scope), path })
      : undefined;
  return useHostRead(key, files, read, refreshKey);
}

/** 写回成功后更新缓存，焦点回来重读之前也显示新的内容。 */
export function rememberWrittenFile(
  scope: FileScope,
  path: string,
  text: string,
  written: WorkspaceWriteFileResult,
): void {
  files.set(`${scopeKey(scope)}:${path}`, {
    path,
    text,
    ...(written.size !== undefined && { size: written.size }),
    ...(written.mtimeMs !== undefined && { mtimeMs: written.mtimeMs }),
  });
}

/** Host 声明了 `file_preview`（0.32.0）：有流式地址与写回。 */
export function hasFilePreview(view: HostConnectionView): boolean {
  return view.status === 'connected' && hostSupports(view.hello.features, 'file_preview');
}

export function useFilePreviewSupported(): boolean {
  return hasFilePreview(useHostConnection().view);
}

const fileUrls = new LruMap<string, WorkspaceFileUrlResult>(500);

/**
 * 一个文件的流式地址（`workspace.fileUrl`）；`enabled` 为 false 或 Host 没有 `file_preview` 时不读。地址后面加上修改时间
 * （`?v=`，Host 不看查询串），文件变了 `<img>`、`<video>`、`<iframe>` 才会重新加载。
 */
export function useFileUrl(scope: FileScope, path: string, refreshKey: unknown, enabled: boolean) {
  const { client } = useHostConnection();
  const supported = useFilePreviewSupported();
  const key = enabled ? `${scopeKey(scope)}:${path}` : undefined;
  const read =
    client && supported && enabled
      ? () => client.request('workspace.fileUrl', { ...scopeParams(scope), path })
      : undefined;
  const state = useHostRead(key, fileUrls, read, refreshKey);
  const result = state.value;
  const src =
    result?.url === undefined ? undefined : `${result.url}?v=${Math.round(result.mtimeMs ?? 0)}`;
  return { ...state, src };
}

/** Host 声明了 `office_preview`（0.138.0）：办公文档能转成 PDF。 */
export function hasOfficePreview(view: HostConnectionView): boolean {
  return view.status === 'connected' && hostSupports(view.hello.features, 'office_preview');
}

export function useOfficePreviewSupported(): boolean {
  return hasOfficePreview(useHostConnection().view);
}

const officePdfs = new LruMap<string, WorkspaceOfficePdfResult>(200);

/**
 * 办公文档转成的 PDF（`workspace.officePdf`，0.138.0）；`enabled` 为 false 或 Host 没有 `office_preview` 时不读。转换可能要几秒；
 * Host 按文件的修改时间缓存，重读同一版不再转换，地址也不变。
 */
export function useOfficePdf(
  scope: FileScope,
  path: string,
  refreshKey: unknown,
  enabled: boolean,
) {
  const { client } = useHostConnection();
  const supported = useOfficePreviewSupported();
  const key = enabled ? `${scopeKey(scope)}:${path}` : undefined;
  const read =
    client && supported && enabled
      ? () => client.request('workspace.officePdf', { ...scopeParams(scope), path })
      : undefined;
  return useHostRead(key, officePdfs, read, refreshKey);
}

/** 输入时等这么久再搜（T3 也是 120 ms）。 */
const SEARCH_DEBOUNCE_MS = 120;

export interface FileSearch {
  entries: readonly WorkspaceEntry[];
  loading: boolean;
  /** 查询还没有结果（第一次输入、换了范围）。 */
  pending: boolean;
}

/** 按名字找文件（@ 提及、文件窗格的搜索）；`query` 为 undefined 时不搜。 */
export function useFileSearch(
  scope: Pick<FileScope, 'workspaceId' | 'sessionId'> | undefined,
  query: string | undefined,
  options: { limit?: number; kind?: WorkspaceEntryKind } = {},
): FileSearch {
  const { client } = useHostConnection();
  const supported = useFilesSupported();
  const { limit = 40, kind } = options;
  const workspaceId = scope?.workspaceId;
  const sessionId = scope?.sessionId;
  const target = useMemo(
    () =>
      workspaceId !== undefined && query !== undefined
        ? {
            key: `${scopeKey({ workspaceId, sessionId })}:${kind ?? ''}:${limit}:${query}`,
            params: {
              workspaceId,
              ...(sessionId !== undefined && { sessionId }),
              query,
              limit,
              ...(kind !== undefined && { kind }),
            },
          }
        : undefined,
    [workspaceId, sessionId, query, limit, kind],
  );
  const [result, setResult] = useState<{ key: string; entries: readonly WorkspaceEntry[] }>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target || !client || !supported) return;
    let stopped = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      client
        .request('workspace.files', target.params)
        .then((value) => {
          if (!stopped) setResult({ key: target.key, entries: value.entries });
        })
        .catch(() => {
          if (!stopped) setResult({ key: target.key, entries: [] });
        })
        .finally(() => {
          if (!stopped) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [target, client, supported]);

  const fresh = result !== undefined && result.key === target?.key;
  return {
    entries: result?.entries ?? [],
    loading,
    pending: target !== undefined && !fresh,
  };
}
