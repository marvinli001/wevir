import type { WevirClient } from '@wevir/client-sdk';
import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  type MethodResult,
  NOTIFICATION_KINDS,
} from '@wevir/protocol';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { useSyncPresentation } from './sync-presentation';

type Preview = MethodResult<'sync.previewSettingsMerge'>;
const LABELS: Record<Preview['key'], PlainMessageKey> = {
  sendWhileBusy: 'settings.chat.sendWhileBusy',
  autoMemory: 'settings.memory.auto',
  autoEpisodes: 'settings.episodes.auto',
  ruleFiles: 'settings.chat.ruleFiles',
  agentInstructions: 'settings.personalization.instructions',
  outputStyle: 'settings.personalization.outputStyle',
  writingStyle: 'settings.personalization.writingStyle',
  notifications: 'settings.tab.notifications',
};
function valueText(values: Preview['versions'][number]['values'], key: Preview['key']): string {
  const value = values[key];
  if (key === 'notifications')
    return NOTIFICATION_KINDS.map(
      (kind) =>
        t(`settings.notify.${kind}`) +
        t('common.colon') +
        t(values.notifications?.[kind] === false ? 'sync.valueOff' : 'sync.valueOn'),
    ).join('\n');
  if (typeof value === 'boolean') return t(value ? 'sync.valueOn' : 'sync.valueOff');
  if (key === 'sendWhileBusy')
    return t(
      value === 'steer' ? 'settings.chat.sendWhileBusy.steer' : 'settings.chat.sendWhileBusy.queue',
    );
  if (
    key === 'outputStyle' &&
    [
      'default',
      'concise',
      'explanatory',
      'learning',
      'proactive',
      'pragmatic',
      'friendly',
    ].includes(value as string)
  )
    return t(`outputStyle.${value}` as PlainMessageKey);
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
}
export function ZuvSettingsConflicts({
  client,
  disabled,
  onResolved,
}: {
  client: WevirClient;
  disabled: boolean;
  onResolved: () => Promise<void>;
}) {
  const label = useId();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const { versionLabel: versionText } = useSyncPresentation(client, open);
  const [entries, setEntries] = useState<MethodResult<'sync.settingsConflicts'>['conflicts']>();
  const [next, setNext] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState(''),
    [choice, setChoice] = useState(''),
    [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };
  const load = async (after?: string) => {
    const page = await client.request('sync.settingsConflicts', after ? { after } : {});
    setEntries((current) => (after ? [...(current ?? []), ...page.conflicts] : page.conflicts));
    setNext(page.next);
  };
  const chosen =
    choice === 'local'
      ? preview?.localValues
      : choice === 'merged'
        ? preview?.merged
        : preview?.versions.find((version) => version.opId === choice)?.values;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setPreview(undefined);
          setSelected('');
          setChoice('');
          void run(() => load());
        }}
      >
        {t('sync.settingsConflicts')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('sync.settingsConflicts')}</DialogTitle>
          </DialogHeader>
          {error && (
            <div className="flex items-start gap-2">
              <p role="alert" className="min-w-0 flex-1 break-words text-destructive">
                {error}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={busy || disabled}
                onClick={() => void run(() => load())}
              >
                {t('connection.retry')}
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-1">
            {entries === undefined ? (
              busy && <p>{t('common.loading')}</p>
            ) : entries.length === 0 ? (
              <p>{t('sync.noConflicts')}</p>
            ) : (
              <Select
                value={selected}
                disabled={busy || disabled}
                aria-label={t('sync.settingsConflicts')}
                options={[
                  { value: '', label: t('sync.settings') },
                  ...entries.map((entry) => ({
                    value: entry.entityId,
                    label: t(LABELS[entry.key]),
                  })),
                ]}
                onValueChange={(value) => {
                  setSelected(value);
                  setPreview(undefined);
                  setChoice('');
                  if (value)
                    void run(async () =>
                      setPreview(
                        await client.request('sync.previewSettingsMerge', { entityId: value }),
                      ),
                    );
                }}
              />
            )}
            {next && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => load(next))}
              >
                {t('sync.moreConflicts')}
              </Button>
            )}
            {preview && (
              <>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  {!preview.versions.some((version) => version.opId === preview.localRevision) && (
                    <div className="min-w-0 space-y-1">
                      <span id={`${label}-local`} className="text-xs text-muted-foreground">
                        {t('sync.localVersion')}
                      </span>
                      <Textarea
                        readOnly
                        aria-labelledby={`${label}-local`}
                        value={valueText(preview.localValues, preview.key)}
                        className="h-32 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                      />
                    </div>
                  )}
                  {preview.versions.map((version, index) => (
                    <div key={version.opId} className="min-w-0 space-y-1">
                      <span
                        id={`${label}-${version.opId}`}
                        className="block min-w-0 max-w-full break-words text-xs text-muted-foreground"
                      >
                        {versionText(version, preview.localRevision, index)}
                      </span>
                      <Textarea
                        readOnly
                        aria-labelledby={`${label}-${version.opId}`}
                        value={valueText(version.values, preview.key)}
                        className="h-32 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                      />
                    </div>
                  ))}
                </div>
                <Select
                  value={choice}
                  disabled={busy || disabled}
                  aria-label={t('sync.selectVersion')}
                  options={[
                    { value: '', label: t('sync.selectVersion') },
                    ...preview.versions.map((version, index) => ({
                      value: version.opId,
                      label: versionText(version, preview.localRevision, index),
                    })),
                    ...(!preview.versions.some(
                      (version) => version.opId === preview.localRevision,
                    ) && Object.keys(preview.localValues).length
                      ? [{ value: 'local', label: t('sync.localVersion') }]
                      : []),
                    ...(preview.merged ? [{ value: 'merged', label: t('sync.mergeResult') }] : []),
                    ...(preview.key === 'agentInstructions'
                      ? [{ value: 'manual', label: t('sync.manualMerge') }]
                      : []),
                  ]}
                  onValueChange={(value) => {
                    setChoice(value);
                    const values =
                      value === 'merged'
                        ? preview.merged
                        : value === 'local' || value === 'manual'
                          ? preview.localValues
                          : preview.versions.find(
                              (version) =>
                                version.opId ===
                                (value === 'manual' ? preview.localRevision : value),
                            )?.values;
                    setText(values?.agentInstructions ?? '');
                  }}
                />
                {choice && preview.key === 'agentInstructions' && (
                  <Textarea
                    aria-label={t('settings.personalization.instructions')}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    disabled={busy || disabled}
                    maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
                    className="h-48 resize-none overflow-auto font-mono text-xs [field-sizing:fixed]"
                  />
                )}
                {choice && preview.key !== 'agentInstructions' && chosen && (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {valueText(chosen, preview.key)}
                  </p>
                )}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
            <Button
              disabled={busy || disabled || !preview || !choice}
              onClick={() => {
                if (!preview) return;
                const values =
                  preview.key === 'agentInstructions' ? { agentInstructions: text } : chosen;
                if (!values) return;
                void run(async () => {
                  await client.request('sync.resolveSettings', { ...preview, values });
                  setPreview(undefined);
                  setSelected('');
                  setChoice('');
                  await load();
                  await onResolved();
                });
              }}
            >
              {t('sync.useVersion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
