// 会话全文搜索的浮窗（0.72.0）：⌘K 或左栏“搜索”打开。空查询时列最近的会话；输入后按 Host 的全文索引查所有项目（可收到当前
// 项目、按种类筛、含已归档），结果点开跳到会话里那一处（session/transcript-focus.ts）。索引没追上、短词只扫了最近的时，底部
// 写明范围，空结果不说成没有历史。

import { hostSupports } from '@wevir/client-sdk';
import type { SearchHit, SearchQueryResult, Session, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  FilePen,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  Search,
  SquareTerminal,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useMatches, useNavigate } from 'react-router';
import { useScrollFade } from '@/components/scroll-fade';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { focusTranscript } from '@/session/transcript-focus';
import {
  focusText,
  hitPath,
  KIND_FILTERS,
  type KindFilter,
  nextKind,
  partialResult,
  recentSessions,
  type SearchNotice,
  searchNotices,
  searchOpen,
  snippetSegments,
} from './search-model';

/** 输入停下多久再查。 */
const DEBOUNCE_MS = 150;
/** 一页几条。 */
const PAGE = 20;
/** 索引中时多久重查一次。 */
const INDEXING_REFRESH_MS = 1500;
/** 空查询时列几个最近的会话。 */
const RECENTS = 8;

const KIND_LABELS: Record<KindFilter, PlainMessageKey> = {
  all: 'search.kind.all',
  user_message: 'search.kind.user_message',
  assistant_message: 'search.kind.assistant_message',
  command: 'search.kind.command',
  file_change: 'search.kind.file_change',
};

const KIND_ICONS: Record<string, typeof Search> = {
  user_message: MessageCircle,
  assistant_message: MessageSquareText,
  command: SquareTerminal,
  file_change: FilePen,
};

export function SearchDialog() {
  const open = searchOpen.use();
  return (
    <Dialog open={open} onOpenChange={(next) => searchOpen.set(next)}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[640px]"
        data-search-dialog
      >
        <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
        {open && <SearchPanel />}
      </DialogContent>
    </Dialog>
  );
}

interface Results {
  /** 查询的键（词与筛选）：翻页时核对，换了查询的旧回复丢掉。 */
  key: string;
  hits: SearchHit[];
  next: number | null;
  last: Pick<SearchQueryResult, 'mode' | 'reason' | 'scan' | 'index'>;
}

type Row =
  | { kind: 'hit'; key: string; hit: SearchHit }
  | { kind: 'recent'; key: string; session: Session };

