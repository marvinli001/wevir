// 自动更新在界面上的取舍（ADR-0007 补记 4），纯逻辑：侧栏左下角显示什么。

import type { Locale } from '@/i18n/locales';
import type { UpdateState } from '../../../shared/desktop-api.js';

/** 侧栏左下角的更新入口；undefined 时不显示（没有新版本、更新关闭、正在检查）。 */
export type UpdateEntry =
  /** `manual`：应用里不下载（Linux 的 deb），点了打开官网的下载页。 */
  | { kind: 'available'; version: string; manual?: true }
  | { kind: 'downloading'; version: string; percent: number }
  /** 下载好了：等用户点“重启以更新”，不自己重启，不打断 Agent。 */
  | { kind: 'restart'; version: string }
  | { kind: 'installing'; version: string }
  /** 下载或安装失败：点了重新检查。只在已经发现过新版本时显示，连不上服务器不打扰。 */
  | { kind: 'failed'; version: string };

export function updateEntry(state: UpdateState | undefined): UpdateEntry | undefined {
  if (state === undefined) return undefined;
  switch (state.phase) {
    case 'available':
      return {
        kind: 'available',
        version: state.version,
        ...(state.manual === true && { manual: true as const }),
      };
    case 'downloading':
      return { kind: 'downloading', version: state.version, percent: Math.floor(state.percent) };
    case 'downloaded':
      return { kind: 'restart', version: state.version };
    case 'installing':
      return { kind: 'installing', version: state.version };
    case 'error':
      return state.version !== undefined && (state.code === 'download' || state.code === 'install')
        ? { kind: 'failed', version: state.version }
        : undefined;
    default:
      return undefined;
  }
}

/** 官网的下载页：中文界面用中文页，其余用英文页（官网只有这两种）。 */
export function downloadPageUrl(locale: Locale): string {
  return locale.startsWith('zh') ? 'https://wevir.si/download' : 'https://wevir.si/en/download';
}
