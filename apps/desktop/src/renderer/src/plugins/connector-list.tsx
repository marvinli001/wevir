// “连接器”分段（0.42.0，desktop-layout.md §23）：用户加的与插件带的 MCP 连接器，状态、开关、详情（工具、配置）、编辑与删除。

import type { Connector, Plugin } from '@wevir/protocol';
import { cn } from 'cn';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { EmptyList, LIST_CARD } from '@/settings/settings-ui';
import { removeConnector, setConnectorEnabled } from './plugin-actions';
import { ConfigLine, DetailActions, DetailSection, ExpandableRow, MonoBlock } from './plugin-rows';
import { usePluginsContext } from './plugins-context';
import { byName, CONNECTOR_STATE_LABEL, connectorState, originName } from './plugins-model';

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
  const { client, data, plugins, busy, run } = usePluginsContext();
  const plugin = connector.pluginId === undefined ? undefined : plugins.get(connector.pluginId);
  const state = connectorState(connector, plugin);
  const origin = originName(connector.pluginId, plugins);
  const stateLabel = t(CONNECTOR_STATE_LABEL[state.key]);
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
      meta={origin !== undefined && t('plugins.from', { name: origin })}
      summary={stateLabel}
      control={
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
      }
    >
      <ConnectorDetail connector={connector} plugin={plugin} />
    </ExpandableRow>
  );
}

function ConnectorDetail({ connector, plugin }: { connector: Connector; plugin?: Plugin }) {
  const { client, data, notify, openPlugin, editConnector } = usePluginsContext();
  const [confirming, setConfirming] = useState(false);
  const missing = connector.missingInputs ?? [];
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
      <DetailActions>
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

/** 命令与参数的显示写法：带空白的参数加引号（只用于显示）。 */
function commandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

/** 配置：传输方式对应的字段，环境变量与请求头只有键，值写“已设置”。 */
function ConnectorConfig({ connector }: { connector: Connector }) {
  const { config } = connector;
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
                <span className="shrink-0 font-sans text-muted-foreground">
                  {t('plugins.secret.set')}
                </span>
              </div>
            ))}
          </MonoBlock>
        </ConfigLine>
      )}
    </div>
  );
}
