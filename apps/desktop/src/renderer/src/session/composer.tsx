import {
  IMAGE_MAX_PER_MESSAGE,
  type PendingDelivery,
  type SessionState,
  type UserImagePart,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowUp, ChevronDown, Folder, ListChecks, Square, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { splitPath } from '@/changes/changes-model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toRelativePath } from '@/files/file-path';
import { type FileScope, useFileSearch, useFilesSupported } from '@/files/files-data';
import { Beam } from '@/fx/beam';
import { MetalCircle } from '@/fx/metal';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import {
  type ComposerCommand,
  type ComposerCommandItem,
  nudge,
  searchCommands,
  searchItems,
  slashMenuState,
} from './composer-commands';
import {
  COMPOSER_IMAGE_ACCEPT,
  type ComposerImage,
  dragHasFiles,
  type ImageRejection,
  pickImages,
} from './composer-images';
import { ComposerMenu, type MenuEntry, menuOptionId } from './composer-menu';
import { ComposerPlusMenu } from './composer-plus-menu';
import { composerPrefs, sendKeyLabel } from './composer-prefs';
import { detectMentionTrigger, mentionText, replaceTextRange } from './composer-trigger';
import { DeliverySwitch } from './delivery-switch';
import { ComposerThumb, ImagePreview, readAsDataUrl, uploadImage } from './image-attachments';
import { composerKeyAction, otherDelivery } from './pending-model';
import { caretOnFirstLine, caretOnLastLine, promptAt, rememberPrompt } from './prompt-history';

/** 有回合在进行（含正在取消）：没有字时按钮是“停止”；Host 不支持待发消息时不能再发送。 */
export function isBusy(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'awaiting_approval' || state === 'cancelling';
}

/**
 * 计划模式（0.36.0，desktop-tokens §49）：开着时底栏有“计划”芯片（点它退出），Shift+Tab 开关；计划给出之后（`followUp`）
 * 输入框空着时主按钮是“实施”（带“在新会话中实施”的下拉），有字时发送键是“继续完善”。
 */
export interface ComposerPlan {
  active: boolean;
  onToggle: () => void;
  followUp?: { onImplement: () => void; onImplementInNew?: () => void };
}

/** 未发送的草稿按会话留在内存里，切走再切回来还在（不持久化）。 */
const drafts = new Map<string, string>();

/** 草稿里的图片（0.28.0），同样按会话留在内存里。 */
const imageDrafts = new Map<string, ComposerImage[]>();
const imageListeners = new Map<string, Set<(images: ComposerImage[]) => void>>();

/** 改一个草稿的图片，挂着的输入框跟着刷新（图片传完时可能已经换了会话，草稿表照样更新）。 */
function updateImageDraft(
  draftKey: string,
  update: (current: ComposerImage[]) => ComposerImage[],
): void {
  const next = update(imageDrafts.get(draftKey) ?? []);
  if (next.length > 0) imageDrafts.set(draftKey, next);
  else imageDrafts.delete(draftKey);
  for (const listener of imageListeners.get(draftKey) ?? []) listener(next);
}

function rejectionText(rejected: { reason: ImageRejection; name: string }): string {
  if (rejected.reason === 'limit')
    return t('composer.imageLimit', { count: IMAGE_MAX_PER_MESSAGE });
  return rejected.reason === 'too_large'
    ? t('composer.imageTooLarge', { name: rejected.name })
    : t('composer.imageUnsupported', { name: rejected.name });
}

/** 挂着的输入框：`restoreDraft` 放回来的文字。 */
const textListeners = new Map<string, Set<(text: string) => void>>();

/**
 * 把一段文字放回输入框（0.38.0：编辑过的消息撤回了回合却没发出去）：挂着的输入框空着时直接显示，否则留作草稿。
 */
export function restoreDraft(draftKey: string, text: string): void {
  if ((drafts.get(draftKey) ?? '') === '') drafts.set(draftKey, text);
  for (const listener of textListeners.get(draftKey) ?? []) listener(text);
}

/** 预先放一份草稿（基于历史新建会话，T5.5）：下次打开这个输入框时显示。 */
export function setDraft(draftKey: string, text: string): void {
  if (text) drafts.set(draftKey, text);
  else drafts.delete(draftKey);
}

/**
 * 输入框：Enter 发送、Shift+Enter 换行、输入法合成期间不发送（openwork-notes §3.7）。回合进行中（R11）：给了
 * `busyDelivery`（Host 支持待发消息）时照常可以发，Enter 与发送键按 `busyDelivery`（“回合进行中按回车”的设置），Tab 用
 * 另一种；没给时不允许再发送（旧 Host 会回 SESSION_BUSY）。`onSend` 返回 true 表示已发出，清空输入框；失败时保留文字。
 *
 * U3 起照方向稿 A 静器（维护者 2026-10-14 定）：右下角是圆形的金属按钮，有字时发送，回合进行中没有字（或不能再发）时
 * 变成停止（金属淡到 0.55），Esc 也可以停止；回合进行中按钮左边是“插话 | 排队”切换（改的就是那项 Host 设置）。回合
 * 进行中、没有在等审批时，输入框底边有一道转动的光（border-beam）。
 *
 * `variant="home"` 是首页的大输入框（U4，方向稿的 composer-big）：更高、字更大，获得焦点时底边有同样的光（focus 预设）。
 *
 * U12 起外形照 Codex 桌面端：20 px 圆角（`rounded-3xl`）、细分隔线描边；底栏左边是“插话 | 排队”与 `leading`，右边是模型
 * 与发送键；不再显示会话状态（进行中的状态与用时在消息流末尾）。`tray` 是贴在输入框上方、被它压住下沿的环境栏（新会话的
 * 项目与本地环境，session/environment-bar.tsx）。
 *
 * U33 起照 T3 Code 与 Codex 桌面端：消息开头打 `/` 弹出斜杠命令（`commands`，由所在页面给出，有的带二级菜单），打 `@` 弹出
 * 文件（`fileScope` 的目录里按名字找），上下键选、回车或 Tab 确定、Esc 收起；底栏最左边是“+”菜单（文件和文件夹、提及文件、
 * 命令与页面标为 `plus` 的命令）。
 *
 * 0.28.0 起照 Codex 桌面端、Claude Code 桌面端与 T3 Code 带图片（`acceptImages` 时）：粘贴、拖进输入框或从“+”菜单的
 * “图片”选，立即传给 Host，缩略图排在文字上方（右上角移除，点开看大图）；传完之前不能发送，只有图片也能发。
 *
 * 0.36.0 起有计划模式（`plan`，见 `ComposerPlan`）。
 */
export function Composer({
  draftKey,
  state,
  disabled = false,
  disabledReason,
  leading,
  tray,
  model,
  busyDelivery,
  onBusyDeliveryChange,
  onSend,
  onStop,
  autoFocus = false,
  variant = 'session',
  placeholder,
  commands,
  fileScope,
  acceptImages = false,
  plan,
}: {
  /** 草稿归属（会话 ID，或新会话草稿的工作区）。 */
  draftKey: string;
  state: SessionState | undefined;
  /** 不能发送也不能停止（只读、还没连上 Host、正在建会话）。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 底栏左侧（“插话 | 排队”之前）：权限模式（U15）、首页没有模型服务时的“添加模型服务”。 */
  leading?: ReactNode;
  /** 输入框上方的环境栏（U12）：新会话的项目与本地环境。 */
  tray?: ReactNode;
  /** 底栏右侧、发送按钮左边：模型与思考力度（U8，session/model-picker.tsx）。 */
  model?: ReactNode;
  /** 回合进行中按发送的方式（R11）；省略表示回合进行中不能发送。 */
  busyDelivery?: PendingDelivery;
  /** 改“回合进行中按回车”（Host 设置）；给了才显示切换。 */
  onBusyDeliveryChange?: (delivery: PendingDelivery) => void;
  /** 回合进行中发出时带上方式；空闲时不带。`images` 是已传给 Host 的图片（0.28.0）。 */
  onSend: (
    text: string,
    delivery?: PendingDelivery,
    images?: readonly UserImagePart[],
  ) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
  variant?: 'session' | 'home';
  /** 默认是“描述你要完成的任务…”；不能发送时显示 `disabledReason`。 */
  placeholder?: string;
  /** 斜杠命令（U33）；省略时没有斜杠菜单。 */
  commands?: readonly ComposerCommand[];
  /** @ 提及与“文件和文件夹”的目录（U33）；省略时没有。 */
  fileScope?: FileScope;
  /** 能带图片（0.28.0，`useAcceptsImages`）：Host 支持、模型收图片。 */
  acceptImages?: boolean;
  /** 计划模式（0.36.0）；省略时没有（Host 或引擎不支持）。 */
  plan?: ComposerPlan;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const home = variant === 'home';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = isBusy(state);
  const pendingEnabled = busyDelivery !== undefined;

  // ── 图片（0.28.0） ──────────────────────────────────────────────────
  const { client } = useHostConnection();
  const [images, setImagesState] = useState<ComposerImage[]>(() => imageDrafts.get(draftKey) ?? []);
  const [imageError, setImageError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ComposerImage>();
  const imageInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const listeners = imageListeners.get(draftKey) ?? new Set();
    imageListeners.set(draftKey, listeners);
    listeners.add(setImagesState);
    return () => {
      listeners.delete(setImagesState);
    };
  }, [draftKey]);
  useEffect(() => {
    const listeners = textListeners.get(draftKey) ?? new Set();
    textListeners.set(draftKey, listeners);
    const restore = (restored: string) =>
      setText((current) => (current.trim() === '' ? restored : current));
    listeners.add(restore);
    return () => {
      listeners.delete(restore);
    };
  }, [draftKey]);
  const updateImages = (update: (current: ComposerImage[]) => ComposerImage[]) =>
    updateImageDraft(draftKey, update);
  const uploading = images.some((image) => image.part === undefined);
  const imagesEnabled = acceptImages && client !== undefined && !disabled;
  const hasContent = text.trim() !== '' || images.length > 0;
  const canSend = (!busy || pendingEnabled) && !disabled && !sending && !uploading && hasContent;
  // 计划给出之后，输入框空着时按发送就是“实施”（0.36.0）。
  const followUp = !busy ? plan?.followUp : undefined;
  const implementReady =
    followUp !== undefined && !hasContent && !disabled && !sending && !uploading;

  useEffect(() => setDraft(draftKey, text), [draftKey, text]);

  /** 粘贴、拖进来或选好的文件：挑出能发的图片，先显示缩略图，再传给 Host。 */
  const addImages = (files: readonly File[], named: boolean) => {
    if (!imagesEnabled || !client) return;
    const picked = pickImages(files, images.length);
    setImageError(picked.rejected && rejectionText(picked.rejected));
    for (const { file, mimeType } of picked.accepted) {
      const key = crypto.randomUUID();
      const name = named ? file.name : undefined;
      void readAsDataUrl(file)
        .then(async (dataUrl) => {
          updateImages((current) => [
            ...current,
            { key, dataUrl, ...(name !== undefined && { name }) },
          ]);
          const part = await uploadImage(client, dataUrl, mimeType, name);
          updateImages((current) =>
            current.map((image) => (image.key === key ? { ...image, part } : image)),
          );
        })
        .catch((error: unknown) => {
          updateImages((current) => current.filter((image) => image.key !== key));
          setImageError(
            t('composer.imageUploadFailed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    }
  };

  const removeImage = (key: string) => {
    updateImages((current) => current.filter((image) => image.key !== key));
    setImageError(undefined);
    textareaRef.current?.focus();
  };

  /** 粘贴：剪贴板里有图片时当图片加进来（同 T3 Code：有文件就不粘贴文字）。 */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imagesEnabled) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    // 截图粘贴进来的文件都叫 image.png，不带名字。
    addImages(files, false);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!imagesEnabled || !dragHasFiles(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // 移到子元素上也会触发：只有离开整个输入框才算。
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!imagesEnabled || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addImages(Array.from(event.dataTransfer.files), true);
    textareaRef.current?.focus();
  };

  // ── 斜杠命令与 @ 提及（U33） ────────────────────────────────────────
  const listId = useId();
  /** 正在翻的历史（U36）：-1 表示没在翻。 */
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { sendShortcut } = composerPrefs.use();
  const [cursor, setCursor] = useState(() => text.length);
  /** 下一次渲染后要放的光标（菜单替换了文字）。 */
  const pendingCursor = useRef<number>(undefined);
  /** 按 Esc 收起的菜单：同一个触发（种类与位置）不再弹出，换了才弹。 */
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const filesSupported = useFilesSupported();
  const canMention = fileScope !== undefined && filesSupported;
  const slash =
    commands && commands.length > 0 ? slashMenuState(text, cursor, commands) : undefined;
  const mention = !slash && canMention ? detectMentionTrigger(text, cursor) : null;
  const menuKey = slash
    ? `slash:${slash.level}:${slash.command?.name ?? ''}:${slash.rangeStart}`
    : mention
      ? `mention:${mention.rangeStart}`
      : undefined;
  const menuOpen = menuKey !== undefined && menuKey !== dismissed && focused && !disabled;
  // 触发没了（删掉了 `/` 或 `@`、发出去了）：下一次照常弹出。
  useEffect(() => {
    if (menuKey === undefined) setDismissed(undefined);
  }, [menuKey]);
  const mentionSearch = useFileSearch(
    menuOpen && mention ? fileScope : undefined,
    menuOpen && mention ? mention.query : undefined,
    { limit: 30 },
  );
  const query = slash?.query ?? mention?.query ?? '';

  const slashLevel = slash?.level;
  const slashCommand = slash?.command;
  const slashQuery = slash?.query;
  const slashResults = useMemo<readonly (ComposerCommand | ComposerCommandItem)[]>(() => {
    if (slashLevel === undefined || slashQuery === undefined || !commands) return [];
    if (slashLevel === 'items') return searchItems(slashCommand?.items?.() ?? [], slashQuery);
    return searchCommands(commands, slashQuery);
  }, [slashLevel, slashCommand, slashQuery, commands]);

  const entries = useMemo<MenuEntry[]>(() => {
    if (slash?.level === 'commands') {
      return (slashResults as ComposerCommand[]).map((command) => {
        const Icon = command.icon;
        return {
          key: command.name,
          icon: <Icon />,
          label: command.label,
          ...(command.detail !== undefined && { detail: command.detail }),
          hint: `/${command.name}`,
          nested: command.items !== undefined,
          ...(command.checked && { checked: true }),
        };
      });
    }
    if (slash?.level === 'items') {
      return (slashResults as ComposerCommandItem[]).map((item) => ({
        key: item.id,
        icon: item.icon,
        label: item.label,
        ...(item.detail !== undefined && { detail: item.detail }),
        ...(item.checked && { checked: true }),
        ...(item.disabled && { disabled: true }),
      }));
    }
    if (mention) {
      return mentionSearch.entries.map((entry) => {
        const { name, dir } = splitPath(entry.path);
        const Icon = entry.kind === 'directory' ? Folder : fileIcon(entry.path);
        return { key: entry.path, icon: <Icon />, label: name, detail: dir };
      });
    }
    return [];
  }, [slash?.level, slashResults, mention, mentionSearch.entries]);

  // 换了触发或查询：高亮回到第一项；二级菜单刚打开时停在当前选中的那项（一级里打勾的是开着的开关，如 `/status`，不跳过去）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着触发与查询。
  useEffect(() => {
    const checked =
      query === '' && slash?.level === 'items' ? entries.findIndex((entry) => entry.checked) : -1;
    setActive(Math.max(0, checked));
  }, [menuKey, query]);

  // 菜单替换文字之后放光标。
  useLayoutEffect(() => {
    const target = pendingCursor.current;
    const textarea = textareaRef.current;
    if (target === undefined || !textarea) return;
    pendingCursor.current = undefined;
    textarea.focus();
    textarea.setSelectionRange(target, target);
  });

  const replaceRange = (start: number, end: number, replacement: string) => {
    const next = replaceTextRange(text, start, end, replacement);
    setText(next.text);
    setCursor(next.cursor);
    pendingCursor.current = next.cursor;
  };

  /** 在光标处插入（前面不是空白时先补一个空格）。 */
  const insertAtCursor = (snippet: string) => {
    const at = Math.min(cursor, text.length);
    const needsSpace = at > 0 && !/\s/.test(text[at - 1] ?? '');
    replaceRange(at, at, `${needsSpace ? ' ' : ''}${snippet}`);
  };

  /** 执行一条没有二级菜单的命令：`insert` 换成文字，`run` 先去掉 `/命令` 再执行。 */
  const runCommand = (command: ComposerCommand, range?: { start: number; end: number }) => {
    if (command.insert !== undefined) {
      if (range) replaceRange(range.start, range.end, command.insert);
      else if (text.trim() === '') replaceRange(0, text.length, command.insert);
      else insertAtCursor(command.insert);
      return;
    }
    if (range) replaceRange(range.start, range.end, '');
    command.run?.();
  };

  const selectEntry = (index: number) => {
    if (slash?.level === 'commands') {
      const command = (slashResults as ComposerCommand[])[index];
      if (!command) return;
      const range = { start: slash.rangeStart, end: slash.rangeEnd };
      if (command.items) replaceRange(range.start, range.end, `/${command.name} `);
      else runCommand(command, range);
      return;
    }
    if (slash?.level === 'items') {
      const item = (slashResults as ComposerCommandItem[])[index];
      if (!item || item.disabled) return;
      replaceRange(slash.rangeStart, slash.rangeEnd, '');
      item.run();
      return;
    }
    if (mention) {
      const entry = mentionSearch.entries[index];
      if (!entry) return;
      replaceRange(mention.rangeStart, mention.rangeEnd, `${mentionText(entry.path)} `);
    }
  };

  /** “+”菜单的“文件和文件夹”：系统的选择框，选中的插入成 @ 提及（目录里的用相对路径）。 */
  const attachPaths = async () => {
    if (!fileScope) return;
    const chosen = await window.wevir.selectPaths(fileScope.root).catch(() => []);
    if (chosen.length === 0) {
      textareaRef.current?.focus();
      return;
    }
    const mentions = chosen.map((path) =>
      mentionText(toRelativePath(path, fileScope.root) ?? path),
    );
    insertAtCursor(`${mentions.join(' ')} `);
  };

  /** 菜单开着时的按键：返回 true 表示已处理。 */
  const onMenuKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menuOpen || menuKey === undefined) return false;
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing) return false;
    if (event.key === 'Escape') {
      setDismissed(menuKey);
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (entries.length === 0) return false;
      setActive((current) => nudge(current, event.key === 'ArrowDown' ? 1 : -1, entries.length));
      return true;
    }
    const plainEnter =
      event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
    if ((plainEnter || (event.key === 'Tab' && !event.shiftKey)) && entries.length > 0) {
      selectEntry(Math.min(active, entries.length - 1));
      return true;
    }
    return false;
  };

  // 带着草稿打开时光标放到末尾、滚到底（基于历史新建的长草稿，接着写“接下来”）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!autoFocus || !textarea || textarea.value === '') return;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
  }, []);

  // Esc 停止：焦点不在输入框里也算（弹层打开时让弹层先处理 Esc）。
  useEffect(() => {
    if (!busy || disabled) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onStop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, disabled, onStop]);

  /** 发送；回合进行中带上方式，默认按设置。 */
  const send = async (delivery = busyDelivery) => {
    if (implementReady) {
      followUp.onImplement();
      return;
    }
    if (!canSend) return;
    setSending(true);
    const sent = text.trim();
    const sentImages = images;
    try {
      // 等待期间可能已经输入了下一条（回合进行中接着发是常事）：只清掉发出去的那条。
      const parts = sentImages.flatMap((image) => (image.part ? [image.part] : []));
      if (await onSend(sent, busy ? delivery : undefined, parts)) {
        if (sent !== '') rememberPrompt(sent);
        setHistoryIndex(-1);
        setText((current) => (current.trim() === sent ? '' : current));
        const keys = new Set(sentImages.map((image) => image.key));
        updateImages((current) => current.filter((image) => !keys.has(image.key)));
        setImageError(undefined);
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  /** ↑ / ↓ 翻发过的消息（U36）：输入框为空、或正在翻且光标在首行 / 末行时。 */
  const onHistoryKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    const caret = event.currentTarget.selectionStart;
    if (event.key === 'ArrowUp') {
      const browsing = historyIndex >= 0;
      if (!(text === '' || (browsing && caretOnFirstLine(text, caret)))) return false;
      const next = promptAt(historyIndex + 1);
      if (next === undefined) return browsing;
      setHistoryIndex(historyIndex + 1);
      replaceRange(0, text.length, next);
      return true;
    }
    if (historyIndex < 0 || !caretOnLastLine(text, caret)) return false;
    const next = historyIndex === 0 ? '' : (promptAt(historyIndex - 1) ?? '');
    setHistoryIndex(historyIndex - 1);
    replaceRange(0, text.length, next);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onMenuKey(event) || (!menuOpen && onHistoryKey(event))) {
      event.preventDefault();
      return;
    }
    const action = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        // 输入法合成中按的回车是选词，不发送（Safari 等合成结束时 keyCode 为 229）。
        composing: event.nativeEvent.isComposing || event.keyCode === 229,
      },
      { busy, pendingEnabled, hasText: hasContent, sendShortcut, planToggle: plan !== undefined },
    );
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'toggle-plan') plan?.onToggle();
    else if (action === 'send') void send();
    else if (busyDelivery !== undefined) void send(otherDelivery(busyDelivery));
  };

  /** 右下角按钮现在做什么：回合进行中、没有字或不能再发时是停止；计划给出之后有字时是“继续完善”。 */
  const action: ComposerAction = !busy
    ? followUp !== undefined
      ? 'refine'
      : 'send'
    : busyDelivery === undefined || !hasContent
      ? 'stop'
      : busyDelivery;

  return (
    // 菜单（U33）画在最外层：光束那一层裁掉溢出（overflow: hidden），放在里面会被裁掉。
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放图片（0.28.0）只是“+”菜单“图片”的快捷方式。
    <div className="relative" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {menuOpen && (entries.length > 0 || slash !== undefined || !mentionSearch.pending) && (
        <ComposerMenu
          listId={listId}
          label={mention ? t('composer.mentionFile') : t('composer.commands')}
          entries={entries}
          active={active}
          {...(slash?.level === 'items' &&
            slash.command && {
              title: slash.command.label,
              onBack: () => replaceRange(slash.rangeStart, slash.rangeEnd, '/'),
            })}
          empty={mention ? t('files.noMatches') : t('composer.noCommands')}
          onActive={setActive}
          onSelect={selectEntry}
        />
      )}
      {tray && (
        // 环境栏比输入框各窄 12 px，下沿垫在输入框下面（-mb-4 与 pb-5），看上去是从输入框背后伸出来的一条（Codex）。
        <div
          data-testid="composer-tray"
          className="mx-3 -mb-4 flex min-w-0 items-center gap-0.5 rounded-t-2xl border border-b-0 border-border bg-card/55 px-1.5 pt-1 pb-5"
        >
          {tray}
        </div>
      )}
      <Beam
        preset={home ? 'focus' : 'composer'}
        active={home ? focused && !disabled : busy && state !== 'awaiting_approval' && !disabled}
        className="relative block w-full"
      >
        <div
          className={cn(
            'rounded-3xl border border-border bg-card shadow-xs transition-colors',
            // 首页的焦点只用光束表示（方向稿），会话里的输入框聚焦时描边加深一档。
            !home && 'focus-within:border-input',
            disabled && 'opacity-70',
            dragging && 'border-ring ring-2 ring-ring/30',
          )}
        >
          {(images.length > 0 || imageError) && (
            <div className="flex flex-col gap-1.5 px-3.5 pt-3">
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2" data-testid="composer-images">
                  {images.map((image) => (
                    <ComposerThumb
                      key={image.key}
                      src={image.dataUrl}
                      {...(image.name !== undefined && { name: image.name })}
                      uploading={image.part === undefined}
                      onRemove={() => removeImage(image.key)}
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
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCursor(event.target.selectionStart);
              setHistoryIndex(-1);
            }}
            onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            role={menuOpen ? 'combobox' : undefined}
            aria-expanded={menuOpen || undefined}
            aria-controls={menuOpen ? listId : undefined}
            aria-activedescendant={
              menuOpen && entries[active] ? menuOptionId(listId, entries[active].key) : undefined
            }
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label={t('session.composerPlaceholder')}
            placeholder={disabledReason ?? placeholder ?? t('session.composerPlaceholder')}
            className={cn(
              'max-h-60 resize-none rounded-none border-0 bg-transparent px-4 pb-1 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent',
              // 原语在 md 以上是 text-sm；首页大一档（方向稿 composer-big 比会话的输入框大 1px）。
              home ? 'min-h-19 pt-4 text-base md:text-base' : 'min-h-13 pt-3.5 text-base',
            )}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
              {(canMention || imagesEnabled || (commands?.length ?? 0) > 0) && (
                <ComposerPlusMenu
                  commands={commands ?? []}
                  disabled={disabled}
                  canMention={canMention}
                  canAttachImages={imagesEnabled}
                  onAttachImages={() => imageInputRef.current?.click()}
                  canCommand={(commands?.length ?? 0) > 0 && text.trim() === ''}
                  onAttach={() => void attachPaths()}
                  onMention={() => insertAtCursor('@')}
                  onCommand={() => replaceRange(0, text.length, '/')}
                  onRun={(command) => runCommand(command)}
                  onClosed={() => window.setTimeout(() => textareaRef.current?.focus(), 0)}
                />
              )}
              {leading}
              {plan?.active && (
                <PlanChip
                  disabled={disabled}
                  onExit={() => {
                    plan.onToggle();
                    textareaRef.current?.focus();
                  }}
                />
              )}
              {busy && busyDelivery !== undefined && onBusyDeliveryChange && (
                <DeliverySwitch
                  value={busyDelivery}
                  disabled={disabled}
                  onChange={onBusyDeliveryChange}
                />
              )}
            </div>
            {model}
            {implementReady ? (
              <ImplementButton
                onImplement={followUp.onImplement}
                {...(followUp.onImplementInNew && { onImplementInNew: followUp.onImplementInNew })}
              />
            ) : (
              <ComposerButton
                action={action}
                // 金属只在“能做点什么”时流动：有字可发、或回合进行中（停止）。空着的输入框停在静帧。
                flowing={action === 'stop' ? !disabled : canSend}
                disabled={action === 'stop' ? disabled : !canSend}
                onClick={() => (action === 'stop' ? onStop() : void send())}
              />
            )}
          </div>
        </div>
      </Beam>
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
            textareaRef.current?.focus();
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

type ComposerAction = 'send' | 'refine' | 'stop' | PendingDelivery;

const ACTION_LABELS = {
  send: 'session.send',
  refine: 'plan.refine',
  stop: 'session.stop',
  steer: 'session.sendSteer',
  queue: 'session.sendQueue',
} as const;

/** 底栏的“计划”芯片（0.36.0）：计划模式开着时显示，点它退出（Shift+Tab 同）。 */
function PlanChip({ disabled, onExit }: { disabled: boolean; onExit: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label={t('composer.planExit')}
            data-testid="composer-plan-chip"
            onClick={onExit}
            className="group/plan flex h-7 shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-foreground outline-none transition-colors duration-150 hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          />
        }
      >
        <ListChecks aria-hidden className="size-3.5 group-hover/plan:hidden" />
        <X aria-hidden className="hidden size-3.5 group-hover/plan:block" />
        {t('composer.planChip')}
      </TooltipTrigger>
      <TooltipContent>
        {t('composer.planExit')}
        <kbd className="ml-1.5 font-sans opacity-70">⇧Tab</kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 计划给出之后、输入框空着时的主按钮（0.36.0，照 T3 Code 的 ComposerPrimaryActions）：“实施”回到默认模式发出实施消息；
 * 右边的下拉是“在新会话中实施”。
 */
function ImplementButton({
  onImplement,
  onImplementInNew,
}: {
  onImplement: () => void;
  onImplementInNew?: () => void;
}) {
  const pill =
    'flex h-8 shrink-0 items-center bg-primary text-sm font-medium text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/50';
  return (
    <span className="flex shrink-0 items-center" data-testid="plan-implement">
      <button
        type="button"
        data-composer-action="implement"
        onClick={onImplement}
        className={cn(
          pill,
          onImplementInNew ? 'rounded-l-full pr-2.5 pl-3.5' : 'rounded-full px-3.5',
        )}
      >
        {t('plan.implement')}
      </button>
      {onImplementInNew && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('plan.implementOptions')}
            data-testid="plan-implement-options"
            className={cn(
              pill,
              'rounded-r-full border-l border-primary-foreground/20 pr-2.5 pl-1.5',
            )}
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" sideOffset={8}>
            <DropdownMenuItem onClick={onImplementInNew} data-action="implement-in-new">
              {t('plan.implementInNew')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

/**
 * 圆形的金属按钮（metal-fx 的 circle、gold）。metal-fx 把按钮的背景清成透明、内圈是它自己的底色并设好对比色，图标的颜色
 * 继承它，所以按钮不设颜色。库会抹掉子元素的 outline 与阴影（normalizeHostStyles），焦点环由外层的 focus-within 画。
 */
function ComposerButton({
  action,
  flowing,
  disabled,
  onClick,
}: {
  action: ComposerAction;
  flowing: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = t(ACTION_LABELS[action]);
  return (
    <span className="shrink-0 rounded-full transition-transform duration-150 ease-smooth has-focus-visible:ring-2 has-focus-visible:ring-ring/50 has-[button:active:not(:disabled)]:scale-95">
      <MetalCircle strength={action === 'stop' ? 0.55 : 1} flowing={flowing}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={label}
                disabled={disabled}
                data-composer-action={action}
                onClick={onClick}
                className="flex size-8 items-center justify-center rounded-full outline-none disabled:opacity-40"
              />
            }
          >
            {action === 'stop' ? (
              <Square aria-hidden className="size-3 fill-current" />
            ) : (
              <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {label}
            <kbd className="ml-1.5 font-sans opacity-70">
              {action === 'stop' ? 'Esc' : sendKeyLabel(composerPrefs.get().sendShortcut)}
            </kbd>
          </TooltipContent>
        </Tooltip>
      </MetalCircle>
    </span>
  );
}
