// “连接器”分段（0.42.0，desktop-layout.md §23）：用户加的与插件带的 MCP 连接器，状态、开关、详情（工具、配置）、编辑与删除。

import type { Connector, Plugin } from '@wevir/protocol';
import { cn } from 'cn';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { currentLocale, t } from '@/i18n';
import { IMPORT_APP_LABEL } from '@/settings/import-model';
import { EmptyList, LIST_CARD } from '@/settings/settings-ui';
import { signInConnector, signOutConnector } from './connector-login';
import { ConnectorSignIn } from './connector-sign-in';
import { removeConnector, setConnectorEnabled } from './plugin-actions';
import { ConfigLine, DetailActions, DetailSection, ExpandableRow, MonoBlock } from './plugin-rows';
import { usePluginsContext } from './plugins-context';
import {
  byName,
  CONNECTOR_STATE_LABEL,
  commandLine,
  connectorState,
  missingSecretKeys,
  originName,
} from './plugins-model';

export function ConnectorList({
  expanded,
  onExpand,
}: {
  expanded: string | undefined;
  onExpand: (id: string | undefined) => void;
}) {
  const { list } = usePluginsContext();
  if (list.connectors.length === 0) return <EmptyList>{t('plugins.empty.connectors')}</EmptyList>;
  return (
    <ul className={cn(LIST_CARD, 'overflow-hidden')} data-testid="connector-list">
      {byName(list.connectors).map((connector) => (
        <ConnectorRow
          key={connector.id}
          connector={connector}
          expanded={expanded === connector.id}
          onToggle={() => onExpand(expanded === connector.id ? undefined : connector.id)}
        />
      ))}
    </ul>
  );
}

function ConnectorRow({
  connector,
  expanded,
  onToggle,
}: {
  connector: Connector;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { client, data, plugins, busy, run, scoped, workspaces, editConnector } =
    usePluginsContext();
  const plugin = connector.pluginId === undefined ? undefined : plugins.get(connector.pluginId);
  const state = connectorState(connector, plugin);
  const origin =
    originName(connector.pluginId, plugins) ??
    (connector.importedFrom && t(IMPORT_APP_LABEL[connector.importedFrom.app]));
  const stateLabel = t(CONNECTOR_STATE_LABEL[state.key]);
  // 名称下面的小字：范围（全局或项目名），来自哪个插件或应用。
  const scope = scoped
    ? connector.workspaceId === undefined
      ? t('plugins.scope.global')
      : (workspaces.find((entry) => entry.id === connector.workspaceId)?.label ??
        connector.workspaceId)
    : undefined;
  const meta = [scope, origin !== undefined && t('plugins.from', { name: origin })]
    .filter(Boolean)
    .join(' · ');
  const fill = missingSecretKeys(connector).length > 0;
  return (
    <ExpandableRow
      id={connector.id}
      expanded={expanded}
      onToggle={onToggle}
      leading={
        <span className="flex w-8 shrink-0 justify-center">
          <StatusDot tone={state.tone} pulse={state.pulse} label={stateLabel} />
        </span>
      }
      title={
        <>
          {connector.name}
          <span className="ml-2 rounded-sm bg-muted px-1.5 text-[11px] leading-4.5 font-normal text-muted-foreground">
            {t(`plugins.connector.transport.${connector.config.transport}`)}
          </span>
        </>
      }
      meta={meta}
      summary={stateLabel}
      control={
        <>
          <ConnectorSignIn connector={connector} disabled={state.key === 'disabled'} />
          {fill && (
            <Button
              variant="outline"
              size="xs"
              className="border-warning/40 text-warning"
              onClick={() => editConnector(connector)}
              data-action="fill-connector"
            >
              {t('plugins.secret.missing')}
            </Button>
          )}
          <Switch
            checked={connector.enabled}
            label={t('plugins.connector.enabled', { name: connector.name })}
            disabled={plugin?.enabled === false || busy.has(connector.id)}
            onChange={(next) =>
              run(
                connector.id,
                () => setConnectorEnabled(client, data, connector.id, next),
                (error) => t('plugins.toggleFailed', { error }),
              )
            }
            data-action="toggle-connector"
          />
        </>
      }
    >
      <ConnectorDetail connector={connector} plugin={plugin} />
    </ExpandableRow>
  );
}

function ConnectorDetail({ connector, plugin }: { connector: Connector; plugin?: Plugin }) {
  const { client, data, busy, run, notify, openPlugin, editConnector } = usePluginsContext();
  const { oauth } = connector;
  const [confirming, setConfirming] = useState(false);
  // 插件连接器缺的是插件的输入项；散装的（导入的）缺的是环境变量或请求头的值，在配置里逐键标出。
  const missing = connector.pluginId === undefined ? [] : (connector.missingInputs ?? []);
  const tools = connector.tools ?? [];
  return (
    <>
      {missing.length > 0 && (
        <p className="text-sm text-warning" data-missing-inputs>
          {t('plugins.connector.missing', { keys: missing.join(', ') })}
        </p>
      )}
      <DetailSection title={t('plugins.connector.tools')}>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('plugins.connector.noTools')}</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-y-auto" data-testid="connector-tools">
            {tools.map((tool) => (
              <li key={tool.name} className="flex items-baseline gap-3 text-xs">
                <span className="shrink-0 font-mono">{tool.name}</span>
                {tool.description && (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {tool.description}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <DetailSection title={t('plugins.connector.config')}>
        <ConnectorConfig connector={connector} />
      </DetailSection>
      {oauth?.status === 'signed_in' && (
        <DetailSection title={t('plugins.connector.account')}>
          <ConnectorAccount oauth={oauth} />
        </DetailSection>
      )}
      <DetailActions>
        {oauth?.status === 'signed_in' && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy.has(connector.id)}
              onClick={() =>
                run(
                  connector.id,
                  () => signInConnector(client, connector),
                  (error) => t('plugins.connector.signIn.failed', { error }),
                )
              }
              data-action="sign-in-again"
            >
              {t('plugins.connector.signInAgain')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy.has(connector.id)}
              onClick={() =>
                run(
                  connector.id,
                  () => signOutConnector(client, connector),
                  (error) => t('plugins.connector.signOut.failed', { error }),
                )
              }
              data-action="sign-out"
            >
              {t('plugins.connector.signOut')}
            </Button>
          </>
        )}
        {plugin ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openPlugin(plugin.id)}
            data-action="open-plugin"
          >
            {t('plugins.openPlugin')}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => editConnector(connector)}
              data-action="edit-connector"
            >
              <Pencil data-icon="inline-start" />
              {t('plugins.connector.edit')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirming(true)}
              data-action="delete-connector"
            >
              {t('plugins.connector.delete')}
            </Button>
          </>
        )}
      </DetailActions>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('plugins.connector.delete.title', { name: connector.name })}
        confirmLabel={t('plugins.connector.delete')}
        failure={(error) => t('plugins.connector.delete.failed', { error })}
        onConfirm={async () => {
          await removeConnector(client, data, connector);
          notify({
            tone: 'success',
            text: t('plugins.connector.deleted', { name: connector.name }),
          });
        }}
      >
        <p>{t('plugins.connector.delete.body')}</p>
      </ConfirmDialog>
    </>
  );
}

