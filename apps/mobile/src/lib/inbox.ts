// 收件箱（0.105.0 的 `inbox.list` + `inbox.changed`，domain-model §3.47）：每台电脑一份列表，版本接不上就整张重读（同会话列表）；
// 各台电脑的合成一个列表，标明来自哪台电脑。作答撞上别处先处理了（`ALREADY_DECIDED`）或过期（`APPROVAL_EXPIRED`）时，说清楚
// 是谁、何时。纯逻辑。

import { WevirRpcError } from '@wevir/client-sdk';
import type {
  ApprovalResolution,
  ClientIdentity,
  InboxItem,
  MethodResult,
  NotificationParams,
} from '@wevir/protocol';
import { botKey } from './bots';

export interface InboxList {
  items: readonly InboxItem[];
  inboxVersion: number;
}

export type InboxChange = NotificationParams<'inbox.changed'>;

/** 应用一批变化；版本接不上时返回 `undefined`，调用方重读整张列表。 */
export function applyInboxChange(list: InboxList, change: InboxChange): InboxList | undefined {
  if (change.inboxVersion !== list.inboxVersion + 1) return undefined;
  const removed = new Set(change.removed);
  const upserted = new Map(change.upserted.map((item) => [item.id, item]));
  const kept = list.items.filter((item) => !removed.has(item.id) && !upserted.has(item.id));
  return { items: [...upserted.values(), ...kept], inboxVersion: change.inboxVersion };
}

/** 合并后的一项：来自哪台电脑（记录名与显示名）。 */
export interface InboxEntry {
  /** `<电脑>/<项 ID>`，列表里唯一。 */
  key: string;
  computer: string;
  computerName: string;
  item: InboxItem;
}

export interface ComputerInbox {
  computer: string;
  computerName: string;
  items: readonly InboxItem[];
}

/** 要作答的（审批、提问）在前，只是提醒的（失败回合、自动化）在后。 */
function needsAnswer(item: InboxItem): boolean {
  return item.kind === 'approval' || item.kind === 'question';
}

/**
 * 各台电脑的收件箱合成一个列表：要作答的在前；同一组里有期限的在前、先到期的在前，其余新的在前；都一样时按电脑与 ID，
 * 刷新时顺序不跳。
 */
