// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/DiffPanel.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：数据换成 Wevir 的协议（workspace.diff / workspace.diffFile / session.checkpoints）；文件头由这里画（文件名与目录
// 分开），不用 Pierre 的；去掉 T3 的比较对象选择、忽略空白、文件树、diff 批注、在编辑器中打开与分批加载；大 diff 默认
// 折叠与省略文件的列表是 Wevir 的；界面换成 Wevir 的组件与文案。
//
// “变更”窗格（0.20.0，desktop-layout.md §18，desktop-tokens.md §33）：当前会话目录的 diff。顶上一行是范围（未提交、本分支、
// 最近一回合、“回合”子菜单里的第 N 回合）、+N −M 与刷新、全部展开 / 收起、统一 / 并排、自动换行；下面是 Pierre 的虚拟化
// CodeView，每个文件一个可折叠的头（文件名、目录、增删数），大 diff 默认折叠，“N 行未修改”可以点开。

import {
  type CodeViewDiffItem,
  type CodeViewItem,
  type FileDiffMetadata,
  setDiffsText,
} from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { DiffFile, SessionId, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitCompare,
  RotateCw,
  Rows3,
  WrapText,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  sourceKey,
  useCheckpoints,
  useDiffSupported,
  useWorkspaceDiff,
} from '@/changes/changes-data';
import {
  areAllCollapsed,
  type ChangesScope,
  defaultCollapsed,
  resolveSource,
  sameScope,
  scopeLabel,
  splitPath,
  type TurnOption,
  toggleAll,
  turnLabel,
  turnNumbers,
  turnOptions,
} from '@/changes/changes-model';
import { changesPrefs, selectScope, useChangesSelection } from '@/changes/changes-store';
import { createDiffFileContentsLoader } from '@/changes/diff-file-contents';
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  fnv1a32,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from '@/changes/diff-rendering';
import { PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { DIFF_HEADER_HEIGHT, StyledDiffCodeView } from '@/changes/styled-code-view';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranscript } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { useTheme } from '@/theme/theme';
import type { PaneContext } from '../pane-registry';

// Pierre 分隔条上的文字（补丁加的 setDiffsText，pnpm-workspace.yaml）。
setDiffsText({
  unmodifiedLines: (count) => t('changes.unmodified', { count }),
  moreContext: t('changes.moreContext'),
  expandAll: t('changes.expandAll'),
});

