import { hostSupports } from '@wevir/client-sdk';
import type { MethodParams, WebSettings } from '@wevir/protocol';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  LIST_CARD,
  type Notice,
  NoticeBanner,
  Segmented,
  SettingsRow,
  SettingsSection,
} from './settings-ui';
import { serviceName, testNotice } from './web-settings-model';

/**
 * 设置 → 联网搜索（0.34.0，docs/architecture/web-tools.md）：Agent 的联网工具开关、`web_search` 用的搜索服务（博查 / Tavily）、
 * 所选服务的 API Key（不回显，保存进 Host 的密钥存储）与测试。`web_fetch` 不需要 Key。设置存在 Host，CLI 的 `wevir web` 改的是
 * 同一份；这一页打开时读一次。
 */
export function WebSettingsPage() {
  const { client, view } = useHostConnection();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'web_tools');
  const [web, setWeb] = useState<WebSettings>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | 'settings'>();
  const [notice, setNotice] = useState<Notice>();
  const keyId = useId();

  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    client
      .request('web.get', {})
      .then((result) => {
        if (!stopped) setWeb(result.web);
      })
      .catch((reason: unknown) => {
        if (!stopped) setNotice({ tone: 'error', text: describe(reason) });
      });
    return () => {
      stopped = true;
    };
  }, [client, supported]);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.web.unsupported') }} />;
  }
  if (!client || web === undefined) {
    return notice ? (
      <NoticeBanner notice={notice} />
    ) : (
      <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
    );
  }

  const service = web.searchService;
  const hasKey = web.services.find((entry) => entry.id === service)?.hasKey === true;

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<Notice | undefined>) => {
    setBusy(kind);
    setNotice(undefined);
    try {
      setNotice(await action());
    } catch (reason) {
      setNotice({ tone: 'error', text: t('settings.web.failed', { error: describe(reason) }) });
    } finally {
      setBusy(undefined);
    }
  };

  const update = (params: MethodParams<'web.update'>, done?: Notice) =>
    run(
      params.key === undefined ? 'settings' : params.key.apiKey === null ? 'remove' : 'save',
      async () => {
        const result = await client.request('web.update', params);
        setWeb(result.web);
        return done;
      },
    );

  const save = (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (key === '') return;
    void update(
      { key: { service, apiKey: key } },
      { tone: 'success', text: t('settings.web.saved') },
    ).then(() => setApiKey(''));
  };

  const test = () =>
    run('test', async () => {
      const key = apiKey.trim();
      const result = await client.request('web.test', {
        service,
        ...(key !== '' && { apiKey: key }),
      });
      return testNotice(result);
    });

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
            title={t('settings.web.enabled')}
            data-setting="web-enabled"
            control={
              <Switch
                checked={web.enabled}
                label={t('settings.web.enabled')}
                disabled={busy !== undefined}
                onChange={(enabled) => void update({ enabled })}
              />
            }
          />
          <SettingsRow
            title={t('settings.web.service')}
            data-setting="web-service"
            control={
              <Segmented
                label={t('settings.web.service')}
                value={service}
                disabled={busy !== undefined}
                onChange={(searchService) => {
                  setApiKey('');
                  void update({ searchService });
                }}
                options={web.services.map((entry) => ({
                  value: entry.id,
                  label: serviceName(entry.id),
                }))}
              />
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection>
        <form className={LIST_CARD} onSubmit={save}>
          <SettingsRow
            title={
              <label htmlFor={keyId}>
                {t('settings.web.apiKey', { service: serviceName(service) })}
              </label>
            }
            data-setting="web-key"
            control={
              <>
                <Input
                  id={keyId}
                  type="password"
                  className="w-56 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  placeholder={
                    hasKey
                      ? t('provider.form.apiKeyPlaceholderSet')
                      : t('provider.form.apiKeyPlaceholder')
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy !== undefined || apiKey.trim() === ''}
                  data-action="web-save"
                >
                  {t('settings.web.save')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== undefined || (!hasKey && apiKey.trim() === '')}
                  onClick={() => void test()}
                  data-action="web-test"
                >
                  {busy === 'test' ? t('settings.web.testing') : t('settings.web.test')}
                </Button>
                {hasKey && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy !== undefined}
                    onClick={() =>
                      void update(
                        { key: { service, apiKey: null } },
                        { tone: 'info', text: t('settings.web.removed') },
                      )
                    }
                    data-action="web-remove"
                  >
                    {t('settings.web.remove')}
                  </Button>
                )}
              </>
            }
          />
        </form>
      </SettingsSection>
    </>
  );
}