/** 已登录的 OAuth 连接器：授权服务器（主机名）、权限范围与令牌过期时间。 */
function ConnectorAccount({ oauth }: { oauth: NonNullable<Connector['oauth']> }) {
  return (
    <div className="space-y-1.5 text-sm" data-testid="connector-account">
      {oauth.issuer !== undefined && (
        <ConfigLine label={t('plugins.connector.issuer')}>
          <MonoBlock>{hostOf(oauth.issuer)}</MonoBlock>
        </ConfigLine>
      )}
      {oauth.scopes !== undefined && oauth.scopes.length > 0 && (
        <ConfigLine label={t('plugins.connector.scopes')}>
          <MonoBlock>{oauth.scopes.join(' ')}</MonoBlock>
        </ConfigLine>
      )}
      {oauth.expiresAt !== undefined && (
        <ConfigLine label={t('plugins.connector.expires')}>
          <MonoBlock>
            {new Intl.DateTimeFormat(currentLocale(), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(oauth.expiresAt))}
          </MonoBlock>
        </ConfigLine>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 配置：传输方式对应的字段，环境变量与请求头只有键，值写“已设置”。 */
function ConnectorConfig({ connector }: { connector: Connector }) {
  const { config } = connector;
  const missing = new Set(missingSecretKeys(connector));
  const secrets = config.transport === 'stdio' ? config.env : config.headers;
  const secretLabel =
    config.transport === 'stdio' ? t('plugins.field.env') : t('plugins.field.headers');
  return (
    <div className="space-y-1.5 text-sm" data-testid="connector-config">
      {config.transport === 'stdio' ? (
        <>
          <ConfigLine label={t('plugins.field.command')}>
            <MonoBlock>{commandLine(config.command, config.args)}</MonoBlock>
          </ConfigLine>
          {config.cwd !== undefined && (
            <ConfigLine label={t('plugins.field.cwd')}>
              <MonoBlock>{config.cwd}</MonoBlock>
            </ConfigLine>
          )}
        </>
      ) : (
        <ConfigLine label={t('plugins.field.url')}>
          <MonoBlock>{config.url}</MonoBlock>
        </ConfigLine>
      )}
      {secrets !== undefined && Object.keys(secrets).length > 0 && (
        <ConfigLine label={secretLabel}>
          <MonoBlock className="space-y-0.5">
            {Object.keys(secrets).map((key) => (
              <div key={key} className="flex gap-3">
                <span className="min-w-0 flex-1">{key}</span>
                {missing.has(key) ? (
                  <span className="shrink-0 font-sans text-warning" data-secret-missing={key}>
                    {t('plugins.secret.missing')}
                  </span>
                ) : (
                  <span className="shrink-0 font-sans text-muted-foreground">
                    {t('plugins.secret.set')}
                  </span>
                )}
              </div>
            ))}
          </MonoBlock>
        </ConfigLine>
      )}
    </div>
  );
}
