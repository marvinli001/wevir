// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/DiffPanel.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：数据换成 Wevir 的协议（workspace.diff / workspace.diffFile / session.checkpoints）；文件头由这里画（文件名与目录
// 分开），不用 Pierre 的；去掉 T3 的比较对象选择、忽略空白、文件树、在编辑器中打开与分批加载；大 diff 默认折叠与省略文件的
// 列表是 Wevir 的；界面换成 Wevir 的组件与文案。行级批注（0.67.0）照 T3 的 AnnotatableCodeView 接回来，批注存在 Host（review.*）；
// 底部的提交区（0.67.0，git.*）是 Wevir 的。
//
// “变更”窗格（0.20.0，desktop-layout.md §18，desktop-tokens.md §33）：当前会话目录的 diff。顶上一行是范围（未提交、本分支、
// 最近一回合、“回合”子菜单里的第 N 回合）、+N −M 与刷新、全部展开 / 收起、统一 / 并排、自动换行；下面是 Pierre 的虚拟化
// CodeView，每个文件一个可折叠的头（文件名、目录、增删数），大 diff 默认折叠，“N 行未修改”可以点开。Host 有 `review_comments`
// 时行号旁的“+”与拖选写批注，顶栏的“批注”列出没发的、发给一个会话。Host 有 `git_commit` 时范围多一项“已暂存”（没有全文展开、
// 不能写批注），底部是提交区（changes/commit-panel.tsx）。

import {
  type CodeViewDiffItem,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
  setDiffsText,
} from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { DiffFile, ReviewComment, Session, SessionId, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Eye,
  GitBranch,
  GitCompare,
  MessageSquare,
  MoveRight,
  RotateCw,
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
  recordedChangePreviews,
  resolveSource,
  sameScope,
  scopeLabel,
  splitPath,
  type TurnOption,
  toggleAll,
  turnChangeStats,
  turnLabel,
  turnNumbers,
  turnOptions,
} from '@/changes/changes-model';
import { changesPrefs, selectScope, useChangesSelection } from '@/changes/changes-store';
import { type StageState, stageState } from '@/changes/commit-model';
import { CommitPanel } from '@/changes/commit-panel';
import { DiffCommentDraft, DiffCommentNote } from '@/changes/diff-comment';
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
import { useGitStatus, useGitSupported } from '@/changes/git-data';
import { JumpToFile } from '@/changes/jump-to-file';
import { useReviewComments, useReviewSupported } from '@/changes/review-data';
import {
  type DiffView,
  pierreSide,
  placeComment,
  type ReviewRange,
  toReviewRange,
} from '@/changes/review-model';
import { commentState, findingTag, lineLabel, ReviewPanel } from '@/changes/review-panel';
import { DIFF_HEADER_HEIGHT, StyledDiffCodeView } from '@/changes/styled-code-view';
import { IconButton } from '@/components/icon-button';
import { ScrollFade } from '@/components/scroll-fade';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  FileLinkMenuProvider,
  useAttachToSession,
  useFileContextMenu,
} from '@/files/file-link-menu';
import { openFile } from '@/files/files-store';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { FilePreviewBlock } from '@/session/file-preview';
import { foldTurn } from '@/session/turn-model';
import { useTheme } from '@/theme/theme';
import { usePanes } from '../pane-controller';
import type { PaneContext } from '../pane-registry';
import { fileIcon } from './files-pane';

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
  return (
    <SessionChanges
      workspaceId={entry.workspace.id}
      sessionId={sessionId as SessionId}
      sessions={entry.sessions}
    />
  );
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

/** 画在 diff 里的一组批注（同一侧同一行结尾的放在一起）：已存的与正在写的草稿。 */
type ReviewEntry =
  | { kind: 'draft' }
  | { kind: 'comment'; comment: ReviewComment; range: ReviewRange };
interface ReviewGroup {
  entries: ReviewEntry[];
}
type ReviewAnnotation = DiffLineAnnotation<ReviewGroup>;

interface Draft {
  fileKey: string;
  path: string;
  previousPath?: string;
  range: ReviewRange;
}

