// 会话页要画的行：用户的话、助手的回答（还在写的带 `streaming`，逐字放出）、思考与工具各一行、错误；回合进行中消息流末尾是
// 运行状态（当前动作、已用时间、正在流出的思考或命令输出），之后是待批准的审批（画法同助理的审批卡）、等回答的问题与排队中的
// 消息。不是用户写的消息（别的会话发来的、回报、后台进程的通知等，`from`）照桌面端画成卡片或一行标记，不画成用户的气泡。
// 回合的折叠同桌面端（turn-model.ts）：结束的回合在用户消息下面有一行“已处理 2 分 31 秒”，正常完成且有过程时默认收起，只留
// 最后一段回答、计划、错误与插话；过程（思考、工具、中间的旁白、后台进程的通知）带 `fold`，收起时不画（`visibleItems`）。
// 子会话之类桌面专有的部件不画。纯逻辑。

import {
  type ChatMessage,
  type ChatPartOf,
  type ContinuityNotice,
  reportBody,
  type Transcript,
} from '@wevir/client-sdk';
import type {
  MessageFrom,
  PendingDelivery,
  PendingMessage,
  QuestionRequest,
  ReviewFinding,
  SecondOpinion,
  SessionId,
  SharedFile,
  SuggestedTask,
  TodoItem,
  ToolDisplayKind,
  TurnId,
  TurnOutcome,
  UserImagePart,
} from '@wevir/protocol';
import { formatBytes, type MessageKey, t } from '../i18n';
import { type ApprovalContext, approvalView, type BotPost } from './bots';
import { isBusy } from './session-actions';
import { failureSummary } from './tool-detail';

export type ToolState = 'awaiting' | 'running' | 'done' | 'failed' | 'skipped' | 'unknown';

/** 不是用户写的消息的图标：后台进程、自动修复、第二意见、回报、别的会话发来的消息。 */
export type NoticeIcon = 'process' | 'repair' | 'opinion' | 'report' | 'message';

/** 标记行的图标。 */
export type LineIcon =
  | 'retry'
  | 'guardrail'
  | 'hook'
  | 'agent'
  | 'done'
  | 'failed'
  | 'info'
  | 'context';

/** 进行中的回合正在做什么（同桌面端的当前动作）：停止中、等审批、等回答、在跑的工具，都不是时在思考。 */
export type LiveAction =
  | { kind: 'thinking' | 'awaiting' | 'input' | 'stopping' }
  | { kind: 'tool'; label: string };

