import type { WevirClient } from '@wevir/client-sdk';
import type { PendingMessage, SessionId, SessionState } from '@wevir/protocol';
import { cn } from 'cn';
import { CornerDownRight, ListPlus, Lock, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describe as describeError } from '@/host/host-connection';
import { t } from '@/i18n';
import { canSteerNow, fallbackNote, groupPending, pendingText } from './pending-model';

/**
 * 输入框上方的待发区（R11，domain-model §3.3.2）：插话（等这一步结束）、排队（回合结束后）、已暂停三组。排队的与暂停的
 * 可以编辑、删除，排队的在回合进行中可以改为插话；交给模型的插话只能看。暂停的有“继续发送”。没有待发消息时不显示。
 */
export function PendingArea({
  sessionId,
  pending,
  state,
  client,
  onError,
}: {
  sessionId: SessionId;
  pending: readonly PendingMessage[];
  state: SessionState | undefined;
  client: WevirClient | undefined;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState<string>();
  if (pending.length === 0) return null;
  const groups = groupPending(pending);

  const run = async (op: (client: WevirClient) => Promise<unknown>) => {
    if (!client) return;
    try {
      await op(client);
    } catch (error) {
      onError(t('pending.failed', { error: describeError(error) }));
    }
  };
  const item = (message: PendingMessage, actions: ReactNode) =>
    editing === message.id ? (
      <PendingEditor
        key={message.id}
        message={message}
        onCancel={() => setEditing(undefined)}
        onSave={(text) =>
          run(async (c) => {
            await c.request('pending.update', {
              sessionId,
              pendingId: message.id,
              content: [{ type: 'text', text }],
            });
            setEditing(undefined);
          })
        }
      />
    ) : (
      <PendingRow key={message.id} message={message} actions={actions} />
    );
  const editable = (message: PendingMessage, toSteer: boolean) => (
    <>
      {toSteer && (
        <IconButton
          label={t('pending.toSteer')}
          size="icon-xs"
          onClick={() =>
            run((c) =>
              c.request('pending.update', { sessionId, pendingId: message.id, delivery: 'steer' }),
            )
          }
        >
          <CornerDownRight />
        </IconButton>
      )}
      <IconButton label={t('pending.edit')} size="icon-xs" onClick={() => setEditing(message.id)}>
        <Pencil />
      </IconButton>
      <IconButton
        label={t('pending.remove')}
        size="icon-xs"
        onClick={() =>
          run((c) => c.request('pending.cancel', { sessionId, pendingId: message.id }))
        }
      >
        <Trash2 />
      </IconButton>
    </>
  );

  return (
    <section
      aria-label={t('pending.label')}
      className="mb-2 space-y-2 rounded-xl border border-border bg-muted/40 px-3 py-2"
      data-testid="pending-area"
    >
      {groups.steer.length > 0 && (
        <PendingGroup icon={<CornerDownRight />} title={t('pending.group.steer')} delivery="steer">
          {groups.steer.map((message) =>
            item(
              message,
              <span className="text-muted-foreground" title={t('pending.steerLocked')}>
                <Lock className="size-3.5" aria-label={t('pending.steerLocked')} />
              </span>,
            ),
          )}
        </PendingGroup>
      )}
      {groups.queue.length > 0 && (
        <PendingGroup icon={<ListPlus />} title={t('pending.group.queue')} delivery="queue">
          {groups.queue.map((message) => item(message, editable(message, canSteerNow(state))))}
        </PendingGroup>
      )}
      {groups.held.length > 0 && (
        <PendingGroup
          icon={<Pause />}
          title={t('pending.group.held')}
          delivery="held"
          action={
            <Button
              size="xs"
              variant="outline"
              disabled={!client || state === 'error' || state === 'closed'}
              onClick={() => run((c) => c.request('pending.resume', { sessionId }))}
            >
              <Play data-icon="inline-start" />
              {t('pending.resume')}
            </Button>
          }
          hint={t('pending.heldHint')}
        >
          {groups.held.map((message) => item(message, editable(message, false)))}
        </PendingGroup>
      )}
    </section>
  );
}

function PendingGroup({
  icon,
  title,
  delivery,
  action,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  delivery: 'steer' | 'queue' | 'held';
  action?: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div data-pending-group={delivery}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span className="flex-1">{title}</span>
        {action}
      </div>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <ul className="mt-1 space-y-1">{children}</ul>
    </div>
  );
}

function PendingRow({ message, actions }: { message: PendingMessage; actions: ReactNode }) {
  const note = fallbackNote(message);
  return (
    <li
      className="group flex items-start gap-2 rounded-lg bg-background/70 px-2.5 py-1.5"
      data-pending-id={message.id}
    >
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-sm whitespace-pre-wrap break-words">
          {pendingText(message)}
        </p>
        {note && (
          <p className="mt-0.5 text-xs text-warning" title={message.fallback?.message}>
            {note}
          </p>
        )}
      </div>
      <div className={cn('flex shrink-0 items-center gap-0.5')}>{actions}</div>
    </li>
  );
}

function PendingEditor({
  message,
  onSave,
  onCancel,
}: {
  message: PendingMessage;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => pendingText(message));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (text.trim() === '' || saving) return;
    setSaving(true);
    try {
      await onSave(text.trim());
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc 只取消编辑，不停止回合（输入框的 Esc 看 defaultPrevented）。
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };
  return (
    <li className="rounded-lg bg-background px-2.5 py-1.5" data-pending-id={message.id}>
      <Textarea
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={t('pending.edit')}
        className="max-h-40 min-h-12 resize-none text-sm"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">{t('pending.editHint')}</span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {t('pending.cancelEdit')}
        </Button>
        <Button size="xs" disabled={text.trim() === '' || saving} onClick={() => void save()}>
          {t('pending.save')}
        </Button>
      </div>
    </li>
  );
}
