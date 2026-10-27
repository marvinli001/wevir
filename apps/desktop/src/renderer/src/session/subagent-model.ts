// 子智能体界面的纯逻辑（R5，ADR-0005 决策 6.1，界面照 Codex 桌面端的截图 design-refs/01–04、06）：标题与状态的说法、
// “子智能体”窗格的分组与排序、相对时间与用时、父会话里要藏起来的 collab 工具卡片、父会话输入框上方要显示的子会话
// 审批。组件在 subagent-marker.tsx、subagent-view.tsx 与 layout/panes/subagents-pane.tsx。

import type { ChatPart, Transcript } from '@wevir/client-sdk';
import type { ApprovalRequest, SubagentStatus, SubagentSummary } from '@wevir/protocol';
import { t } from '@/i18n';

export type EndedStatus = Exclude<SubagentStatus, 'running'>;

/** 显示用的标题：Host 给的标题（兜底标题或生成的标题），没有时用昵称，再没有就是“子智能体”。 */
export function subagentTitle(summary: Pick<SubagentSummary, 'title' | 'nickname'>): string {
  return summary.title.trim() || summary.nickname?.trim() || t('subagent.untitled');
}

const ENDED_MARKERS = {
  completed: 'subagent.marker.completed',
  failed: 'subagent.marker.failed',
  closed: 'subagent.marker.closed',
  cancelled: 'subagent.marker.cancelled',
} as const;

/**
 * 父会话消息流里的一行：“〈标题〉开始工作”，结束时另一行“〈标题〉已完成”（运行失败、已关闭、已取消各有说法）。
 * `ended` 是投影的“结束”部件记下的当时的状态（client-sdk projection.ts）。
 */
export function markerText(
  summary: Pick<SubagentSummary, 'title' | 'nickname'>,
  ended?: EndedStatus,
): string {
  const title = subagentTitle(summary);
  return ended === undefined
    ? t('subagent.marker.started', { title })
    : t(ENDED_MARKERS[ended], { title });
}

export function statusLabel(status: SubagentStatus): string {
  return t(`subagent.status.${status}`);
}

/** 推理强度的说法（“推理强度 高”）；认识的级别本地化，不认识的原样显示。 */
export function effortLabel(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  switch (effort) {
    case 'off':
      return t('subagent.effort.off');
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return t('subagent.effort', { level: t(`subagent.effort.${effort}`) });
    default:
      return t('subagent.effort', { level: effort });
  }
}

/** 详情右上角的“模型 · 推理强度”（截图 04）。 */
export function modelLine(summary: Pick<SubagentSummary, 'modelId' | 'reasoningEffort'>): string {
  const effort = effortLabel(summary.reasoningEffort);
  return effort ? `${summary.modelId} · ${effort}` : summary.modelId;
}

// ── 列表 ────────────────────────────────────────────────────────────

export interface SubagentGroups {
  /** 已开启：还在运行的，最近派出的在前。 */
  open: SubagentSummary[];
  /** 完成：完成、运行失败、已关闭、已取消，最近结束的在前。 */
  done: SubagentSummary[];
}

/** 列表里显示的时刻：运行中的是派出时刻，结束的是结束时刻。 */
export function lastActivity(summary: SubagentSummary): string {
  return summary.status === 'running' ? summary.startedAt : (summary.endedAt ?? summary.startedAt);
}

/**
 * “子智能体”窗格的两组（截图 03：“已开启 · N”“完成 · N”）。组内按时刻从新到旧；时刻相同时后派出的在前（输入是
 * 父会话快照的 `subagents`，按派出的先后）。
 */