type SessionItemBody =
  /** `images`：用户附的照片（按需 `image.read`）。 */
  | { kind: 'user'; key: string; text: string; images?: readonly UserImagePart[] }
  /** `streaming`：还在流出的回答或计划。 */
  | { kind: 'assistant'; key: string; text: string; streaming?: true }
  /** 一段思考：一行“思考了 N 秒”，有文字时可展开。 */
  | { kind: 'thought'; key: string; text: string; durationMs?: number }
  /**
   * 工具一行：种类（图标）、动词（不认识的种类用工具名）与对象（摘要、命令、网址或搜索词）。`images`：工具产出的图片（生图等），
   * 画在这一行下面。
   */
  | {
      kind: 'tool';
      key: string;
      toolKind: ToolDisplayKind;
      verb: string;
      target?: string;
      state: ToolState;
      images?: readonly UserImagePart[];
      /** 失败时行下面的一行说明（结果的第一行）。 */
      failure?: string;
      /** 原部件：点开时由 tool-detail.ts 整理成参数与结果或改动预览。 */
      part: ToolPart;
    }
  /**
   * 一行标记（同桌面端的工具行式样）：重新连接、护栏拦截、钩子、子智能体与任务的回报、会话级提示（`center`，居中）。`detail`
   * 是点开看的原文（理由、命令）；有 `sessionId` 时点它打开那个会话。
   */
  | {
      kind: 'line';
      key: string;
      icon: LineIcon;
      tone?: 'destructive' | 'warning' | 'running';
      text: string;
      target?: string;
      detail?: string;
      sessionId?: SessionId;
      center?: true;
      /** 正在进行（重新连接中）。 */
      active?: true;
    }
  /** 分隔线：压缩上下文（文字居中）与章节（`chapter`，标题在左）。 */
  | { kind: 'divider'; key: string; text: string; chapter?: true }
  /** Agent 的清单。 */
  | { kind: 'todo'; key: string; items: readonly TodoItem[] }
  /** 回答过的提问：每题一行“题目 → 回答”（`answer` 省略是跳过了）；取消了只有一行说明。 */
  | {
      kind: 'answers';
      key: string;
      rows: readonly { question: string; answer?: string }[];
      cancelled?: true;
      timedOut?: true;
    }
  /** Agent 交给用户的文件。 */
  | { kind: 'files'; key: string; files: readonly SharedFile[] }
  /** Agent 建议的后续任务。 */
  | { kind: 'tasks'; key: string; tasks: readonly SuggestedTask[] }
  /** 第二意见。 */
  | { kind: 'opinion'; key: string; opinion: SecondOpinion }
  /** 审查发现。 */
  | { kind: 'findings'; key: string; summary?: string; findings: readonly ReviewFinding[] }
  /**
   * 结束的回合那一行（同桌面端）：“已处理 2 分 31 秒”“出错 · 12 秒”等，点它展开或收起这个回合的过程。`defaultOpen`：出错、
   * 被停止、被中断或没有过程的回合默认展开。
   */
  | {
      kind: 'turn';
      key: string;
      outcome: TurnOutcome;
      durationMs: number;
      defaultOpen: boolean;
    }
  /**
   * 回合进行中的运行状态，在消息流末尾：当前动作，回合开始的时刻（`startedAt`，算已用时间），`detail` 是正在流出的思考或
   * 在跑的命令最近的输出。
   */
  | { kind: 'live'; key: 'live'; action: LiveAction; startedAt?: string; detail?: string }
  | { kind: 'error'; key: string; text: string }
  | { kind: 'handoff'; key: string; notice: ContinuityNotice }
  | { kind: 'usage-limit'; key: string; part: ChatPartOf<'error'> }
  /** 待批准的审批：`post` 是助理审批卡的形状，`approvalId` 用来回应。 */
  | { kind: 'approval'; key: string; approvalId: string; post: BotPost }
  /** 等用户回答的问题。 */
  | { kind: 'question'; key: string; request: QuestionRequest }
  /** 别的会话发来的消息或回报：标题一行，下面是发来的会话（几个回报合成一条时没有）与正文。 */
  | {
      kind: 'relayed';
      key: string;
      icon: 'report' | 'message';
      label: string;
      source?: string;
      text: string;
    }
  /** Host 交给模型的通知（后台进程、自动修复、引用的第二意见）：一行标记，`text` 是交给模型的全文。 */
  | { kind: 'notice'; key: string; icon: NoticeIcon; label: string; text: string }
  /**
   * 回合进行中发出、还没送达的消息（插话等着插进去、排队等这个回合结束）。不是用户写的（`notice`）只显示一行说明。
   */
  | {
      kind: 'pending';
      key: string;
      pendingId: string;
      text: string;
      delivery: PendingDelivery;
      /** 上一回合异常结束，暂停发送（`pending.resume` 继续）。 */
      held: boolean;
      notice?: { icon: NoticeIcon; label: string };
    };

/** 消息流的一行。`fold`：属于哪个回合的过程（那个回合那一行的 key），收起时不画。 */
export type SessionItem = SessionItemBody & { fold?: string };

function toolState(part: ToolPart): ToolState {
  if (part.status === 'completed') return 'done';
  if (part.status === 'cancelled' || part.approval?.status === 'denied') return 'skipped';
  if (part.status === 'awaiting_approval') return 'awaiting';
  return part.status;
}

/**
 * 界面语言的文字：图片占位，工具种类的动词（不认识的种类给 `undefined`，用工具名），发来消息的会话的标题（不知道时
 * `undefined`）。
 */
export interface SessionItemLabels {
  image: string;
  tool: (kind: ToolDisplayKind) => string | undefined;
  sessionTitle?: (sessionId: SessionId) => string | undefined;
}

/** 用户消息的文字，图片写成 `[图片]`。 */

function userText(parts: readonly { type: string; text?: string }[], imageLabel: string): string {
  return parts
    .map((part) =>
      part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? `[${imageLabel}]` : '',
    )
    .filter((part) => part !== '')
    .join('\n\n')
    .trim();
}

