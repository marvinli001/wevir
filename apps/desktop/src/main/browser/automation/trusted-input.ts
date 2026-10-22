// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/trusted-input.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：按 Wevir 的格式重排（Biome）；Enter 也发一个 `\r` 的 char（页面的 keypress），否则输入框不会隐式提交表单。
// 0.48.0：焦点在跨进程的 iframe 里时按键走 CDP 的 Input.dispatchKeyEvent（`dispatchCdpKey`）：sendInputEvent 只交给顶层的
// widget，跨进程的 frame 收不到。
// 键名先经 `parseKeyCombo` 核对：认不出的键名报错，不再发出 key 为空的 keydown；组合键（`Shift+A`、`Meta+a`、`ControlOrMeta+a`）
// 带修饰键走 CDP，macOS 上的编辑快捷键另带 Chromium 的编辑命令（照 Playwright 的 macEditingCommands）。

import type { KeyboardInputEvent } from 'electron';
import type { ActionablePoint } from './actionability.js';
import type { CdpCommandSender } from './cdp-session-queue.js';

export type MouseButton = 'left' | 'right' | 'middle';
export type InputModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface ClickInputOptions {
  button?: MouseButton;
  doubleClick?: boolean;
  modifiers?: InputModifier[];
}

const MODIFIER_MASKS: Record<InputModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export interface IsolatedKeyboardInputEvent extends KeyboardInputEvent {
  type: 'char' | 'keyDown' | 'keyUp';
  // Electron accepts this NativeWebKeyboardEvent flag even though its public
  // TypeScript declarations omit it. It stops an unhandled webview key from
  // being redispatched to the embedder's active DOM element or application menu.
  skipIfUnhandled: true;
}

type KeyboardInputSender = (event: IsolatedKeyboardInputEvent) => void;

const ELECTRON_KEY_CODE_ALIASES: Record<string, string> = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
};

export async function dispatchTrustedClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  options: ClickInputOptions = {},
): Promise<void> {
  const button = options.button ?? 'left';
  const modifiers = modifierMask(options.modifiers);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    modifiers,
  });
  if (options.doubleClick) {
    await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
    await dispatchTrustedMouseClick(send, point, button, modifiers, 2);
    return;
  }
  await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
}

async function dispatchTrustedMouseClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  button: MouseButton,
  modifiers: number,
  clickCount: number,
): Promise<void> {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button,
    buttons: mouseButtonMask(button),
    clickCount,
    modifiers,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
  });
}

export async function dispatchTrustedHover(
  send: CdpCommandSender,
  point: ActionablePoint,
): Promise<void> {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
}

export async function dispatchTrustedDrag(
  send: CdpCommandSender,
  source: ActionablePoint,
  target: ActionablePoint,
): Promise<void> {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: source.x,
    y: source.y,
    button: 'none',
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: source.x,
    y: source.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: (source.x + target.x) / 2,
    y: (source.y + target.y) / 2,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: target.x,
    y: target.y,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

export async function dispatchTrustedScroll(
  send: CdpCommandSender,
  point: ActionablePoint,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
}

export function dispatchTrustedKey(send: KeyboardInputSender, key: string): void {
  const keyCode = ELECTRON_KEY_CODE_ALIASES[key] ?? key;
  let character: string | null = null;
  if (key === 'Space') {
    character = ' ';
  } else if (key === 'Enter') {
    // Chromium 在 keypress 上做隐式提交与换行，keyDown 之后要有 char。
    character = '\r';
  } else if (key.length === 1) {
    character = key;
  }
  send({
    type: 'keyDown',
    keyCode,
    skipIfUnhandled: true,
  });
  if (character !== null) {
    send({
      type: 'char',
      keyCode: character,
      skipIfUnhandled: true,
    });
  }
  send({
    type: 'keyUp',
    keyCode,
    skipIfUnhandled: true,
  });
}

/** 常用键的 Windows 虚拟键码（CDP 的 keyDown 要它，否则编辑类的键不起作用）；也是能按的键名（字符之外）。 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, 112 + i])),
};

/** 键名的别名（不分大小写）。 */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  ' ': 'Space',
};

const MODIFIER_ALIASES: Record<string, InputModifier | 'ControlOrMeta'> = {
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  controlormeta: 'ControlOrMeta',
};

const NAMED_KEYS = new Map(
  Object.keys(VIRTUAL_KEY_CODES).map((name) => [name.toLowerCase(), name]),
);

export type ParsedKey =
  | { ok: true; key: string; modifiers: InputModifier[] }
  | { ok: false; message: string };

/**
 * `Shift+A`、`ControlOrMeta+a`、`Enter` 这类写法拆成主键与修饰键；主键是一个字符或已知的键名，键名与修饰键不分大小写。
 * `ControlOrMeta` 在 macOS 上是 Meta，别处是 Control。
 */
