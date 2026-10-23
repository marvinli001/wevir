// 设置 → 电脑操作（0.114.0，Host 功能 `computer_use`）：电脑操作工具的开关（Host 设置的 `computerUse`，默认关）与 macOS 的两项
// 系统权限（屏幕录制、辅助功能）的状态，没允许的给一个按钮：请系统弹框并打开系统设置里那一页。权限归在 Wevir.app 上，由主进程
// 拉起的 helper 查询；窗口回到前台时重读（用户从系统设置回来）。

import { hostSupports } from '@wevir/client-sdk';
import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import type { ComputerStatus } from '../../../shared/desktop-api';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';

const UNSUPPORTED = {
  platform: 'settings.computerUse.unsupported.platform',
  macos: 'settings.computerUse.unsupported.macos',
  helper: 'settings.computerUse.unsupported.build',
} as const;

export function ComputerSettings() {
  const { view } = useHostConnection();
  const { settings, update } = useHostSettings();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'computer_use');
  const [status, setStatus] = useState<ComputerStatus>();
  const [notice, setNotice] = useState<Notice>();

  const read = useCallback(() => {
    platformApi()
      ?.computer.status()
      .then(setStatus)
      .catch((reason: unknown) => setNotice({ tone: 'error', text: describe(reason) }));
  }, []);

  useEffect(() => {
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [read]);

  if (!supported) {
    return (
      <NoticeBanner notice={{ tone: 'info', text: t('settings.computerUse.unsupported.host') }} />
    );
  }
  if (status !== undefined && !status.supported) {
    return (
      <NoticeBanner notice={{ tone: 'info', text: t(UNSUPPORTED[status.reason ?? 'platform']) }} />
    );
  }

  const save = async (computerUse: boolean) => {
    setNotice(undefined);
    try {
      await update({ computerUse });
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.computerUse.saveFailed', { error: describe(reason) }),
      });
    }
  };

  const ask = (kind: 'screen_recording' | 'accessibility') => {
    platformApi()
      ?.computer.requestPermission(kind)
      .then(setStatus)
      .catch((reason: unknown) => setNotice({ tone: 'error', text: describe(reason) }));
  };

  const permission = (
    kind: 'screen_recording' | 'accessibility',
    granted: boolean | undefined,
    title: string,
    description?: string,
  ) => (
    <SettingsRow
      title={title}
      {...(description !== undefined && { description })}
      data-setting={kind}
      control={
        granted === undefined ? undefined : granted ? (
          <span className="text-sm text-muted-foreground">{t('settings.computerUse.granted')}</span>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">
              {t('settings.computerUse.missing')}
            </span>
            <Button variant="outline" size="sm" onClick={() => ask(kind)}>
              {t('settings.computerUse.openSettings')}
            </Button>
          </>
        )
      }
    />
  );

  return (
    <>
      <SettingsSection>
        {notice && (
          <div className="mb-3">
            <NoticeBanner notice={notice} />
          </div>
        )}
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.computerUse.enabled')}
            data-setting="computer-use"
            control={
              <Switch
                label={t('settings.computerUse.enabled')}
                checked={settings.computerUse === true}
                onChange={(checked) => void save(checked)}
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.computerUse.permissions')}>
        <div className={LIST_CARD}>
          {permission(
            'screen_recording',
            status?.screenRecording,
            t('settings.computerUse.screenRecording'),
            status?.screenRecording === false ? t('settings.computerUse.relaunchNote') : undefined,
          )}
          {permission(
            'accessibility',
            status?.accessibility,
            t('settings.computerUse.accessibility'),
          )}
        </div>
      </SettingsSection>
    </>
  );
}