function SearchPanel() {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const navigate = useNavigate();
  const workspaceId = useMatches()
    .map((match) => match.params.workspaceId)
    .find(Boolean);
  const supported = client !== undefined && hostSupports(client.hello.features, 'session_search');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [projectOnly, setProjectOnly] = useState(false);
  const [archived, setArchived] = useState(false);
  const [results, setResults] = useState<Results>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useScrollFade(listRef);

  const trimmed = query.trim();
  const scopeWorkspace = projectOnly ? workspaceId : undefined;
  const key = JSON.stringify([trimmed, kind, scopeWorkspace ?? null, archived]);
  const keyRef = useRef(key);
  keyRef.current = key;

  const workspaces = data.status === 'ready' ? data.workspaces : [];
  const workspaceName = useMemo(
    () => new Map(workspaces.map((entry) => [entry.workspace.id, entry.workspace.displayName])),
    [workspaces],
  );

  const fetchPage = async (offset: number): Promise<void> => {
    if (!client || !supported || trimmed === '') return;
    const requestKey = key;
    setLoading(true);
    try {
      const result = await client.request('search.query', {
        query: trimmed,
        scope: {
          ...(kind !== 'all' && { kinds: [kind] }),
          ...(scopeWorkspace !== undefined && { workspaceIds: [scopeWorkspace as WorkspaceId] }),
          ...(archived && { includeArchived: true }),
        },
        limit: PAGE,
        offset,
      });
      if (keyRef.current !== requestKey) return;
      setError(undefined);
      setResults((current) => ({
        key: requestKey,
        hits:
          offset > 0 && current?.key === requestKey
            ? [...current.hits, ...result.hits]
            : result.hits,
        next: result.nextOffset,
        last: result,
      }));
    } catch (reason) {
      if (keyRef.current === requestKey) setError(describe(reason));
    } finally {
      if (keyRef.current === requestKey) setLoading(false);
    }
  };
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 查询的键变了才重查。
  useEffect(() => {
    setActive(0);
    if (trimmed === '') {
      setResults(undefined);
      setLoading(false);
      setError(undefined);
      return;
    }
    const timer = window.setTimeout(() => void fetchRef.current(0), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  // 索引还没追上时隔一会儿重查第一页，追上后说明消失、结果补全；翻过页就不重查，免得丢掉已载入的。
  useEffect(() => {
    if (results?.key !== key || results.last.index.state !== 'indexing') return;
    if (results.hits.length > PAGE) return;
    const timer = window.setTimeout(() => void fetchRef.current(0), INDEXING_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [results, key]);

  const rows: Row[] = useMemo(() => {
    if (trimmed === '') {
      const sessions = workspaces.flatMap((entry) => entry.sessions);
      return recentSessions(sessions, RECENTS).map((session) => ({
        kind: 'recent' as const,
        key: session.id,
        session: session as Session,
      }));
    }
    if (results?.key !== key) return [];
    return results.hits.map((hit) => ({
      kind: 'hit' as const,
      key: `${hit.sessionId}:${hit.seq}`,
      hit,
    }));
  }, [trimmed, workspaces, results, key]);
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  // 选中的一行留在视野里；选到最后几行时翻下一页。
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
    if (results?.next != null && !loading && current >= rows.length - 3 && trimmed !== '') {
      void fetchRef.current(results.next);
    }
  }, [current, rows.length, results?.next, loading, trimmed]);

  const openRow = (row: Row | undefined) => {
    if (!row) return;
    searchOpen.set(false);
    if (row.kind === 'recent') {
      navigate(paths.session(row.session.workspaceId, row.session.id));
      return;
    }
    const { hit } = row;
    navigate(hitPath(hit));
    const text = focusText(hit);
    focusTranscript({
      sessionId: hit.sessionId,
      seq: hit.seq,
      ...(text !== undefined && { text }),
    });
  };

  const onScroll = () => {
    const list = listRef.current;
    if (!list || results?.next == null || loading) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) {
      void fetchRef.current(results.next);
    }
  };

  const notices = results && results.key === key ? searchNotices(results.last) : [];
  const status: ReactNode =
    trimmed === '' ? null : error !== undefined ? (
      <p className="px-3 py-8 text-center text-sm text-destructive">
        {t('search.failed', { error })}
      </p>
    ) : results?.key === key && rows.length === 0 ? (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground" data-search-empty>
        {partialResult(results.last) ? t('search.emptyPartial') : t('search.empty')}
      </p>
    ) : results?.key !== key ? (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('search.loading')}</p>
    ) : null;

  return (
    <div className="flex max-h-[min(560px,76vh)] flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          // biome-ignore lint/a11y/noAutofocus: 浮窗打开就是为了输入。
          autoFocus
          value={query}
          disabled={!supported}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + rows.length) % Math.max(rows.length, 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              openRow(rows[current]);
            } else if (event.key === 'Tab') {
              event.preventDefault();
              setKind((value) => nextKind(value, event.shiftKey ? -1 : 1));
            }
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          aria-controls="session-search-results"
          className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          data-search-input
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5 pb-1">
        {KIND_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
            className={cn(
              'h-7 rounded-md px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:focus-field',
              kind === value && 'bg-accent text-foreground',
            )}
            data-search-kind={value}
          >
            {t(KIND_LABELS[value])}
          </button>
        ))}
        <span className="flex-1" />
        {workspaceId !== undefined && (
          <Toggle pressed={projectOnly} onChange={setProjectOnly} name="project">
            {t('search.scope.project')}
          </Toggle>
        )}
        <Toggle pressed={archived} onChange={setArchived} name="archived">
          {t('search.archived')}
        </Toggle>
      </div>
      <div
        ref={listRef}
        onScroll={onScroll}
        id="session-search-results"
        role="listbox"
        aria-label={t('search.title')}
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5 [--scroll-fade-size:16px]"
      >
        {!supported ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t('search.unsupported')}
          </p>
        ) : (
          <>
            {trimmed === '' && rows.length > 0 && (
              <p className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{t('search.recent')}</p>
            )}
            {rows.map((row, index) =>
              row.kind === 'recent' ? (
                <ResultRow
                  key={row.key}
                  active={index === current}
                  onSelect={() => openRow(row)}
                  onHover={() => setActive(index)}
                  icon={MessagesSquare}
                  title={row.session.title || t('session.untitled')}
                  place={workspaceName.get(row.session.workspaceId)}
                  time={row.session.updatedAt}
                />
              ) : (
                <ResultRow
                  key={row.key}
                  active={index === current}
                  onSelect={() => openRow(row)}
                  onHover={() => setActive(index)}
                  icon={KIND_ICONS[row.hit.kind] ?? MessageSquareText}
                  title={row.hit.sessionTitle || t('session.untitled')}
                  place={workspaceName.get(row.hit.workspaceId)}
                  time={row.hit.ts}
                  archived={row.hit.archived === true}
                >
                  {snippetSegments(row.hit.snippet, row.hit.highlights).map((segment, i) =>
                    segment.mark ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 片段的分段只随结果整体替换。
                      <mark key={i} className="bg-transparent font-medium text-foreground">
                        {segment.text}
                      </mark>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
                      <span key={i}>{segment.text}</span>
                    ),
                  )}
                </ResultRow>
              ),
            )}
            {status}
          </>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border px-4 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" data-search-notice>
          {notices.map(noticeText).join(' · ')}
        </span>
        <KeyHint keys="↑↓">{t('search.key.select')}</KeyHint>
        <KeyHint keys="↵">{t('search.key.open')}</KeyHint>
        <KeyHint keys="⇥">{t('search.key.kind')}</KeyHint>
        <KeyHint keys="esc">{t('search.key.close')}</KeyHint>
      </div>
    </div>
  );
}