function title(sessionId: SessionId, labels: SessionItemLabels): string {
  return labels.sessionTitle?.(sessionId) || t('session.untitled');
}

/** 后台进程的通知的一行说明：退出（带退出码或信号）或输出匹配。 */
function processLabel(process: NonNullable<MessageFrom['process']>): string {
  if (process.event !== 'exit') return t('transcript.processMatched', { name: process.name });
  if (process.signal !== undefined) {
    return t('transcript.processStopped', { name: process.name, signal: process.signal });
  }
  return t('transcript.processExited', {
    name: process.name,
    code: String(process.exitCode ?? '?'),
  });
}

/**
 * 不是用户写的消息怎么标：图标与一行说明，同桌面端（message-view.tsx）。几个子会话的回报合成一条时 `from` 指向这个会话
 * 自己（`merged`）。
 */
function noticeOf(
  from: MessageFrom,
  own: SessionId | undefined,
  labels: SessionItemLabels,
): { icon: NoticeIcon; label: string; merged: boolean } {
  if (from.process !== undefined) {
    return { icon: 'process', label: processLabel(from.process), merged: false };
  }
  if (from.repair !== undefined) {
    const label = t('transcript.repair', {
      attempt: from.repair.attempt,
      max: from.repair.maxAttempts,
    });
    return { icon: 'repair', label, merged: false };
  }
  if (from.opinion !== undefined) {
    return { icon: 'opinion', label: t('transcript.opinion'), merged: false };
  }
  if (from.kind === 'report') {
    const merged = from.sessionId === own && from.channel === undefined;
    const label = merged
      ? t('transcript.reportsMerged')
      : t('transcript.reportFrom', { title: title(from.sessionId, labels) });
    return { icon: 'report', label, merged };
  }
  return { icon: 'message', label: t('transcript.relayed.message'), merged: false };
}

function pendingItem(
  message: PendingMessage,
  own: SessionId | undefined,
  labels: SessionItemLabels,
): SessionItem {
  const notice = message.from !== undefined ? noticeOf(message.from, own, labels) : undefined;
  return {
    kind: 'pending',
    key: `pending:${message.id}`,
    pendingId: message.id,
    text: userText(message.content, labels.image),
    delivery: message.delivery,
    held: message.status === 'held',
    ...(notice !== undefined && { notice: { icon: notice.icon, label: notice.label } }),
  };
}

type ToolPart = ChatPartOf<'tool'>;

/** 工具的动词（不认识的种类用工具名）与对象（摘要、命令、网址或搜索词）。 */
function toolText(part: ToolPart, labels: SessionItemLabels): { verb: string; target?: string } {
  const display = part.display;
  const target = display.summary ?? display.command ?? display.url ?? display.query;
  const verb = labels.tool(display.kind) ?? part.toolName.split('__').at(-1) ?? part.toolName;
  return target !== undefined && target !== '' ? { verb, target } : { verb };
}

/** 工具一行的文字：动词加对象。 */
function toolLabel(part: ToolPart, labels: SessionItemLabels): string {
  const { verb, target } = toolText(part, labels);
  return target !== undefined ? `${verb} · ${target}` : verb;
}

