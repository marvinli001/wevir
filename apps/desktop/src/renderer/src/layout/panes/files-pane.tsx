// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/FileBrowserPanel.tsx、useDirectoryEntries.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，不用 @pierre/trees；树与搜索结果自己画，去掉拖到输入框与右键菜单。
//
// “文件”窗格（U32，0.22.0，desktop-layout.md §19，desktop-tokens.md §36）：会话目录的文件树，照 T3 Code 的 FileBrowserPanel
// （MIT，ec1313c）——按需逐层读目录（`workspace.listDir`），顶上一行是按名字搜（`workspace.files`）与刷新；点文件在“文件预览”
// 里打开，被 .gitignore 忽略的项淡一些。没有会话时是工作区的根目录。

import type { SessionId, WorkspaceEntry } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  type LucideIcon,
  RotateCw,
  Search,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { splitPath } from '@/changes/changes-model';
import { IconButton } from '@/components/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  type FileScope,
  scopeKey,
  useDirectory,
  useFileSearch,
  useFilesSupported,
} from '@/files/files-data';
import { openFile } from '@/files/files-store';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import { usePanes } from '../pane-controller';
import type { PaneContext } from '../pane-registry';

/** 每个目录范围展开了哪些文件夹（本次运行内）。 */
const expandedStore = createStore<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

/** 窗格的目录范围：会话的目录，没有会话时是工作区的根目录。 */
export function useFileScope(context: PaneContext): FileScope | undefined {
  const { entry, sessionId } = context;
  return useMemo(() => {
    if (!entry) return undefined;
    const session =
      sessionId === undefined
        ? undefined
        : entry.sessions.find((candidate) => candidate.id === sessionId);
    return {
      workspaceId: entry.workspace.id,
      ...(session && { sessionId: session.id as SessionId }),
      root: session?.cwd ?? entry.workspace.rootPath,
    };
  }, [entry, sessionId]);
}

/** 会话状态变了（回合结束）时重读：文件多半刚改过。 */
export function useScopeRefreshKey(context: PaneContext): string {
  const session = context.entry?.sessions.find((candidate) => candidate.id === context.sessionId);
  return session?.state ?? '';
}

export function FilesPane({ context }: { context: PaneContext }) {
  const supported = useFilesSupported();
  const scope = useFileScope(context);
  const refreshKey = useScopeRefreshKey(context);
  if (!scope) return <Note>{t('files.noProject')}</Note>;
  if (!supported) return <Note>{t('files.unsupported')}</Note>;
  return <FileBrowser scope={scope} refreshKey={refreshKey} />;
}

