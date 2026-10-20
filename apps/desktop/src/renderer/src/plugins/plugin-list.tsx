// “插件”分段（0.42.0，desktop-layout.md §23）：已装的插件，整体开关、详情里的各项、输入项与卸载。

import type { Connector, Plugin, Skill } from '@wevir/protocol';
import { cn } from 'cn';
import { Blocks, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { StatusDot } from '@/components/status-dot';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { EmptyList, LIST_CARD } from '@/settings/settings-ui';
import {
  removePlugin,
  setConnectorEnabled,
  setPluginEnabled,
  setPluginInputs,
  setSkillEnabled,
} from './plugin-actions';
import { InputField } from './plugin-inputs';
import { DetailActions, DetailSection, ExpandableRow } from './plugin-rows';
import { usePluginsContext } from './plugins-context';
import {
  byName,
  CONNECTOR_STATE_LABEL,
  connectorState,
  missingRequiredInputs,
  pluginItems,
  skillSummary,
} from './plugins-model';

export function PluginList({
  expanded,
  onExpand,
}: {
  expanded: string | undefined;
  onExpand: (id: string | undefined) => void;
}) {
  const { plugins } = usePluginsContext();
  if (plugins.size === 0) return <EmptyList>{t('plugins.empty.plugins')}</EmptyList>;
  return (
    <ul className={cn(LIST_CARD, 'overflow-hidden')} data-testid="plugin-list">
      {byName([...plugins.values()]).map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          expanded={expanded === plugin.id}
          onToggle={() => onExpand(expanded === plugin.id ? undefined : plugin.id)}
        />
      ))}
    </ul>
  );
}