export function ChangesPane({ context }: { context: PaneContext }) {
  const supported = useDiffSupported();
  const { entry, sessionId } = context;
  if (!entry || sessionId === undefined) return <Note>{t('changes.noSession')}</Note>;
  if (!supported) return <Note>{t('changes.unsupported')}</Note>;
  return <SessionChanges workspaceId={entry.workspace.id} sessionId={sessionId as SessionId} />;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <GitCompare aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

interface FileEntry {
  fileDiff: FileDiffMetadata;
  fileKey: string;
  fileVersion: number;
  path: string;
}

const fileEntryCache = new WeakMap<FileDiffMetadata, FileEntry>();

function fileEntry(fileDiff: FileDiffMetadata): FileEntry {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
    path: resolveFileDiffPath(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

interface CollapsedState {
  scopeKey: string | undefined;
  keys: ReadonlySet<string>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

function SessionChanges({
  workspaceId,
  sessionId,
}: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
}) {
  const { client } = useHostConnection();
  const { resolved: theme } = useTheme();
  const prefs = changesPrefs.use();
  const selection = useChangesSelection(sessionId);
  const transcript = useTranscript(sessionId)?.transcript;
  const sessionState = transcript?.state;
  const activeTurnId = transcript?.activeTurnId;
  // 回合开始、结束时重读：改动多半刚发生。
  const refreshKey = `${sessionState ?? ''}:${activeTurnId ?? ''}`;
  const checkpoints = useCheckpoints(sessionId, refreshKey);
  const messages = transcript?.messages;
  const numbers = useMemo(() => turnNumbers(messages ?? []), [messages]);
  const turns = useMemo(() => turnOptions(checkpoints ?? [], numbers), [checkpoints, numbers]);
  const source = resolveSource(selection.scope, turns);
  const sourceTurn =
    source?.kind === 'turn' ? turns.find((turn) => turn.turnId === source.turnId) : undefined;
  const running = sessionState === 'running' || sessionState === 'awaiting_approval';
  const live = source?.kind === 'turn' ? sourceTurn?.live === true && running : running;
  const diff = useWorkspaceDiff(workspaceId, sessionId, source, { refreshKey, live });
  const result = diff.result;
  const scopeKey = source === undefined ? undefined : sourceKey(sessionId, source);

  const renderable = useMemo(
    () => getRenderablePatch(result?.patch, `changes:${theme}`),
    [result?.patch, theme],
  );
  const entries = useMemo(
    () => (renderable?.kind === 'files' ? renderable.files.map(fileEntry) : []),
    [renderable],
  );
  const defaults = useMemo(
    () =>
      defaultCollapsed(
        entries.map(({ fileKey, fileDiff }) => {
          const stat = getDiffLineStat([fileDiff]);
          return { key: fileKey, lines: stat.additions + stat.deletions };
        }),
      ),
    [entries],
  );
  const [collapsedState, setCollapsedState] = useState<CollapsedState>({
    scopeKey: undefined,
    keys: NO_KEYS,
  });
  const collapsed = collapsedState.scopeKey === scopeKey ? collapsedState.keys : defaults.keys;
  const fileKeys = useMemo(() => entries.map((entry) => entry.fileKey), [entries]);
  const allCollapsed = areAllCollapsed(fileKeys, collapsed);
  // 全部展开 / 收起时重挂 CodeView，免得虚拟列表一次改太多项的高度（T3 的 codeViewRevision）。
  const [revision, setRevision] = useState(0);

  const updateCollapsed = useCallback(
    (update: (keys: ReadonlySet<string>) => ReadonlySet<string>) => {
      setCollapsedState((current) => {
        const keys = current.scopeKey === scopeKey ? current.keys : defaults.keys;
        return { scopeKey, keys: update(keys) };
      });
    },
    [scopeKey, defaults],
  );
  const toggleFile = useCallback(
    (fileKey: string) =>
      updateCollapsed((keys) => {
        const next = new Set(keys);
        if (next.has(fileKey)) next.delete(fileKey);
        else next.add(fileKey);
        return next;
      }),
    [updateCollapsed],
  );
  const toggleAllFiles = () => {
    setRevision((value) => value + 1);
    updateCollapsed((keys) => toggleAll(fileKeys, keys));
  };

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      entries.map(({ fileDiff, fileKey, fileVersion }) => {
        const folded = collapsed.has(fileKey);
        return {
          id: fileKey,
          type: 'diff',
          fileDiff,
          collapsed: folded,
          version: fnv1a32(`${fileVersion}:${folded ? '1' : '0'}`),
        };
      }),
    [entries, collapsed],
  );

  // 从入口带来的文件：展开它、滚过去。
  const [codeView, setCodeView] = useState<CodeViewHandle<undefined, undefined> | null>(null);
  const revealed = useRef<number>(undefined);
  const reveal = selection.reveal;
  useEffect(() => {
    if (!reveal || revealed.current === reveal.id) return;
    const target = entries.find((entry) => entry.path === reveal.path);
    if (!target || !codeView?.getInstance()) return;
    revealed.current = reveal.id;
    updateCollapsed((keys) => {
      if (!keys.has(target.fileKey)) return keys;
      const next = new Set(keys);
      next.delete(target.fileKey);
      return next;
    });
    codeView.scrollTo({ type: 'item', id: target.fileKey, align: 'start' });
  }, [reveal, entries, codeView, updateCollapsed]);

  const loadDiffFiles = useMemo(() => {
    if (!client || result?.base === undefined || scopeKey === undefined) return undefined;
    return createDiffFileContentsLoader(client, {
      workspaceId,
      sessionId,
      base: result.base,
      head: result.head,
      cacheKey: `${scopeKey}:${fnv1a32(result.patch ?? '')}`,
    });
  }, [client, workspaceId, sessionId, result, scopeKey]);

  const omitted = useMemo(
    () => (result?.files ?? []).filter((file) => file.omitted !== undefined),
    [result?.files],
  );
  const renderFooter = useCallback(
    () => (omitted.length > 0 ? <OmittedFiles files={omitted} /> : null),
    [omitted],
  );
  const renderHeader = useCallback(
    (item: CodeViewItem<undefined>) =>
      item.type === 'diff' ? (
        <FileHeader item={item} collapsed={item.collapsed === true} onToggle={toggleFile} />
      ) : null,
    [toggleFile],
  );

  const stats = {
    added: result?.added ?? 0,
    removed: result?.removed ?? 0,
  };
  const hasFiles = (result?.fileCount ?? 0) > 0;

  let body: ReactNode;
  if (selection.scope.kind === 'latest' && checkpoints !== undefined && turns.length === 0) {
    body = <Note>{t('changes.noTurns')}</Note>;
  } else if (diff.error !== undefined && !result) {
    body = <Note>{t('changes.failed', { error: diff.error })}</Note>;
  } else if (!result) {
    body = <Note>{t('common.loading')}</Note>;
  } else if (!result.repo) {
    body = <Note>{t('changes.notRepo')}</Note>;
  } else if (result.unavailable !== undefined) {
    body = <Note>{t('changes.noCheckpoint')}</Note>;
  } else if (!hasFiles) {
    body = <Note>{t('changes.empty')}</Note>;
  } else if (renderable?.kind === 'raw') {
    body = (
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-soft-foreground">
        {renderable.text}
      </pre>
    );
  } else {
    body = (
      <StyledDiffCodeView
        key={`${scopeKey}:${revision}`}
        viewerRef={setCodeView}
        className="h-full min-h-0 overflow-auto"
        items={items}
        renderCustomHeader={renderHeader}
        renderCodeViewFooter={renderFooter}
        options={{
          diffStyle: prefs.split ? 'split' : 'unified',
          lineDiffType: 'none',
          overflow: prefs.wrap ? 'wrap' : 'scroll',
          theme: resolveDiffThemeName(theme),
          themeType: theme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          stickyHeaders: true,
          hunkSeparators: 'line-info',
          ...(loadDiffFiles && { loadDiffFiles }),
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <ScopeMenu
          sessionId={sessionId}
          scope={selection.scope}
          turns={turns}
          label={scopeLabel(selection.scope, turns)}
        />
        {selection.scope.kind === 'branch' && result?.baseRef && (
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            data-testid="changes-base"
          >
            {t('changes.against', { base: result.baseRef })}
          </span>
        )}
        <div className="min-w-1 flex-1" />
        {hasFiles && (
          <span
            className="mr-1 shrink-0 font-mono text-xs tabular-nums"
            data-testid="changes-stats"
          >
            <span className="text-success">+{stats.added.toLocaleString('en-US')}</span>{' '}
            <span className="text-destructive">−{stats.removed.toLocaleString('en-US')}</span>
          </span>
        )}
        <IconButton
          label={t('changes.refresh')}
          onClick={diff.refresh}
          disabled={source === undefined}
        >
          <RotateCw className={cn(diff.loading && 'animate-spin')} />
        </IconButton>
        {entries.length > 0 && (
          <IconButton
            label={allCollapsed ? t('changes.expandAllFiles') : t('changes.collapseAllFiles')}
            onClick={toggleAllFiles}
          >
            {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
          </IconButton>
        )}
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <IconButton
          label={t('changes.unified')}
          aria-pressed={!prefs.split}
          className={cn(!prefs.split && 'bg-accent')}
          onClick={() => changesPrefs.set((current) => ({ ...current, split: false }))}
        >
          <Rows3 />
        </IconButton>
        <IconButton
          label={t('changes.split')}
          aria-pressed={prefs.split}
          className={cn(prefs.split && 'bg-accent')}
          onClick={() => changesPrefs.set((current) => ({ ...current, split: true }))}
        >
          <Columns2 />
        </IconButton>
        <IconButton
          label={t('changes.wrap')}
          aria-pressed={prefs.wrap}
          className={cn(prefs.wrap && 'bg-accent')}
          onClick={() => changesPrefs.set((current) => ({ ...current, wrap: !current.wrap }))}
        >
          <WrapText />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

function ScopeMenu({
  sessionId,
  scope,
  turns,
  label,
}: {
  sessionId: SessionId;
  scope: ChangesScope;
  turns: readonly TurnOption[];
  label: string;
}) {
  const top = scope.kind === 'turn' && turns[0]?.turnId === scope.turnId ? 'latest' : scope.kind;
  const turnValue =
    scope.kind === 'turn' ? scope.turnId : scope.kind === 'latest' ? turns[0]?.turnId : '';
  const choose = (next: ChangesScope) => {
    if (!sameScope(next, scope)) selectScope(sessionId, next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-48 gap-1 px-2 font-medium"
            data-testid="changes-scope"
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={top}
          onValueChange={(value) => {
            if (value === 'uncommitted' || value === 'branch' || value === 'latest') {
              choose({ kind: value });
            }
          }}
        >
          <DropdownMenuRadioItem value="uncommitted" closeOnClick>
            {t('changes.scope.uncommitted')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="branch" closeOnClick>
            {t('changes.scope.branch')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="latest" closeOnClick disabled={turns.length === 0}>
            {t('changes.scope.latest')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={turns.length === 0}>
            {t('changes.scope.turns')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            <DropdownMenuRadioGroup
              value={turnValue}
              onValueChange={(value) => {
                const turn = turns.find((option) => option.turnId === value);
                if (turn) choose({ kind: 'turn', turnId: turn.turnId });
              }}
            >
              {turns.map((turn) => (
                <DropdownMenuRadioItem key={turn.turnId} value={turn.turnId} closeOnClick>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{turnLabel(turn.number)}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {turn.live ? (
                        t('changes.turnLive')
                      ) : (
                        <>
                          <span className="text-success">+{turn.added ?? 0}</span>{' '}
                          <span className="text-destructive">−{turn.removed ?? 0}</span>
                        </>
                      )}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const STATUS_LABELS: Partial<
  Record<
    FileDiffMetadata['type'],
    'changes.status.added' | 'changes.status.deleted' | 'changes.status.renamed'
  >
> = {
  new: 'changes.status.added',
  deleted: 'changes.status.deleted',
  'rename-pure': 'changes.status.renamed',
  'rename-changed': 'changes.status.renamed',
};

/** 文件头：折叠箭头、文件名、目录、新增 / 删除 / 重命名、增删行数；整行点一下折叠或展开。高度与 DIFF_HEADER_HEIGHT 一致。 */
function FileHeader({
  item,
  collapsed,
  onToggle,
}: {
  item: CodeViewDiffItem;
  collapsed: boolean;
  onToggle: (fileKey: string) => void;
}) {
  const { fileDiff } = item;
  const path = resolveFileDiffPath(fileDiff);
  const { name, dir } = splitPath(path);
  const stat = getDiffLineStat([fileDiff]);
  const status = STATUS_LABELS[fileDiff.type];
  const previous =
    fileDiff.prevName !== undefined && fileDiff.prevName !== path ? fileDiff.prevName : undefined;
  return (
    <button
      type="button"
      style={{ height: DIFF_HEADER_HEIGHT }}
      aria-expanded={!collapsed}
      aria-label={
        collapsed ? t('changes.expandFile', { path }) : t('changes.collapseFile', { path })
      }
      title={previous ? `${previous} → ${path}` : path}
      onClick={() => onToggle(item.id)}
      className="flex w-full min-w-0 items-center gap-1.5 px-2 text-left font-sans text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      data-changes-file={path}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 transition-transform duration-200 ease-smooth',
          !collapsed && 'rotate-90',
          getDiffCollapseIconClassName(fileDiff),
        )}
      />
      <span className="shrink-0 font-medium text-foreground">{name}</span>
      {dir !== '' && (
        <span dir="rtl" className="min-w-0 truncate text-left text-muted-foreground">
          <bdi dir="ltr">{dir}</bdi>
        </span>
      )}
      {status && <span className="shrink-0 text-muted-foreground">· {t(status)}</span>}
      <span className="ml-auto shrink-0 pl-2 font-mono tabular-nums">
        <span className="text-success">+{stat.additions}</span>{' '}
        <span className="text-destructive">−{stat.deletions}</span>
      </span>
    </button>
  );
}

const OMITTED_LABELS: Record<string, 'changes.omitted.tooLarge' | 'changes.omitted.overLimit'> = {
  too_large: 'changes.omitted.tooLarge',
  over_limit: 'changes.omitted.overLimit',
};

/** 列表最后：diff 太大没给的文件，只有路径、原因与行数。 */
function OmittedFiles({ files }: { files: readonly DiffFile[] }) {
  return (
    <div className="px-3 py-3 text-xs" data-testid="changes-omitted">
      <p className="mb-1.5 text-muted-foreground">
        {t('changes.omitted.title', { count: files.length })}
      </p>
      <ul>
        {files.map((file) => (
          <li key={file.path} className="flex h-6 min-w-0 items-center gap-2">
            <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono">
              <bdi dir="ltr">{file.path}</bdi>
            </span>
            <span className="shrink-0 text-muted-foreground">
              {t(OMITTED_LABELS[file.omitted ?? ''] ?? 'changes.omitted.overLimit')}
            </span>
            {file.added !== undefined && file.removed !== undefined && (
              <span className="shrink-0 font-mono tabular-nums">
                <span className="text-success">+{file.added}</span>{' '}
                <span className="text-destructive">−{file.removed}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
