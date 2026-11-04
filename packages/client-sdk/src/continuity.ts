import { AUTO_CONTINUE_MAX_WAIT_MS, type SessionAutoContinue, type TurnId } from '@wevir/protocol';
import type { ChatPartOf, SessionNotice } from './projection.js';

export type HandoffNoticeOf = Extract<SessionNotice, { kind: 'handoff' }>;
export type ConfigurationNoticeOf = Extract<SessionNotice, { kind: 'configured' }>;
export type ContinuityNotice = HandoffNoticeOf | ConfigurationNoticeOf;

export type RoutingReasonKey =
  | 'routing.reason.attempt_limit'
  | 'routing.reason.node_disabled'
  | 'routing.reason.provider_missing'
  | 'routing.reason.provider_disabled'
  | 'routing.reason.visited'
  | 'routing.reason.same_model'
  | 'routing.reason.signed_out'
  | 'routing.reason.exhausted'
  | 'routing.reason.model_missing'
  | 'routing.reason.switch_failed';

export type HandoffTextKey =
  | 'common.listSeparator'
  | 'handoff.detail.attempt'
  | 'handoff.detail.budgetUsed'
  | 'handoff.detail.bytes'
  | 'handoff.detail.constraints'
  | 'handoff.detail.count'
  | 'handoff.detail.covered'
  | 'handoff.detail.coveredRange'
  | 'handoff.detail.engine'
  | 'handoff.detail.engine.new'
  | 'handoff.detail.engine.resumed'
  | 'handoff.detail.hash'
  | 'handoff.detail.history'
  | 'handoff.detail.history.no'
  | 'handoff.detail.history.yes'
  | 'handoff.detail.itemCounts'
  | 'handoff.detail.items'
  | 'handoff.detail.none'
  | 'handoff.detail.notes'
  | 'handoff.detail.omitted'
  | 'handoff.detail.omittedRange'
  | 'handoff.detail.reason'
  | 'handoff.detail.skipped'
  | 'handoff.detail.status'
  | 'handoff.detail.status.delivered'
  | 'handoff.detail.status.failed'
  | 'handoff.detail.status.none'
  | 'handoff.detail.status.prepared'
  | 'handoff.detail.strategy'
  | 'handoff.detail.strategy.delta'
  | 'handoff.detail.strategy.full'
  | 'handoff.reason.usage_limit';

type ParameterizedKey =
  | 'handoff.detail.coveredRange'
  | 'handoff.detail.itemCounts'
  | 'handoff.detail.omittedRange'
  | 'handoff.detail.count'
  | 'handoff.detail.budgetUsed';

export interface HandoffText {
  (key: Exclude<HandoffTextKey, ParameterizedKey> | RoutingReasonKey): string;
  (key: 'handoff.detail.coveredRange', params: Record<'from' | 'to', string | number>): string;
  (key: 'handoff.detail.itemCounts', params: Record<'items' | 'omitted', string | number>): string;
  (
    key: 'handoff.detail.omittedRange',
    params: Record<'first' | 'last' | 'count', string | number>,
  ): string;
  (key: 'handoff.detail.count', params: Record<'count', string | number>): string;
  (key: 'handoff.detail.budgetUsed', params: Record<'used' | 'budget', string | number>): string;
}

export interface HandoffLabels {
  text: HandoffText;
  providerLabel: (providerId: string) => string;
}

/** 接力详情里的一行：名称与值，`tone` 给状态上色。 */
export interface HandoffDetailRow {
  key: string;
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'muted';
}

/**
 * 接力详情（只读）：方式、引擎会话、覆盖范围、条目、能不能读历史与递交状态，全部来自 `session.handoff` 与之后的回合。状态只说 Host
 * 有没有把摘要交给新来源，不说模型理解了没有。
 */
