import { type PlainMessageKey, t } from '@/i18n';
import { formatShortcut, IS_MAC, SHORTCUTS, type Shortcut } from '@/lib/shortcuts';
import { composerPrefs, sendKeyLabel } from '@/session/composer-prefs';
import { LIST_CARD, SettingsSection } from './settings-ui';

type Row = [label: PlainMessageKey, keys: string];

const key = (shortcut: Shortcut) => formatShortcut(shortcut);

/**
 * 设置 → 键盘快捷键（U35，照 Codex 桌面端）：只列出来，不能改。三组：通用、窗格、输入框；输入框的发送键跟着“常规 → 发送消息”。
 */
export function ShortcutsSettings() {
  const { sendShortcut } = composerPrefs.use();
  const sections: [PlainMessageKey, Row[]][] = [
    [
      'shortcuts.section.general',
      [
        ['shortcuts.newSession', key(SHORTCUTS.newSession)],
        ['shortcuts.settings', key(SHORTCUTS.settings)],
        ['shortcuts.search', key(SHORTCUTS.search)],
        ['shortcuts.back', key(SHORTCUTS.back)],
        ['shortcuts.forward', key(SHORTCUTS.forward)],
        ['shortcuts.toggleSidebar', key(SHORTCUTS.toggleSidebar)],
      ],
    ],
    [
      'shortcuts.section.panes',
      [
        ['shortcuts.toggleAux', key(SHORTCUTS.toggleAux)],
        ['shortcuts.terminal', key(SHORTCUTS.terminal)],
        ['shortcuts.browser', key(SHORTCUTS.browser)],
        ['shortcuts.files', key(SHORTCUTS.files)],
        ['shortcuts.openTabs', key(SHORTCUTS.openTabs)],
        ['shortcuts.maximize', key(SHORTCUTS.maximize)],
        ['shortcuts.splitRight', key(SHORTCUTS.splitRight)],
        ['shortcuts.nextTab', key(SHORTCUTS.nextTab)],
        ['shortcuts.previousTab', key(SHORTCUTS.previousTab)],
        ['shortcuts.nextPane', key(SHORTCUTS.nextPane)],
        ['shortcuts.previousPane', key(SHORTCUTS.previousPane)],
      ],
    ],
    [
      'shortcuts.section.composer',
      [
        ['shortcuts.send', sendKeyLabel(sendShortcut)],
        [
          'shortcuts.newline',
          sendShortcut === 'enter' ? (IS_MAC ? '⇧ Enter' : 'Shift+Enter') : 'Enter',
        ],
        ['shortcuts.sendOther', 'Tab'],
        ['shortcuts.stop', 'Esc'],
        ['shortcuts.commands', '/'],
        ['shortcuts.mention', '@'],
      ],
    ],
  ];
  return sections.map(([title, rows]) => (
    <SettingsSection key={title} title={t(title)}>
      <dl className={LIST_CARD}>
        {rows.map(([label, keys]) => (
          <div key={label} className="flex min-h-11 items-center gap-6 px-4 py-2.5 text-sm">
            <dt className="min-w-0 flex-1">{t(label)}</dt>
            <dd>
              <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-sans text-xs text-soft-foreground">
                {keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  ));
}