function addAnnotation(
  annotations: ReviewAnnotation[],
  range: ReviewRange,
  entry: ReviewEntry,
): ReviewAnnotation[] {
  const side = pierreSide(range.side);
  const index = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.endLine,
  );
  if (index < 0) {
    return [...annotations, { side, lineNumber: range.endLine, metadata: { entries: [entry] } }];
  }
  return annotations.map((annotation, position) =>
    position === index
      ? { ...annotation, metadata: { entries: [...annotation.metadata.entries, entry] } }
      : annotation,
  );
}

function SessionChanges({
  workspaceId,
  sessionId,
  sessions,
}: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  sessions: readonly Session[];
}) {
  const { client } = useHostConnection();
  const { resolved: theme } = useTheme();
  const prefs = changesPrefs.use();
  const stored = useChangesSelection(sessionId);
  const gitSupported = useGitSupported();
  // 旧 Host 不认 `staged`：退回“未提交”。
  const selection =
    stored.scope.kind === 'staged' && !gitSupported
      ? { ...stored, scope: { kind: 'uncommitted' as const } }
      : stored;
  const transcript = useTranscript(sessionId)?.transcript;
  // 文件头的右键菜单（files/file-link-menu.tsx）：路径相对会话目录，“添加到对话”放进这个会话的输入框。
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const attach = useAttachToSession(session);
  const sessionState = transcript?.state;
  const activeTurnId = transcript?.activeTurnId;
  // 回合开始、结束时重读：改动多半刚发生。
  const refreshKey = `${sessionState ?? ''}:${activeTurnId ?? ''}`;
  const checkpoints = useCheckpoints(sessionId, refreshKey);
  // 暂存与提交（0.67.0）：暂存状态变了（索引或 HEAD）时 diff 一起重读。
  const git = useGitStatus(workspaceId, sessionId, refreshKey);
  const gitKey = `${git.status?.head ?? ''}:${git.status?.index ?? ''}`;
  const messages = transcript?.messages;
  const numbers = useMemo(() => turnNumbers(messages ?? []), [messages]);
  const turns = useMemo(
    () => turnOptions(checkpoints ?? [], numbers, messages),
    [checkpoints, numbers, messages],
  );
  const source = resolveSource(selection.scope, turns);
  const sourceTurn =
    source?.kind === 'turn' ? turns.find((turn) => turn.turnId === source.turnId) : undefined;
  const running = sessionState === 'running' || sessionState === 'awaiting_approval';
  const live = source?.kind === 'turn' ? sourceTurn?.live === true && running : running;
  const diff = useWorkspaceDiff(workspaceId, sessionId, source, {
    refreshKey: `${refreshKey}:${gitKey}`,
    live,
  });
  const staged = source?.kind === 'staged';
  // 文件头的勾选框（Host 有 `git_commit`、看的是未提交或已暂存时）：勾上暂存整个文件，取消勾选取消暂存。
  const panes = usePanes();
  const staging = gitSupported && (source?.kind === 'uncommitted' || staged);
  const gitFiles = useMemo(
    () => new Map((git.status?.files ?? []).map((file) => [file.path, file])),
    [git.status],
  );
  const result = diff.result;
  const selectedTurnId = source?.kind === 'turn' ? source.turnId : undefined;
  const turnMessages = useMemo(
    () =>
      selectedTurnId === undefined
        ? []
        : (messages?.filter(
            (message) => message.role !== 'system' && message.turnId === selectedTurnId,
          ) ?? []),
    [messages, selectedTurnId],
  );
  const recorded = useMemo(
    () =>
      result !== undefined && !(result.fileCount ?? 0) && selectedTurnId !== undefined
        ? recordedChangePreviews(turnMessages)
        : [],
    [result, selectedTurnId, turnMessages],
  );
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

  // 行级批注（0.67.0）：Host 有 review_comments、这段 diff 读到了基线时才能写。
  const reviewSupported = useReviewSupported();
  const review = useReviewComments(
    workspaceId,
    sessionId,
    `${scopeKey}:${fnv1a32(result?.patch ?? '')}`,
  );
  const view = useMemo<DiffView>(() => ({ base: result?.base, head: result?.head }), [result]);
  const commentable =
    reviewSupported &&
    source !== undefined &&
    !staged &&
    result?.base !== undefined &&
    recorded.length === 0;
  const [draft, setDraft] = useState<Draft>();
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const placed = useMemo(() => {
    const byPath = new Map<string, { comment: ReviewComment; range: ReviewRange }[]>();
    if (!reviewSupported) return byPath;
    for (const comment of review.comments) {
      const range = placeComment(comment, view);
      if (!range) continue;
      byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), { comment, range }]);
    }
    return byPath;
  }, [reviewSupported, review.comments, view]);

  const items = useMemo<CodeViewDiffItem<ReviewGroup>[]>(
    () =>
      entries.map(({ fileDiff, fileKey, fileVersion, path }) => {
        const folded = collapsed.has(fileKey);
        let annotations: ReviewAnnotation[] = [];
        for (const { comment, range } of placed.get(path) ?? []) {
          annotations = addAnnotation(annotations, range, { kind: 'comment', comment, range });
        }
        if (draft?.fileKey === fileKey) {
          annotations = addAnnotation(annotations, draft.range, { kind: 'draft' });
        }
        const marks = annotations
          .flatMap((annotation) =>
            annotation.metadata.entries.map((entry) =>
              entry.kind === 'draft'
                ? `draft:${annotation.lineNumber}`
                : `${entry.comment.id}:${annotation.lineNumber}:${entry.comment.body}`,
            ),
          )
          .join(':');
        // 文件头跟着暂存状态与批注数变：放进版本，虚拟列表才会重画它。
        const stageMark = staging ? (stageState(gitFiles.get(path)) ?? '') : '';
        return {
          id: fileKey,
          type: 'diff',
          fileDiff,
          collapsed: folded,
          annotations,
          version: fnv1a32(`${fileVersion}:${folded ? '1' : '0'}:${stageMark}:${marks}`),
        };
      }),
    [entries, collapsed, placed, draft, staging, gitFiles],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange | null, context: { item: CodeViewItem<ReviewGroup> }) => {
      const item = context.item;
      if (!range || item.type !== 'diff') return;
      const path = resolveFileDiffPath(item.fileDiff);
      const previous = item.fileDiff.prevName;
      setDraft({
        fileKey: item.id,
        path,
        ...(previous !== undefined && previous !== path && { previousPath: previous }),
        range: toReviewRange(item.fileDiff, range),
      });
    },
    [],
  );
  const saveDraft = useCallback(
    async (body: string) => {
      if (!draft || source === undefined || result?.base === undefined) return;
      await review.add({
        source,
        base: result.base,
        ...(result.head !== undefined && { head: result.head }),
        path: draft.path,
        ...(draft.previousPath !== undefined && { previousPath: draft.previousPath }),
        side: draft.range.side,
        startLine: draft.range.startLine,
        endLine: draft.range.endLine,
        body,
      });
      setDraft(undefined);
      setSelectedLines(null);
    },
    [draft, source, result, review],
  );
  const cancelDraft = useCallback(() => {
    setDraft(undefined);
    setSelectedLines(null);
  }, []);
  const removeComment = review.remove;
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewGroup>) => (
      <div className="flex flex-col py-0.5">
        {annotation.metadata.entries.map((entry) =>
          entry.kind === 'draft' ? (
            <DiffCommentDraft
              key="draft"
              rangeLabel={draft ? lineLabel(draft.range.startLine, draft.range.endLine) : ''}
              onCancel={cancelDraft}
              onSave={saveDraft}
            />
          ) : (
            <DiffCommentNote
              key={entry.comment.id}
              text={entry.comment.body}
              {...(entry.comment.finding !== undefined && {
                title: entry.comment.finding.title,
                tag: findingTag(entry.comment) ?? '',
              })}
              rangeLabel={lineLabel(entry.range.startLine, entry.range.endLine)}
              stateLabel={commentState(entry.comment)}
              outdated={entry.comment.anchor.state === 'outdated'}
              onDelete={() => void removeComment([entry.comment.id]).catch(() => {})}
            />
          ),
        )}
      </div>
    ),
    [draft, cancelDraft, saveDraft, removeComment],
  );

  // 从入口带来的文件：展开它、滚过去；带了行（审查发现，0.83.0）时再滚到新的一侧的那一行（不在 diff 里时停在文件头）。
  const [codeView, setCodeView] = useState<CodeViewHandle<ReviewGroup, undefined> | null>(null);
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
    const line = reveal.line;
    if (line === undefined) return;
    const frame = window.requestAnimationFrame(() =>
      codeView.scrollTo({
        type: 'line',
        id: target.fileKey,
        lineNumber: line,
        side: 'additions',
        align: 'center',
      }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [reveal, entries, codeView, updateCollapsed]);

  const loadDiffFiles = useMemo(() => {
    // 暂存的 diff 新的一侧是索引，没有全文可读。
    if (!client || staged || result?.base === undefined || scopeKey === undefined) return undefined;
    return createDiffFileContentsLoader(client, {
      workspaceId,
      sessionId,
      base: result.base,
      head: result.head,
      cacheKey: `${scopeKey}:${fnv1a32(result.patch ?? '')}`,
    });
  }, [client, workspaceId, sessionId, result, scopeKey, staged]);

  const omitted = useMemo(
    () => (result?.files ?? []).filter((file) => file.omitted !== undefined),
    [result?.files],
  );
  const renderFooter = useCallback(
    () => (omitted.length > 0 ? <OmittedFiles files={omitted} /> : null),
    [omitted],
  );
  const { stage, unstage, busy: gitBusy } = git;
  const toggleStage = useCallback(
    (path: string, state: StageState) => {
      if (state === 'conflicted') return;
      void (state === 'staged' ? unstage([path]) : stage([path]));
    },
    [stage, unstage],
  );
  const renderHeader = useCallback(
    (item: CodeViewItem<ReviewGroup>) => {
      if (item.type !== 'diff') return null;
      const path = resolveFileDiffPath(item.fileDiff);
      return (
        <FileHeader
          item={item}
          collapsed={item.collapsed === true}
          onToggle={toggleFile}
          stage={staging ? stageState(gitFiles.get(path)) : undefined}
          stageBusy={gitBusy}
          onStage={toggleStage}
          comments={placed.get(path)?.length ?? 0}
          onOpen={item.fileDiff.type === 'deleted' ? undefined : () => openFile(panes, path)}
        />
      );
    },
    [toggleFile, staging, gitFiles, gitBusy, toggleStage, placed, panes],
  );

  const stats =
    selectedTurnId !== undefined
      ? turnChangeStats(result, foldTurn(turnMessages, false, false).changes)
      : { added: result?.added ?? 0, removed: result?.removed ?? 0 };
  const hasFiles = (result?.fileCount ?? 0) > 0 || recorded.length > 0;

  let body: ReactNode;
  if (selection.scope.kind === 'latest' && checkpoints !== undefined && turns.length === 0) {
    body = <Note>{t('changes.noTurns')}</Note>;
  } else if (recorded.length > 0) {
    body = (
      <ScrollFade className="h-full overflow-auto p-3">
        <div className="space-y-2" data-turn-change-previews>
          {recorded.map(({ key, preview }) => (
            <FilePreviewBlock key={key} preview={preview} root={session?.cwd} />
          ))}
        </div>
      </ScrollFade>
    );
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
      <StyledDiffCodeView<ReviewGroup>
        key={`${scopeKey}:${revision}`}
        viewerRef={setCodeView}
        className="h-full min-h-0 overflow-auto"
        items={items}
        renderCustomHeader={renderHeader}
        renderCodeViewFooter={renderFooter}
        selectedLines={selectedLines}
        onSelectedLinesChange={setSelectedLines}
        renderAnnotation={renderAnnotation}
        options={{
          enableGutterUtility: commentable && draft === undefined,
          enableLineSelection: commentable && draft === undefined,
          onGutterUtilityClick: beginComment,
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

  const jumpPaths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const branchBase =
    selection.scope.kind === 'branch' && result?.baseRef !== undefined ? result.baseRef : undefined;

  return (
    <FileLinkMenuProvider cwd={session?.cwd ?? ''} attach={attach}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1.5 px-2">
          <ScopeMenu
            sessionId={sessionId}
            scope={selection.scope}
            turns={turns}
            label={scopeLabel(selection.scope, turns)}
            staged={gitSupported}
            stats={hasFiles ? stats : undefined}
          />
          {branchBase !== undefined && (
            <span
              className="flex h-7 min-w-0 items-center gap-1 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
              title={t('changes.against', { base: branchBase })}
              data-testid="changes-base"
            >
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              {git.status?.branch !== undefined && (
                <>
                  <span className="min-w-0 truncate font-mono text-foreground">
                    {git.status.branch}
                  </span>
                  <MoveRight aria-hidden className="size-3 shrink-0" />
                </>
              )}
              <span className="min-w-0 truncate font-mono">{branchBase}</span>
            </span>
          )}
          <div className="min-w-1 flex-1" />
          {reviewSupported && (
            <ReviewPanel
              review={review}
              sessions={sessions}
              sessionId={sessionId}
              onReveal={(path) => selectScope(sessionId, selection.scope, path)}
            />
          )}
          <div
            className="flex shrink-0 items-center gap-px rounded-full border border-border bg-card p-px shadow-xs [&_[data-slot=button]]:rounded-full"
            data-testid="changes-tools"
          >
            <JumpToFile
              paths={jumpPaths}
              onJump={(path) => selectScope(sessionId, selection.scope, path)}
            />
            <IconButton
              label={t('changes.refresh')}
              size="icon-xs"
              onClick={() => {
                diff.refresh();
                git.refresh();
              }}
              disabled={source === undefined}
            >
              <RotateCw className={cn(diff.loading && 'animate-spin')} />
            </IconButton>
            <IconButton
              label={t('changes.wrap')}
              size="icon-xs"
              disabled={recorded.length > 0}
              aria-pressed={prefs.wrap}
              className={cn(prefs.wrap && 'bg-accent text-foreground')}
              onClick={() => changesPrefs.set((current) => ({ ...current, wrap: !current.wrap }))}
            >
              <WrapText />
            </IconButton>
            <IconButton
              label={t('changes.split')}
              size="icon-xs"
              disabled={recorded.length > 0}
              aria-pressed={prefs.split}
              className={cn(prefs.split && 'bg-accent text-foreground')}
              onClick={() => changesPrefs.set((current) => ({ ...current, split: !current.split }))}
            >
              <Columns2 />
            </IconButton>
            <IconButton
              label={allCollapsed ? t('changes.expandAllFiles') : t('changes.collapseAllFiles')}
              size="icon-xs"
              disabled={entries.length === 0}
              onClick={toggleAllFiles}
            >
              {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            </IconButton>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 border-t border-border">{body}</div>
        {gitSupported && (
          <CommitPanel
            git={git}
            open={prefs.commit}
            onOpenChange={(open) => changesPrefs.set((current) => ({ ...current, commit: open }))}
            onReveal={(path, inIndex) =>
              selectScope(sessionId, { kind: inIndex ? 'staged' : 'uncommitted' }, path)
            }
          />
        )}
      </div>
    </FileLinkMenuProvider>
  );
}

function Stats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums" data-testid="changes-stats">
      <span className="text-success">+{added.toLocaleString('en-US')}</span>{' '}
      <span className="text-destructive">−{removed.toLocaleString('en-US')}</span>
    </span>
  );
}

function ScopeMenu({
  sessionId,
  scope,
  turns,
  label,
  staged,
  stats,
}: {
  sessionId: SessionId;
  scope: ChangesScope;
  turns: readonly TurnOption[];
  label: string;
  /** Host 有 `git_commit`：多一项“已暂存”。 */
  staged: boolean;
  /** 有改动时按钮里写 +N −M（照 Codex）。 */
  stats: { added: number; removed: number } | undefined;
}) {
  const top = scope.kind === 'turn' && turns[0]?.turnId === scope.turnId ? 'latest' : scope.kind;
  const turnValue =
    scope.kind === 'turn' ? scope.turnId : scope.kind === 'latest' ? turns[0]?.turnId : '';
  const choose = (next: ChangesScope) => {
    if (!sameScope(next, scope)) selectScope(sessionId, next);
  };
  const pick = (value: unknown) => {
    if (value === 'uncommitted' || value === 'staged' || value === 'branch' || value === 'latest') {
      choose({ kind: value });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-w-0 max-w-64 shrink gap-1.5 rounded-full px-2.5 shadow-xs"
            data-testid="changes-scope"
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        {stats && <Stats added={stats.added} removed={stats.removed} />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup value={top} onValueChange={pick}>
          <DropdownMenuRadioItem value="latest" closeOnClick disabled={turns.length === 0}>
            {t('changes.scope.latest')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={turns.length === 0}>
            {t('changes.scope.turns')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <ScrollFade className="max-h-80 overflow-y-auto [--scroll-fade-size:16px]">
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
            </ScrollFade>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={top} onValueChange={pick}>
          <DropdownMenuRadioItem value="uncommitted" closeOnClick>
            {t('changes.scope.uncommitted')}
          </DropdownMenuRadioItem>
          {staged && (
            <DropdownMenuRadioItem value="staged" closeOnClick>
              {t('changes.scope.staged')}
            </DropdownMenuRadioItem>
          )}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={top} onValueChange={pick}>
          <DropdownMenuRadioItem value="branch" closeOnClick>
            {t('changes.scope.branch')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
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

/**
 * 文件头（照 Codex）：暂存勾选框（可选）、文件图标（新增成功色、删除失败色）、目录与文件名、⌄、新增 / 已删除 / 重命名，右边
 * 批注数、+a −r 与悬停时的“打开文件”。点文件名一侧折叠或展开。高度与 DIFF_HEADER_HEIGHT 一致。
 */
function FileHeader({
  item,
  collapsed,
  onToggle,
  stage,
  stageBusy,
  onStage,
  comments,
  onOpen,
}: {
  item: CodeViewDiffItem<ReviewGroup>;
  collapsed: boolean;
  onToggle: (fileKey: string) => void;
  /** 没有时不画勾选框（不在未提交 / 已暂存，或 Host 没有 `git_commit`）。 */
  stage: StageState | undefined;
  stageBusy: boolean;
  onStage: (path: string, state: StageState) => void;
  comments: number;
  onOpen: (() => void) | undefined;
}) {
  const { fileDiff } = item;
  const path = resolveFileDiffPath(fileDiff);
  const { name, dir } = splitPath(path);
  const stat = getDiffLineStat([fileDiff]);
  const status = STATUS_LABELS[fileDiff.type];
  const previous =
    fileDiff.prevName !== undefined && fileDiff.prevName !== path ? fileDiff.prevName : undefined;
  const Icon = fileIcon(path);
  const onContextMenu = useFileContextMenu(fileDiff.type === 'deleted' ? undefined : path);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 右键菜单只是鼠标的便捷操作，菜单里的事都有别的入口。
    <div
      onContextMenu={onContextMenu}
      style={{ height: DIFF_HEADER_HEIGHT }}
      className="group/header flex w-full min-w-0 items-center gap-2 px-3 font-sans text-[13px] transition-colors hover:bg-muted/40"
      data-changes-file={path}
    >
      {stage !== undefined && (
        <Checkbox
          size="sm"
          checked={stage === 'staged'}
          indeterminate={stage === 'partial'}
          disabled={stageBusy || stage === 'conflicted'}
          onCheckedChange={() => onStage(path, stage)}
          aria-label={
            stage === 'staged' ? t('commit.unstageFile', { path }) : t('commit.stageFile', { path })
          }
          data-action={stage === 'staged' ? 'git-unstage' : 'git-stage'}
          data-stage={stage}
        />
      )}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={
          collapsed ? t('changes.expandFile', { path }) : t('changes.collapseFile', { path })
        }
        title={previous ? `${previous} → ${path}` : path}
        onClick={() => onToggle(item.id)}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset"
      >
        <Icon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground',
            getDiffCollapseIconClassName(fileDiff),
          )}
        />
        <span className="flex min-w-0 items-baseline">
          {dir !== '' && (
            <span dir="rtl" className="min-w-0 truncate text-left text-muted-foreground">
              <bdi dir="ltr">{dir}/</bdi>
            </span>
          )}
          <span className="shrink-0 text-foreground">{name}</span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-smooth',
            collapsed && '-rotate-90',
          )}
        />
        {status && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] leading-[18px] text-muted-foreground">
            {t(status)}
          </span>
        )}
        {stage === 'conflicted' && (
          <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 text-[11px] leading-[18px] text-destructive">
            {t('commit.conflicted')}
          </span>
        )}
      </button>
      {comments > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
          title={t('comments.title')}
        >
          <MessageSquare aria-hidden className="size-3" />
          {comments}
        </span>
      )}
      <span className="shrink-0 font-mono text-xs tabular-nums">
        <span className="text-success">+{stat.additions}</span>{' '}
        <span className="text-destructive">−{stat.deletions}</span>
      </span>
      {onOpen && (
        <IconButton
          label={t('changes.openFile')}
          size="icon-xs"
          className="-mr-1 text-muted-foreground opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
          onClick={onOpen}
        >
          <Eye />
        </IconButton>
      )}
    </div>
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
