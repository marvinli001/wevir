import {
  compareProtocolVersions,
  type ThemeCreate,
  ThemeFileSchema,
  type ThemeSummary,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Check, Copy, Download, Image, MoreHorizontal, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { appearanceStore, useAppearance } from '@/theme/appearance';
import {
  accentSwatch,
  applyTheme,
  DEFAULT_COLORS,
  exportTheme,
  matchPreset,
  parseTheme,
  THEME_PRESETS,
  themeFileFromPreset,
} from '@/theme/appearance-model';
import { customThemeStore } from '@/theme/custom-theme';
import { useTheme } from '@/theme/theme';
import { type Notice, NoticeBanner, SETTINGS_CARD } from './settings-ui';

type CreateSource = ThemeCreate['source'];

export function ThemeLibrary() {
  const { client, view } = useHostConnection();
  const appearance = useAppearance();
  const { resolved } = useTheme();
  const custom = customThemeStore.use();
  const [themes, setThemes] = useState<ThemeSummary[]>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<CreateSource>();
  const [id, setId] = useState('');
  const [createError, setCreateError] = useState<string>();
  const [deleting, setDeleting] = useState<ThemeSummary>();
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [pasteError, setPasteError] = useState<string>();
  const epoch = useRef(0);
  const locked = useRef(false);
  const connected = view.status === 'connected';
  const readable = connected && client?.supports('themes') && client.can('session.read');
  const manageable = readable && client?.can('host.manage');
  const creatable =
    manageable && client && compareProtocolVersions(client.hello.protocolVersion, '0.196.0') >= 0;
  const localFiles = capabilities().localFiles;
  const preset = matchPreset(appearance);

  useEffect(() => {
    let order = 0;
    let disposed = false;
    epoch.current++;
    locked.current = false;
    setBusy(false);
    setThemes(undefined);
    if (!readable || !client) return;
    const read = async () => {
      const request = ++order;
      try {
        const result = await client.request('themes.list', {});
        if (!disposed && request === order) setThemes(result.themes);
      } catch (error) {
        if (!disposed && request === order) setNotice({ tone: 'error', text: describe(error) });
      }
    };
    const off = client.onThemesUpdated(() => void read());
    void read();
    return () => {
      disposed = true;
      epoch.current++;
      off();
    };
  }, [client, readable]);

  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = async (
    action: (current: () => boolean) => Promise<void>,
    fail = (error: string) => setNotice({ tone: 'error', text: error }),
  ) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setNotice(undefined);
    const request = epoch.current;
    const current = () => epoch.current === request;
    try {
      await action(current);
    } catch (error) {
      if (current()) fail(describe(error));
    } finally {
      if (current()) {
        locked.current = false;
        setBusy(false);
      }
    }
  };

  const stopCustom = async () => {
    if (manageable && client) await client.request('themes.setActive', { id: null });
    else if (customThemeStore.get().activeId !== null)
      throw new Error(t('settings.appearance.themeAccess'));
  };
  const selectPreset = (next: (typeof THEME_PRESETS)[number]) =>
    void run(async (current) => {
      await stopCustom();
      if (current()) appearanceStore.set((value) => applyTheme(value, next));
    });
  const beginCreate = (next: CreateSource, suggested: string) => {
    const base =
      suggested
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 54) || 'my-theme';
    const used = new Set([
      ...THEME_PRESETS.map((entry) => entry.id),
      ...(themes ?? []).map((entry) => entry.id),
    ]);
    let nextId = base;
    for (let suffix = 2; used.has(nextId); suffix++) nextId = `${base}-${suffix}`;
    setId(nextId);
    setCreateError(undefined);
    setSource(next);
  };
  const importFile = (kind: 'folder' | 'file') =>
    void run(async (current) => {
      const path = await platformApi().selectThemeSource(kind);
      if (!path || !current()) return;
      const name =
        path
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.json$/i, '') ?? '';
      beginCreate({ path }, name === 'theme' ? 'my-theme' : name);
    });
  const create = () => {
    if (!client || !source || !creatable) return;
    setCreateError(undefined);
    void run(async (current) => {
      await client.request('themes.create', { id, source });
      if (current()) setSource(undefined);
    }, setCreateError);
  };
  const copyJson = () =>
    void run(async (current) => {
      let json = exportTheme(appearance);
      const activeId = customThemeStore.get().activeId;
      if (activeId !== null) {
        if (!client || !readable) throw new Error(t('settings.appearance.themeAccess'));
        const result = await client.request('themes.get', { id: activeId });
        if (!current() || customThemeStore.get().activeId !== activeId) return;
        if (!result.theme) throw new Error(t('settings.appearance.importInvalid'));
        json = JSON.stringify(result.theme, null, 2);
      }
      if (!current()) return;
      await platformApi().copyText(json);
      if (current()) setNotice({ tone: 'success', text: t('settings.appearance.themeCopied') });
    });
  const paste = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      setPasteError(describe(error));
      return;
    }
    if (raw && typeof raw === 'object' && 'schemaVersion' in raw) {
      const parsed = ThemeFileSchema.safeParse(raw);
      if (!parsed.success) {
        setPasteError(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'theme'}: ${issue.message}`)
            .join('\n'),
        );
        return;
      }
      if (!creatable) {
        setPasteError(t('settings.appearance.themeAccess'));
        return;
      }
      setPasting(false);
      beginCreate({ theme: parsed.data }, parsed.data.name);
      return;
    }
    const legacy = parseTheme(text);
    if (!legacy) {
      setPasteError(t('settings.appearance.importInvalid'));
      return;
    }
    void run(async (current) => {
      await stopCustom();
      if (current()) {
        appearanceStore.set((value) => applyTheme(value, legacy));
        setPasting(false);
      }
    }, setPasteError);
  };
  const canSelectPreset = !custom.activeId || manageable;
  const cards = [
    ...(preset
      ? THEME_PRESETS
      : [
          ...THEME_PRESETS,
          { ...appearance, id: 'local-custom', name: t('settings.appearance.custom') },
        ]
    ).map((entry) => ({
      ...entry,
      readOnly: true,
      hasBackdrop: false,
      swatches: [
        entry[resolved].background ?? DEFAULT_COLORS[resolved].background,
        entry[resolved].foreground ?? DEFAULT_COLORS[resolved].foreground,
        accentSwatch(entry.accent, resolved),
      ],
      selected: custom.activeId === null && (preset?.id ?? 'local-custom') === entry.id,
      select: () => selectPreset(entry),
      copy: () => beginCreate({ theme: themeFileFromPreset(entry) }, `${entry.id}-copy`),
      disabled: !canSelectPreset,
      host: undefined as ThemeSummary | undefined,
    })),
    ...(themes ?? []).map((entry) => ({
      ...entry,
      selected: custom.activeId === entry.id,
      select: () =>
        void run(async () => {
          await client?.request('themes.setActive', { id: entry.id });
        }),
      copy: () => beginCreate({ themeId: entry.id }, `${entry.id}-copy`),
      disabled: !manageable,
      host: entry,
    })),
  ];

  return (
    <div className="space-y-3" data-setting="theme-preset">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">{t('settings.appearance.theme')}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" disabled={busy} data-action="import-theme" />
            }
          >
            <Download />
            {t('settings.appearance.importTheme')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={!creatable || !localFiles}
              onClick={() => importFile('folder')}
              data-import="folder"
            >
              {t('settings.appearance.themeFolder')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!creatable || !localFiles}
              onClick={() => importFile('file')}
              data-import="file"
            >
              {t('settings.appearance.themeFile')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setText('');
                setPasteError(undefined);
                setPasting(true);
              }}
              data-import="paste"
            >
              {t('settings.appearance.themeJson')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton
          label={t('settings.appearance.copyTheme')}
          disabled={busy}
          onClick={copyJson}
          data-action="copy-theme-json"
        >
          <Copy />
        </IconButton>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || (!!custom.activeId && !manageable)}
          data-action="restore-default-theme"
          onClick={() =>
            void run(async (current) => {
              if (manageable && client) await client.request('themes.setActive', { id: null });
              if (current()) customThemeStore.set((state) => ({ ...state, error: undefined }));
            })
          }
        >
          <RotateCcw />
          {t('settings.appearance.restoreTheme')}
        </Button>
      </div>
      {notice && <NoticeBanner notice={notice} />}
      {readable && themes === undefined && !notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cards.map((card) => (
          <div
            key={`${card.host ? 'host' : 'preset'}-${card.id}`}
            className={cn(SETTINGS_CARD, 'relative min-w-0', card.selected && 'ring-2 ring-ring')}
          >
            <button
              type="button"
              data-theme-id={card.id}
              aria-pressed={card.selected}
              disabled={busy || card.disabled}
              onClick={card.select}
              className="flex w-full flex-col gap-3 rounded-xl p-3 text-left outline-none hover:bg-accent/50 focus-visible:focus-ring disabled:opacity-50"
            >
              <span className="flex h-5 items-center gap-1.5 pr-7" aria-hidden>
                {[...new Set(card.swatches ?? [])].map((color) => (
                  <span
                    key={color}
                    className="size-4 rounded-full ring-1 ring-foreground/15"
                    style={{ background: color }}
                  />
                ))}
                {card.hasBackdrop && (
                  <Image
                    className="size-3.5 shrink-0 text-muted-foreground"
                    data-theme-background
                  />
                )}
              </span>
              <span className="flex w-full items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{card.name}</span>
                {card.selected && <Check aria-hidden className="size-4 shrink-0" />}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('settings.appearance.themeActions', { name: card.name })}
                    className="absolute top-2 right-2"
                    disabled={busy}
                    data-theme-actions={card.id}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  disabled={card.disabled}
                  onClick={card.select}
                  data-action="apply-theme"
                >
                  {t('settings.appearance.applyTheme')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!creatable}
                  onClick={card.copy}
                  data-action="clone-theme"
                >
                  {t('settings.appearance.cloneTheme')}
                </DropdownMenuItem>
                {card.host && (
                  <>
                    <DropdownMenuItem
                      disabled={!localFiles || !manageable}
                      data-action="reveal-theme"
                      onClick={() =>
                        void run(async (current) => {
                          const result = await client?.request('themes.get', { id: card.id });
                          if (result && current()) await platformApi().revealPath(result.directory);
                        })
                      }
                    >
                      {t('files.revealFolder')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!manageable || card.readOnly}
                      variant="destructive"
                      onClick={() => setDeleting(card.host)}
                      data-action="delete-theme"
                    >
                      {t('settings.appearance.deleteTheme')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      {(themes ?? [])
        .filter((entry) => entry.problems?.length)
        .map((entry) => (
          <div key={entry.id} className="space-y-1" data-theme-problems={entry.id}>
            <p className="text-sm font-medium">{entry.name}</p>
            {entry.problems?.map((problem) => (
              <NoticeBanner
                key={`${problem.path}-${problem.message}`}
                notice={{ tone: problem.severity, text: `${problem.path}: ${problem.message}` }}
              />
            ))}
          </div>
        ))}
      <Dialog
        open={source !== undefined}
        onOpenChange={(open) => {
          if (!busy && !open) setSource(undefined);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-md"
          aria-describedby={undefined}
        >
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <DialogHeader className="shrink-0">
              <DialogTitle>{t('settings.appearance.createTheme')}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 space-y-3 overflow-y-auto">
              <label htmlFor="new-theme-id" className="space-y-2 text-sm">
                {t('settings.appearance.themeId')}
                <Input
                  id="new-theme-id"
                  autoFocus
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  disabled={busy}
                  aria-invalid={!!createError}
                  data-theme-id-input
                />
              </label>
              {createError && <NoticeBanner notice={{ tone: 'error', text: createError }} />}
            </div>
            <DialogFooter className="shrink-0">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setSource(undefined)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || !id.trim() || !creatable}>
                {t('settings.appearance.createTheme')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={pasting}
        onOpenChange={(open) => {
          if (!busy) setPasting(open);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-md"
          aria-describedby={undefined}
        >
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              paste();
            }}
          >
            <DialogHeader className="shrink-0">
              <DialogTitle>{t('settings.appearance.importTheme')}</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 space-y-3 overflow-y-auto">
              <Textarea
                autoFocus
                value={text}
                spellCheck={false}
                aria-label={t('settings.appearance.themeJson')}
                aria-invalid={!!pasteError}
                disabled={busy}
                onChange={(event) => {
                  setText(event.target.value);
                  setPasteError(undefined);
                }}
                className="max-h-64 min-h-40 overflow-y-auto font-mono text-xs"
              />
              {pasteError && <NoticeBanner notice={{ tone: 'error', text: pasteError }} />}
            </div>
            <DialogFooter className="shrink-0">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setPasting(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || !text.trim()}>
                {t('settings.appearance.import')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={t('settings.appearance.deleteTheme')}
        confirmLabel={t('settings.appearance.deleteTheme')}
        failure={(error) => error}
        onConfirm={async () => {
          if (!client || !deleting || !manageable)
            throw new Error(t('settings.appearance.themeAccess'));
          await client.request('themes.delete', { id: deleting.id });
        }}
      >
        <p>
          {t(
            deleting?.id === custom.activeId
              ? 'settings.appearance.deleteActiveThemePrompt'
              : 'settings.appearance.deleteThemePrompt',
            { name: deleting?.name ?? '' },
          )}
        </p>
      </ConfirmDialog>
    </div>
  );
}