function noticeText(notice: SearchNotice): string {
  switch (notice.kind) {
    case 'indexing':
      return t('search.indexing', { count: notice.sessions });
    case 'scan':
      return t('search.scanLimited', { count: notice.count });
    case 'mixed':
      return t('search.mixedLimited', { count: notice.count });
    case 'noIndex':
      return t('search.noIndex', { count: notice.count });
  }
}

function Toggle({
  pressed,
  onChange,
  name,
  children,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  name: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        'h-7 rounded-md border border-border px-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-field',
        pressed && 'border-transparent bg-accent text-foreground',
      )}
      data-search-toggle={name}
    >
      {children}
    </button>
  );
}

function KeyHint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {children}
      <kbd className="rounded border border-border px-1 font-sans text-[11px] leading-4">
        {keys}
      </kbd>
    </span>
  );
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function shortTime(iso: string): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = sameDay(date, new Date())
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(currentLocale(), options).format(date);
}

function ResultRow({
  active,
  onSelect,
  onHover,
  icon: Icon,
  title,
  place,
  time,
  archived = false,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  icon: typeof Search;
  title: string;
  place: string | undefined;
  time: string;
  archived?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-active={active || undefined}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        'flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none',
        active && 'bg-accent',
      )}
      data-search-row
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="truncate text-foreground">{title}</span>
          {place !== undefined && (
            <span className="shrink-0 truncate text-xs text-muted-foreground">{place}</span>
          )}
          {archived && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('search.archivedBadge')}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {shortTime(time)}
          </span>
        </span>
        {children !== undefined && (
          <span className="line-clamp-2 text-xs leading-5 break-all text-muted-foreground">
            {children}
          </span>
        )}
      </span>
    </button>
  );
}
