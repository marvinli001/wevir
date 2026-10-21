import type { ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_TRANSCRIBER,
  localStatusText,
  parseTranscriberValue,
  transcriberOptions,
  transcriberValue,
} from './dictation-settings-model';

const provider = (patch: Partial<ProviderProfile>): ProviderProfile =>
  ({
    id: 'groq',
    kind: 'openai-compatible',
    displayName: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    models: [{ id: 'llama' }],
    defaultModelId: 'llama',
    hasSecret: true,
    ...patch,
  }) as ProviderProfile;

describe('听写设置的转写选项', () => {
  it('选项值与设置互转，模型 ID 可以带冒号', () => {
    expect(transcriberValue(undefined)).toBe(LOCAL_TRANSCRIBER);
    expect(transcriberValue({ kind: 'local' })).toBe(LOCAL_TRANSCRIBER);
    const value = transcriberValue({ kind: 'provider', providerId: 'groq', modelId: 'w:large' });
    expect(parseTranscriberValue(value)).toEqual({
      kind: 'provider',
      providerId: 'groq',
      modelId: 'w:large',
    });
    expect(parseTranscriberValue('local')).toEqual({ kind: 'local' });
  });

  it('列出启用的 OpenAI 兼容 Provider 的转写模型；选中的不在了标不可用', () => {
    const providers = [
      provider({ transcriptionModels: [{ id: 'whisper-large-v3', displayName: 'Whisper' }] }),
      provider({ id: 'off', enabled: false, transcriptionModels: [{ id: 'whisper-1' }] }),
      provider({ id: 'ds', kind: 'deepseek-official' }),
    ];
    expect(transcriberOptions(providers, undefined, '本机')).toEqual([
      { value: 'local', label: '本机' },
      { value: 'provider:groq:whisper-large-v3', label: 'Groq · Whisper' },
    ]);
    const missing = transcriberOptions(
      providers,
      { kind: 'provider', providerId: 'gone', modelId: 'whisper-1' },
      '本机',
    );
    expect(missing.at(-1)).toEqual({
      value: 'provider:gone:whisper-1',
      label: 'whisper-1（不可用）',
    });
  });

  it('本机模型的状态文字', () => {
    const base = { modelName: 'SenseVoice Small', downloadBytes: 166_000_000 };
    expect(localStatusText({ ...base, state: 'missing' }, 'zh-CN')).toBe('未下载 · 166 MB');
    expect(localStatusText({ ...base, state: 'ready', installedBytes: 240_000_000 }, 'zh-CN')).toBe(
      '已下载 · 240 MB',
    );
    expect(
      localStatusText(
        {
          ...base,
          state: 'installing',
          progress: { phase: 'downloading', completedBytes: 83_000_000, totalBytes: 166_000_000 },
        },
        'zh-CN',
      ),
    ).toBe('正在下载 50%');
    expect(
      localStatusText(
        { ...base, state: 'installing', progress: { phase: 'extracting', completedBytes: 0 } },
        'zh-CN',
      ),
    ).toBe('正在安装…');
    expect(localStatusText({ ...base, state: 'installing' }, 'zh-CN')).toBe('正在下载 0%');
  });
});
