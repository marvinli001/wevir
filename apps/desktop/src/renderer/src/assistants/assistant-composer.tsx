// 助理与群的输入框（0.120.0；0.133.0 群里打 @ 选成员；0.135.0 图片、文件、听写与停止）：一行，单行时输入框与左右的按钮同高
// （32px），文字和按钮在同一条中线上，四周留白相同。图片、文件、听写与主按钮都用会话输入框的那一套（session/）：图片先传给 Host
// （`image.upload`）再放进帖子；文件插入成 @ 提及（绝对路径，助理不在哪个项目里）；听写在麦克风按钮上按住或点一下，录音时这一行换成
// 录音条。协调者（群里是成员）在回、输入框空着时主按钮是停止（`channel.stop`），Esc 同。

import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import type { Channel, ChannelPost, UserImageMimeType } from '@wevir/protocol';
import { cn } from 'cn';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { Textarea } from '@/components/ui/textarea';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { matchesShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { capabilities, platformApi } from '@/platform/platform';
import { paths } from '@/routes/paths';
import { rejectionText } from '@/session/composer';
import { ComposerButton } from '@/session/composer-button';
import {
  COMPOSER_IMAGE_ACCEPT,
  type ComposerImage,
  dragHasFiles,
  messageContent,
  pickImages,
  splitFiles,
} from '@/session/composer-images';
import { ComposerPlusMenu } from '@/session/composer-plus-menu';
import { composerPrefs } from '@/session/composer-prefs';
import { mentionText } from '@/session/composer-trigger';
import { DictationBar, DictationButton } from '@/session/dictation-button';
import { insertDictation } from '@/session/dictation-model';
import {
  ComposerThumb,
  ImagePreview,
  readAsDataUrl,
  uploadImage,
} from '@/session/image-attachments';
import { composerKeyAction } from '@/session/pending-model';
import { useDictation } from '@/session/use-dictation';
import { AssistantAvatar } from './assistant-avatar';
import { composerAction, composerSupported, mentionedIn, mentionQuery } from './assistants-model';

export function AssistantComposer({
  client,
  channel,
  members,
  onPosted,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  /** 群的成员（打 @ 时可选）；助理的时间线是空的。 */
  members: readonly Channel[];
  onPosted: (post: ChannelPost) => void;
  onError: (text: string) => void;
}) {
  const { view } = useHostConnection();
  const features = view.status === 'connected' ? view.hello.features : undefined;
  const supported = composerSupported(features);
  /** 帖子能带图片：Host 收下帖子里的图片（0.135.0）。协调者的模型看不了时 Host 换成说明，这里不再按模型挡。 */
  const imagesEnabled =
    supported && features !== undefined && hostSupports(features, 'user_images');
  /** 路径指这台电脑上的文件（外壳的 `localFiles`）：选择框与拖放带文件。 */
  const localFiles = supported && capabilities().localFiles;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [imageError, setImageError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ComposerImage>();
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const query = members.length > 0 ? mentionQuery(text, caret) : undefined;
  const choices =
    query === undefined
      ? []
      : members.filter((member) =>
          member.title.toLowerCase().startsWith(query.query.toLowerCase()),
        );
  const group = channel.kind === 'group';
  const uploading = images.some((image) => image.part === undefined);
  const hasContent = text.trim() !== '' || images.length > 0;
  const action = composerAction({ channel, supported, hasContent });

  // 换了助理：草稿不带过去。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着频道。
  useEffect(() => {
    setText('');
    setImages([]);
    setImageError(undefined);
  }, [channel.id]);

  const send = async () => {
    const body = text.trim();
    if (!hasContent || busy || uploading) return;
    setBusy(true);
    try {
      const mentions = mentionedIn(body, members);
      const parts = images.flatMap((image) => (image.part === undefined ? [] : [image.part]));
      const { post } = await client.request('channel.post', {
        channelId: channel.id,
        content: messageContent(body, parts),
        clientPostId: crypto.randomUUID(),
        ...(mentions.length > 0 && { mentions }),
      });
      setText('');
      setImages([]);
      setImageError(undefined);
      onPosted(post);
    } catch (reason) {
      onError(t('assistants.postFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await client.request('channel.stop', { channelId: channel.id });
    } catch (reason) {
      onError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setStopping(false);
    }
  };

  // ── 图片与文件 ──────────────────────────────────────────────────────

  /** 粘贴、拖进来或选好的图片：先显示缩略图，再传给 Host。 */
  const addImages = (files: readonly File[], named: boolean) => {
    if (!imagesEnabled) return;
    const chosen = pickImages(files, images.length);
    setImageError(chosen.rejected && rejectionText(chosen.rejected));
    for (const { file, mimeType } of chosen.accepted) {
      const key = crypto.randomUUID();
      const name = named ? file.name : undefined;
      void addImage(key, file, mimeType, name);
    }
  };

  const addImage = async (key: string, file: File, mimeType: UserImageMimeType, name?: string) => {
    try {
      const dataUrl = await readAsDataUrl(file);
      setImages((current) => [...current, { key, dataUrl, ...(name !== undefined && { name }) }]);
      const part = await uploadImage(client, dataUrl, mimeType, name);
      setImages((current) =>
        current.map((image) => (image.key === key ? { ...image, part } : image)),
      );
    } catch (error) {
      setImages((current) => current.filter((image) => image.key !== key));
      setImageError(
        t('composer.imageUploadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  /** 在光标处插入（前面不是空白时先补一个空格）。 */
  const insertAtCaret = (snippet: string) => {
    const at = Math.min(caret, text.length);
    const before = text.slice(0, at);
    const glue = before !== '' && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${glue}${snippet}${text.slice(at)}`;
    const cursor = at + glue.length + snippet.length;
    setText(next);
    setCaret(cursor);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const insertPaths = (chosen: readonly string[]) =>
    insertAtCaret(`${chosen.map(mentionText).join(' ')} `);

  /** 粘贴或拖进来的文件：图片上传，其余的插入成 @ 提及；取不到路径的提示格式不支持。 */
  const addFiles = (files: readonly File[], named: boolean) => {
    const { images: chosen, others } = splitFiles(files, imagesEnabled);
    const resolved = others.map((file) => ({
      file,
      path: localFiles ? platformApi().getPathForFile(file) : '',
    }));
    if (chosen.length > 0) addImages(chosen, named);
    const unresolved = resolved.find((entry) => entry.path === '');
    if (unresolved) setImageError(t('composer.imageUnsupported', { name: unresolved.file.name }));
    else if (chosen.length === 0) setImageError(undefined);
    const found = resolved.flatMap((entry) => (entry.path === '' ? [] : [entry.path]));
    if (found.length > 0) insertPaths(found);
  };

  const attachPaths = async () => {
    const chosen = await platformApi()
      .selectPaths()
      .catch(() => []);
    if (chosen.length === 0) inputRef.current?.focus();
    else insertPaths(chosen);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0 || !(imagesEnabled || localFiles)) return;
    event.preventDefault();
    // 截图粘贴进来的文件都叫 image.png，不带名字。
    addFiles(files, false);
  };

  const canDrop = imagesEnabled || localFiles;
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrop || !dragHasFiles(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!canDrop || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files), true);
  };

  // ── 听写 ────────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const dictation = useDictation({
    sessionId: channel.coordinator?.sessionId,
    onText: (transcript) => {
      const next = insertDictation(text, caret, transcript);
      setText(next.text);
      setCaret(next.cursor);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.cursor, next.cursor));
    },
  });
  const canDictate = supported && dictation.available;
  const dictating = dictation.phase === 'starting' || dictation.phase === 'recording';
  const dictationBar = dictation.phase !== 'idle';
  /** 录音时按了发送：转写完、文字放进输入框之后再发。 */
  const sendAfterDictation = useRef(false);
  const [sendQueued, setSendQueued] = useState(false);
  useEffect(() => {
    if (dictation.phase !== 'idle' || !sendAfterDictation.current) return;
    sendAfterDictation.current = false;
    if (dictation.errorKey === undefined) setSendQueued(true);
  }, [dictation.phase, dictation.errorKey]);
  // 转写的文字已经在这一次渲染的 `text` 里。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着排队的发送。
  useEffect(() => {
    if (!sendQueued) return;
    setSendQueued(false);
    void send();
  }, [sendQueued]);

  // 录音时 Esc 丢掉这段录音（先于下面的停止）；在回时 Esc 停止（弹层打开时让弹层先处理）。
  useEffect(() => {
    if (!dictating) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dictation.cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dictating, dictation.cancel]);
  const answering = supported && channel.answering === true;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (!answering) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void stopRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answering]);

  // ── 按键 ────────────────────────────────────────────────────────────

  const mention = (member: Channel) => {
    if (query === undefined) return;
    const next = `${text.slice(0, query.start)}@${member.title} ${text.slice(caret)}`;
    const at = query.start + member.title.length + 2;
    setText(next);
    setCaret(at);
    setPicked(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  };
  const { sendShortcut } = composerPrefs.use();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (canDictate && matchesShortcut(event, SHORTCUTS.dictation)) {
      event.preventDefault();
      if (!event.repeat) dictation.press();
      return;
    }
    if (choices.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setPicked((current) => (current + step + choices.length) % choices.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const member = choices[Math.min(picked, choices.length - 1)];
        if (member !== undefined) mention(member);
        return;
      }
    }
    const key = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        composing: false,
      },
      { busy: false, pendingEnabled: false, hasText: hasContent, sendShortcut },
    );
    if (key === 'send') {
      event.preventDefault();
      void send();
    }
  };
  /** ⌘⇧D 松开（D 或任一修饰键，macOS 按着 ⌘ 时 D 的 keyup 不一定来）结束。 */
  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      [
        'KeyD',
        'MetaLeft',
        'MetaRight',
        'ControlLeft',
        'ControlRight',
        'ShiftLeft',
        'ShiftRight',
      ].includes(event.code)
    ) {
      dictation.release();
    }
  };

  const placeholder = t(
    group ? 'assistants.group.placeholder' : 'assistants.composer.placeholder',
    { name: channel.title },
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放只是“+”菜单的快捷方式。
    <div className="relative" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {choices.length > 0 && (
        <ul
          className="absolute bottom-full left-0 mb-1.5 flex w-56 flex-col rounded-xl border border-border bg-popover p-1 shadow-md"
          aria-label={t('assistants.group.mention')}
          data-testid="mention-menu"
        >
          {choices.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted',
                  index === picked && 'bg-muted',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => mention(member)}
                aria-current={index === picked}
                data-mention={member.id}
              >
                {member.assistant && <AssistantAvatar avatar={member.assistant.avatar} size={20} />}
                <span className="min-w-0 truncate">{member.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          'flex flex-col gap-2 rounded-2xl border border-input bg-card p-2 focus-within:focus-field',
          dragging && 'border-ring ring-2 ring-ring/30',
        )}
        data-testid="assistant-composer"
      >
        {dictation.errorKey && (
          <div className="flex items-center gap-2 px-2 pt-1 text-xs" role="alert">
            <p className="min-w-0 text-destructive" data-testid="composer-dictation-error">
              {dictation.error}
            </p>
            {dictation.errorKey === 'dictation.error.modelMissing' && (
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:focus-ring"
                onClick={() => void navigate(paths.settings('dictation'))}
              >
                {t('dictation.openSettings')}
              </button>
            )}
          </div>
        )}
        {(images.length > 0 || imageError) && (
          <div className="flex flex-col gap-1.5 px-1 pt-1">
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="composer-images">
                {images.map((image) => (
                  <ComposerThumb
                    key={image.key}
                    src={image.dataUrl}
                    {...(image.name !== undefined && { name: image.name })}
                    uploading={image.part === undefined}
                    onRemove={() => {
                      setImages((current) => current.filter((entry) => entry.key !== image.key));
                      setImageError(undefined);
                      inputRef.current?.focus();
                    }}
                    onOpen={() => setPreview(image)}
                  />
                ))}
              </div>
            )}
            {imageError && (
              <p
                role="alert"
                className="text-xs text-destructive"
                data-testid="composer-image-error"
              >
                {imageError}
              </p>
            )}
          </div>
        )}
        {/* 单行时输入框与两边的按钮同高（32px），文字和按钮在同一条中线上。 */}
        <div className="flex items-end gap-1">
          {dictationBar ? (
            <DictationBar dictation={dictation} />
          ) : (
            <>
              {(imagesEnabled || localFiles) && (
                <div className="flex h-8 shrink-0 items-center">
                  <ComposerPlusMenu
                    commands={[]}
                    disabled={false}
                    canMention={false}
                    canAttachFiles={localFiles}
                    canAttachImages={imagesEnabled}
                    canCommand={false}
                    onAttach={() => void attachPaths()}
                    onAttachImages={() => imageInputRef.current?.click()}
                    onMention={() => {}}
                    onCommand={() => {}}
                    onRun={() => {}}
                    onClosed={() => window.setTimeout(() => inputRef.current?.focus(), 0)}
                  />
                </div>
              )}
              <Textarea
                ref={inputRef}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setCaret(event.target.selectionStart);
                  setPicked(0);
                  dictation.clearError();
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onPaste={onPaste}
                placeholder={placeholder}
                aria-label={placeholder}
                className="max-h-48 min-h-8 flex-1 resize-none rounded-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 focus-visible:ring-0"
                rows={1}
                data-field="post"
              />
              {canDictate && <DictationButton dictation={dictation} disabled={false} />}
            </>
          )}
          {dictationBar ? (
            <ComposerButton
              action="send"
              loading={dictation.phase === 'transcribing'}
              disabled={false}
              onClick={() => {
                sendAfterDictation.current = true;
                dictation.stop();
              }}
            />
          ) : (
            <ComposerButton
              action={action}
              loading={busy}
              disabled={action === 'stop' ? stopping : !hasContent || uploading}
              onClick={() => void (action === 'stop' ? stop() : send())}
            />
          )}
        </div>
      </div>
      {imagesEnabled && (
        <input
          ref={imageInputRef}
          type="file"
          accept={COMPOSER_IMAGE_ACCEPT}
          multiple
          hidden
          data-testid="composer-image-input"
          onChange={(event) => {
            addImages(Array.from(event.target.files ?? []), true);
            event.target.value = '';
            inputRef.current?.focus();
          }}
        />
      )}
      <ImagePreview
        src={preview?.dataUrl}
        {...(preview?.name !== undefined && { name: preview.name })}
        onClose={() => setPreview(undefined)}
      />
    </div>
  );
}