export function mergeInboxes(inboxes: readonly ComputerInbox[]): InboxEntry[] {
  const entries = inboxes.flatMap(({ computer, computerName, items }) =>
    items.map((item) => ({ key: `${computer}/${item.id}`, computer, computerName, item })),
  );
  return entries.sort((a, b) => {
    const group = Number(needsAnswer(b.item)) - Number(needsAnswer(a.item));
    if (group !== 0) return group;
    const ae = a.item.expiresAt;
    const be = b.item.expiresAt;
    if (ae !== undefined || be !== undefined) {
      if (ae === undefined) return 1;
      if (be === undefined) return -1;
      if (ae !== be) return ae < be ? -1 : 1;
    }
    if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt < b.item.createdAt ? 1 : -1;
    if (a.computer !== b.computer) return a.computer < b.computer ? -1 : 1;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
}

export type Expiry = { kind: 'none' } | { kind: 'pending'; minutes: number } | { kind: 'expired' };

/** 离 `expiresAt` 还有多久（向上取整到分钟）；已过就是过期（Host 随后会把它移出去）。 */
export function expiryOf(item: Pick<InboxItem, 'expiresAt'>, now: Date): Expiry {
  if (item.expiresAt === undefined) return { kind: 'none' };
  const ms = Date.parse(item.expiresAt) - now.getTime();
  if (!Number.isFinite(ms)) return { kind: 'none' };
  if (ms <= 0) return { kind: 'expired' };
  return { kind: 'pending', minutes: Math.ceil(ms / 60_000) };
}

/** 高风险（Host 判定，0.131.0）：作答“允许”前要验证本人。 */
export function isHighRisk(item: InboxItem): boolean {
  return item.kind === 'approval' && item.ref.risk?.level === 'high';
}

/** 谁处理的：本机、别的客户端（按种类）、Host 自己（规则、超时、回合取消…）。 */
export type HandledBy =
  | 'this_device'
  | 'desktop'
  | 'cli'
  | 'mobile'
  | 'other'
  | 'rule'
  | 'timeout'
  | 'cancelled';

/** 作答的结果：成了，或别处已经处理（谁、何时、结果）。 */
export type AnswerOutcome =
  | { kind: 'done' }
  | {
      kind: 'elsewhere';
      by: HandledBy;
      /** 结算时刻；旧 Host 不给（0.131.0 之前）。 */
      at?: string;
      /** 审批的结局：允许、拒绝、过期、取消。提问只有回答与取消。 */
      result: 'approved' | 'denied' | 'expired' | 'cancelled' | 'answered';
    };

function handledBy(
  reason: string,
  who: ClientIdentity | undefined,
  self: Pick<ClientIdentity, 'clientId'>,
): HandledBy {
  switch (reason) {
    case 'user':
      if (who === undefined) return 'other';
      if (who.clientId === self.clientId) return 'this_device';
      return who.clientKind === 'desktop' || who.clientKind === 'cli' || who.clientKind === 'mobile'
        ? who.clientKind
        : 'other';
    case 'rule':
    // 生命周期钩子替用户答的（0.137.0）：手机上同规则一样写“自动处理”。
    case 'hook':
      return 'rule';
    case 'timeout':
      return 'timeout';
    default:
      return 'cancelled';
  }
}

/** `approval.respond` 的错误：已处理或已过期时给出结果，别的错误返回 `undefined`（照常抛出）。 */
export function approvalConflict(
  error: unknown,
  self: Pick<ClientIdentity, 'clientId'>,
): Extract<AnswerOutcome, { kind: 'elsewhere' }> | undefined {
  if (!(error instanceof WevirRpcError)) return undefined;
  if (!error.is('ALREADY_DECIDED') && !error.is('APPROVAL_EXPIRED')) return undefined;
  const data = (error.data ?? {}) as {
    status?: string;
    resolution?: ApprovalResolution;
    resolvedAt?: string;
  };
  const reason = data.resolution?.reason ?? 'host_restarted';
  const status = error.is('APPROVAL_EXPIRED') ? 'expired' : (data.status ?? 'cancelled');
  const result =
    status === 'approved' || status === 'denied' || status === 'expired' ? status : 'cancelled';
  return {
    kind: 'elsewhere',
    by: status === 'expired' ? 'timeout' : handledBy(reason, data.resolution?.decidedBy, self),
    ...(data.resolvedAt !== undefined && { at: data.resolvedAt }),
    result,
  };
}

/** `question.respond` 的结果：已经结束的问题照样返回它的结局，不是本机答的就是别处处理了。 */
export function questionOutcome(
  result: Pick<MethodResult<'question.respond'>, 'status' | 'resolution'>,
  self: Pick<ClientIdentity, 'clientId'>,
): AnswerOutcome {
  const resolution = result.resolution;
  if (result.status === 'answered' && resolution?.reason === 'user') {
    if (resolution.answeredBy?.clientId === self.clientId) return { kind: 'done' };
  }
  return {
    kind: 'elsewhere',
    by: handledBy(resolution?.reason ?? 'turn_cancelled', resolution?.answeredBy, self),
    result: result.status === 'answered' ? 'answered' : 'cancelled',
  };
}

/** 点一项去哪：助理的（带 `channelId`）打开那个助理，别的打开会话，没有会话的自动化打开那台电脑。 */
export type InboxTarget =
  | { pathname: '/bot/[key]'; params: { key: string } }
  | { pathname: '/session/[key]'; params: { key: string } }
  | { pathname: '/computer/[name]'; params: { name: string } };

export function inboxTarget(entry: Pick<InboxEntry, 'computer' | 'item'>): InboxTarget {
  const { computer, item } = entry;
  if (item.channelId !== undefined)
    return { pathname: '/bot/[key]', params: { key: botKey(computer, item.channelId) } };
  if (item.sessionId !== undefined)
    return { pathname: '/session/[key]', params: { key: botKey(computer, item.sessionId) } };
  return { pathname: '/computer/[name]', params: { name: computer } };
}

/** 提问能不能在列表里直接点选项回答：只有一题、单选、不是密码、有选项。别的进会话回答。 */
export function quickQuestion(
  item: InboxItem,
): { questionId: string; id: string; options: readonly string[] } | undefined {
  if (item.kind !== 'question') return undefined;
  const [question, ...rest] = item.ref.questions;
  if (question === undefined || rest.length > 0) return undefined;
  if (question.multiSelect === true || question.secret === true) return undefined;
  if (question.options.length === 0) return undefined;
  return {
    questionId: item.ref.questionId,
    id: question.id,
    options: question.options.map((o) => o.label),
  };
}
