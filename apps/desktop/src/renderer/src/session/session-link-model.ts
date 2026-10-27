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

/** 悬停卡片第一行的状态：运行中、待审批、待回答、待决定、出错，其余是空闲。 */
export function sessionStatus(session: Session): { tone: StatusTone; label: string } {
  switch (sessionMarker(session)) {
    case 'running':
      return { tone: 'accent', label: t('session.marker.running') };
    case 'awaiting_approval':
      return { tone: 'warning', label: t('session.marker.awaitingApproval') };
    case 'awaiting_input':
      return { tone: 'warning', label: t('session.marker.awaitingInput') };
    case 'awaiting_decision':
      return { tone: 'warning', label: t('session.marker.awaitingDecision') };
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
 * 回报正文（Host 发给模型的英文外壳：一条或几条 `reportText` 的笔记，用 `---` 隔开，后面是读全文的提示与有关会话的状态）里给人
 * 看的部分：每个会话的回答，没有回答时是错误；几个会话合在一起时每段前面写上会话标题。认不出时原样返回。
 */
const REPORT_NOTE =
  /^Session ses_[0-9A-Za-z]+(?: "([\s\S]*?)")? finished a turn (?:you asked for|the user ran there) \(\w+\)\.(?:\nError: ([^\n]*))?\n(?:Its final answer:\n\n([\s\S]*)|It gave no final answer\.)$/;
const REPORT_TAIL =
  /\n\nRead (?:a|the) whole conversation with wevir_session_read if you need more\.(?:\n\n[\s\S]*)?$/;

export function reportBody(text: string): string {
  const tail = REPORT_TAIL.exec(text);
  if (!tail) return text;
  const notes = text.slice(0, tail.index).split('\n\n---\n\n');
  const parsed = notes.map((note) => REPORT_NOTE.exec(note));
  if (parsed.some((match) => match === null)) return text;
  const bodies = parsed.map((match) => ({
    title: match?.[1],
    body: match?.[3] ?? match?.[2] ?? '',
  }));
  if (bodies.length === 1) return bodies[0]?.body ?? '';
  return bodies
    .map(({ title, body }) => (title ? `**${title}**\n\n${body}` : body))
    .join('\n\n---\n\n');
}
