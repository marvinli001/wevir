import type { WevirClient } from '@wevir/client-sdk';
import {
  MESSAGE_TEXT_MAX_LENGTH,
  type PendingDelivery,
  type SessionId,
  type SessionState,
  type UserImageMimeType,
} from '@wevir/protocol';
import { cn } from 'cn';
import { BookOpen, ChevronDown, Folder, ListChecks, X } from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { splitPath } from '@/changes/changes-model';
import { ErrorNote } from '@/components/error-note';
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
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import { getShortcut, IS_MAC, matchesShortcut } from '@/lib/shortcuts';
import { paths } from '@/routes/paths';
import { type ComposerAction, ComposerButton } from './composer-button';
import { useComposerCatalog } from './composer-catalog';
import {
  type ComposerCommand,
  type ComposerCommandItem,
  nudge,
  searchCommands,
  searchItems,
  slashMenuState,
} from './composer-commands';
import {
  type DraftAttachment,
  draftFor,
  draftIssue,
  finishComposerSend,
  hasDraft,
  textLength,
} from './composer-drafts';
import type { ComposerAttachmentPart } from './composer-images';
import { useComposerInput } from './composer-input';
import { prepareImage, uploadAttachment, uploadDraft } from './composer-media';
import { ComposerMenu, type MenuEntry, menuOptionId } from './composer-menu';
import { withDraftPastes } from './composer-pastes';
import { ComposerPlusMenu } from './composer-plus-menu';
import { composerPrefs } from './composer-prefs';
import { detectMentionTrigger, mentionText, replaceTextRange } from './composer-trigger';
import { DeliverySwitch } from './delivery-switch';
import { DictationBar, DictationButton } from './dictation-button';
import { insertDictation } from './dictation-model';
import { composerKeyAction, otherDelivery } from './pending-model';
import { ghostText, isAcceptKey } from './prompt-suggestion';
import { appendQuote } from './selection-model';
import { useDictation } from './use-dictation';

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

/** 模拟器的标注也按输入框的像素和字节限制处理。 */
export async function attachDraftImage(
  draftKey: string,
  client: WevirClient,
  image: { dataUrl: string; mimeType: UserImageMimeType; name?: string },
) {
  const store = draftFor(draftKey);
  await store.loaded;
  const raw = Uint8Array.from(atob(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)), (ch) =>
    ch.charCodeAt(0),
  );
  const item = await prepareImage(
    new Blob([raw], { type: image.mimeType }),
    image.mimeType,
    image.name,
  );
  const current = store.get().draft;
  const candidate = { ...current, attachments: [...current.attachments, item] };
  const issue = draftIssue(candidate);
  if (issue) throw new Error(issue);
  store.edit(() => candidate);
  await uploadAttachment(client, item);
}

export function restoreDraft(
  draftKey: string,
  text: string,
  append = false,
  parts: readonly ComposerAttachmentPart[] = [],
  pasted: readonly string[] = [],
) {
  draftFor(draftKey).edit((draft) => {
    const attachments: DraftAttachment[] = parts.map((part) => ({
      key: crypto.randomUUID(),
      kind: part.type,
      size: part.size,
      ...(part.name && { name: part.name }),
      part,
    }));
    return {
      ...draft,
      text:
        draft.text.trim() === '' ? text : append ? `${draft.text.trimEnd()}\n${text}` : draft.text,
      attachments: [...draft.attachments, ...attachments],
      pastes: [...draft.pastes, ...pasted.map((text) => ({ key: crypto.randomUUID(), text }))],
    };
  });
}
export function setDraft(draftKey: string, text: string) {
  draftFor(draftKey).edit((draft) => ({ ...draft, text }));
}

/** 挂着的输入框：`insertQuote` 追加引用。 */
const quoteListeners = new Map<string, (selected: string) => void>();
/** 打开时要把光标放到末尾并获得焦点的输入框（`insertQuote` 时它还没挂上，如刚分出的支线窗格）。 */
const focusOnOpen = new Set<string>();

/**
 * 把选中的文字作为引用追加到输入框（desktop-tokens §57，消息里选中文字的“添加到对话”）：输入框挂着时追加在已有内容后面、
 * 获得焦点、光标落在引用后面可以接着写；还没挂上时（刚分出的支线窗格）写进草稿，打开时再聚焦。
 */
