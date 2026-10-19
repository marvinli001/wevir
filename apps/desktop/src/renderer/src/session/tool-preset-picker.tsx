// 新会话的工具预设（0.61.0，Host 功能 `tool_presets`）：输入框左下角权限芯片旁边的“工具”芯片。点开选“全部”或“核心”，核心之上
// 可另加浏览器、LSP 等组，下面写着给模型几个 Wevir 工具与这个设置管什么、不管什么。建会话时带上（session/start-session.ts），建好后
// 不能改，会话侧栏的“Wevir 工具”卡片显示它（layout/tool-preset-card.tsx）。Host 没有这个功能时不显示。

import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import type { ToolGroup, ToolPreset, ToolPresetId } from '@wevir/protocol';
import { cn } from 'cn';
import { Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import {
  choosePreset,
  FULL_PRESET,
  optionalGroups,
  presetToolCount,
  type ToolPresetsInfo,
  toggleGroup,
  totalToolCount,
} from './tool-preset-model';

export const TOOL_GROUP_LABELS: Record<ToolGroup, PlainMessageKey> = {
  sessions: 'toolPreset.group.sessions',
  catalog: 'toolPreset.group.catalog',
  tasks: 'toolPreset.group.tasks',
  memory: 'toolPreset.group.memory',
  workbench: 'toolPreset.group.workbench',
  browser: 'toolPreset.group.browser',
  lsp: 'toolPreset.group.lsp',
  processes: 'toolPreset.group.processes',
  plugins: 'toolPreset.group.plugins',
};

export const TOOL_PRESET_LABELS: Record<ToolPresetId, PlainMessageKey> = {
  full: 'toolPreset.full',
  core: 'toolPreset.core',
};

/** 芯片与侧栏摘要里的名字：“全部”“核心”“核心 + 2 组”。 */
export function toolPresetName(preset: ToolPreset): string {
  const extra = preset.id === 'core' ? (preset.groups?.length ?? 0) : 0;
  return extra === 0
    ? t(TOOL_PRESET_LABELS[preset.id])
    : t('toolPreset.coreWith', { count: extra });
}

/** Host 支持工具预设（0.61.0 的 `tool_presets`）。 */
export function useToolPresetsSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'tool_presets');
}

const cache = new WeakMap<WevirClient, Promise<ToolPresetsInfo>>();

/** 这个 Host 的预设清单（`tools.presets`），每个连接读一次；Host 不支持或读不到时 `undefined`。 */
export function useToolPresets(): ToolPresetsInfo | undefined {
  const { client } = useHostConnection();
  const supported = useToolPresetsSupported();
  const [info, setInfo] = useState<{ client: WevirClient; value: ToolPresetsInfo }>();
  useEffect(() => {
    if (!supported || client === undefined) return;
    let request = cache.get(client);
    if (request === undefined) {
      request = client.request('tools.presets', {});
      cache.set(client, request);
      request.catch(() => cache.delete(client));
    }
    let live = true;
    request.then(
      (value) => live && setInfo({ client, value }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, supported]);
  return supported && info !== undefined && info.client === client ? info.value : undefined;
}

/** 新会话选的预设：每次打开新会话都从“全部”开始（不记上次的，也没有设置里的默认值）。 */
export function useToolPresetChoice() {
  const [choice, setChoice] = useState<ToolPreset>(FULL_PRESET);
  return { choice, choose: setChoice };
}

/**
 * 输入框左下角的“工具”芯片。Host 不支持工具预设、或清单还没读到时不显示。
 */
export function ToolPresetPicker({
  value,
  onChange,
}: {
  value: ToolPreset;
  onChange: (next: ToolPreset) => void;
}) {
  const info = useToolPresets();
  if (info === undefined) return null;
  const extras = optionalGroups(info);
  const count = presetToolCount(value, info);
  const total = totalToolCount(info);
  const name = toolPresetName(value);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              data-testid="tool-preset-picker"
              data-preset={value.id}
              aria-label={t('toolPreset.label', { preset: name })}
              className={cn(
                'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-soft-foreground outline-none transition-colors duration-150',
                'hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground',
              )}
            />
          }
        >
          <Wrench aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{t('toolPreset.chip', { preset: name })}</span>
        </TooltipTrigger>
        <TooltipContent>{t('toolPreset.change')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72 p-1.5">
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{t('toolPreset.title')}</p>
        <DropdownMenuRadioGroup
          value={value.id}
          onValueChange={(next: ToolPresetId) => {
            if (next !== value.id) onChange(choosePreset(next));
          }}
        >
          {(['full', 'core'] as const).map((id) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              data-preset={id}
              className="items-start gap-2.5 pl-2"
            >
              <span className="flex min-w-0 flex-col">
                <span className="flex items-baseline gap-2">
                  {t(TOOL_PRESET_LABELS[id])}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('toolPreset.count', { count: presetToolCount(choosePreset(id), info) })}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(id === 'full' ? 'toolPreset.fullHint' : 'toolPreset.coreHint')}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {value.id === 'core' && extras.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-1 pb-1 text-xs text-muted-foreground">
              {t('toolPreset.addGroups')}
            </p>
            {extras.map((group) => (
              <DropdownMenuCheckboxItem
                key={group.id}
                checked={value.groups?.includes(group.id) === true}
                onCheckedChange={() => onChange(toggleGroup(value, group.id, info))}
                data-group={group.id}
                className="gap-2"
              >
                <span className="min-w-0 flex-1 truncate">{t(TOOL_GROUP_LABELS[group.id])}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('toolPreset.count', { count: group.tools.length })}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <div className="space-y-1 px-2 pt-1 pb-1 text-xs text-muted-foreground">
          <p className="text-foreground tabular-nums" data-testid="tool-preset-summary">
            {t('toolPreset.summary', { count, total })}
          </p>
          <p>{t('toolPreset.scope')}</p>
          <p>{t('toolPreset.always')}</p>
          <p>{t('toolPreset.fixed')}</p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
