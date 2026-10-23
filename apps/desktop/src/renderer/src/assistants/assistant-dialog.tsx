// 新建助理的对话框（0.120.0）：头像（随机，可换一个）、名字、一句话的职责、模型。建好后跳到它的时间线，Host 马上唤醒它做第一步
// （“我需要什么”卡片）。全局一个（routes/router.tsx 的 AppRoot），`openAssistantDialog` 打开。

import {
  ASSISTANT_DESCRIPTION_MAX_LENGTH,
  ASSISTANT_NAME_MAX_LENGTH,
  type AssistantAvatar as Avatar,
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
import { paths } from '@/routes/paths';
import { type ModelChoice, ModelPicker } from '@/session/model-picker';
import { useModelChoice } from '@/session/start-session';
import { AssistantAvatar } from './assistant-avatar';
import { randomAvatar, rerollAvatar } from './assistants-model';

const open = createStore(false);

export function openAssistantDialog(): void {
  open.set(true);
}

export function AssistantDialog() {
  const current = open.use();
  return (
    <Dialog open={current} onOpenChange={(next) => open.set(next)}>
      {current && <AssistantForm onDone={() => open.set(false)} />}
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