export function parseKeyCombo(
  input: string,
  platform: NodeJS.Platform = process.platform,
): ParsedKey {
  let main: string;
  let prefix: string[];
  if (input === '+' || input === ' ') {
    main = input;
    prefix = [];
  } else if (input.endsWith('++')) {
    main = '+';
    prefix = input.slice(0, -2).split('+');
  } else {
    const parts = input.split('+');
    main = parts.pop() ?? '';
    prefix = parts;
  }
  const modifiers: InputModifier[] = [];
  for (const raw of prefix) {
    const alias = MODIFIER_ALIASES[raw.trim().toLowerCase()];
    if (!alias) {
      return {
        ok: false,
        message: `Unknown modifier "${raw}" in "${input}". Use Shift, Control, Alt, Meta or ControlOrMeta, joined with + (for example Shift+Tab or ControlOrMeta+a).`,
      };
    }
    const modifier =
      alias === 'ControlOrMeta' ? (platform === 'darwin' ? 'Meta' : 'Control') : alias;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const key = canonicalKey(main);
  if (!key) {
    return {
      ok: false,
      message: `Unknown key "${main}"${prefix.length > 0 ? ` in "${input}"` : ''}. Use one character or a key name: ${Object.keys(VIRTUAL_KEY_CODES).join(', ')}.`,
    };
  }
  return { ok: true, key, modifiers };
}

function canonicalKey(name: string): string | undefined {
  if ([...name].length === 1 && name !== ' ') return name;
  const lower = name.toLowerCase();
  return KEY_ALIASES[lower] ?? KEY_ALIASES[name] ?? NAMED_KEYS.get(lower);
}

/** macOS 上 Chromium 的编辑快捷键不经 keydown 生效，要随按键带上编辑命令（Playwright 的 macEditingCommands 里常用的几条）。 */
const MAC_EDITING_COMMANDS: Record<string, string> = {
  'Meta+a': 'selectAll',
  'Meta+c': 'copy',
  'Meta+x': 'cut',
  'Meta+v': 'paste',
  'Meta+z': 'undo',
  'Meta+Shift+z': 'redo',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection',
  'Shift+ArrowRight': 'moveRightAndModifySelection',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine',
  'Meta+ArrowRight': 'moveToRightEndOfLine',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Alt+Backspace': 'deleteWordBackward',
};

function editingCommands(
  key: string,
  modifiers: readonly InputModifier[],
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'darwin' || modifiers.length === 0) return [];
  const order: InputModifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
  const name = [
    ...order.filter((modifier) => modifiers.includes(modifier)),
    key.length === 1 ? key.toLowerCase() : key,
  ].join('+');
  const command = MAC_EDITING_COMMANDS[name];
  return command ? [command] : [];
}

/** DOM 的 `code`（物理键位）；只给字母、数字与键名。 */
function keyCode(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return VIRTUAL_KEY_CODES[key] !== undefined ? key : undefined;
}

/**
 * 用 CDP 按一个键（可以带修饰键）：浏览器按焦点所在的 frame 交过去（跨进程的 iframe 也行）。带 Control、Alt、Meta 时不输入字符；
 * Shift 加字母输入大写。
 */
export async function dispatchCdpKey(
  send: CdpCommandSender,
  key: string,
  modifiers: readonly InputModifier[] = [],
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const shifted = modifiers.includes('Shift') && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
  const typesText = modifiers.every((modifier) => modifier === 'Shift');
  const character = !typesText
    ? ''
    : shifted === 'Space'
      ? ' '
      : shifted === 'Enter'
        ? '\r'
        : [...shifted].length === 1
          ? shifted
          : '';
  const domKey = shifted === 'Space' ? ' ' : shifted;
  const windowsVirtualKeyCode =
    VIRTUAL_KEY_CODES[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  const code = keyCode(key);
  const mask = modifierMask([...modifiers]);
  const commands = editingCommands(key, modifiers, platform);
  const common = {
    key: domKey,
    windowsVirtualKeyCode,
    ...(code && { code }),
    ...(mask !== 0 && { modifiers: mask }),
  };
  await send('Input.dispatchKeyEvent', {
    type: character ? 'keyDown' : 'rawKeyDown',
    ...common,
    ...(character && { text: character, unmodifiedText: shifted !== key ? key : character }),
    ...(commands.length > 0 && { commands }),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

function modifierMask(modifiers: InputModifier[] | undefined): number {
  return (modifiers ?? []).reduce((mask, modifier) => mask | MODIFIER_MASKS[modifier], 0);
}

function mouseButtonMask(button: MouseButton): number {
  if (button === 'right') {
    return 2;
  }
  if (button === 'middle') {
    return 4;
  }
  return 1;
}
