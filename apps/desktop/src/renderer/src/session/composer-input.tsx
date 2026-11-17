import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import { MESSAGE_TEXT_MAX_LENGTH } from '@wevir/protocol';
import { FileText, RotateCcw, Search } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { nudge } from './composer-commands';
import {
  type ComposerDraft,
  type DraftAttachment,
  draftIssue,
  hasDraft,
  textLength,
  useComposerDraft,
} from './composer-drafts';
import type { ComposerHistory, HistoryPage } from './composer-history';
import { COMPOSER_IMAGE_ACCEPT, dragHasFiles, imageMimeType } from './composer-images';
import { addComposerFiles, backUpRestoredFiles, resumeComposerImages } from './composer-media';
import { isLargePaste } from './composer-pastes';
import { ComposerThumb, ImagePreview, readAsDataUrl, useImageData } from './image-attachments';
import {
  AttachmentStrip,
  ComposerPasteChip,
  PastedTextPreview,
  RemoveAttachmentButton,
} from './pasted-text';
import { caretOnFirstLine, caretOnLastLine } from './prompt-history';

export function useComposerInput(
  key: string,
  client: WevirClient | undefined,
  images: boolean,
  disabled: boolean,
  insertPaths: (paths: readonly string[]) => void,
  focus: () => void,
  initialFolder?: string,
) {
  const { draft, store, error: storageError } = useComposerDraft(key);
  const [adding, setAdding] = useState(0);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const navigation = useRef({ ids: [] as string[], index: -1, busy: false });
  const resetHistory = useCallback(() => {
    navigation.current = { ids: [], index: -1, busy: false };
  }, []);
  const pendingImage = draft.attachments.some((a) => a.sourceType && !a.failure);
  useEffect(() => {
    if (pendingImage) void resumeComposerImages(store);
  }, [store, pendingImage]);
  const needsBackup = draft.attachments.some((a) => a.part && !a.blob);
  useEffect(() => {
    if (needsBackup && client) void backUpRestoredFiles(store, client, setError);
  }, [store, client, needsBackup]);
  const original = useRef<ComposerDraft>(draft);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const local = capabilities().localFiles && !disabled;
  const files = !!client && !disabled && hostSupports(client.hello.features, 'user_files');
  const choose = (entry: ComposerDraft) => {
    store.edit(() => ({ text: entry.text, pastes: entry.pastes, attachments: entry.attachments }));
    setError(undefined);
    focus();
  };
  const setText = useCallback(
    (next: string | ((text: string) => string)) =>
      store.edit((d) => ({ ...d, text: typeof next === 'string' ? next : next(d.text) })),
    [store],
  );
  const add = (input: readonly File[], named: boolean, directories = new Set<File>()) => {
    if (disabled || input.length === 0) return;
    setError(undefined);
    resetHistory();
    const upload: File[] = [];
    const paths: string[] = [];
    for (const file of input) {
      if (!directories.has(file) && (files || (images && imageMimeType(file)))) upload.push(file);
      else {
        const path = local ? platformApi().getPathForFile(file) : '';
        if (path) paths.push(path);
        else setError(t('composer.fileUnsupported', { name: file.name }));
      }
    }
    if (paths.length) insertPaths(paths);
    if (upload.length) {
      setAdding((n) => n + 1);
      void addComposerFiles(key, upload, { images, files, named }, setError).finally(() =>
        setAdding((n) => n - 1),
      );
    }
  };
  const attachPaths = async () => {
    try {
      const picked = await platformApi().selectPaths(initialFolder);
      if (picked.length) insertPaths(picked);
    } catch (reason) {
      setError(describe(reason));
    }
    focus();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    if (event.clipboardData.files.length) {
      event.preventDefault();
      add(Array.from(event.clipboardData.files), false);
      return;
    }
    const pasted = event.clipboardData.getData('text/plain');
    const block = isLargePaste(pasted);
    const selection = block
      ? 0
      : event.currentTarget.selectionEnd - event.currentTarget.selectionStart;
    if (textLength(draft) + pasted.length - selection > MESSAGE_TEXT_MAX_LENGTH) {
      event.preventDefault();
      setError(t('composer.textLimit', { count: MESSAGE_TEXT_MAX_LENGTH }));
      return;
    }
    if (!block) return;
    event.preventDefault();
    const paste = { key: crypto.randomUUID(), text: pasted };
    store.edit((d) => ({ ...d, pastes: [...d.pastes, paste] }));
    resetHistory();
    setError(undefined);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !dragHasFiles(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (disabled || !dragHasFiles(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    // FileList 与 getAsFile 的对象身份并不保证相同。按 DataTransferItem 判断文件夹再传给同一批 File。
    const selected: File[] = [];
    const directories = new Set<File>();
    for (const item of event.dataTransfer.items ?? []) {
      const file = item.getAsFile();
      if (file) {
        selected.push(file);
        if (item.webkitGetAsEntry?.()?.isDirectory) directories.add(file);
      }
    }
    add(selected.length ? selected : Array.from(event.dataTransfer.files), true, directories);
    focus();
  };
  const onHistoryKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return false;
    const caret = event.currentTarget.selectionStart;
    const nav = navigation.current;
    const up = event.key === 'ArrowUp';
    if (!up && event.key !== 'ArrowDown') return false;
    if (up && (nav.index < 0 ? hasDraft(draft) : !caretOnFirstLine(draft.text, caret)))
      return false;
    if (!up && (nav.index < 0 || !caretOnLastLine(draft.text, caret))) return false;
    if (nav.busy) return true;
    if (nav.index < 0) original.current = draft;
    const position = nav.index + (up ? 1 : -1);
    if (position < 0) {
      choose(original.current);
      resetHistory();
      return true;
    }
    nav.busy = true;
    const recall = async () => {
      let id = nav.ids[position];
      if (!id) {
        const { items } = await store.history.search('', nav.ids.at(-1), 1);
        id = items[0]?.id;
        if (!id) return;
        nav.ids.push(id);
      }
      const previous = await store.history.read(id);
      if (previous && navigation.current === nav) {
        nav.index = position;
        choose(previous);
      }
    };
    void recall()
      .catch((reason) => setError(describe(reason)))
      .finally(() => {
        nav.busy = false;
      });
    return true;
  };
  return {
    draft,
    store,
    setText,
    resetHistory,
    adding: adding > 0 || pendingImage,
    failedAttachment: draft.attachments.find((a) => a.failure)?.failure,
    dragging,
    onDragOver,
    onDrop,
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onPaste,
    onHistoryKey,
    error:
      draftIssue(draft) ??
      draft.attachments.find((a) => a.failure)?.failure ??
      error ??
      storageError,
    setError,
    canAttach: files || local,
    onAttach: files ? () => fileRef.current?.click() : () => void attachPaths(),
    onPaths: files && local ? () => void attachPaths() : undefined,
    onImages: () => imageRef.current?.click(),
    onHistory: () => setHistoryOpen(true),
    picker: (
      <>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="composer-file-input"
          onChange={(event) => {
            add(Array.from(event.target.files ?? []), true);
            event.target.value = '';
            focus();
          }}
        />
        <input
          ref={imageRef}
          type="file"
          multiple
          hidden
          accept={COMPOSER_IMAGE_ACCEPT}
          data-testid="composer-image-input"
          onChange={(event) => {
            add(Array.from(event.target.files ?? []), true);
            event.target.value = '';
            focus();
          }}
        />
        {historyOpen && (
          <PromptHistory
            history={store.history}
            onClose={() => setHistoryOpen(false)}
            onChoose={(entry) => {
              choose(entry);
              resetHistory();
              setHistoryOpen(false);
            }}
          />
        )}
      </>
    ),
    strip: (
      <DraftStrip
        draft={draft}
        onRetry={(id) => {
          store.edit((d) => ({
            ...d,
            attachments: d.attachments.map((a) => {
              if (a.key !== id) return a;
              const { failure: _error, ...rest } = a;
              return rest;
            }),
          }));
          setError(undefined);
        }}
        onRemove={(key) => {
          store.edit((d) => ({
            ...d,
            pastes: d.pastes.filter((p) => p.key !== key),
            attachments: d.attachments.filter((p) => p.key !== key),
          }));
          setError(undefined);
          focus();
        }}
      />
    ),
  };
}

function DraftStrip({
  draft,
  onRemove,
  onRetry,
}: {
  draft: ComposerDraft;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [paste, setPaste] = useState<string>();
  const [preview, setPreview] = useState<{ src: string; name?: string }>();
  const [error, setError] = useState<string>();
  const count = draft.attachments.length + draft.pastes.length;
  if (!count) return null;
  return (
    <>
      <AttachmentStrip count={count}>
        {draft.pastes.map((p) => (
          <ComposerPasteChip
            key={p.key}
            text={p.text}
            onOpen={() => setPaste(p.text)}
            onRemove={() => onRemove(p.key)}
          />
        ))}
        {draft.attachments.map((item) =>
          item.failure ? (
            <div key={item.key} className="relative h-14 max-w-56 shrink-0">
              <button
                type="button"
                data-action="retry-attachment"
                title={item.failure}
                onClick={() => onRetry(item.key)}
                className="flex h-full items-center gap-2 rounded-xl border border-destructive/35 px-3 text-sm text-foreground hover:bg-muted focus-visible:focus-field"
              >
                <RotateCcw aria-hidden className="size-4" />
                <span className="truncate">{item.name ?? t('composer.attachImages')}</span>
                <span className="text-xs">{t('files.retry')}</span>
              </button>
              <RemoveAttachmentButton
                action="remove-failed"
                label={t('composer.removeAttachment')}
                onClick={() => onRemove(item.key)}
              />
            </div>
          ) : item.kind === 'image' ? (
            <DraftImage
              key={item.key}
              item={item}
              onOpen={(src) => setPreview({ src, ...(item.name && { name: item.name }) })}
              onError={setError}
              onRemove={() => onRemove(item.key)}
            />
          ) : (
            <div
              key={item.key}
              className="relative flex h-14 max-w-52 shrink-0 items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 text-sm"
              data-testid="composer-file"
            >
              <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.name}</span>
              <RemoveAttachmentButton
                action="remove-file"
                label={t('composer.removeAttachment')}
                onClick={() => onRemove(item.key)}
              />
            </div>
          ),
        )}
      </AttachmentStrip>
      {error && (
        <p role="alert" className="px-4 text-xs text-destructive">
          {error}
        </p>
      )}
      <ImagePreview
        src={preview?.src}
        {...(preview?.name && { name: preview.name })}
        onClose={() => setPreview(undefined)}
      />
      <PastedTextPreview text={paste} onClose={() => setPaste(undefined)} />
    </>
  );
}
function DraftImage({
  item,
  onOpen,
  onRemove,
  onError,
}: {
  item: DraftAttachment;
  onOpen: (src: string) => void;
  onRemove: () => void;
  onError: (error: string) => void;
}) {
  const { src } = useImageData(
    item.part?.type === 'image' && !item.thumbnail ? item.part : undefined,
  );
  return (
    <ComposerThumb
      src={item.thumbnail ?? src}
      {...(item.name && { name: item.name })}
      uploading={!item.thumbnail && !src}
      onRemove={onRemove}
      onOpen={() => {
        if (item.blob) void readAsDataUrl(item.blob).then(onOpen, (e) => onError(describe(e)));
        else if (src) onOpen(src);
      }}
    />
  );
}
function PromptHistory({
  history,
  onClose,
  onChoose,
}: {
  history: ComposerHistory;
  onClose: () => void;
  onChoose: (entry: ComposerDraft) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [page, setPage] = useState<HistoryPage>({ items: [], more: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const listId = useId();
  useEffect(() => {
    const request = ++generation.current;
    setLoading(true);
    setPage({ items: [], more: false });
    setError(undefined);
    void history
      .search(query)
      .then(
        (result) => {
          if (request === generation.current) setPage(result);
        },
        (reason) => {
          if (request === generation.current) setError(describe(reason));
        },
      )
      .finally(() => {
        if (request === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [history, query]);
  const more = async () => {
    if (loading || !page.more) return;
    const request = generation.current;
    setLoading(true);
    try {
      const result = await history.search(query, page.items.at(-1)?.id);
      if (request === generation.current)
        setPage((current) => ({ items: [...current.items, ...result.items], more: result.more }));
    } catch (reason) {
      if (request === generation.current) setError(describe(reason));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  };
  const choose = async (id: string) => {
    const request = generation.current;
    try {
      const item = await history.read(id);
      if (item && request === generation.current) onChoose(item);
    } catch (reason) {
      if (request === generation.current) setError(describe(reason));
    }
  };
  const matches = page.items;
  const selected = matches[Math.min(active, matches.length - 1)];
  const optionId = (id: string) => `${listId}-${id}`;
  useEffect(() => {
    if (selected)
      document.getElementById(`${listId}-${selected.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, listId]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-2 sm:max-w-md">
        <DialogTitle>{t('composer.history')}</DialogTitle>
        <label className="flex items-center gap-2 rounded-lg border border-input px-2 focus-within:focus-field">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={selected && optionId(selected.id)}
            aria-label={t('composer.searchHistory')}
            placeholder={t('composer.searchHistory')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || !matches.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) =>
                  nudge(current, event.key === 'ArrowDown' ? 1 : -1, matches.length),
                );
              } else if (event.key === 'Enter' && selected) {
                event.preventDefault();
                void choose(selected.id);
              }
            }}
            className="h-9 w-full bg-transparent text-sm outline-none"
          />
        </label>
        <div
          id={listId}
          role="listbox"
          aria-label={t('composer.history')}
          className="max-h-[min(52vh,24rem)] space-y-0.5 overflow-y-auto"
        >
          {matches.map((entry, index) => {
            return (
              <button
                id={optionId(entry.id)}
                key={entry.id}
                type="button"
                role="option"
                aria-selected={entry.id === selected?.id}
                tabIndex={-1}
                onMouseMove={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void choose(entry.id)}
                className="block w-full rounded-lg px-2 py-2 text-left text-sm aria-selected:bg-muted focus-visible:focus-field"
              >
                <span className="block truncate">{entry.title}</span>
                {entry.files && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.files}
                  </span>
                )}
              </button>
            );
          })}
          {!loading && !error && !matches.length && (
            <p className="p-3 text-center text-sm text-muted-foreground">{t('search.empty')}</p>
          )}
        </div>
        {error && (
          <p role="alert" className="px-2 text-xs text-destructive">
            {t('search.failed', { error })}
          </p>
        )}
        {loading && (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            {t('common.loading')}
          </p>
        )}
        {page.more && (
          <button
            type="button"
            disabled={loading}
            className="rounded-lg py-1.5 text-sm hover:bg-muted focus-visible:focus-field"
            onClick={() => void more()}
          >
            {t('message.showMore')}
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}
