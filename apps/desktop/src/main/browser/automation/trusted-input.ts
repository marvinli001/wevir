// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/trusted-input.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：按 Wevir 的格式重排（Biome）；Enter 也发一个 `\r` 的 char（页面的 keypress），否则输入框不会隐式提交表单。
// 0.48.0：焦点在跨进程的 iframe 里时按键走 CDP 的 Input.dispatchKeyEvent（`dispatchCdpKey`）：sendInputEvent 只交给顶层的
// widget，跨进程的 frame 收不到。

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

/** 常用键的 Windows 虚拟键码（CDP 的 keyDown 要它，否则编辑类的键不起作用）。 */
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
  Delete: 46,
};

/** 用 CDP 按一个键：浏览器按焦点所在的 frame 交过去（跨进程的 iframe 也行）。 */
export async function dispatchCdpKey(send: CdpCommandSender, key: string): Promise<void> {
  const character = key === 'Space' ? ' ' : key === 'Enter' ? '\r' : key.length === 1 ? key : '';
  const domKey = key === 'Space' ? ' ' : key;
  const windowsVirtualKeyCode =
    VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  await send('Input.dispatchKeyEvent', {
    type: character ? 'keyDown' : 'rawKeyDown',
    key: domKey,
    windowsVirtualKeyCode,
    ...(character && { text: character, unmodifiedText: character }),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: domKey, windowsVirtualKeyCode });
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