function durationOf(part: ChatPartOf<'reasoning'>): number | undefined {
  if (part.startedAt === undefined || part.endedAt === undefined) return undefined;
  const ms = Date.parse(part.endedAt) - Date.parse(part.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * 运行状态下面露出的那段：正在流出的思考或命令输出的末尾，压成一段。手机上只露三行，从末尾往前取到 `DETAIL_WIDTH` 个半角字宽
 * （全角字按两个），前面截掉的写成省略号，最新的字总在最后一行。
 */
const DETAIL_WIDTH = 130;

function detailText(text: string): string | undefined {
  const flat = text
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') return undefined;
  const chars = Array.from(flat);
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const code = chars[start - 1]?.codePointAt(0) ?? 0;
    const next = width + (code >= 0x2e80 ? 2 : 1);
    if (next > DETAIL_WIDTH) break;
    width = next;
    start -= 1;
  }
  return start === 0 ? flat : `…${chars.slice(start).join('').trimStart()}`;
}

function messageItems(
  message: ChatMessage,
  own: SessionId | undefined,
  labels: SessionItemLabels,
  /** 正在流出、由运行状态代表的思考（不另画一行）。 */
  liveThought: string | undefined,
  /** 进行中的回合（它最后一个部件是重新连接时写“正在重新连接”）。 */
  activeTurnId: TurnId | undefined,
): SessionItem[] {
  const out: SessionItem[] = [];
  if (message.role === 'user') {
    const text = userText(message.parts, labels.image);
    const from = message.from;
    if (from === undefined) {
      const images = message.parts.flatMap((part) => (part.type === 'image' ? [part.image] : []));
      const own = userText(
        message.parts.filter((part) => part.type !== 'image'),
        labels.image,
      );
      if (own !== '' || images.length > 0)
        out.push({
          kind: 'user',
          key: message.id,
          text: own,
          ...(images.length > 0 && { images }),
        });
      return out;
    }
    // 额度恢复后或点了恢复按钮后 Host 替用户发的继续消息不显示；不挂起回合的提问的回答（0.156.0）也不显示，回答写在提问那一处。
    if (from.usageLimit !== undefined || from.retry !== undefined || from.question !== undefined)
      return out;
    const { icon, label, merged } = noticeOf(from, own, labels);
    if (icon === 'report' || icon === 'message') {
      out.push({
        kind: 'relayed',
        key: message.id,
        icon,
        label,
        ...(!merged && { source: title(from.sessionId, labels) }),
        // 回报的正文是 Host 发给模型的英文外壳，只显示那个会话的回答。
        text: icon === 'report' ? reportBody(text) : text,
      });
      return out;
    }
    // 引用第二意见时用户附的话照常是用户的气泡。
    if (from.opinion?.note !== undefined) {
      out.push({ kind: 'user', key: `${message.id}:note`, text: from.opinion.note });
    }
    out.push({ kind: 'notice', key: message.id, icon, label, text });
    return out;
  }
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
      case 'plan':
        if (part.text.trim() !== '')
          out.push({
            kind: 'assistant',
            key: part.key,
            text: part.text,
            ...(part.state === 'streaming' && { streaming: true }),
          });
        break;
      case 'reasoning': {
        if (part.key === liveThought) break;
        const durationMs = durationOf(part);
        // 没有文字、又不到一秒的思考（引擎只给了加密的思考）不占一行。
        if (part.text.trim() === '' && (durationMs === undefined || durationMs < 1_000)) break;
        out.push({
          kind: 'thought',
          key: part.key,
          text: part.text,
          ...(durationMs !== undefined && { durationMs }),
        });
        break;
      }
      case 'tool': {
        const state = toolState(part);
        // 失败与被拒绝的（同桌面端）下面带结果的第一行。
        const rejected = part.approval?.status === 'denied' && part.status !== 'completed';
        const failure = state === 'failed' || rejected ? failureSummary(part) : undefined;
        out.push({
          kind: 'tool',
          key: part.key,
          toolKind: part.display.kind,
          ...toolText(part, labels),
          state,
          ...(part.images !== undefined && part.images.length > 0 && { images: part.images }),
          ...(failure !== undefined && { failure }),
          part,
        });
        break;
      }
      case 'error':
        out.push(
          part.usageLimit !== undefined
            ? { kind: 'usage-limit', key: part.key, part }
            : { kind: 'error', key: part.key, text: part.message },
        );
        break;
      case 'notice': {
        const notice = part.notice;
        if (notice.kind === 'handoff' || notice.kind === 'configured') {
          out.push({ kind: 'handoff', key: part.key, notice });
        } else out.push(noticeLine(part.key, notice));
        break;
      }
      case 'retry': {
        const active =
          message.role === 'assistant' &&
          message.turnId === activeTurnId &&
          message.parts.at(-1)?.key === part.key;
        const counted = part.attempt !== undefined && part.maxAttempts !== undefined;
        const text = counted
          ? t(active ? 'retry.active' : 'retry.done', {
              attempt: part.attempt ?? 0,
              max: part.maxAttempts ?? 0,
            })
          : t(active ? 'retry.activePlain' : 'retry.donePlain');
        out.push({
          kind: 'line',
          key: part.key,
          icon: 'retry',
          text,
          ...(part.reason !== undefined && { detail: part.reason }),
          ...(active && { active: true }),
        });
        break;
      }
      case 'guardrail':
        out.push(guardrailLine(part));
        break;
      case 'hook':
        out.push(hookLine(part));
        break;
      case 'subagent': {
        const { subagent, ended } = part;
        const title = subagent.title.trim() || subagent.nickname?.trim() || t('subagent.untitled');
        const failed = ended === 'failed';
        out.push({
          kind: 'line',
          key: part.key,
          icon: failed ? 'failed' : ended === undefined ? 'agent' : 'done',
          ...(failed && { tone: 'destructive' }),
          text: t(ended === undefined ? 'subagent.marker.started' : `subagent.marker.${ended}`, {
            title,
          }),
          sessionId: subagent.sessionId,
        });
        break;
      }
      case 'task_report': {
        const outcome = part.task.outcome ?? 'completed';
        const ok = outcome === 'completed';
        out.push({
          kind: 'line',
          key: part.key,
          icon: ok ? 'done' : 'failed',
          ...(!ok && { tone: 'destructive' }),
          text: t(
            ok
              ? 'suggest.report.completed'
              : outcome === 'cancelled'
                ? 'suggest.report.cancelled'
                : 'suggest.report.failed',
            { title: part.task.title },
          ),
          ...(part.task.sessionId !== undefined && { sessionId: part.task.sessionId }),
          ...(part.summary !== undefined && { detail: part.summary }),
        });
        break;
      }
      case 'compaction': {
        const auto = part.trigger === 'auto';
        const running = part.status === 'running';
        const key: MessageKey = running
          ? auto
            ? 'compaction.autoRunning'
            : 'compaction.running'
          : auto
            ? 'compaction.autoDone'
            : 'compaction.done';
        out.push({ kind: 'divider', key: part.key, text: t(key) });
        break;
      }
      case 'chapter':
        out.push({ kind: 'divider', key: part.key, text: part.title, chapter: true });
        break;
      case 'todo':
        if (part.items.length > 0) out.push({ kind: 'todo', key: part.key, items: part.items });
        break;
      case 'question': {
        const answered = answersItem(part.key, part.question);
        if (answered !== undefined) out.push(answered);
        break;
      }
      case 'files':
        if (part.files.length > 0) out.push({ kind: 'files', key: part.key, files: part.files });
        break;
      case 'tasks':
        if (part.tasks.length > 0) out.push({ kind: 'tasks', key: part.key, tasks: part.tasks });
        break;
      case 'opinion':
        out.push({ kind: 'opinion', key: part.key, opinion: part.opinion });
        break;
      case 'findings':
        out.push({
          kind: 'findings',
          key: part.key,
          ...(part.summary !== undefined &&
            part.summary.trim() !== '' && { summary: part.summary }),
          findings: part.findings,
        });
        break;
    }
  }
  return out;
}

