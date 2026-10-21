// 设置 → 个性化 → 写作（0.95.0，Host 功能 `writing_style`，domain-model §3.43）：“参考我的写作风格”的开关（Host 设置的
// `writingStyle`），与 Agent 建好的写作风格档案（`writingStyle.*`：查看与编辑、删除）。档案只有一份，对所有项目有效；改动从下一次
// 建会话、恢复或接力起生效。编辑带着读到的版本保存，期间被 Agent 改过时留着草稿，再存一次就覆盖。

import type { WritingStyleProfile } from '@wevir/protocol';
import { WRITING_STYLE_MAX_LENGTH } from '@wevir/protocol';
import { Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';

export function WritingStyleSettings({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (writingStyle: boolean) => void;
}) {
  const { client } = useHostConnection();
  const [profile, setProfile] = useState<WritingStyleProfile | null>();
  const [notice, setNotice] = useState<Notice>();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.request('writingStyle.get', {});
      setProfile(result.profile ?? null);
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.personalization.writingProfile.loadFailed', { error: describe(reason) }),
      });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!client) return;
    await client.request('writingStyle.delete', {});
    setProfile(null);
  };

  return (
    <SettingsSection title={t('settings.personalization.writing')} data-section="writing">
      {notice && (
        <div className="mb-3">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <div className={LIST_CARD}>
        <SettingsRow
          title={t('settings.personalization.writingStyle')}
          data-setting="writing-style"
          control={
            <Switch
              label={t('settings.personalization.writingStyle')}
              checked={enabled}
              onChange={onToggle}
            />
          }
        />
        {profile !== undefined && (
          <SettingsRow
            title={t('settings.personalization.writingProfile')}
            description={
              profile === null
                ? t('settings.personalization.writingProfile.missing')
                : updatedText(profile.updatedAt)
            }
            data-setting="writing-profile"
            control={
              profile !== null && (
                <>
                  <IconButton
                    label={t('settings.personalization.writingProfile.edit')}
                    onClick={() => setEditing(true)}
                    data-action="edit-writing-profile"
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label={t('settings.personalization.writingProfile.delete')}
                    onClick={() => setDeleting(true)}
                    data-action="delete-writing-profile"
                  >
                    <Trash2 />
                  </IconButton>
                </>
              )
            }
          />
        )}
      </div>
      {editing && profile && (
        <ProfileEditor
          profile={profile}
          onSaved={setProfile}
          onClose={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('settings.personalization.writingProfile.deleteTitle')}
        confirmLabel={t('settings.personalization.writingProfile.delete')}
        onConfirm={remove}
        failure={(error) => t('settings.personalization.writingProfile.deleteFailed', { error })}
      >
        <p>{t('settings.memory.deleteBody')}</p>
      </ConfirmDialog>
    </SettingsSection>
  );
}

function updatedText(updatedAt: string): string | undefined {
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return undefined;
  const format = new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return t('settings.personalization.writingProfile.updated', {
    time: format.format(new Date(time)),
  });
}

/** 档案的编辑框：改动后才能保存；被别处改过时提示并换成新的版本，草稿留着，再存一次就覆盖。 */
function ProfileEditor({
  profile,
  onSaved,
  onClose,
}: {
  profile: WritingStyleProfile;
  onSaved: (profile: WritingStyleProfile) => void;
  onClose: () => void;
}) {
  const { client } = useHostConnection();
  const [draft, setDraft] = useState(profile.content);
  const [base, setBase] = useState(profile);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await client.request('writingStyle.update', {
        content: draft,
        revision: base.revision,
      });
      if (result.conflict) {
        setBase(result.profile);
        onSaved(result.profile);
        setNotice({ tone: 'warning', text: t('settings.personalization.writingProfile.conflict') });
        return;
      }
      onSaved(result.profile);
      onClose();
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.personalization.saveFailed', { error: describe(reason) }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('settings.personalization.writingProfile')}</DialogTitle>
            <DialogDescription>{updatedText(base.updatedAt)}</DialogDescription>
          </DialogHeader>
          {notice && <NoticeBanner notice={notice} />}
          <Textarea
            aria-label={t('settings.personalization.writingProfile')}
            value={draft}
            maxLength={WRITING_STYLE_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            className="max-h-[60vh] min-h-64 font-mono text-xs md:text-xs"
            data-writing-profile
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || draft.trim() === '' || draft === base.content}
              data-confirm
            >
              {t('settings.personalization.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
