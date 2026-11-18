import { accountId, type WevirClient } from '@wevir/client-sdk';
import { ACCOUNT_LABEL_MAX_LENGTH, type AccountState, type Session } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, LoaderCircle, Plus, Tag, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AccountBadge } from '@/components/account-badge';
import { AnimatedRows } from '@/components/animated-rows';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type SourceInfo, sourceTitle } from '@/data/sources';
import { type PlainMessageKey, t } from '@/i18n';
import { openSessions, removeClosingSessions } from './remove';

// 订阅的多个账号（0.63.0）：一种来源有好几个账号时详情顶部是账号的切换条（角标、邮箱、状态），选中的账号的登录、用量与模型在下面；
// 账号的操作是标签、删除（只有添加的账号）与添加账号。账号彼此隔离，凭据与会话各在 Host 数据目录里自己的目录。

/** 标签的预设（像 iOS 双卡的“主号”“副号”）；也可以自己写。 */
export const LABEL_PRESETS: readonly PlainMessageKey[] = [
  'source.account.preset.primary',
  'source.account.preset.secondary',
  'source.account.preset.personal',
  'source.account.preset.work',
];

/** 切换条上一个账号的名字：邮箱，没有邮箱时用“名字 2”这类区分（`sourceTitle`）。 */
function chipText(
  source: SourceInfo,
  account: AccountState,
  accounts: readonly AccountState[],
): string {
  if (account.email !== undefined) return account.email;
  return sourceTitle(
    { id: accountId(account), kind: account.kind },
    accounts.map((each) => ({ ...each, label: undefined })),
    t(source.name),
  );
}

export function AccountSwitcher({
  source,
  accounts,
  selected,
  onSelect,
  adding,
  onAdd,
  labeling,
  onLabel,
  onRemove,
  compact = false,
}: {
  source: SourceInfo;
  accounts: readonly AccountState[];
  selected: string;
  onSelect: (id: string) => void;
  adding: boolean;
  onAdd: (() => void) | undefined;
  labeling: boolean;
  onLabel: ((account: AccountState, label: string | null) => Promise<void>) | undefined;
  onRemove: ((account: AccountState) => void) | undefined;
  compact?: boolean;
}) {
  return (
    <AnimatedRows
      as="div"
      role="tablist"
      aria-label={t('source.account.list')}
      className="mt-4 flex flex-wrap items-center gap-1.5"
      data-account-switcher
      items={accounts}
      keyOf={accountId}
      tail={
        onAdd !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={adding}
            onClick={onAdd}
            data-action="add-account"
          >
            {adding ? <LoaderCircle className="animate-spin" /> : <Plus />}
            {t('source.account.add')}
          </Button>
        ) : undefined
      }
    >
      {(account) => {
        const id = accountId(account);
        const active = id === selected;
        const text = chipText(source, account, accounts);
        return (
          <div
            className={cn(
              'flex h-7 max-w-56 items-center rounded-md border border-border bg-background transition-colors duration-150',
              active && 'bg-selected',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(id)}
              data-account={id}
              title={account.label && !compact ? `${account.label} · ${text}` : text}
              className="flex size-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-accent/50 focus-visible:focus-field"
            >
              {account.label !== undefined ? (
                compact ? (
                  <AccountBadge label={account.label} size="sm" />
                ) : (
                  <span className="max-w-[40%] shrink-0 truncate font-medium">{account.label}</span>
                )
              ) : (
                <StatusDot
                  tone={account.status === 'signed_in' ? 'success' : 'neutral'}
                  label={t(
                    account.status === 'signed_in'
                      ? 'source.status.signedIn'
                      : 'source.status.signedOut',
                  )}
                  className="size-1.5"
                />
              )}
              <span
                className="truncate"
                data-account-email={account.email !== undefined || undefined}
              >
                {text}
              </span>
              {account.localLogin === true && (
                <span className="shrink-0 text-muted-foreground">{t('source.account.local')}</span>
              )}
            </button>
            {active && onLabel && (
              <AccountLabelControl
                account={account}
                disabled={labeling}
                onChange={(label) => onLabel(account, label)}
                onRemove={id !== account.kind && onRemove ? () => onRemove(account) : undefined}
              />
            )}
          </div>
        );
      }}
    </AnimatedRows>
  );
}

/** 标签：小弹层里选预设、自己写，或去掉。 */
function AccountLabelControl({
  account,
  disabled,
  onChange,
  onRemove,
}: {
  account: AccountState;
  disabled: boolean;
  onChange: (label: string | null) => Promise<void>;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const current = account.label;
  const pick = async (label: string | null) => {
    setOpen(false);
    if (label === (current ?? null)) return;
    await onChange(label);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const label = draft.trim();
    if (label !== '') void pick(label);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(current ?? '');
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="mr-0.5 shrink-0"
            aria-label={t('source.account.label')}
            disabled={disabled}
            data-action="account-label"
          />
        }
      >
        <Tag />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-1.5 p-1.5" data-account-label-editor>
        <ul className="flex flex-col">
          {LABEL_PRESETS.map((key) => {
            const label = t(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => void pick(label)}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <AccountBadge label={label} />
                  <span className="flex-1 truncate">{label}</span>
                  {label === current && <Check className="size-3.5" />}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => void pick(null)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
            >
              <span className="size-4" aria-hidden />
              <span className="flex-1 truncate">{t('source.account.labelNone')}</span>
              {current === undefined && <Check className="size-3.5" />}
            </button>
          </li>
        </ul>
        <form onSubmit={submit} className="flex gap-1.5 border-t border-border pt-1.5">
          <Input
            value={draft}
            maxLength={ACCOUNT_LABEL_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('source.account.labelCustom')}
            className="h-7 text-sm"
          />
          <Button type="submit" size="sm" className="h-7" disabled={draft.trim() === ''}>
            {t('source.account.labelSave')}
          </Button>
        </form>
        {onRemove && (
          <Button
            variant="ghost"
            size="sm"
            className="justify-start"
            data-action="remove-account"
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <Trash2 data-icon="inline-start" />
            {t('source.account.remove')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** 删除添加的账号：确认框写明后果；有没关闭的会话时先关闭它们。 */
export function RemoveAccountDialog({
  client,
  title,
  account,
  sessions,
  onClose,
  onRemoved,
}: {
  client: WevirClient;
  title: string;
  account: AccountState;
  sessions: readonly Session[];
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const id = accountId(account);
  const open = openSessions(sessions.filter((session) => session.providerId === id));
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('source.account.remove.title', { name: title })}
      confirmLabel={t('source.account.remove.confirm')}
      onConfirm={async () => {
        await removeClosingSessions(client, () => client.request('account.remove', { id }));
        await onRemoved();
      }}
      failure={(error) => t('source.account.remove.failed', { error })}
    >
      <p>{t('source.account.remove.body')}</p>
      {open.length > 0 && <p>{t('provider.remove.openSessions', { count: open.length })}</p>}
    </ConfirmDialog>
  );
}