export function groupSubagents(subagents: readonly SubagentSummary[]): SubagentGroups {
  const ordered = subagents
    .map((summary, index) => ({ summary, index, at: lastActivity(summary) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.index - a.index)
    .map((item) => item.summary);
  return {
    open: ordered.filter((summary) => summary.status === 'running'),
    done: ordered.filter((summary) => summary.status !== 'running'),
  };
}

/**
 * “后台任务”的“清除已完成”（desktop-layout.md §15）：记下当时已结束的里最晚的结束时刻（Host 的时钟），之后列表只留运行中的
 * 与在那之后结束的。只是不显示，记录还在；又被父 agent 叫醒、再结束的重新出现。没有已结束的时返回 undefined。
 */
export function clearMark(subagents: readonly SubagentSummary[]): string | undefined {
  let mark: string | undefined;
  for (const summary of subagents) {
    if (summary.status === 'running') continue;
    const at = lastActivity(summary);
    if (mark === undefined || at > mark) mark = at;
  }
  return mark;
}

export function withoutCleared(
  subagents: readonly SubagentSummary[],
  mark: string | undefined,
): readonly SubagentSummary[] {
  if (mark === undefined) return subagents;
  const kept = subagents.filter(
    (summary) => summary.status === 'running' || lastActivity(summary) > mark,
  );
  return kept.length === subagents.length ? subagents : kept;
}

/** 相对时间（截图 03 的“1 小时前”）：不到一分钟是“刚刚”，再往后是分钟、小时、天。 */
export function formatRelativeTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return t('time.justNow');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  return t('time.daysAgo', { n: Math.floor(hours / 24) });
}

// ── 父会话的消息流 ──────────────────────────────────────────────────

/** 标章节的工具调用（0.82.0）：成功的不画，紧跟着的分隔线就是它的结果。 */
function isChapterCall(part: ChatPart): boolean {
  return (
    part.type === 'tool' &&
    part.status === 'completed' &&
    part.toolName.endsWith('wevir_mark_chapter')
  );
}

/**
 * 父会话里不再显示成工具卡片的 collab 调用（派出、等待、关闭子 agent 等，展示类型 `sub_agent`）：子会话的“开始工作 /
 * 已完成”两行取代了它们。规则不认引擎的工具名：
 * - 派出了某个子会话的那次调用（`subagent` 部件的 `parentToolCallId`）总是藏起来；
 * - 会话有子会话时，其余的 `sub_agent` 调用也藏起来，失败的除外（失败的调用没有对应的子会话，卡片是唯一的线索）。
 * 没有子会话的会话（dsh 等引擎的子 agent 只是一次工具调用）照常显示卡片。另外成功标了章节的调用（0.82.0）也藏起来。
 */
export function visibleParts(
  parts: readonly ChatPart[],
  hasSubagents: boolean,
): readonly ChatPart[] {
  const spawned = new Set<string>();
  let chapterCalls = false;
  for (const part of parts) {
    if (part.type === 'subagent') spawned.add(part.subagent.parentToolCallId);
    else if (isChapterCall(part)) chapterCalls = true;
  }
  if (!hasSubagents && spawned.size === 0 && !chapterCalls) return parts;
  const visible = parts.filter(
    (part) =>
      part.type !== 'tool' ||
      (!isChapterCall(part) &&
        (part.display.kind !== 'sub_agent' ||
          (!spawned.has(part.toolCallId) && (!hasSubagents || part.status === 'failed')))),
  );
  return visible.length === parts.length ? parts : visible;
}

/** 输入框上方的一个未决审批；来自子会话的带上它的摘要（R4：审批属于子会话，父会话的快照里有副本）。 */
export interface PendingApproval {
  approval: ApprovalRequest;
  subagent?: SubagentSummary;
}

/** 会话自己的与它的子会话的未决审批，按请求的先后。 */
export function pendingApprovals(
  transcript: Pick<Transcript, 'pendingApprovals' | 'subagents'>,
): PendingApproval[] {
  const items: PendingApproval[] = transcript.pendingApprovals.map((approval) => ({ approval }));
  const seen = new Set(items.map((item) => item.approval.id));
  for (const subagent of transcript.subagents) {
    for (const approval of subagent.pendingApprovals) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      items.push({ approval, subagent });
    }
  }
  return items.sort((a, b) => a.approval.createdAt.localeCompare(b.approval.createdAt));
}