function PluginRow({
  plugin,
  expanded,
  onToggle,
}: {
  plugin: Plugin;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { client, data, busy, run } = usePluginsContext();
  const missing = missingRequiredInputs(plugin).length > 0;
  const meta = [`v${plugin.version}`, plugin.author?.name].filter(Boolean).join(' · ');
  const counts = [
    plugin.connectors.length > 0 &&
      t('plugins.plugin.connectors', { count: plugin.connectors.length }),
    plugin.skills.length > 0 && t('plugins.plugin.skills', { count: plugin.skills.length }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ExpandableRow
      id={plugin.id}
      expanded={expanded}
      onToggle={onToggle}
      leading={<PluginIcon plugin={plugin} />}
      title={plugin.name}
      meta={
        <>
          {meta}
          {missing && (
            <span className="text-warning" data-missing-inputs>
              {meta && ' · '}
              {t('plugins.plugin.missingInputs')}
            </span>
          )}
        </>
      }
      summary={counts}
      control={
        <Switch
          checked={plugin.enabled}
          label={t('plugins.plugin.enabled', { name: plugin.name })}
          disabled={busy.has(plugin.id)}
          onChange={(next) =>
            run(
              plugin.id,
              () => setPluginEnabled(client, data, plugin.id, next),
              (error) => t('plugins.toggleFailed', { error }),
            )
          }
          data-action="toggle-plugin"
        />
      }
    >
      <PluginDetail plugin={plugin} />
    </ExpandableRow>
  );
}

/** 32 px 的器皿：包里的图标（`data:` 地址），没有时是 `Blocks`。 */
function PluginIcon({ plugin }: { plugin: Plugin }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-border">
      {plugin.iconUrl ? (
        <img src={plugin.iconUrl} alt="" className="size-5 object-contain" />
      ) : (
        <Blocks aria-hidden className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

function PluginDetail({ plugin }: { plugin: Plugin }) {
  const { client, data, list, notify } = usePluginsContext();
  const [confirming, setConfirming] = useState(false);
  const items = pluginItems(plugin, list);
  const hasItems = items.connectors.length + items.skills.length > 0;
  return (
    <>
      {plugin.description && (
        <p className="text-sm break-words text-soft-foreground">{plugin.description}</p>
      )}
      {plugin.homepage && (
        <button
          type="button"
          onClick={() =>
            void window.wevir.openExternal(plugin.homepage ?? '').catch(() => undefined)
          }
          className="block max-w-full truncate rounded-sm text-left text-sm text-muted-foreground underline underline-offset-3 outline-none hover:text-foreground focus-visible:focus-ring"
          data-action="open-homepage"
        >
          {t('plugins.plugin.homepage')}
        </button>
      )}
      {hasItems && (
        <DetailSection title={t('plugins.plugin.contents')}>
          <ul className="divide-y divide-border">
            {items.connectors.map((connector) => (
              <ContentConnector key={connector.id} connector={connector} plugin={plugin} />
            ))}
            {items.skills.map((skill) => (
              <ContentSkill key={skill.id} skill={skill} plugin={plugin} />
            ))}
          </ul>
        </DetailSection>
      )}
      {plugin.inputs.length > 0 && (
        <DetailSection title={t('plugins.plugin.inputs')}>
          <InputsForm plugin={plugin} />
        </DetailSection>
      )}
      <DetailActions>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirming(true)}
          data-action="uninstall-plugin"
        >
          {t('plugins.plugin.uninstall')}
        </Button>
      </DetailActions>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('plugins.plugin.uninstall.title', { name: plugin.name })}
        confirmLabel={t('plugins.plugin.uninstall')}
        failure={(error) => t('plugins.plugin.uninstall.failed', { error })}
        onConfirm={async () => {
          await removePlugin(client, data, plugin);
          notify({ tone: 'success', text: t('plugins.plugin.uninstalled', { name: plugin.name }) });
        }}
      >
        <p>{t('plugins.plugin.uninstall.body')}</p>
      </ConfirmDialog>
    </>
  );
}

/** 详情里“包含”的一行：连接器，状态点、名称、状态文字与单项开关（插件关着时停用）。 */
function ContentConnector({ connector, plugin }: { connector: Connector; plugin: Plugin }) {
  const { client, data, busy, run } = usePluginsContext();
  const state = connectorState(connector, plugin);
  const label = t(CONNECTOR_STATE_LABEL[state.key]);
  return (
    <li className="flex items-center gap-3 py-2 text-sm" data-content-item={connector.id}>
      <StatusDot tone={state.tone} pulse={state.pulse} label={label} />
      <span className="min-w-0 flex-1 truncate">{connector.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <Switch
        checked={connector.enabled}
        label={t('plugins.connector.enabled', { name: connector.name })}
        disabled={!plugin.enabled || busy.has(connector.id)}
        onChange={(next) =>
          run(
            connector.id,
            () => setConnectorEnabled(client, data, connector.id, next),
            (error) => t('plugins.toggleFailed', { error }),
          )
        }
        data-action="toggle-connector"
      />
    </li>
  );
}

/** 详情里“包含”的一行：Skill，名称、短描述与单项开关。 */
function ContentSkill({ skill, plugin }: { skill: Skill; plugin: Plugin }) {
  const { client, data, busy, run } = usePluginsContext();
  return (
    <li className="flex items-center gap-3 py-2 text-sm" data-content-item={skill.id}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{skill.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{skillSummary(skill)}</span>
      </span>
      <Switch
        checked={skill.enabled}
        label={t('plugins.skill.enabled', { name: skill.name })}
        disabled={!plugin.enabled || busy.has(skill.id)}
        onChange={(next) =>
          run(
            skill.id,
            () => setSkillEnabled(client, data, skill.id, next),
            (error) => t('plugins.toggleFailed', { error }),
          )
        }
        data-action="toggle-skill"
      />
    </li>
  );
}

/**
 * 已装插件的输入项：非密钥项显示当前值；密钥项不回显，已设置时占位写“已设置（留空不变）”，右边有“清除”。只送改过的键：
 * 字符串是新值，null 是清除。
 */
function InputsForm({ plugin }: { plugin: Plugin }) {
  const { client, data, notify } = usePluginsContext();
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [saving, setSaving] = useState(false);
  const dirty = Object.keys(edits).length > 0;

  const edit = (key: string, secret: boolean, value: string) =>
    setEdits((current) => {
      const next = { ...current };
      // 密钥项写回空等于没改；非密钥项写空是清除。
      if (secret && value === '') delete next[key];
      else next[key] = value;
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await setPluginInputs(client, data, plugin.id, edits);
      setEdits({});
      notify({ tone: 'success', text: t('plugins.plugin.inputsSaved', { name: plugin.name }) });
    } catch (reason) {
      notify({
        tone: 'error',
        text: t('plugins.plugin.inputsFailed', { error: describe(reason) }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {plugin.inputs.map((input) => {
        const edited = edits[input.key];
        const cleared = edited === null;
        const value = typeof edited === 'string' ? edited : input.secret ? '' : (input.value ?? '');
        const kept = input.secret && input.set && !cleared;
        return (
          <InputField
            key={input.key}
            spec={input}
            value={value}
            placeholder={kept ? t('plugins.secret.keep') : undefined}
            onChange={(next) => edit(input.key, input.secret, next)}
            action={
              kept && edited === undefined ? (
                <IconButton
                  label={t('plugins.plugin.inputClear', { label: input.label })}
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={() => setEdits((current) => ({ ...current, [input.key]: null }))}
                  data-action="clear-input"
                >
                  <X />
                </IconButton>
              ) : undefined
            }
          />
        );
      })}
      <Button
        size="sm"
        disabled={!dirty || saving}
        onClick={() => void save()}
        data-action="save-inputs"
      >
        {t('plugins.plugin.inputsSave')}
      </Button>
    </div>
  );
}
