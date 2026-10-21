// 设置 → 个性化（0.78.0，Host 功能 `agent_instructions`）：照 Claude Code 的输出风格设置只留两样，输出风格与“给 Agent 的说明”，
// 都存在 Host 设置。Host 把它们交给新建、恢复与接力的会话，已经开着的会话不跟着改。0.95.0 起下面多一组“写作”
// （writing-style-settings.tsx，Host 功能 `writing_style`）。

import { hostSupports } from '@wevir/client-sdk';
import type { HostSettings } from '@wevir/protocol';
import { AGENT_INSTRUCTIONS_MAX_LENGTH } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { globalStyle, OUTPUT_STYLE_LABELS, OUTPUT_STYLE_OPTIONS } from './personalization-model';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';
import { WritingStyleSettings } from './writing-style-settings';

export function PersonalizationSettings() {
  const { view } = useHostConnection();
  const { settings, update } = useHostSettings();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'agent_instructions');
  const writingSupported =
    view.status === 'connected' && hostSupports(view.hello.features, 'writing_style');
  const [notice, setNotice] = useState<Notice>();

  const save = async (patch: Partial<HostSettings>) => {
    setNotice(undefined);
    try {
      await update(patch);
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.personalization.saveFailed', { error: describe(reason) }),
      });
    }
  };

  if (!supported) {
    return (
      <NoticeBanner notice={{ tone: 'info', text: t('settings.personalization.unsupported') }} />
    );
  }

  return (
    <>
      <SettingsSection>
        {notice && (
          <div className="mb-3">
            <NoticeBanner notice={notice} />
          </div>
        )}
        <div className={LIST_CARD}>
          <SettingsRow
            title={t('settings.personalization.outputStyle')}
            data-setting="output-style"
            control={
              <Select
                className="w-40"
                aria-label={t('settings.personalization.outputStyle')}
                value={globalStyle(settings.outputStyle)}
                onValueChange={(outputStyle) => void save({ outputStyle })}
                options={OUTPUT_STYLE_OPTIONS.map((value) => ({
                  value,
                  label: t(OUTPUT_STYLE_LABELS[value]),
                }))}
              />
            }
          />
          <InstructionsEditor
            value={settings.agentInstructions ?? ''}
            onSave={(agentInstructions) => save({ agentInstructions })}
          />
        </div>
      </SettingsSection>
      {writingSupported && (
        <WritingStyleSettings
          enabled={settings.writingStyle === true}
          onToggle={(writingStyle) => void save({ writingStyle })}
        />
      )}
    </>
  );
}

/** 多行输入框，改动后才能保存；外面的值变了（别的客户端改的）且没有改动时跟上。 */
function InstructionsEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft((current) => (current === saved ? value : current));
    setSaved(value);
  }, [value, saved]);

  const submit = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2.5 px-4 py-3" data-setting="agent-instructions">
      <div className="text-sm font-medium">{t('settings.personalization.instructions')}</div>
      <Textarea
        aria-label={t('settings.personalization.instructions')}
        value={draft}
        maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        className="max-h-80 min-h-28 font-mono text-xs md:text-xs"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={draft === value || saving}
          onClick={() => void submit()}
          data-action="save-instructions"
        >
          {t('settings.personalization.save')}
        </Button>
      </div>
    </div>
  );
}
