import { type KeyboardEvent, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { type PlainMessageKey, t } from '@/i18n';
import {
  formatShortcut,
  IS_MAC,
  type ShortcutId,
  setShortcut,
  shortcutConflict,
  shortcutFromEvent,
  shortcutOverrides,
  useKeybindings,
} from '@/lib/shortcuts';
import { composerPrefs, type SendShortcut, sendKeyLabel } from '@/session/composer-prefs';
import { LIST_CARD, Segmented, SettingsSection } from './settings-ui';

const GENERAL: ShortcutId[] = [
  'newSession',
  'settings',
  'restoreDefaultTheme',
  'search',
  'back',
  'forward',
  'previousSession',
  'nextSession',
  'toggleSidebar',
];
const PANES: ShortcutId[] = [
  'toggleAux',
  'terminal',
  'browser',
  'files',
  'openTabs',
  'maximize',
  'splitRight',
  'nextTab',
  'previousTab',
  'nextPane',
  'previousPane',
];
const COMPOSER: ShortcutId[] = ['lowerEffort', 'higherEffort', 'dictation'];
const GROUPS = [
  ['shortcuts.section.general', GENERAL],
  ['shortcuts.section.panes', PANES],
  ['shortcuts.section.composer', COMPOSER],
] as const;

function shortcutLabel(id: ShortcutId): string {
  return t(id === 'restoreDefaultTheme' ? 'appMenu.restoreDefaultTheme' : `shortcuts.${id}`);
}

export function ShortcutsSettings() {
  const bindings = useKeybindings();
  const { sendShortcut } = composerPrefs.use();
  const [recording, setRecording] = useState<ShortcutId>();
  const [error, setError] = useState<{ id: ShortcutId; message: string }>();
  const fixed: [PlainMessageKey, string][] = [
    [
      'shortcuts.newline',
      sendShortcut === 'enter' ? (IS_MAC ? '⇧ Enter' : 'Shift+Enter') : 'Enter',
    ],
    ['shortcuts.sendOther', 'Tab'],
    ['shortcuts.stop', 'Esc'],
    ['shortcuts.commands', '/'],
    ['shortcuts.mention', '@'],
  ];
  const finish = () => {
    setRecording(undefined);
  };
  const record = (id: ShortcutId, event: KeyboardEvent<HTMLButtonElement>) => {
    if (recording !== id || event.nativeEvent.isComposing) return;
    if (event.code === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return finish();
    if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const shortcut = shortcutFromEvent(event);
    if (!shortcut) return setError({ id, message: t('shortcuts.unavailable') });
    const conflict = shortcutConflict(id, shortcut);
    if (conflict)
      return setError({
        id,
        message: t('shortcuts.conflict', { action: shortcutLabel(conflict) }),
      });
    setShortcut(id, shortcut);
    finish();
  };

  return GROUPS.map(([title, ids]) => (
    <SettingsSection
      key={title}
      title={t(title)}
      action={
        title === 'shortcuts.section.general' &&
        Object.keys(shortcutOverrides.get()).length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              finish();
              shortcutOverrides.set({});
            }}
          >
            {t('shortcuts.reset')}
          </Button>
        )
      }
    >
      <dl className={LIST_CARD}>
        {ids.map((id) => (
          <div key={id} className="flex min-h-11 items-center gap-4 px-4 py-1.5 text-sm">
            <dt className="min-w-0 flex-1">{shortcutLabel(id)}</dt>
            <dd className="flex max-w-[65%] flex-col items-end gap-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                aria-label={`${shortcutLabel(id)} · ${formatShortcut(bindings[id])}`}
                aria-pressed={recording === id}
                data-shortcut={id}
                onClick={(event) => {
                  event.currentTarget.focus();
                  setRecording(id);
                  setError(undefined);
                }}
                onBlur={finish}
                onKeyDown={(event) => record(id, event)}
              >
                {recording === id ? (
                  t('shortcuts.record')
                ) : (
                  <kbd className="font-sans">{formatShortcut(bindings[id])}</kbd>
                )}
              </Button>
              <Collapse open={recording === id && error?.id === id} motion="height">
                <ErrorNote className="justify-end text-right text-xs">{error?.message}</ErrorNote>
              </Collapse>
            </dd>
          </div>
        ))}
        {ids === COMPOSER && (
          <>
            <div className="flex min-h-11 items-center gap-4 px-4 py-1.5 text-sm">
              <dt className="min-w-0 flex-1">{t('shortcuts.send')}</dt>
              <dd>
                <Segmented<SendShortcut>
                  label={t('shortcuts.send')}
                  value={sendShortcut}
                  onChange={(value) =>
                    composerPrefs.set((current) => ({ ...current, sendShortcut: value }))
                  }
                  options={(['enter', 'mod-enter'] as const).map((value) => ({
                    value,
                    label: sendKeyLabel(value),
                  }))}
                />
              </dd>
            </div>
            {fixed.map(([label, value]) => (
              <div key={label} className="flex min-h-11 items-center gap-4 px-4 py-1.5 text-sm">
                <dt className="min-w-0 flex-1">{t(label)}</dt>
                <dd>
                  <kbd className="text-xs font-sans text-muted-foreground">{value}</kbd>
                </dd>
              </div>
            ))}
          </>
        )}
      </dl>
    </SettingsSection>
  ));
}