/** 会话级提示（恢复、只读、关闭、换目录、开局上下文）：居中的一行。 */
function noticeLine(
  key: string,
  notice: Exclude<ChatPartOf<'notice'>['notice'], { kind: 'handoff' | 'configured' }>,
): SessionItem {
  switch (notice.kind) {
    case 'context':
      return {
        kind: 'line',
        key,
        icon: 'context',
        text: t('context.receipt.title'),
        target: formatBytes(notice.receipt.bytes),
        center: true,
      };
    case 'resumed':
      return { kind: 'line', key, icon: 'info', text: t('notice.resumed'), center: true };
    case 'read_only':
      return {
        kind: 'line',
        key,
        icon: 'info',
        text: t('notice.readOnly', { reason: t(`readOnly.${notice.reason}`) }),
        center: true,
      };
    case 'closed':
      return { kind: 'line', key, icon: 'info', text: t('notice.closed'), center: true };
    case 'moved':
      return {
        kind: 'line',
        key,
        icon: 'info',
        text: t(notice.to === 'local' ? 'notice.movedToLocal' : 'notice.movedToWorktree'),
        ...(notice.branch !== undefined && { target: notice.branch }),
        center: true,
      };
  }
}

const GUARDRAIL_ACTIONS: Record<string, MessageKey> = {
  denied: 'guardrail.action.denied',
  continued: 'guardrail.action.continued',
  allowed: 'guardrail.action.allowed',
};

