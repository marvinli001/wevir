import { hostSupports } from '@wevir/client-sdk';
import { type GatewayPrivacySettings, GatewayPrivacySettingsSchema } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';

export function PrivacySettings() {
  const { view } = useHostConnection();
  const { settings, editable, update } = useHostSettings();
  const privacy = settings.gatewayPrivacy ?? {};
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'gateway_privacy');
  const savedRules = (privacy.excludedPatterns ?? []).join('\n');
  const [rules, setRules] = useState(savedRules);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => setRules(savedRules), [savedRules]);

  const save = async (patch: Partial<GatewayPrivacySettings>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const next = { ...privacy, ...patch };
      if (!GatewayPrivacySettingsSchema.safeParse(next).success)
        throw new Error(t('settings.privacy.invalidRules'));
      await update({ gatewayPrivacy: next });
    } catch (reason) {
      setNotice({ tone: 'error', text: t('settings.privacy.failed', { error: describe(reason) }) });
    } finally {
      setBusy(false);
    }
  };

  const addValue = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      const hash = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      await update({
        gatewayPrivacy: {
          ...privacy,
          excludedValueHashes: [...new Set([...(privacy.excludedValueHashes ?? []), hash])],
        },
      });
      setValue('');
    } catch (reason) {
      setNotice({ tone: 'error', text: t('settings.privacy.failed', { error: describe(reason) }) });
    } finally {
      setBusy(false);
    }
  };

  if (!supported)
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.privacy.unsupported') }} />;
  const disabled = !editable || busy;
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
            title={t('settings.privacy.enabled')}
            control={
              <Switch
                label={t('settings.privacy.enabled')}
                checked={privacy.enabled === true}
                disabled={disabled}
                onChange={(enabled) => void save({ enabled })}
                data-action="gateway-privacy"
              />
            }
          />
          <SettingsRow
            title={t('settings.privacy.coverage')}
            control={
              <span className="text-sm text-muted-foreground">{t('settings.privacy.covered')}</span>
            }
          />
          <SettingsRow
            title={t('settings.privacy.excluded')}
            control={
              <span className="text-sm text-muted-foreground">{t('settings.privacy.outside')}</span>
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.privacy.exemptValues')}>
        <div className={LIST_CARD}>
          <form
            className="flex gap-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void addValue();
            }}
          >
            <Input
              type="password"
              aria-label={t('settings.privacy.exemptValue')}
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={disabled}
              maxLength={65536}
            />
            <Button
              size="sm"
              type="submit"
              disabled={
                disabled || value === '' || (privacy.excludedValueHashes?.length ?? 0) >= 100
              }
            >
              {t('settings.privacy.add')}
            </Button>
          </form>
          {(privacy.excludedValueHashes ?? []).map((hash) => (
            <SettingsRow
              key={hash}
              title={<code className="font-mono text-xs">{hash.slice(0, 12)}</code>}
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    void save({
                      excludedValueHashes: privacy.excludedValueHashes?.filter(
                        (item) => item !== hash,
                      ),
                    })
                  }
                >
                  {t('settings.privacy.remove')}
                </Button>
              }
            />
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.privacy.exemptRules')}>
        <div className="space-y-3">
          <Textarea
            aria-label={t('settings.privacy.exemptRules')}
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            disabled={disabled}
            spellCheck={false}
            className="min-h-28 font-mono text-xs md:text-xs"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={disabled || rules === savedRules}
              onClick={() =>
                void save({ excludedPatterns: rules.split(/\r?\n/).filter((rule) => rule !== '') })
              }
            >
              {t('settings.privacy.save')}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </>
  );
}
