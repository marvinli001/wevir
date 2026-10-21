// 设置 → 听写（0.92.0）与 React 无关的部分：“转写”下拉的选项（本机模型，加上已启用的 OpenAI 兼容 Provider 填的转写模型）、
// 选项值与 `speechTranscriber` 互转、本机模型状态的文字。

import type { ProviderProfile, SpeechLocalStatus, SpeechTranscriber } from '@wevir/protocol';
import { t } from '@/i18n';
import { formatFileSize } from '@/session/shared-files-model';

export const LOCAL_TRANSCRIBER = 'local';

export interface TranscriberOption {
  value: string;
  label: string;
}

/** `speechTranscriber` → 下拉的值；省略是本机。Provider ID 不含冒号，模型 ID 可以含。 */
export function transcriberValue(transcriber: SpeechTranscriber | undefined): string {
  return transcriber === undefined || transcriber.kind === 'local'
    ? LOCAL_TRANSCRIBER
    : `provider:${transcriber.providerId}:${transcriber.modelId}`;
}

export function parseTranscriberValue(value: string): SpeechTranscriber {
  const match = /^provider:([^:]+):(.+)$/su.exec(value);
  return match?.[1] !== undefined && match[2] !== undefined
    ? { kind: 'provider', providerId: match[1], modelId: match[2] }
    : { kind: 'local' };
}

/**
 * 下拉的选项：本机在最前，然后是各 Provider 的转写模型（停用的不列）。设置里选的那个已经不在了（删了 Provider 或模型）时
 * 照样列出来，标“不可用”，免得下拉显示成空的。
 */
export function transcriberOptions(
  providers: readonly ProviderProfile[],
  current: SpeechTranscriber | undefined,
  localName: string,
): TranscriberOption[] {
  const options: TranscriberOption[] = [{ value: LOCAL_TRANSCRIBER, label: localName }];
  for (const provider of providers) {
    if (provider.kind !== 'openai-compatible' || provider.enabled === false) continue;
    for (const model of provider.transcriptionModels ?? []) {
      options.push({
        value: transcriberValue({ kind: 'provider', providerId: provider.id, modelId: model.id }),
        label: `${provider.displayName} · ${model.displayName ?? model.id}`,
      });
    }
  }
  const value = transcriberValue(current);
  if (current?.kind === 'provider' && !options.some((option) => option.value === value)) {
    options.push({
      value,
      label: t('settings.dictation.unavailable', { name: current.modelId }),
    });
  }
  return options;
}

/** 本机模型那一行的状态文字。 */
export function localStatusText(status: SpeechLocalStatus, locale: string): string {
  const size = (bytes: number) => formatFileSize(bytes, locale);
  switch (status.state) {
    case 'unsupported':
      return t('settings.dictation.local.unsupported');
    case 'missing':
      return t('settings.dictation.local.missing', { size: size(status.downloadBytes) });
    case 'ready':
      return t('settings.dictation.local.ready', {
        size: size(status.installedBytes ?? status.downloadBytes),
      });
    case 'failed':
      return t('settings.dictation.local.failed', { error: status.error ?? '' });
    case 'installing': {
      const progress = status.progress;
      // 刚开始、还没有进度时按下载 0% 算。
      if (progress !== undefined && progress.phase !== 'downloading') {
        return t('settings.dictation.local.extracting');
      }
      const total = progress?.totalBytes ?? status.downloadBytes;
      const completed = progress?.completedBytes ?? 0;
      const percent = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : 0;
      return t('settings.dictation.local.downloading', { percent });
    }
  }
}