const GUARDRAIL_KINDS: Record<string, MessageKey> = {
  forbidden_command: 'guardrail.kind.forbidden_command',
  protected_path: 'guardrail.kind.protected_path',
  stop_check: 'guardrail.kind.stop_check',
  commit_check: 'guardrail.kind.commit_check',
};

/** 认识的开放字符串换成界面文字，不认识的原样。 */
function known(table: Record<string, MessageKey>, value: string): string {
  const key = Object.hasOwn(table, value) ? table[value] : undefined;
  return key !== undefined ? t(key) : value;
}

/** 护栏拦下的一步（同桌面端）：“已拦截 禁止命令 rm -rf /”，结束前检查带第几次；点开是交给 Agent 的理由。 */
function guardrailLine(part: ChatPartOf<'guardrail'>): SessionItem {
  const { blocked } = part;
  const attempt =
    blocked.attempt !== undefined && blocked.maxAttempts !== undefined
      ? `${blocked.attempt}/${blocked.maxAttempts}`
      : undefined;
  const target = [blocked.command ?? blocked.path, attempt].filter(Boolean).join(' · ');
  return {
    kind: 'line',
    key: part.key,
    icon: 'guardrail',
    ...(blocked.action === 'denied' && { tone: 'destructive' }),
    ...(blocked.action === 'continued' && { tone: 'warning' }),
    text: `${known(GUARDRAIL_ACTIONS, blocked.action)} ${known(GUARDRAIL_KINDS, blocked.kind)}`,
    ...(target !== '' && { target }),
    ...(blocked.reason.trim() !== '' && { detail: blocked.reason }),
  };
}

const HOOK_ACTIONS: Record<string, MessageKey> = {
  blocked: 'hook.action.blocked',
  denied: 'hook.action.denied',
  allowed: 'hook.action.allowed',
  continued: 'hook.action.continued',
  context: 'hook.action.context',
  failed: 'hook.action.failed',
  limit: 'hook.action.limit',
};

/** 一条 hook 的结果（同桌面端）：动作、事件与工具或命令；点开是命令与理由。 */
function hookLine(part: ChatPartOf<'hook'>): SessionItem {
  const { outcome } = part;
  const blocked = outcome.action === 'blocked' || outcome.action === 'denied';
  const tone =
    blocked || outcome.action === 'failed'
      ? 'destructive'
      : outcome.action === 'context'
        ? 'running'
        : 'warning';
  const target = [outcome.event, outcome.tool ?? outcome.command].filter(Boolean).join(' ');
  const detail = [outcome.command, outcome.reason].filter(Boolean).join('\n\n');
  return {
    kind: 'line',
    key: part.key,
    icon: 'hook',
    tone,
    text: known(HOOK_ACTIONS, outcome.action),
    target,
    ...(detail !== '' && { detail }),
  };
}

/** 回答过（或取消了）的提问；还在等回答的不画（在消息流末尾另有提问卡片）。 */
function answersItem(key: string, question: QuestionRequest): SessionItem | undefined {
  if (question.status === 'pending') return undefined;
  if (question.status === 'cancelled') return { kind: 'answers', key, rows: [], cancelled: true };
  const answers = question.resolution?.answers ?? {};
  return {
    kind: 'answers',
    key,
    rows: question.questions.map((item) => {
      const answer = answers[item.id]?.answers ?? [];
      const text =
        answer.length === 0
          ? undefined
          : item.secret
            ? '••••'
            : answer.join(t('common.listSeparator'));
      return {
        question: item.header ?? item.question,
        ...(text !== undefined && { answer: text }),
      };
    }),
    ...(question.resolution?.reason === 'timeout' && { timedOut: true }),
  };
}

/**
 * 回合进行中的运行状态（同桌面端的当前动作与“正在思考”那一行）；没在跑时 `undefined`。`toolKey` 是当前动作代表的那个工具
 * （它不另画一行，做完了才列进消息流），`thoughtKey` 是正在流出的那段思考。
 */