export function Note({
  children,
  icon: Icon = FolderTree,
}: {
  children: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function FileBrowser({ scope, refreshKey }: { scope: FileScope; refreshKey: string }) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(0);
  const key = `${refreshKey}:${manual}`;
  const searching = query.trim() !== '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-muted/60 px-2 text-muted-foreground focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring-soft">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder={t('files.search')}
            aria-label={t('files.search')}
            data-testid="files-search"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              aria-label={t('settings.searchClear')}
              onClick={() => setQuery('')}
              className="flex size-4 items-center justify-center rounded-full outline-none hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </label>
        <IconButton label={t('files.refresh')} onClick={() => setManual((value) => value + 1)}>
          <RotateCw />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1" role="tree" aria-label={t('pane.kind.files')}>
          {searching ? (
            <SearchResults scope={scope} query={query} />
          ) : (
            <DirectoryChildren scope={scope} path="" depth={0} refreshKey={key} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function useExpanded(scope: FileScope) {
  const all = expandedStore.use();
  const keyOfScope = scopeKey(scope);
  const expanded = all.get(keyOfScope) ?? new Set<string>();
  const toggle = (path: string) =>
    expandedStore.set((current) => {
      const next = new Set(current.get(keyOfScope));
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return new Map(current).set(keyOfScope, next);
    });
  return { expanded, toggle };
}

/** 文件窗格里已经打开的文件（高亮那一行）。 */
function useOpenPaths(): ReadonlySet<string> {
  const groups = usePanes()?.scope.groups;
  return useMemo(() => {
    const paths = new Set<string>();
    for (const group of groups ?? []) {
      for (const tab of group.tabs) {
        if (tab.kind === 'file' && tab.params?.path !== undefined) paths.add(tab.params.path);
      }
    }
    return paths;
  }, [groups]);
}

function DirectoryChildren({
  scope,
  path,
  depth,
  refreshKey,
}: {
  scope: FileScope;
  path: string;
  depth: number;
  refreshKey: string;
}) {
  const listing = useDirectory(scope, path, true, refreshKey);
  const { expanded, toggle } = useExpanded(scope);
  const panes = usePanes();
  const open = useOpenPaths();
  if (!listing.value) {
    return listing.error !== undefined ? (
      <Row depth={depth} muted>
        {t('files.failed', { error: listing.error })}
      </Row>
    ) : depth === 0 ? (
      <Row depth={depth} muted>
        {t('common.loading')}
      </Row>
    ) : null;
  }
  if (listing.value.length === 0 && depth === 0) {
    return (
      <Row depth={0} muted>
        {t('files.empty')}
      </Row>
    );
  }
  return listing.value.map((entry) => {
    const isOpen = expanded.has(entry.path);
    return entry.kind === 'directory' ? (
      <div key={entry.path} role="none">
        <EntryRow
          entry={entry}
          depth={depth}
          expanded={isOpen}
          onClick={() => toggle(entry.path)}
        />
        {isOpen && (
          <DirectoryChildren
            scope={scope}
            path={entry.path}
            depth={depth + 1}
            refreshKey={refreshKey}
          />
        )}
      </div>
    ) : (
      <EntryRow
        key={entry.path}
        entry={entry}
        depth={depth}
        active={open.has(entry.path)}
        onClick={() => openFile(panes, entry.path)}
      />
    );
  });
}

function SearchResults({ scope, query }: { scope: FileScope; query: string }) {
  const search = useFileSearch(scope, query, { limit: 100 });
  const panes = usePanes();
  const { toggle, expanded } = useExpanded(scope);
  const open = useOpenPaths();
  if (search.pending && search.entries.length === 0) {
    return (
      <Row depth={0} muted>
        {t('common.loading')}
      </Row>
    );
  }
  if (search.entries.length === 0) {
    return (
      <Row depth={0} muted>
        {t('files.noMatches')}
      </Row>
    );
  }
  return search.entries.map((entry) => (
    <EntryRow
      key={entry.path}
      entry={entry}
      depth={0}
      showDirectory
      active={entry.kind === 'file' && open.has(entry.path)}
      onClick={() => {
        if (entry.kind === 'file') openFile(panes, entry.path);
        else if (!expanded.has(entry.path)) toggle(entry.path);
      }}
    />
  ));
}

const INDENT_PX = 12;

function Row({ depth, muted, children }: { depth: number; muted?: boolean; children: ReactNode }) {
  return (
    <p
      className={cn('truncate py-1 pr-3 text-sm', muted && 'text-muted-foreground')}
      style={{ paddingLeft: 12 + depth * INDENT_PX }}
    >
      {children}
    </p>
  );
}

const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|bash|css|scss|html|vue|svelte|sql|lua|dart|zig)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const JSON_FILE = /\.(json|jsonc|json5|ya?ml|toml)$/i;
const TEXT = /\.(md|mdx|markdown|txt|rst|log)$/i;

export function fileIcon(path: string): LucideIcon {
  if (CODE.test(path)) return FileCode;
  if (IMAGE.test(path)) return FileImage;
  if (JSON_FILE.test(path)) return FileJson;
  if (TEXT.test(path)) return FileText;
  return File;
}

function EntryRow({
  entry,
  depth,
  expanded,
  active,
  showDirectory,
  onClick,
}: {
  entry: WorkspaceEntry;
  depth: number;
  expanded?: boolean;
  active?: boolean;
  showDirectory?: boolean;
  onClick: () => void;
}) {
  const { name, dir } = splitPath(entry.path);
  const directory = entry.kind === 'directory';
  const Icon = directory ? (expanded ? FolderOpen : Folder) : fileIcon(entry.path);
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={directory ? expanded === true : undefined}
      aria-selected={active === true}
      data-file-entry={entry.path}
      onClick={onClick}
      title={entry.path}
      className={cn(
        'flex h-6.5 w-full items-center gap-1.5 pr-3 text-left text-sm outline-none transition-colors duration-100 hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset',
        active && 'bg-selected ring-1 ring-selected-border ring-inset text-accent-foreground',
        entry.ignored && 'opacity-55',
      )}
      style={{ paddingLeft: 8 + depth * INDENT_PX }}
    >
      {directory ? (
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{name}</span>
      {showDirectory && dir && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dir}</span>
      )}
    </button>
  );
}
