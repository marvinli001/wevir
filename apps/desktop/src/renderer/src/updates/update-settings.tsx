// 设置 → 关于的“应用”一节（ADR-0007 补记 4）：版本、更新通道、更新状态与操作。

import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { currentLocale, t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { LIST_CARD, Segmented, SettingsRow, SettingsSection } from '@/settings/settings-ui';
import type { UpdateChannel, UpdateState } from '../../../shared/desktop-api.js';
import { UpdateProgress } from './update-progress';
import { useUpdateState } from './update-store';

export function AppUpdateSettings() {
  const state = useUpdateState();
  const format = useMemo(
    () => new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
    [],
  );
  if (state === undefined) return null;
  const disabled = state.phase === 'disabled';
  const lastChecked =
    state.lastCheckedAt === undefined
      ? undefined
      : t('update.lastChecked', { time: format.format(new Date(state.lastCheckedAt)) });
  return (
    <SettingsSection title={t('settings.about.app')}>
      <div className={LIST_CARD}>
        <SettingsRow
          title={t('settings.about.version')}
          control={
            <span className="font-mono text-xs text-muted-foreground" data-testid="app-version">
              {state.currentVersion}
            </span>
          }
        />
        <SettingsRow
          title={t('settings.about.channel')}
          control={
            <Segmented<UpdateChannel>
              label={t('settings.about.channel')}
              value={state.channel}
              disabled={disabled}
              onChange={(channel) => void platformApi().setUpdateChannel(channel)}
              options={[
                { value: 'stable', label: t('settings.about.channel.stable') },
                { value: 'dev', label: t('settings.about.channel.dev') },
              ]}
            />
          }
        />
        <SettingsRow
          title={t('settings.about.update')}
          description={statusText(state) ?? lastChecked}
          data-testid="update-status"
          control={<UpdateAction state={state} />}
        />
      </div>
    </SettingsSection>
  );
}

function statusText(state: UpdateState): string | undefined {
  switch (state.phase) {
    case 'disabled':
      return t(`update.disabled.${state.reason}`);
    case 'idle':
      return undefined;
    case 'checking':
      return t('update.status.checking');
    case 'latest':
      return t('update.status.latest');
    case 'available':
      return t('update.status.available', { version: state.version });
    case 'downloading':
      return t('update.status.downloading', { version: state.version });
    case 'downloaded':
      return t('update.status.downloaded', { version: state.version });
    case 'installing':
      return t('update.status.installing');
    case 'error':
      return t(`update.error.${state.code}`);
  }
}

function UpdateAction({ state }: { state: UpdateState }) {
  switch (state.phase) {
    case 'disabled':
      return state.reason === 'location' ? (
        <Button variant="outline" size="sm" onClick={() => void platformApi().moveToApplications()}>
          {t('update.action.move')}
        </Button>
      ) : null;
    case 'available':
      return (
        <Button size="sm" onClick={() => void platformApi().downloadUpdate()}>
          {t('update.action.download')}
        </Button>
      );
    case 'downloaded':
      return (
        <Button size="sm" onClick={() => void platformApi().installUpdate()}>
          {t('update.action.restart')}
        </Button>
      );
    case 'downloading':
      return <UpdateProgress percent={Math.floor(state.percent)} />;
    case 'installing':
      return null;
    default:
      return (
        <Button
          variant="outline"
          size="sm"
          disabled={state.phase === 'checking'}
          data-testid="update-check"
          onClick={() => void platformApi().checkForUpdates()}
        >
          {t('update.action.check')}
        </Button>
      );
  }
}