function liveStatus(
  transcript: Transcript,
  labels: SessionItemLabels,
):
  | { item: Extract<SessionItem, { kind: 'live' }>; toolKey?: string; thoughtKey?: string }
  | undefined {
  if (!isBusy(transcript)) return undefined;
  const turnId = transcript.activeTurnId;
  const messages = transcript.messages.filter(
    (message) => message.role !== 'system' && message.turnId === turnId,
  );
  const assistant = messages.findLast((message) => message.role === 'assistant');
  const prompt = messages.find((message) => message.role === 'user');
  const startedAt =
    assistant?.role === 'assistant' && assistant.startedAt !== undefined
      ? assistant.startedAt
      : prompt?.role === 'user'
        ? prompt.ts
        : undefined;
  const parts = assistant?.parts ?? [];
  const tool = parts.findLast(
    (part): part is ToolPart =>
      part.type === 'tool' && (part.status === 'running' || part.status === 'awaiting_approval'),
  );
  const tail = parts.at(-1);
  const thought = tail?.type === 'reasoning' && tail.state === 'streaming' ? tail : undefined;
  let action: LiveAction;
  if (transcript.state === 'cancelling') action = { kind: 'stopping' };
  else if (transcript.pendingApprovals.length > 0) action = { kind: 'awaiting' };
  else if (transcript.pendingQuestions.length > 0) action = { kind: 'input' };
  else if (tool !== undefined && tool.status === 'running')
    action = { kind: 'tool', label: toolLabel(tool, labels) };
  else action = { kind: 'thinking' };
  const detail =
    thought !== undefined
      ? detailText(thought.text)
      : action.kind === 'tool' && tool?.output !== undefined
        ? detailText(lastLine(tool.output.text))
        : undefined;
  return {
    item: {
      kind: 'live',
      key: 'live',
      action,
      ...(startedAt !== undefined && { startedAt }),
      ...(detail !== undefined && { detail }),
    },
    ...(action.kind === 'tool' && tool !== undefined && { toolKey: tool.key }),
    ...(thought !== undefined && { thoughtKey: thought.key }),
  };
}

/** 命令输出的最后一行有字的行。 */
function lastLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') return line;
  }
  return '';
}

/**
 * 消息流，回合进行中末尾是运行状态，然后是待批准的审批、等回答的问题与还没送达的消息。只有本地缓存（离线）时 `live` 给
 * false：缓存里的回合在电脑上可能早已结束，不画运行状态。
 */
export function sessionItems(
  transcript: Transcript,
  labels: SessionItemLabels,
  {
    live: showLive = true,
    approvalContext,
  }: { live?: boolean; approvalContext?: ApprovalContext } = {},
): SessionItem[] {
  const own = transcript.sessionId;
  const live = showLive ? liveStatus(transcript, labels) : undefined;
  const active = isBusy(transcript) ? transcript.activeTurnId : undefined;
  const perMessage = transcript.messages.map((message) =>
    messageItems(message, own, labels, live?.thoughtKey, showLive ? active : undefined).filter(
      (item) => item.key !== live?.toolKey,
    ),
  );
  const out = foldTurns(transcript.messages, perMessage, active);
  if (live !== undefined) out.push(live.item);
  for (const request of transcript.pendingApprovals) {
    out.push({
      kind: 'approval',
      key: `approval:${request.id}`,
      approvalId: request.id,
      post: approvalView(request, 'pending', approvalContext),
    });
  }
  for (const question of transcript.pendingQuestions) {
    out.push({ kind: 'question', key: `question:${question.id}`, request: question });
  }
  for (const message of transcript.pendingMessages) {
    if (message.from?.question !== undefined) continue;
    if (message.status === 'waiting' || message.status === 'held')
      out.push(pendingItem(message, own, labels));
  }
  return out;
}

/** 回合的结果与最后一段回答（收起时留下的那段正文）。 */
interface TurnInfo {
  finished?: { outcome: TurnOutcome; durationMs: number };
  finalKey?: string;
}

function turnInfo(messages: readonly ChatMessage[]): Map<TurnId, TurnInfo> {
  const turns = new Map<TurnId, TurnInfo>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const info = turns.get(message.turnId) ?? {};
    if (message.finished !== undefined) info.finished = message.finished;
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim() !== '') info.finalKey = part.key;
    }
    turns.set(message.turnId, info);
  }
  return turns;
}

/**
 * 收起时也留下的部件（同桌面端 turn-model.ts）：计划、错误、建议的任务与回报、第二意见、交出的文件、审查发现、护栏拦截、章节、
 * 手动压缩，以及会话级提示与接力。
 */
