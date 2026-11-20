import { Tab, TabList } from '@/components/ui/tabs';
// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/FileBrowserPanel.tsx、useDirectoryEntries.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，不用 @pierre/trees；树与搜索结果自己画，去掉拖到输入框与右键菜单。
//
// “文件”窗格（U32，0.22.0，desktop-layout.md §19，desktop-tokens.md §36）：会话目录的文件树，照 T3 Code 的 FileBrowserPanel
// （MIT，ec1313c）——按需逐层读目录（`workspace.listDir`），树顶上按名字搜（`workspace.files`）；被 .gitignore 忽略的项淡一些。
// 没有会话时是工作区的根目录。2026-11-20 起照 Claude Code 桌面端的 Files 面板：顶上一行是打开的文件（files-tabs.ts，单击树里的
// 文件是预览标签页）与折叠、文件树开关、更多；下面是当前文件的预览（同“文件预览”窗格，file-pane.tsx）与文件树，树可以收起、
// 放在左侧或右侧。更多菜单里是转到文件、文件树、预览标签页与源码的显示设置。

import type { SessionId, WorkspaceEntry } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ChevronRight,
  ChevronsDownUp,
  Ellipsis,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  type LucideIcon,
  Search,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { splitPath } from '@/changes/changes-model';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  FileLinkMenuProvider,
  useAttachToSession,
  useFileContextMenu,
} from '@/files/file-link-menu';
import {
  type FileScope,
  scopeKey,
  useDirectory,
  useFileSearch,
  useFilesSupported,
} from '@/files/files-data';
import { type FilePrefs, filePrefs, TAB_SIZES, type TabSize } from '@/files/files-store';
import {
  closePath,
  NO_OPEN_FILES,
  type OpenFiles,
  openPath,
  pinAll,
  pinPath,
  type TreePosition,
  treeSide,
} from '@/files/files-tabs';
import { t } from '@/i18n';
import { formatShortcut, matchesShortcut, type Shortcut } from '@/lib/shortcuts';
import { createStore } from '@/lib/store';
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
      ...(session?.origin?.kind === 'synced' && { readOnly: true }),
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
  // 文件与文件夹的右键菜单（files/file-link-menu.tsx）：“添加到对话”放进这个会话的输入框，没有会话时没有。
  const attach = useAttachToSession(
    context.entry?.sessions.find((candidate) => candidate.id === context.sessionId),
  );
  if (!scope) return <Note>{t('files.noProject')}</Note>;
  if (!supported) return <Note>{t('files.unsupported')}</Note>;
  if (scope.readOnly) return <Note>{t('files.unavailable')}</Note>;
  return (
    <FileLinkMenuProvider cwd={scope.root} attach={attach}>
      <FileBrowser scope={scope} refreshKey={refreshKey} context={context} />
    </FileLinkMenuProvider>
  );
}

/** 窗格的空状态：图标与一行字；有 `hint` 时那行字是标题，下面一行小字说从哪里开始（照 Claude Code 桌面端）。 */
export function Note({
  children,
  icon: Icon = FolderTree,
  hint,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  hint?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      {hint === undefined ? (
        <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
      ) : (
        <div className="flex max-w-64 flex-col gap-0.5">
          <p className="text-sm text-foreground">{children}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      )}
    </div>
  );
}

const FilePane = lazy(() => import('./file-pane').then((module) => ({ default: module.FilePane })));

/** 窗格里的快捷键（焦点在窗格里时），照 Claude Code 桌面端。 */
const FILES_SHORTCUTS = {
  goToFile: { code: 'KeyP', mod: true },
  toggleTree: { code: 'KeyY', mod: true, shift: true },
} as const satisfies Record<string, Shortcut>;

/** 每个目录范围打开的文件（本次运行内）。 */
const openFilesStore = createStore<ReadonlyMap<string, OpenFiles>>(new Map());

function useOpenFiles(scope: FileScope) {
  const all = openFilesStore.use();
  const key = scopeKey(scope);
  const state = all.get(key) ?? NO_OPEN_FILES;
  const update = useCallback(
    (change: (current: OpenFiles) => OpenFiles) =>
      openFilesStore.set((current) => {
        const before = current.get(key) ?? NO_OPEN_FILES;
        const after = change(before);
        return after === before ? current : new Map(current).set(key, after);
      }),
    [key],
  );
  return { state, update };
}