export function handoffDetailRows(
  notice: HandoffNoticeOf | ConfigurationNoticeOf,
  labels: HandoffLabels,
): HandoffDetailRow[] {
  const { text: t, providerLabel } = labels;
  const rows: HandoffDetailRow[] = [];
  if (notice.reason !== undefined) {
    rows.push({
      key: 'reason',
      label: t('handoff.detail.reason'),
      value: t('handoff.reason.usage_limit'),
    });
    if (notice.failover !== undefined)
      rows.push({
        key: 'attempt',
        label: t('handoff.detail.attempt'),
        value: String(notice.failover.attempt),
      });
    if (notice.skipped !== undefined)
      rows.push({
        key: 'skipped',
        label: t('handoff.detail.skipped'),
        value:
          notice.skipped.length === 0
            ? t('handoff.detail.none')
            : notice.skipped
                .map((skip) => {
                  const name = providerLabel(skip.providerId);
                  return `${name} · ${routingReason(skip.reason, t)}`;
                })
                .join(t('common.listSeparator')),
      });
  }
  if (notice.kind === 'configured') return rows;
  rows.push(...materialRows(notice, t));
  // 递交记录（0.59.0）：旧 Host 写的事件没有。
  const { receipt } = notice;
  if (receipt !== undefined) {
    if (receipt.omitted.length > 0) {
      rows.push({
        key: 'omitted',
        label: t('handoff.detail.omitted'),
        value: receipt.omitted
          .map((range) =>
            range.first === range.last
              ? range.first
              : t('handoff.detail.omittedRange', {
                  first: range.first,
                  last: range.last,
                  count: range.count,
                }),
          )
          .join(t('common.listSeparator')),
      });
    }
    rows.push({
      key: 'constraints',
      label: t('handoff.detail.constraints'),
      value: t('handoff.detail.count', { count: receipt.constraints }),
    });
    rows.push({
      key: 'notes',
      label: t('handoff.detail.notes'),
      value:
        receipt.notes.length === 0
          ? t('handoff.detail.none')
          : receipt.notes
              .map((note) => `${note.name} · ${note.revision.slice(0, 8)}`)
              .join(t('common.listSeparator')),
    });
    rows.push({
      key: 'bytes',
      label: t('handoff.detail.bytes'),
      value: t('handoff.detail.budgetUsed', {
        used: receipt.bytes.toLocaleString(),
        budget: receipt.budgetBytes.toLocaleString(),
      }),
    });
    rows.push({ key: 'hash', label: t('handoff.detail.hash'), value: receipt.hash.slice(0, 16) });
  }
  const { delivery } = notice;
  rows.push({
    key: 'status',
    label: t('handoff.detail.status'),
    value: t(`handoff.detail.status.${delivery.status}`),
    tone:
      delivery.status === 'delivered'
        ? 'success'
        : delivery.status === 'failed'
          ? 'warning'
          : 'muted',
  });
  return rows;
}

function materialRows(
  notice: Pick<HandoffNoticeOf, 'strategy' | 'resumed' | 'covered' | 'items' | 'omittedItems'> & {
    historyTool?: boolean | undefined;
  },
  t: HandoffText,
): HandoffDetailRow[] {
  const strategy =
    notice.strategy === 'full_thread_summary'
      ? t('handoff.detail.strategy.full')
      : notice.strategy === 'delta_since_target_last_seen'
        ? t('handoff.detail.strategy.delta')
        : notice.strategy;
  const rows: HandoffDetailRow[] = [
    { key: 'strategy', label: t('handoff.detail.strategy'), value: strategy },
    {
      key: 'engine',
      label: t('handoff.detail.engine'),
      value: notice.resumed ? t('handoff.detail.engine.resumed') : t('handoff.detail.engine.new'),
    },
    {
      key: 'covered',
      label: t('handoff.detail.covered'),
      value:
        notice.covered === undefined
          ? t('handoff.detail.none')
          : t('handoff.detail.coveredRange', {
              from: notice.covered.fromSeq,
              to: notice.covered.toSeq,
            }),
    },
    {
      key: 'items',
      label: t('handoff.detail.items'),
      value: t('handoff.detail.itemCounts', {
        items: notice.items,
        omitted: notice.omittedItems,
      }),
      ...(notice.omittedItems > 0 && { tone: 'warning' as const }),
    },
  ];
  if (notice.historyTool !== undefined) {
    rows.push({
      key: 'history',
      label: t('handoff.detail.history'),
      value: notice.historyTool ? t('handoff.detail.history.yes') : t('handoff.detail.history.no'),
      ...(!notice.historyTool && { tone: 'warning' as const }),
    });
  }
  return rows;
}

export interface AutoContinueState {
  armed?: SessionAutoContinue;
  lastTurnId?: TurnId;
}

/** 排程直接取 Host 投影；资格与桌面额度卡片一致。 */
export function usageLimitState(
  part: ChatPartOf<'error'>,
  autoContinue: AutoContinueState | undefined,
  now = Date.now(),
): { armed: SessionAutoContinue | undefined; toggleable: boolean } {
  const pending = autoContinue?.armed;
  const armed = pending?.turnId === part.turnId ? pending : undefined;
  const resetsAt = Date.parse(part.usageLimit?.resetsAt ?? '');
  const toggleable =
    autoContinue !== undefined &&
    part.turnId !== undefined &&
    autoContinue.lastTurnId === part.turnId &&
    part.resumedAt === undefined &&
    resetsAt - now <= AUTO_CONTINUE_MAX_WAIT_MS;
  return { armed, toggleable };
}

const ROUTING_REASONS: Record<string, RoutingReasonKey> = {
  attempt_limit: 'routing.reason.attempt_limit',
  node_disabled: 'routing.reason.node_disabled',
  provider_missing: 'routing.reason.provider_missing',
  provider_disabled: 'routing.reason.provider_disabled',
  visited: 'routing.reason.visited',
  same_model: 'routing.reason.same_model',
  signed_out: 'routing.reason.signed_out',
  exhausted: 'routing.reason.exhausted',
  model_missing: 'routing.reason.model_missing',
  switch_failed: 'routing.reason.switch_failed',
};

export function routingReason(reason: string, text: (key: RoutingReasonKey) => string): string {
  const key = ROUTING_REASONS[reason];
  return key ? text(key) : reason;
}