export function insertQuote(draftKey: string, selected: string): void {
  const listener = quoteListeners.get(draftKey);
  if (listener) {
    listener(selected);
    return;
  }
  draftFor(draftKey).edit((draft) => ({
    ...draft,
    text: appendQuote(draft.text, selected)?.text ?? draft.text,
  }));
  focusOnOpen.add(draftKey);
}

/** 挂着的输入框：`insertMention` 在光标处插入 @ 提及。 */
const mentionListeners = new Map<string, (path: string) => void>();

/**
 * 把一个文件或文件夹作为 @ 提及放进输入框（消息里文件链接的右键菜单“添加到对话”）：输入框挂着时插在光标处并获得焦点，规则同
 * “+”菜单选的文件（目录里的用相对路径）；还没挂上时追加到草稿末尾。
 */
export function insertMention(draftKey: string, path: string): void {
  const listener = mentionListeners.get(draftKey);
  if (listener) {
    listener(path);
    return;
  }
  draftFor(draftKey).edit((draft) => ({
    ...draft,
    text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? ' ' : ''}${mentionText(path)} `,
  }));
  focusOnOpen.add(draftKey);
}

/**
 * 输入框：Enter 发送、Shift+Enter 换行、输入法合成期间不发送（openwork-notes §3.7）。回合进行中（R11）：给了
 * `busyDelivery`（Host 支持待发消息）时照常可以发，Enter 与发送键按 `busyDelivery`（“回合进行中按回车”的设置），Tab 用
 * 另一种；没给时不允许再发送（旧 Host 会回 SESSION_BUSY）。`onSend` 返回 true 或新会话 ID 表示已发出，清空输入框；失败时保留文字。
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
 * 图片与文件可粘贴、拖放或从“+”菜单选择。输入历史、附件和未发出的文字按会话存在 IndexedDB。
 *
 * 0.36.0 起有计划模式（`plan`，见 `ComposerPlan`）。
 *
 * 粘贴的大段文字（0.90.0）照 Codex 桌面端放在文字上方的附件条里，同图片排成一行（放不下时横向滚动，滚轮也能左右滑），点开看原文；
 * 发出时排在文字前面，各成一段标 `pasted` 的文本。
 *
 * 0.92.0 起有听写（Host 支持 `speech` 时）：发送键左边的麦克风按钮或 ⌘⇧D，按住说话、松开转写，文字放到光标处，不自动发送；
 * 录音时 Esc 丢掉这段。
 */
export const Composer = memo(function Composer({
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
  commands: localCommands,
  allowDraftSkills = false,
  catalogProviderId,
  fileScope,
  acceptImages = false,
  plan,
  suggestion,
  sessionId,
  redirect = false,
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
  /** 新会话发送成功时返回其 ID，首条消息写入该会话的输入历史。 */
  onSend: (
    text: string,
    delivery?: PendingDelivery,
    attachments?: readonly ComposerAttachmentPart[],
  ) => Promise<boolean | SessionId>;
  onStop: () => void;
  autoFocus?: boolean;
  variant?: 'session' | 'home';
  /** 默认是“描述你要完成的任务…”；不能发送时显示 `disabledReason`。 */
  placeholder?: string;
  /** 斜杠命令（U33）；省略时没有斜杠菜单。 */
  commands?: readonly ComposerCommand[];
  allowDraftSkills?: boolean;
  catalogProviderId?: string;
  /** @ 提及与“文件和文件夹”的目录（U33）；省略时没有。 */
  fileScope?: FileScope;
  /** 能带图片（0.28.0，`useAcceptsImages`）：Host 支持、模型收图片。 */
  acceptImages?: boolean;
  /** 计划模式（0.36.0）；省略时没有（Host 或引擎不支持）。 */
  plan?: ComposerPlan;
  /**
   * 输入建议（0.53.0，`visibleSuggestion` 已挑过：会话空闲、设置开着……）。输入框完全空着时以灰色文字显示，Tab 或 → 填进输入框，
   * 打字、选命令、贴图片就消失。窄屏不显示 Tab 提示，点建议文字接受。
   */
  suggestion?: string;
  /** 所在的会话（听写打开润色时用它的模型）；新会话的草稿页没有。 */
  sessionId?: SessionId;
  /**
   * 审批挂起（0.144.0，Host 有 `approval_messages`）：发出的消息拒绝最早的审批并作为附言交给 Agent。占位文字与发送按钮随之改变，
   * 不显示“插话 | 排队”。
   */
  redirect?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const [focused, setFocused] = useState(false);
  const home = variant === 'home';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = isBusy(state);
  const pendingEnabled = busyDelivery !== undefined;

  // ── 图片（0.28.0） ──────────────────────────────────────────────────
  const { client } = useHostConnection();
  const pathsToInsert = useRef<(paths: readonly string[]) => void>(() => {});
  const input = useComposerInput(
    draftKey,
    client,
    acceptImages && !disabled,
    disabled,
    (paths) => pathsToInsert.current(paths),
    () => textareaRef.current?.focus(),
    fileScope?.root,
  );
  const {
    draft,
    setText,
    resetHistory,
    onHistoryKey,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaste,
    dragging,
  } = input;
  const { text, attachments, pastes } = draft;
  // 消息里选中文字的“添加到对话”：追加引用、聚焦、光标放到末尾。
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(() => {
    const quote = (selected: string) => {
      const next = appendQuote(latestText.current, selected);
      if (!next) return;
      latestText.current = next.text;
      setText(next.text);
      setCursor(next.cursor);
      pendingCursor.current = next.cursor;
      resetHistory();
    };
    quoteListeners.set(draftKey, quote);
    return () => {
      if (quoteListeners.get(draftKey) === quote) quoteListeners.delete(draftKey);
    };
  }, [draftKey, setText, resetHistory]);
  const imagesEnabled = acceptImages && client !== undefined && !disabled;
  const hasContent = hasDraft(draft);
  const issue =
    draftIssue(draft) ??
    input.failedAttachment ??
    (attachments.some((file) => file.kind === 'image') && !acceptImages
      ? t('composer.modelNoImages')
      : undefined);
  const canSend =
    (!busy || pendingEnabled) && !disabled && !sending && !input.adding && !issue && hasContent;
  const followUp = !busy ? plan?.followUp : undefined;
  const implementReady =
    followUp !== undefined && !hasContent && !disabled && !sending && !input.adding;
  // ── 斜杠命令与 @ 提及（U33） ────────────────────────────────────────
  const listId = useId();
  const { sendShortcut } = composerPrefs.use();
  const [cursor, setCursor] = useState(() => text.length);
  /** 下一次渲染后要放的光标（菜单替换了文字）。 */
  const pendingCursor = useRef<number>(undefined);
  /** 按 Esc 收起的菜单：同一个触发（种类与位置）不再弹出，换了才弹。 */
  const [dismissed, setDismissed] = useState<string>();
  const [active, setActive] = useState(0);
  const filesSupported = useFilesSupported();
  const canMention = fileScope !== undefined && filesSupported;
  const skillToken = detectMentionTrigger(text, cursor, '$');
  const catalog = useComposerCatalog(
    client,
    sessionId,
    allowDraftSkills,
    catalogProviderId,
    focused && !disabled && (!!skillToken || text.trimStart().startsWith('/')),
    localCommands,
  );
  const commands = catalog.commands;
  const skill = catalog.available ? skillToken : null;
  const skillMatches = useMemo(
    () =>
      skill === null
        ? []
        : catalog.skills.filter((item) =>
            item.name.toLowerCase().includes(skill.query.toLowerCase()),
          ),
    [skill, catalog.skills],
  );
  const slash =
    commands && commands.length > 0 ? slashMenuState(text, cursor, commands) : undefined;
  const mention = !slash && canMention ? detectMentionTrigger(text, cursor) : null;
  const menuKey = slash
    ? `slash:${slash.level}:${slash.command?.name ?? ''}:${slash.rangeStart}`
    : skill
      ? `skill:${skill.rangeStart}`
      : mention
        ? `mention:${mention.rangeStart}`
        : undefined;
  const menuOpen = menuKey !== undefined && menuKey !== dismissed && focused && !disabled;
  const ghost = ghostText(suggestion, {
    text,
    imageCount: attachments.length + pastes.length,
    menuOpen,
  });
  const ghostId = useId();
  // 触发没了（删掉了 `/` 或 `@`、发出去了）：下一次照常弹出。
  useEffect(() => {
    if (menuKey === undefined) setDismissed(undefined);
  }, [menuKey]);
  const mentionSearch = useFileSearch(
    menuOpen && mention ? fileScope : undefined,
    menuOpen && mention ? mention.query : undefined,
    { limit: 30 },
  );
  const query = slash?.query ?? skill?.query ?? mention?.query ?? '';

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
          ...(command.label !== `/${command.name}` && { hint: `/${command.name}` }),
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
    if (skill)
      return skillMatches.map((entry) => ({
        key: entry.name,
        icon: <BookOpen />,
        label: `$${entry.name}`,
        ...(entry.description && { detail: entry.description }),
      }));
    if (mention) {
      return mentionSearch.entries.map((entry) => {
        const { name, dir } = splitPath(entry.path);
        const Icon = entry.kind === 'directory' ? Folder : fileIcon(entry.path);
        return { key: entry.path, icon: <Icon />, label: name, detail: dir };
      });
    }
    return [];
  }, [slash?.level, slashResults, mention, mentionSearch.entries, skill, skillMatches]);

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
    // 光标在末尾时把末尾滚进视野（追加了一段长引用）。
    if (target >= textarea.value.length) textarea.scrollTop = textarea.scrollHeight;
  });

  const replaceRange = (start: number, end: number, replacement: string) => {
    const next = replaceTextRange(text, start, end, replacement);
    setText(next.text);
    setCursor(next.cursor);
    pendingCursor.current = next.cursor;
  };

  // ── 听写（0.92.0） ──────────────────────────────────────────────────
  const navigate = useNavigate();
  const dictation = useDictation({
    sessionId,
    onText: (transcript) => {
      const next = insertDictation(text, cursor, transcript);
      setText(next.text);
      setCursor(next.cursor);
      pendingCursor.current = next.cursor;
      resetHistory();
    },
  });
  const dictating = dictation.phase === 'starting' || dictation.phase === 'recording';
  const canDictate = dictation.available && !disabled;
  /** 录音条（照 Codex）：开始录音到转写完，底栏换成 ✕、波形与停止键。 */
  const dictationBar = dictation.phase !== 'idle';
  /** 录音时按了发送：转写完、文字放进输入框之后再发。 */
  const sendAfterDictation = useRef(false);
  const [sendQueued, setSendQueued] = useState(false);
  useEffect(() => {
    if (dictation.phase !== 'idle' || !sendAfterDictation.current) return;
    sendAfterDictation.current = false;
    if (dictation.errorKey === undefined) setSendQueued(true);
  }, [dictation.phase, dictation.errorKey]);

  // 录音时 Esc 丢掉这段录音，不停止回合（先于下面停止回合的监听处理）。
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

  /** ⌘⇧D：按下开始，松开（D 或任一修饰键，macOS 按着 ⌘ 时 D 的 keyup 不一定来）结束。 */
  const onDictationKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!canDictate || !matchesShortcut(event, getShortcut('dictation'))) return false;
    if (!event.repeat) dictation.press();
    return true;
  };
  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.code === getShortcut('dictation').code ||
      /^(?:Meta|Control|Alt|Shift)(?:Left|Right)$/.test(event.code)
    ) {
      dictation.release();
    }
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
    if (skill) {
      const entry = skillMatches[index];
      if (entry) replaceRange(skill.rangeStart, skill.rangeEnd, `$${entry.name} `);
      return;
    }
    if (mention) {
      const entry = mentionSearch.entries[index];
      if (!entry) return;
      replaceRange(mention.rangeStart, mention.rangeEnd, `${mentionText(entry.path)} `);
    }
  };

  /** 插入成 @ 提及：目录里的用相对路径，目录外的（或没选目录）用绝对路径。 */
  const insertPaths = (paths: readonly string[]) => {
    const mentions = paths.map((path) =>
      mentionText((fileScope && toRelativePath(path, fileScope.root)) ?? path),
    );
    insertAtCursor(`${mentions.join(' ')} `);
  };

  pathsToInsert.current = insertPaths;
  const insertPathsRef = useRef(insertPaths);
  insertPathsRef.current = insertPaths;
  useEffect(() => {
    const mention = (path: string) => {
      insertPathsRef.current([path]);
      textareaRef.current?.focus();
    };
    mentionListeners.set(draftKey, mention);
    return () => {
      if (mentionListeners.get(draftKey) === mention) mentionListeners.delete(draftKey);
    };
  }, [draftKey]);

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

  // 带着草稿打开时光标放到末尾、滚到底（基于历史新建的长草稿，接着写“接下来”）；`insertQuote` 先放了引用的输入框（支线窗格）
  // 同样，并且获得焦点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时。
  useEffect(() => {
    const textarea = textareaRef.current;
    const requested = focusOnOpen.delete(draftKey);
    if (!textarea || (!autoFocus && !requested) || textarea.value === '') return;
    if (requested) textarea.focus();
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

  // 转写的文字已经在这一次渲染的 `text` 里。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着排队的发送。
  useEffect(() => {
    if (!sendQueued) return;
    setSendQueued(false);
    void send();
  }, [sendQueued]);

  /** 发送；回合进行中带上方式，默认按设置。 */
  const send = async (delivery = busyDelivery) => {
    if (implementReady) {
      followUp.onImplement();
      return;
    }
    if (!canSend || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    const sent = draft;
    try {
      const parts = await uploadDraft(client, sent.attachments);
      const body = withDraftPastes(sent.pastes, sent.text.trim());
      const result = await onSend(body, busy ? delivery : undefined, parts);
      if (result) {
        if (input.store !== draftFor(draftKey)) return;
        await finishComposerSend(draftKey, sent, typeof result === 'string' ? result : undefined);
        resetHistory();
        input.setError(undefined);
      }
    } catch (error) {
      input.setError(t('composer.attachmentUploadFailed', { error: describe(error) }));
    } finally {
      sendInFlight.current = false;
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  /** 接受输入建议：填进输入框（光标在末尾），不直接发送，用户可以改。 */
  const acceptGhost = () => {
    if (ghost !== undefined) replaceRange(0, 0, ghost);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onDictationKey(event)) {
      event.preventDefault();
      return;
    }
    if (
      ghost !== undefined &&
      isAcceptKey({
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        composing: event.nativeEvent.isComposing || event.keyCode === 229,
      })
    ) {
      event.preventDefault();
      acceptGhost();
      return;
    }
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
      : redirect
        ? 'redirect'
        : busyDelivery;

  return (
    // 菜单（U33）画在最外层：光束那一层裁掉溢出（overflow: hidden），放在里面会被裁掉。
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放图片（0.28.0）只是“+”菜单“图片”的快捷方式。
    <div className="relative" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {menuOpen && (entries.length > 0 || slash !== undefined || !mentionSearch.pending) && (
        <ComposerMenu
          listId={listId}
          label={
            skill
              ? t('rail.context.cat.skills')
              : mention
                ? t('composer.mentionFile')
                : t('composer.commands')
          }
          entries={entries}
          active={active}
          {...(slash?.level === 'items' &&
            slash.command && {
              title: slash.command.label,
              onBack: () => replaceRange(slash.rangeStart, slash.rangeEnd, '/'),
            })}
          empty={
            mention
              ? t('files.noMatches')
              : (catalog.error ??
                (catalog.loading
                  ? t('common.loading')
                  : skill
                    ? t('search.empty')
                    : t('composer.noCommands')))
          }
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
      {/* 底板与内容分两层叠放：光束只包不带内容的底板（底色、描边、阴影），内容叠在上面。光束的动画每一帧都让它包住的子树重算
          样式（fx/beam.tsx），包住整个输入框时文本框、芯片与按钮都跟着算。 */}
      <div className={cn('group/composer grid w-full', disabled && 'opacity-70')}>
        <Beam
          preset={home ? 'focus' : 'composer'}
          active={home ? focused && !disabled : busy && state !== 'awaiting_approval' && !disabled}
          className="pointer-events-none col-start-1 row-start-1 block min-w-0"
        >
          <div
            data-composer-box
            className={cn(
              'size-full rounded-3xl border border-border bg-card shadow-xs transition-colors',
              // 首页的焦点只用光束表示（方向稿），会话里的输入框聚焦时描边加深一档。
              !home && 'group-focus-within/composer:border-input',
              dragging && 'border-ring ring-2 ring-ring/30',
            )}
          />
        </Beam>
        {/* 容器名 composer：底栏按输入框自己的宽度收紧（子会话窗格、窄窗口），见权限芯片与插话/排队切换。透明的描边占住底板描边的
            那 1 px，内容的位置与底板对齐。 */}
        <div className="@container/composer relative col-start-1 row-start-1 min-w-0 rounded-3xl border border-transparent">
          {dictation.errorKey && (
            <div className="flex items-center gap-2 px-4 pt-3 text-xs">
              <ErrorNote data-testid="composer-dictation-error">{dictation.error}</ErrorNote>
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
          {input.strip}
          {(issue || input.error) && (
            <ErrorNote className="px-4 pt-1.5 text-xs" data-testid="composer-image-error">
              {issue ?? input.error}
            </ErrorNote>
          )}
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={text}
              maxLength={Math.max(0, MESSAGE_TEXT_MAX_LENGTH - (textLength(draft) - text.length))}
              onChange={(event) => {
                setText(event.target.value);
                setCursor(event.target.selectionStart);
                resetHistory();
                dictation.clearError();
              }}
              onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
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
              aria-describedby={ghost !== undefined ? ghostId : undefined}
              placeholder={
                ghost !== undefined
                  ? ''
                  : (disabledReason ??
                    (busy && redirect ? t('session.redirectPlaceholder') : undefined) ??
                    placeholder ??
                    t('session.composerPlaceholder'))
              }
              className={cn(
                'max-h-60 resize-none rounded-none border-0 bg-transparent px-4 pb-1 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent',
                // 原语在 md 以上是 text-sm；首页大一档（方向稿 composer-big 比会话的输入框大 1px）。
                home ? 'min-h-19 pt-4 text-base md:text-base' : 'min-h-13 pt-3.5 text-base',
              )}
            />
            {ghost !== undefined && (
              <div
                id={ghostId}
                data-testid="composer-suggestion"
                className={cn(
                  'pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 px-4 text-base leading-6 text-muted-foreground',
                  home ? 'pt-4' : 'pt-3.5',
                )}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('composer.suggestionAccept', { text: ghost })}
                  onClick={acceptGhost}
                  className="min-w-0 truncate text-left max-sm:pointer-events-auto"
                >
                  {ghost}
                </button>
                <kbd className="hidden shrink-0 self-center rounded border border-border px-1.5 text-[11px] leading-4 sm:inline-flex">
                  Tab
                </kbd>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            {dictationBar ? (
              <DictationBar dictation={dictation} />
            ) : (
              <>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                  {
                    <ComposerPlusMenu
                      commands={commands ?? []}
                      disabled={disabled}
                      canMention={canMention}
                      canAttachFiles={input.canAttach}
                      onHistory={input.onHistory}
                      onSkill={catalog.available ? () => insertAtCursor('$') : undefined}
                      onPaths={input.onPaths}
                      canAttachImages={imagesEnabled}
                      onAttachImages={input.onImages}
                      canCommand={(commands?.length ?? 0) > 0 && text.trim() === ''}
                      onAttach={input.onAttach}
                      onMention={() => insertAtCursor('@')}
                      onCommand={() => replaceRange(0, text.length, '/')}
                      onRun={(command) => runCommand(command)}
                      onClosed={() => window.setTimeout(() => textareaRef.current?.focus(), 0)}
                    />
                  }
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
                  {busy && !redirect && busyDelivery !== undefined && onBusyDeliveryChange && (
                    <DeliverySwitch
                      value={busyDelivery}
                      disabled={disabled}
                      onChange={onBusyDeliveryChange}
                    />
                  )}
                </div>
                {model}
                {canDictate && <DictationButton dictation={dictation} disabled={disabled} />}
              </>
            )}
            {dictationBar ? (
              <ComposerButton
                action="send"
                loading={dictation.phase === 'transcribing'}
                disabled={disabled}
                onClick={() => {
                  sendAfterDictation.current = true;
                  dictation.stop();
                }}
              />
            ) : implementReady ? (
              <ImplementButton
                onImplement={followUp.onImplement}
                {...(followUp.onImplementInNew && { onImplementInNew: followUp.onImplementInNew })}
              />
            ) : (
              <ComposerButton
                action={action}
                // 发出之后、Host 接住之前（新会话要先启动引擎）：加载圈。
                loading={sending && action !== 'stop'}
                disabled={action === 'stop' ? disabled : !canSend && !sending}
                onClick={() => (action === 'stop' ? onStop() : void send())}
              />
            )}
          </div>
        </div>
      </div>
      {input.picker}
    </div>
  );
});

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
            className="group/plan flex h-7 shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium text-foreground outline-none transition-colors duration-150 hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] focus-visible:focus-ring disabled:opacity-50"
          />
        }
      >
        <ListChecks aria-hidden className="size-3.5 group-hover/plan:hidden" />
        <X aria-hidden className="hidden size-3.5 group-hover/plan:block" />
        {t('composer.planChip')}
      </TooltipTrigger>
      <TooltipContent>
        {t('composer.planExit')}
        <kbd className="ml-1.5 font-sans opacity-70">{IS_MAC ? '⇧Tab' : 'Shift+Tab'}</kbd>
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
    'flex h-8 shrink-0 items-center bg-primary text-sm font-medium text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:focus-ring';
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
