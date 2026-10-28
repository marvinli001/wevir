// 新建与编辑助理的对话框（0.120.0）：头像（随机，可换一个）、名字、一句话的职责、模型；编辑时另有可访问的文件夹。建好后跳到它的
// 时间线，Host 马上唤醒它做第一步（“我需要什么”卡片）；编辑只把变了的字段交给 `channel.update`。全局一个（routes/router.tsx 的
// AppRoot），`openAssistantDialog` 新建、`editAssistant` 编辑。

import {
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_FOLDERS_MAX,
  ASSISTANT_NAME_MAX_LENGTH,
  type AssistantAvatar as Avatar,
  type Channel,
} from '@wevir/protocol';
import { Dices } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import { chooseSourceFolder, SourceFolderList } from '@/projects/source-folders';
import { paths } from '@/routes/paths';
import { type ModelChoice, ModelPicker } from '@/session/model-picker';
import { resolveChoice, useModelChoice } from '@/session/start-session';
import { AssistantAvatar } from './assistant-avatar';
import { assistantPatch, randomAvatar, rerollAvatar } from './assistants-model';

/** 开着时：新建（`{}`）或编辑那个助理。 */
const open = createStore<{ edit?: Channel } | undefined>(undefined);

export function openAssistantDialog(): void {
  open.set({});
}

export function editAssistant(channel: Channel): void {
  open.set({ edit: channel });
}

export function AssistantDialog() {
  const current = open.use();
  return (
    <Dialog open={current !== undefined} onOpenChange={(next) => !next && open.set(undefined)}>
      {current?.edit !== undefined ? (
        <EditForm channel={current.edit} onDone={() => open.set(undefined)} />
      ) : (
        current !== undefined && <AssistantForm onDone={() => open.set(undefined)} />
      )}
    </Dialog>
  );
}

function AssistantForm({ onDone }: { onDone: () => void }) {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const models = useModelChoice();
  const [avatar, setAvatar] = useState<Avatar>(() => randomAvatar());
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [picked, setPicked] = useState<ModelChoice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 建对话框时 Provider 还没读到：读到后用默认模型。
  const model = picked ?? models.choice;
  const ready = name.trim() !== '' && job.trim() !== '' && model !== undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (client === undefined || !ready || busy || model === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const { channel } = await client.request('channel.create', {
        kind: 'assistant',
        name: name.trim(),
        description: job.trim(),
        avatar,
        coordinator: {
          providerId: model.providerId,
          ...(model.modelId !== undefined && { modelId: model.modelId }),
          ...(model.reasoningEffort !== undefined && { reasoningEffort: model.reasoningEffort }),
        },
      });
      models.choose(model);
      onDone();
      navigate(paths.assistant(channel.id));
    } catch (reason) {
      setError(t('assistants.createFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="gap-5 p-5 sm:max-w-120" data-testid="assistant-dialog">
      <DialogTitle className="text-lg font-semibold">{t('assistants.dialog.title')}</DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <AssistantAvatar avatar={avatar} size={44} />
          <IconButton
            label={t('assistants.dialog.reroll')}
            onClick={() => setAvatar((current) => rerollAvatar(current))}
            data-action="reroll"
          >
            <Dices />
          </IconButton>
        </div>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('assistants.field.name')}
          aria-label={t('assistants.field.name')}
          maxLength={ASSISTANT_NAME_MAX_LENGTH}
          autoFocus
          data-field="name"
        />
        <Input
          value={job}
          onChange={(event) => setJob(event.target.value)}
          placeholder={t('assistants.field.job')}
          aria-label={t('assistants.field.job')}
          maxLength={ASSISTANT_DESCRIPTION_MAX_LENGTH}
          data-field="job"
        />
        {models.providers && model && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-soft-foreground">{t('assistants.field.model')}</span>
            <ModelPicker providers={models.providers} value={model} onChange={setPicked} />
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!ready || busy} data-action="create">
            {t('assistants.dialog.create')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function EditForm({ channel, onDone }: { channel: Channel; onDone: () => void }) {
  const { client } = useHostConnection();
  const models = useModelChoice();
  const assistant = channel.assistant;
  const [avatar, setAvatar] = useState<Avatar>(() => assistant?.avatar ?? randomAvatar());
  const [name, setName] = useState(channel.title);
  const [job, setJob] = useState(assistant?.description ?? '');
  const [folders, setFolders] = useState<readonly string[]>(assistant?.folders ?? []);
  const [picked, setPicked] = useState<ModelChoice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 现在的模型：协调者没记模型时是那个 Provider 的默认模型。
  const coordinator = channel.coordinator;
  const current =
    models.providers &&
    coordinator !== undefined &&
    resolveChoice(models.providers, {
      providerId: coordinator.providerId,
      modelId: coordinator.modelId ?? '',
      ...(coordinator.reasoningEffort !== undefined && {
        reasoningEffort: coordinator.reasoningEffort,
      }),
    });
  const model = picked ?? current;
  const patch = assistantPatch(channel, {
    name,
    job,
    avatar,
    folders,
    ...(picked !== undefined && { model: picked }),
  });
  const ready = name.trim() !== '' && job.trim() !== '' && patch !== undefined;

  const addFolder = async () => {
    try {
      const folder = await chooseSourceFolder();
      if (folder !== null && !folders.includes(folder)) setFolders([...folders, folder]);
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (client === undefined || !ready || busy || patch === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('channel.update', { channelId: channel.id, ...patch });
      onDone();
    } catch (reason) {
      setError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="gap-5 p-5 sm:max-w-120" data-testid="assistant-edit-dialog">
      <DialogTitle className="text-lg font-semibold">{t('assistants.edit.title')}</DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <AssistantAvatar avatar={avatar} size={44} />
          <IconButton
            label={t('assistants.dialog.reroll')}
            onClick={() => setAvatar((value) => rerollAvatar(value))}
            data-action="reroll"
          >
            <Dices />
          </IconButton>
        </div>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('assistants.field.name')}
          aria-label={t('assistants.field.name')}
          maxLength={ASSISTANT_NAME_MAX_LENGTH}
          data-field="name"
        />
        <Input
          value={job}
          onChange={(event) => setJob(event.target.value)}
          placeholder={t('assistants.field.job')}
          aria-label={t('assistants.field.job')}
          maxLength={ASSISTANT_DESCRIPTION_MAX_LENGTH}
          data-field="job"
        />
        {models.providers && model && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-soft-foreground">{t('assistants.field.model')}</span>
            <ModelPicker providers={models.providers} value={model} onChange={setPicked} />
          </div>
        )}
        {assistant !== undefined && (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-soft-foreground">{t('assistants.field.folders')}</span>
            <SourceFolderList
              folders={folders}
              max={ASSISTANT_FOLDERS_MAX}
              onAdd={() => void addFolder()}
              onRemove={(index) => setFolders(folders.filter((_, at) => at !== index))}
            />
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!ready || busy} data-action="save">
            {t('assistants.edit.save')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
