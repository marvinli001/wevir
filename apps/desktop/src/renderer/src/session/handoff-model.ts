// 接力（0.25.0，domain-model §3.14）的纯逻辑：已有会话能换到哪些来源、当前的引擎能做什么、切换处那一行写什么。

import type { SessionNotice } from '@wevir/client-sdk';
import type {
  AccountState,
  EngineFeatures,
  ProviderProfile,
  Session,
  SessionState,
} from '@wevir/protocol';
import { accountSuffix, sourceOf, sourceTitle } from '@/data/sources';
import { t } from '@/i18n';
import { routingReason } from '@/settings/routing-model';

const ACTIVE: readonly SessionState[] = ['running', 'awaiting_approval', 'cancelling'];

/** 一个 Provider 的会话由哪个引擎跑、能做什么（`host.hello` 的 `engineFeatures`，按种类）；旧 Host 没有。 */
export function engineFeaturesOf(
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
  providers: readonly ProviderProfile[],
  providerId: string,
): EngineFeatures | undefined {
  const kind = providers.find((provider) => provider.id === providerId)?.kind;
  return kind === undefined ? undefined : engineFeatures?.[kind];
}

/**
 * 已有会话能不能接力到这个 Provider：会话是顶层、不是支线、可写、没有在跑回合；有额外目录（多文件夹的环境）时对方的引擎
 * 要支持额外目录。同一个 Provider 不算接力。
 */
export function canHandoffTo(
  target: Pick<ProviderProfile, 'id' | 'kind'>,
  session: Pick<
    Session,
    'providerId' | 'extraRoots' | 'state' | 'side' | 'parentSessionId' | 'readOnly'
  >,
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
): boolean {
  if (target.id === session.providerId) return false;
  if (session.side || session.parentSessionId !== undefined || session.readOnly !== undefined) {
    return false;
  }
  if (ACTIVE.includes(session.state)) return false;
  if ((session.extraRoots?.length ?? 0) > 0) {
    return engineFeatures?.[target.kind]?.additionalRoots === true;
  }
  return true;
}

export type HandoffNoticeOf = Extract<SessionNotice, { kind: 'handoff' }>;
export type ConfigurationNoticeOf = Extract<SessionNotice, { kind: 'configured' }>;

export function handoffTransition(
  providers: readonly ProviderProfile[],
  fromProviderId: string,
  toProviderId: string,
  accounts?: readonly AccountState[],
): string {
  const from = providers.find((provider) => provider.id === fromProviderId);
  const to = providers.find((provider) => provider.id === toProviderId);
  const fromSource = from && sourceOf(from);
  const toSource = to && sourceOf(to);
  const accountsChanged =
    fromProviderId !== toProviderId && fromSource && fromSource.kind === toSource?.kind;
  const label = (provider: ProviderProfile | undefined, id: string) => {
    if (!provider) return id;
    const source = sourceOf(provider);
    if (accountsChanged && source) return accountSuffix(provider, accounts) ?? t(source.name);
    return source ? t(source.name) : provider.displayName;
  };
  return t('handoff.transition', {
    from: label(from, fromProviderId),
    to: label(to, toProviderId),
  });
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
  providers: readonly ProviderProfile[] = [],
  accounts?: readonly AccountState[],
): HandoffDetailRow[] {
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
                  const provider = providers.find((provider) => provider.id === skip.providerId);
                  const source = provider && sourceOf(provider);
                  const name = provider
                    ? source
                      ? sourceTitle(provider, accounts, t(source.name))
                      : provider.displayName
                    : skip.providerId;
                  return `${name} · ${routingReason(skip.reason)}`;
                })
                .join(t('common.listSeparator')),
      });
  }
  if (notice.kind === 'configured') return rows;
  rows.push(...materialRows(notice));
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

/**
 * “来源 · 模型”：订阅写软件名，API 写服务的名字；认不出的照原样。同一来源有多个账号时软件名带账号的标签或序号（0.63.0）。
 */
export function modelLabel(
  providers: readonly ProviderProfile[],
  providerId: string,
  modelId: string,
  accounts?: readonly AccountState[],
): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) return modelId;
  const source = sourceOf(provider);
  const model = provider.models.find((candidate) => candidate.id === modelId);
  const name = source ? sourceTitle(provider, accounts, t(source.name)) : provider.displayName;
  return `${name} · ${model?.displayName ?? modelId}`;
}
