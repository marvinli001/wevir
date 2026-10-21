// 设置 → 个性化 → 写作（0.95.0，Host 功能 `writing_style`，domain-model §3.43）：“参考我的写作风格”的开关（Host 设置的
// `writingStyle`），与 Agent 建好的写作风格档案（`writingStyle.*`：查看与编辑、删除）。档案只有一份，对所有项目有效；改动从下一次
// 建会话、恢复或接力起生效。编辑带着读到的版本保存，期间被 Agent 改过时留着草稿并列出现在的版本，由用户选覆盖或放弃。

import type { WritingStyleProfile } from '@wevir/protocol';
import { WRITING_STYLE_MAX_LENGTH } from '@wevir/protocol';
import { cn } from 'cn';
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

/**
 * 档案的编辑框：改动后才能保存。保存带着读到的版本，期间被改过（Agent 存了、别的窗口改了）时不写，草稿留着，上面列出现在的版本，
 * 由用户选“用草稿覆盖”或“放弃草稿”（同记忆的编辑框）。
 */
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
  const [conflict, setConflict] = useState<WritingStyleProfile>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const save = async (revision: string) => {
    if (!client) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await client.request('writingStyle.update', { content: draft, revision });
      onSaved(result.profile);
      if (result.conflict) {
        setBase(result.profile);
        setConflict(result.profile);
        return;
      }
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() !== '' && draft !== base.content) void save(base.revision);
  };

  const discard = () => {
    if (!conflict) return;
    setDraft(conflict.content);
    setConflict(undefined);
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
          {conflict && (
            <div
              className="space-y-2 rounded-lg bg-warning/10 px-3 py-2 text-sm"
              data-writing-conflict
            >
              <p className="text-warning">
                {t('settings.personalization.writingProfile.conflict')}
              </p>
              <p className="text-xs font-medium">{t('settings.memory.conflict.current')}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-card p-2 font-mono text-xs">
                {conflict.content}
              </pre>
            </div>
          )}
          <Textarea
            aria-label={t('settings.personalization.writingProfile')}
            value={draft}
            maxLength={WRITING_STYLE_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            className={cn(
              'font-mono text-xs md:text-xs',
              conflict ? 'max-h-64 min-h-40' : 'max-h-[60vh] min-h-64',
            )}
            data-writing-profile
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {conflict ? t('common.close') : t('common.cancel')}
            </Button>
            {conflict ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={discard}
                  disabled={busy}
                  data-action="discard-draft"
                >
                  {t('settings.memory.conflict.discard')}
                </Button>
                <Button
                  type="button"
                  onClick={() => void save(conflict.revision)}
                  disabled={busy || draft.trim() === ''}
                  data-action="overwrite-writing-profile"
                >
                  {t('settings.memory.conflict.overwrite')}
                </Button>
              </>
            ) : (
              <Button
                type="submit"
                disabled={busy || draft.trim() === '' || draft === base.content}
                data-confirm
              >
                {t('settings.personalization.save')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