/** 文件树在哪一侧：自动时看窗格在窗口的哪半边。 */
function useTreeSide(
  root: RefObject<HTMLElement | null>,
  position: TreePosition,
): 'left' | 'right' {
  const [side, setSide] = useState<'left' | 'right'>('right');
  useEffect(() => {
    const element = root.current;
    if (position !== 'auto' || !element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSide(treeSide('auto', rect, window.innerWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [root, position]);
  return position === 'auto' ? side : position;
}

function FileBrowser({
  scope,
  refreshKey,
  context,
}: {
  scope: FileScope;
  refreshKey: string;
  context: PaneContext;
}) {
  const prefs = filePrefs.use();
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(0);
  const key = `${refreshKey}:${manual}`;
  const searching = query.trim() !== '';
  const { state: open, update } = useOpenFiles(scope);
  const { expanded, collapseAll } = useExpanded(scope);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const side = useTreeSide(root, prefs.treePosition);

  const openEntry = (path: string, pin: boolean) =>
    update((current) => openPath(current, path, { preview: prefs.previewTabs, pin }));
  const setPref = <K extends keyof FilePrefs>(name: K, value: FilePrefs[K]) =>
    filePrefs.set((current) => ({ ...current, [name]: value }));
  const toggleTree = () => setPref('tree', !prefs.tree);
  const goToFile = () => {
    if (!prefs.tree) setPref('tree', true);
    requestAnimationFrame(() => search.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (matchesShortcut(event, FILES_SHORTCUTS.goToFile)) {
      event.preventDefault();
      goToFile();
    } else if (matchesShortcut(event, FILES_SHORTCUTS.toggleTree)) {
      event.preventDefault();
      toggleTree();
    }
  };

  const active = open.active;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 窗格里的快捷键；每一项都在更多菜单或按钮里。
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={onKeyDown}
      data-testid="files-pane"
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border pr-2 pl-1.5">
        <OpenFileTabs
          open={open}
          onSelect={(path) => update((current) => ({ ...current, active: path }))}
          onPin={(path) => update((current) => pinPath(current, path))}
          onClose={(path) => update((current) => closePath(current, path))}
        />
        {prefs.tree && (
          <IconButton
            label={t('files.collapseAll')}
            disabled={expanded.size === 0}
            onClick={collapseAll}
            data-action="collapse-all"
          >
            <ChevronsDownUp />
          </IconButton>
        )}
        <IconButton
          label={t(prefs.tree ? 'files.hideTree' : 'files.showTree')}
          shortcut={formatShortcut(FILES_SHORTCUTS.toggleTree)}
          aria-pressed={prefs.tree}
          className={cn(prefs.tree && 'bg-accent')}
          onClick={toggleTree}
          data-action="toggle-tree"
        >
          <List />
        </IconButton>
        <FilesMenu
          prefs={prefs}
          setPref={setPref}
          canCollapse={expanded.size > 0}
          onCollapseAll={collapseAll}
          onGoToFile={goToFile}
          onToggleTree={toggleTree}
          onRefresh={() => setManual((value) => value + 1)}
          onPreviewTabs={(on) => {
            setPref('previewTabs', on);
            if (!on) update(pinAll);
          }}
        />
      </div>
      <div className={cn('flex min-h-0 flex-1', side === 'left' && 'flex-row-reverse')}>
        <div className="relative min-h-0 min-w-0 flex-1">
          {active !== undefined ? (
            <Suspense fallback={null}>
              <FilePane
                tab={{ id: `files:${active}`, kind: 'file', params: { path: active } }}
                context={context}
                embedded
              />
            </Suspense>
          ) : (
            <Note
              icon={Folder}
              hint={t(prefs.tree ? 'files.openEmptyHint' : 'files.treeHiddenHint')}
            >
              {t('files.openEmpty')}
            </Note>
          )}
        </div>
        {prefs.tree && (
          <aside
            className={cn(
              'flex w-[clamp(10rem,38%,17rem)] shrink-0 flex-col border-border',
              side === 'right' ? 'border-l' : 'border-r',
            )}
            data-testid="files-tree"
            data-side={side}
          >
            <div className="shrink-0 p-1.5">
              <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg bg-muted/60 px-2 text-muted-foreground focus-within:bg-muted focus-within:focus-ring">
                <Search aria-hidden className="size-3.5 shrink-0" />
                <input
                  ref={search}
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
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="pb-1" role="tree" aria-label={t('pane.kind.files')}>
                {searching ? (
                  <SearchResults scope={scope} query={query} active={active} onOpen={openEntry} />
                ) : (
                  <DirectoryChildren
                    scope={scope}
                    path=""
                    depth={0}
                    refreshKey={key}
                    active={active}
                    onOpen={openEntry}
                  />
                )}
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 打开的文件：预览中的那个是斜体；双击固定，中键或叉关掉。 */
function OpenFileTabs({
  open,
  onSelect,
  onPin,
  onClose,
}: {
  open: OpenFiles;
  onSelect: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open.active === undefined) return;
    strip.current
      ?.querySelector<HTMLElement>(`[data-file-tab="${CSS.escape(open.active)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open.active]);
  return (
    <TabList
      value={open.active ?? null}
      onValueChange={(path) => onSelect(path)}
      ref={strip}
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      aria-label={t('pane.kind.files')}
    >
      {open.paths.map((path) => {
        const selected = path === open.active;
        const preview = path === open.preview;
        const Icon = fileIcon(path);
        return (
          <div
            key={path}
            data-file-tab={path}
            className={cn(
              'group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-xs',
              selected ? 'text-foreground' : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            <Tab
              value={path}
              title={path}
              onDoubleClick={() => onPin(path)}
              onAuxClick={(event) => event.button === 1 && onClose(path)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 outline-none',
                preview && 'italic',
              )}
              data-testid="file-tab"
              data-preview={preview || undefined}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{splitPath(path).name}</span>
            </Tab>
            <button
              type="button"
              aria-label={t('browser.closeTab')}
              onClick={() => onClose(path)}
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded outline-none hover:bg-background focus-visible:opacity-100',
                selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </TabList>
  );
}

function FilesMenu({
  prefs,
  setPref,
  canCollapse,
  onCollapseAll,
  onGoToFile,
  onToggleTree,
  onRefresh,
  onPreviewTabs,
}: {
  prefs: FilePrefs;
  setPref: <K extends keyof FilePrefs>(name: K, value: FilePrefs[K]) => void;
  canCollapse: boolean;
  onCollapseAll: () => void;
  onGoToFile: () => void;
  onToggleTree: () => void;
  onRefresh: () => void;
  onPreviewTabs: (on: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label={t('files.more')} data-action="files-more">
            <Ellipsis />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={onGoToFile}>
          {t('files.goToFile')}
          <DropdownMenuShortcut>{formatShortcut(FILES_SHORTCUTS.goToFile)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRefresh}>{t('files.refresh')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onToggleTree}>
          {t(prefs.tree ? 'files.hideTree' : 'files.showTree')}
          <DropdownMenuShortcut>{formatShortcut(FILES_SHORTCUTS.toggleTree)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t('files.treePosition')}
            <span className="ml-auto text-xs text-muted-foreground">
              {t(`files.treePosition.${prefs.treePosition}`)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.treePosition}
              onValueChange={(value) => setPref('treePosition', value as TreePosition)}
            >
              {(['auto', 'left', 'right'] as const).map((position) => (
                <DropdownMenuRadioItem key={position} value={position} closeOnClick>
                  {t(`files.treePosition.${position}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={!canCollapse || !prefs.tree} onClick={onCollapseAll}>
          {t('files.collapseAll')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          closeOnClick
          checked={prefs.previewTabs}
          onCheckedChange={onPreviewTabs}
        >
          {t('files.previewTabs')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          closeOnClick
          checked={prefs.wrap}
          onCheckedChange={(checked) => setPref('wrap', checked)}
        >
          {t('changes.wrap')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          closeOnClick
          checked={prefs.scrollPastEnd}
          onCheckedChange={(checked) => setPref('scrollPastEnd', checked)}
        >
          {t('files.scrollPastEnd')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t('files.tabSize')}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {prefs.tabSize}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={prefs.tabSize}
              onValueChange={(value) => setPref('tabSize', value as TabSize)}
            >
              {TAB_SIZES.map((size) => (
                <DropdownMenuRadioItem key={size} value={size} closeOnClick>
                  {size}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const collapseAll = () =>
    expandedStore.set((current) =>
      current.get(keyOfScope)?.size ? new Map(current).set(keyOfScope, new Set()) : current,
    );
  return { expanded, toggle, collapseAll };
}

interface TreeProps {
  /** 当前预览的文件（高亮那一行）。 */
  active: string | undefined;
  /** 单击是预览，双击固定。 */
  onOpen: (path: string, pin: boolean) => void;
}

function DirectoryChildren({
  scope,
  path,
  depth,
  refreshKey,
  active,
  onOpen,
}: TreeProps & {
  scope: FileScope;
  path: string;
  depth: number;
  refreshKey: string;
}) {
  const listing = useDirectory(scope, path, true, refreshKey);
  const { expanded, toggle } = useExpanded(scope);
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
            active={active}
            onOpen={onOpen}
          />
        )}
      </div>
    ) : (
      <EntryRow
        key={entry.path}
        entry={entry}
        depth={depth}
        active={entry.path === active}
        onClick={() => onOpen(entry.path, false)}
        onDoubleClick={() => onOpen(entry.path, true)}
      />
    );
  });
}

function SearchResults({
  scope,
  query,
  active,
  onOpen,
}: TreeProps & { scope: FileScope; query: string }) {
  const search = useFileSearch(scope, query, { limit: 100 });
  const { toggle, expanded } = useExpanded(scope);
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
      active={entry.kind === 'file' && entry.path === active}
      onClick={() => {
        if (entry.kind === 'file') onOpen(entry.path, false);
        else if (!expanded.has(entry.path)) toggle(entry.path);
      }}
      onDoubleClick={entry.kind === 'file' ? () => onOpen(entry.path, true) : undefined}
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
  onDoubleClick,
}: {
  entry: WorkspaceEntry;
  depth: number;
  expanded?: boolean;
  active?: boolean;
  showDirectory?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const { name, dir } = splitPath(entry.path);
  const directory = entry.kind === 'directory';
  const Icon = directory ? (expanded ? FolderOpen : Folder) : fileIcon(entry.path);
  const onContextMenu = useFileContextMenu(entry.path);
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={directory ? expanded === true : undefined}
      aria-selected={active === true}
      data-file-entry={entry.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={entry.path}
      className={cn(
        'flex h-6.5 w-full items-center gap-1.5 pr-3 text-left text-sm outline-none transition-colors duration-100 hover:bg-accent/70 focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset',
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
