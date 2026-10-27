// 会话链接（照 Claude Code 桌面端 2026-10-27 的会话胶囊）：消息里指向另一个会话的链接、它的悬停卡片里的状态。纯逻辑。

import type { Session, SessionId, Workspace } from '@wevir/protocol';
import type { StatusTone } from '@/components/status-dot';
import type { WorkbenchData } from '@/data/workbench-model';
import { isChats, sessionMarker } from '@/data/workbench-model';
import { t } from '@/i18n';

/** 会话链接的写法（prompts/base.md）：`wevir://session/<id>`，也认 `#<id>`。 */
const SESSION_HREF = /^(?:wevir:\/\/session\/|#)(ses_[0-9A-Za-z]{1,64})\/?$/;

/** 链接指向的会话；不是会话链接时 undefined。 */
export function sessionHrefId(href: string): SessionId | undefined {
  return SESSION_HREF.exec(href.trim())?.[1] as SessionId | undefined;
}

export interface SessionEntry {
  session: Session;
  workspace: Workspace;
}

/** 工作台里的一个会话与它所在的工作区；还没载入或不存在时 undefined。 */
export function findSession(data: WorkbenchData, id: string | undefined): SessionEntry | undefined {
  if (id === undefined || data.status !== 'ready') return undefined;
  for (const { workspace, sessions } of data.workspaces) {
    const session = sessions.find((candidate) => candidate.id === id);
    if (session) return { session, workspace };
  }
  return undefined;
}

/** 悬停卡片第一行的状态：运行中、待审批、待回答、出错，其余是空闲。 */
export function sessionStatus(session: Session): { tone: StatusTone; label: string } {
  switch (sessionMarker(session)) {
    case 'running':
      return { tone: 'accent', label: t('session.marker.running') };
    case 'awaiting_approval':
      return { tone: 'warning', label: t('session.marker.awaitingApproval') };
    case 'awaiting_input':
      return { tone: 'warning', label: t('session.marker.awaitingInput') };
    case 'error':
      return { tone: 'danger', label: t('session.marker.error') };
    case undefined:
      return { tone: 'neutral', label: t('session.marker.idle') };
  }
}

/** 卡片里的项目名；“对话”工作区写“对话”。 */
export function sessionPlace(workspace: Workspace): string {
  return isChats(workspace) ? t('sidebar.chats') : workspace.displayName;
}

/**
 * 回报正文（Host 的 `reportText`，发给模型的英文外壳：“Session … finished a turn you asked for (…). Its final answer: …
 * Read the whole conversation with wevir_session_read …”）里给人看的部分：那个会话的回答，没有回答时是错误。认不出时原样返回。
 */
const REPORT_TEXT =
  /^Session ses_[0-9A-Za-z]+(?: "[\s\S]*?")? finished a turn you asked for \(\w+\)\.(?:\nError: ([^\n]*))?\n(?:Its final answer:\n\n([\s\S]*?)|It gave no final answer\.)\n\nRead the whole conversation with wevir_session_read if you need more\.$/;

export function reportBody(text: string): string {
  const match = REPORT_TEXT.exec(text);
  if (!match) return text;
  return match[2] ?? match[1] ?? '';
}