const KEPT_PARTS: ReadonlySet<ChatMessage['parts'][number]['type']> = new Set([
  'plan',
  'error',
  'tasks',
  'task_report',
  'opinion',
  'files',
  'findings',
  'guardrail',
  'chapter',
  'notice',
]);

/**
 * 回合的过程：思考、工具、清单、回答过的提问、重新连接、钩子、子智能体、自动压缩、最后一段回答之前的旁白，回合中途插进来的
 * 后台进程通知。别的部件、插话与别的会话发来的消息收起时也留下。
 */
function isProcess(item: SessionItem, message: ChatMessage, finalKey: string | undefined): boolean {
  if (message.role === 'user') return item.kind === 'notice' && message.from?.process !== undefined;
  const part = message.parts.find((candidate) => candidate.key === item.key);
  if (part === undefined) return false;
  if (part.type === 'text') return item.key !== finalKey;
  if (part.type === 'compaction') return part.trigger === 'auto';
  return !KEPT_PARTS.has(part.type);
}

/**
 * 给结束的回合加上那一行，过程标上 `fold`。那一行在回合开头用户自己的消息下面（同桌面端）；正常完成又没有过程的回合不加。
 * 正在进行的回合（`activeTurnId`）不加。
 */
function foldTurns(
  messages: readonly ChatMessage[],
  perMessage: readonly (readonly SessionItem[])[],
  activeTurnId: TurnId | undefined,
): SessionItem[] {
  const turns = turnInfo(messages);
  const tagged = messages.map((message, index) => {
    const items = perMessage[index] ?? [];
    if (message.role === 'system') return items.map((item) => ({ item, process: false }));
    const finalKey = turns.get(message.turnId)?.finalKey;
    return items.map((item) => ({ item, process: isProcess(item, message, finalKey) }));
  });
  const headers = new Map<TurnId, Extract<SessionItem, { kind: 'turn' }>>();
  for (const [turnId, info] of turns) {
    const finished = info.finished;
    if (finished === undefined || turnId === activeTurnId) continue;
    const hasProcess = messages.some(
      (message, index) =>
        message.role !== 'system' &&
        message.turnId === turnId &&
        tagged[index]?.some((entry) => entry.process),
    );
    if (finished.outcome === 'completed' && !hasProcess) continue;
    headers.set(turnId, {
      kind: 'turn',
      key: `turn:${turnId}`,
      outcome: finished.outcome,
      durationMs: finished.durationMs,
      defaultOpen: finished.outcome !== 'completed',
    });
  }
  const lastIndex = new Map<TurnId, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'system') lastIndex.set(message.turnId, index);
  });
  const out: SessionItem[] = [];
  const placed = new Set<TurnId>();
  const seen = new Set<TurnId>();
  messages.forEach((message, index) => {
    const entries = tagged[index] ?? [];
    if (message.role === 'system') {
      for (const { item } of entries) out.push(item);
      return;
    }
    const turnId = message.turnId;
    const header = headers.get(turnId);
    const lead = !seen.has(turnId) && message.role === 'user' && message.steered !== true;
    seen.add(turnId);
    if (header !== undefined && !lead && !placed.has(turnId)) {
      out.push(header);
      placed.add(turnId);
    }
    for (const { item, process } of entries) {
      out.push(process && header !== undefined ? { ...item, fold: header.key } : item);
    }
    // 回合只有用户的消息（还没回答就被停止）：那一行跟在它后面。
    if (header !== undefined && !placed.has(turnId) && lastIndex.get(turnId) === index) {
      out.push(header);
      placed.add(turnId);
    }
  });
  return out;
}

/**
 * 实际画出的行：收起的回合（`open` 里点过的照点过的，否则照 `defaultOpen`）不画它的过程。
 */
export function visibleItems(
  items: readonly SessionItem[],
  open: ReadonlyMap<string, boolean>,
): readonly SessionItem[] {
  const folded = new Set<string>();
  for (const item of items) {
    if (item.kind === 'turn' && !(open.get(item.key) ?? item.defaultOpen)) folded.add(item.key);
  }
  if (folded.size === 0) return items;
  return items.filter((item) => item.fold === undefined || !folded.has(item.fold));
}
