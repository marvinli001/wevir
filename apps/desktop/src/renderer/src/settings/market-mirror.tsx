import type { HostSettings, MarketMirror, MarketMirrorPreference } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { SettingsRow } from './settings-ui';

/** 镜像是托管平台的名字，不翻译。 */
const MIRROR_NAMES: Record<MarketMirror, string> = { github: 'GitHub', cnb: 'CNB', gitee: 'Gitee' };

/**
 * 设置 → 常规 → 插件市场（0.91.0，Host 功能 `plugin_market`）：官方市场从哪个镜像读。选择存在 Host 设置（`marketMirror`）。
 * “自动”是 Host 首次使用时测速后记住的那家，括号里写出是哪家；不显示测速结果。
 */
export function MarketMirrorRow({
  settings,
  disabled,
  save,
}: {
  settings: HostSettings;
  disabled: boolean;
  save: (patch: Partial<HostSettings>) => void;
}) {
  const { client } = useHostConnection();
  const preference = settings.marketMirror ?? 'auto';
  const [resolved, setResolved] = useState<MarketMirror>();

  // 自动模式下 `market.status` 可能要先测速（几秒），所以单独取，不挡住设置页。
  useEffect(() => {
    if (!client || preference !== 'auto') return;
    let current = true;
    setResolved(undefined);
    client
      .request('market.status', {})
      .then((status) => {
        if (current && status.preference === 'auto') setResolved(status.mirror);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [client, preference]);

  const auto =
    resolved === undefined
      ? t('settings.market.mirror.auto')
      : t('settings.market.mirror.autoResolved', { mirror: MIRROR_NAMES[resolved] });
  return (
    <SettingsRow
      title={t('settings.market.mirror')}
      data-setting="market-mirror"
      control={
        <Select
          className="w-48"
          aria-label={t('settings.market.mirror')}
          value={preference}
          disabled={disabled}
          onValueChange={(marketMirror) => save({ marketMirror })}
          options={[
            { value: 'auto', label: auto },
            ...(Object.keys(MIRROR_NAMES) as MarketMirror[]).map((mirror) => ({
              value: mirror as MarketMirrorPreference,
              label: MIRROR_NAMES[mirror],
            })),
          ]}
        />
      }
    />
  );
}
