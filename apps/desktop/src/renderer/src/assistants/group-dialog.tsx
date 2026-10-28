// 新建与编辑助理群的对话框（0.132.0）：群名与成员（勾选助理，至少两个）。建好后跳到群的时间线；编辑只把变了的名字与成员交给
// `channel.update`。全局一个（routes/router.tsx 的 AppRoot），`openGroupDialog` 新建、`editGroup` 编辑；助理列表由打开的页面带进来。

import {
  ASSISTANT_NAME_MAX_LENGTH,
  type Channel,
  type ChannelId,
  GROUP_MEMBERS_MAX,
  GROUP_MEMBERS_MIN,
} from '@wevir/protocol';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import { paths } from '@/routes/paths';
import { AssistantAvatar } from './assistant-avatar';

/** 开着时：可选的助理，与要编辑的群（新建时没有）。 */
const open = createStore<{ assistants: Channel[]; edit?: Channel } | undefined>(undefined);

export function openGroupDialog(assistants: Channel[]): void {
  open.set({ assistants });
}

export function editGroup(group: Channel, assistants: Channel[]): void {
  open.set({ assistants, edit: group });
}

export function GroupDialog() {
  const current = open.use();
  return (
    <Dialog open={current !== undefined} onOpenChange={(next) => !next && open.set(undefined)}>
      {current !== undefined && (
        <GroupForm
          key={current.edit?.id ?? 'new'}
          assistants={current.assistants}
          {...(current.edit !== undefined && { group: current.edit })}
          onDone={() => open.set(undefined)}
        />
      )}
    </Dialog>
  );
}

function GroupForm({
  assistants,
  group,
  onDone,
}: {
  assistants: Channel[];
  group?: Channel;
  onDone: () => void;
}) {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const [name, setName] = useState(group?.title ?? '');
  const [members, setMembers] = useState<ChannelId[]>(group?.group?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const before = group?.group?.members ?? [];
  const changed =
    group === undefined ||
    name.trim() !== group.title ||
    members.length !== before.length ||
    members.some((id, index) => id !== before[index]);
  const ready =
    name.trim() !== '' &&
    members.length >= GROUP_MEMBERS_MIN &&
    members.length <= GROUP_MEMBERS_MAX &&
    changed;

  const toggle = (id: ChannelId, checked: boolean) =>
    setMembers((current) =>
      checked
        ? [...current.filter((item) => item !== id), id]
        : current.filter((item) => item !== id),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (client === undefined || !ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (group === undefined) {
        const { channel } = await client.request('channel.create', {
          kind: 'group',
          name: name.trim(),
          members,
        });
        onDone();
        navigate(paths.assistant(channel.id));
      } else {
        await client.request('channel.update', {
          channelId: group.id,
          ...(name.trim() !== group.title && { name: name.trim() }),
          members,
        });
        onDone();
      }
    } catch (reason) {
      setError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="gap-5 p-5 sm:max-w-120" data-testid="group-dialog">
      <DialogTitle className="text-lg font-semibold">
        {t(group === undefined ? 'assistants.group.new' : 'assistants.group.edit')}
      </DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('assistants.group.name')}
          aria-label={t('assistants.group.name')}
          maxLength={ASSISTANT_NAME_MAX_LENGTH}
          autoFocus
          data-field="group-name"
        />
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1.5 text-sm text-soft-foreground">
            {t('assistants.group.members', { count: members.length })}
          </legend>
          {assistants.map((assistant) => {
            const checked = members.includes(assistant.id);
            return (
              <label
                key={assistant.id}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted"
                data-member={assistant.id}
              >
                <Checkbox
                  size="sm"
                  checked={checked}
                  disabled={!checked && members.length >= GROUP_MEMBERS_MAX}
                  onCheckedChange={(next) => toggle(assistant.id, next)}
                />
                {assistant.assistant && (
                  <AssistantAvatar avatar={assistant.assistant.avatar} size={22} />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{assistant.title}</span>
              </label>
            );
          })}
        </fieldset>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!ready || busy} data-action="save-group">
            {t(group === undefined ? 'assistants.dialog.create' : 'assistants.edit.save')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
