// 会话全文搜索（0.72.0，Host 功能 `session_search`）的界面状态与纯函数：浮窗开关、结果的去处、片段的高亮分段、状态行。

import type { SearchHit, SearchKind, SearchQueryResult, Session } from '@wevir/protocol';
import { createStore } from '@/lib/store';
import { paths } from '@/routes/paths';

/** 搜索浮窗开着（⌘K、左栏“搜索”）。 */
export const searchOpen = createStore(false);

/** 结果的种类筛选：全部与协议的四种。 */
export const KIND_FILTERS = [
  'all',
  'user_message',
  'assistant_message',
  'command',
  'file_change',
] as const satisfies readonly ('all' | SearchKind)[];
export type KindFilter = (typeof KIND_FILTERS)[number];

/** 下一个（`step` 为 -1 时上一个）种类，循环。 */
export function nextKind(kind: KindFilter, step: 1 | -1): KindFilter {
  const index = KIND_FILTERS.indexOf(kind);
  return KIND_FILTERS[(index + step + KIND_FILTERS.length) % KIND_FILTERS.length] as KindFilter;
}

/** 打开结果：子会话在父会话的“子智能体”窗格里打开（同记忆来源，settings/memory-model.ts）。 */
export function hitPath(hit: Pick<SearchHit, 'workspaceId' | 'sessionId' | 'parentSessionId'>) {
  return hit.parentSessionId === undefined
    ? paths.session(hit.workspaceId, hit.sessionId)
    : paths.agent(hit.workspaceId, hit.parentSessionId, hit.sessionId);
}

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

/** 片段按高亮切段；越界或重叠的高亮忽略。 */
export function snippetSegments(
  snippet: string,
  highlights: readonly { start: number; end: number }[],
): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let at = 0;
  for (const { start, end } of highlights) {
    if (start < at || end <= start || end > snippet.length) continue;
    if (start > at) segments.push({ text: snippet.slice(at, start), mark: false });
    segments.push({ text: snippet.slice(start, end), mark: true });
    at = end;
  }
  if (at < snippet.length) segments.push({ text: snippet.slice(at), mark: false });
  return segments;
}

/** 跳过去之后在消息里找的文字：第一处高亮。 */
export function focusText(hit: Pick<SearchHit, 'snippet' | 'highlights'>): string | undefined {
  const first = hit.highlights[0];
  return first === undefined ? undefined : hit.snippet.slice(first.start, first.end);
}

/** 结果的范围说明（浮窗底部）：索引还没追上、短词只扫了最近的、没有全文索引。全都完整时为空。 */
export type SearchNotice =
  | { kind: 'indexing'; sessions: number }
  | { kind: 'scan'; count: number }
  | { kind: 'mixed'; count: number }
  | { kind: 'noIndex'; count: number };

export function searchNotices(
  result: Pick<SearchQueryResult, 'mode' | 'reason' | 'scan' | 'index'>,
): SearchNotice[] {
  const notices: SearchNotice[] = [];
  if (result.index.state === 'indexing') {
    notices.push({ kind: 'indexing', sessions: result.index.pendingSessions });
  }
  if (result.mode === 'scan' && result.reason === 'fts_unavailable' && result.scan) {
    notices.push({ kind: 'noIndex', count: result.scan.examined });
  } else if (result.scan !== undefined && !result.scan.complete) {
    notices.push({
      kind: result.mode === 'mixed' ? 'mixed' : 'scan',
      count: result.scan.examined,
    });
  }
  return notices;
}

/** 结果可能不全（空结果不能说成没有）。 */
export function partialResult(result: Pick<SearchQueryResult, 'scan' | 'index'>): boolean {
  return result.index.state === 'indexing' || result.scan?.complete === false;
}

/** 查询词为空时列出的最近会话：所有项目里最近活动的顶层会话。 */
export function recentSessions(
  sessions: readonly Pick<Session, 'id' | 'updatedAt' | 'parentSessionId'>[],
  limit: number,
) {
  return [...sessions]
    .filter((session) => session.parentSessionId === undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
