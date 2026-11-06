// 设置 → 听写（0.92.0，Host 功能 `speech`）：转写用哪个（本机模型或 Provider 的转写模型，存在 Host 设置 `speechTranscriber`）、
// 润色开关（`speechPolish`），以及本机模型的下载、取消与删除。模型状态打开时读一次，之后跟着 `speech.changed`。

import { hostSupports } from '@wevir/client-sdk';
import type { HostSettings, SpeechStatus } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import {
  localStatusText,
  parseTranscriberValue,
  transcriberOptions,
  transcriberValue,
} from './dictation-settings-model';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';

/**
 * 听写模型的状态（Host 有 `speech` 时）：打开时读一次，之后跟着 `speech.changed`。设置 → 听写与设置 → 存储的“下载的组件”共用。
 */
export function useSpeechStatus(onError: (reason: unknown) => void) {
  const { client, view } = useHostConnection();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'speech');
  const [status, setStatus] = useState<SpeechStatus>();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    const load = () =>
      client
        .request('speech.status', {})
        .then((result) => {
          if (!stopped) setStatus(result.status);
        })
        .catch((reason: unknown) => {
          if (!stopped) onErrorRef.current(reason);
        });
    void load();
    const unsubscribe = client.onSpeechChanged((change) => {
      if (change === undefined) void load();
      else setStatus(change.status);
    });
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [client, supported]);

  return { client, supported, status };
}

export function DictationSettings() {
  const [notice, setNotice] = useState<Notice>();
  const { client, supported, status } = useSpeechStatus((reason) =>
    setNotice({ tone: 'error', text: describe(reason) }),
  );
  const { settings, update } = useHostSettings();
  const data = useWorkbenchData();
  const [busy, setBusy] = useState(false);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.dictation.unsupported') }} />;
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.dictation.failed', { error: describe(reason) }),
      });
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Partial<HostSettings>) => run(() => update(patch));

  const local = status?.local;
  const localName = local?.modelName ?? t('settings.dictation.local');
  const providers = data.status === 'ready' ? data.providers : [];
  const options = transcriberOptions(
    providers,
    settings.speechTranscriber,
    t('settings.dictation.localOption', { name: localName }),
  );

  return (
    <>
      {notice && (
        <div className="mb-3">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <SettingsSection>
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.dictation.transcriber')}
            data-setting="speech-transcriber"
            control={
              <Select
                className="w-56"
                aria-label={t('settings.dictation.transcriber')}
                value={transcriberValue(settings.speechTranscriber)}
                onValueChange={(value) =>
                  void save({ speechTranscriber: parseTranscriberValue(value) })
                }
                options={options}
              />
            }
          />
          <SettingsRow
            title={t('settings.dictation.polish')}
            data-setting="speech-polish"
            control={
              <Switch
                checked={settings.speechPolish === true}
                label={t('settings.dictation.polish')}
                onChange={(speechPolish) => void save({ speechPolish })}
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.dictation.localModel')}>
        <div className={LIST_CARD}>
          <SettingsRow
            title={localName}
            data-setting="speech-local-model"
            description={local ? localStatusText(local, currentLocale()) : t('common.loading')}
            control={
              local && client ? (
                <LocalModelAction
                  state={local.state}
                  busy={busy}
                  onInstall={() => run(() => client.request('speech.install', {}))}
                  onCancel={() => run(() => client.request('speech.cancelInstall', {}))}
                  onRemove={() => run(() => client.request('speech.uninstall', {}))}
                />
              ) : undefined
            }
          />
        </div>
      </SettingsSection>
    </>
  );
}

export function LocalModelAction({
  state,
  busy,
  onInstall,
  onCancel,
  onRemove,
  installVariant = 'default',
}: {
  state: SpeechStatus['local']['state'];
  busy: boolean;
  /** 下载按钮的样式：设置 → 存储里与别的组件一样用 secondary。 */
  installVariant?: 'default' | 'secondary';
  onInstall: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  switch (state) {
    case 'unsupported':
      return null;
    case 'missing':
    case 'failed':
      return (
        <Button
          size="sm"
          variant={installVariant}
          disabled={busy}
          onClick={onInstall}
          data-action="speech-install"
        >
          {state === 'failed' ? t('settings.dictation.retry') : t('settings.dictation.download')}
        </Button>
      );
    case 'installing':
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
          data-action="speech-cancel"
        >
          {t('common.cancel')}
        </Button>
      );
    case 'ready':
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onRemove}
          data-action="speech-uninstall"
        >
          {t('settings.dictation.remove')}
        </Button>
      );
  }
}
