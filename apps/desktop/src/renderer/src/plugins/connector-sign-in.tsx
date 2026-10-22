// 连接器行里的登录控件（0.97.0）：要登录时是“登录”，正在登录时是“取消登录”（只有这个窗口发起的能取消）。不用 OAuth 或
// 已登录的不显示。

import type { Connector } from '@wevir/protocol';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { canCancelSignIn, cancelSignIn, signInConnector } from './connector-login';
import { usePluginsContext } from './plugins-context';
import { needsSignIn } from './plugins-model';

export function ConnectorSignIn({
  connector,
  disabled,
}: {
  connector: Connector;
  disabled?: boolean;
}) {
  const { client, busy, run } = usePluginsContext();
  if (canCancelSignIn(connector)) {
    return (
      <Button
        variant="ghost"
        size="xs"
        disabled={busy.has(connector.id)}
        onClick={() =>
          run(
            connector.id,
            () => cancelSignIn(client, connector),
            (error) => t('plugins.connector.signIn.failed', { error }),
          )
        }
        data-action="cancel-sign-in"
      >
        {t('plugins.connector.signIn.cancel')}
      </Button>
    );
  }
  if (!needsSignIn(connector)) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={disabled === true || busy.has(connector.id)}
      onClick={() =>
        run(
          connector.id,
          () => signInConnector(client, connector),
          (error) => t('plugins.connector.signIn.failed', { error }),
        )
      }
      data-action="sign-in"
    >
      {t('plugins.connector.signIn')}
    </Button>
  );
}
