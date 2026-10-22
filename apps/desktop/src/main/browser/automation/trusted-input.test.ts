// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/trusted-input.test.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 Wevir 的；加上 Enter 的 char；键名解析与带修饰键的 CDP 按键。

import { describe, expect, test } from 'vitest';
import type { IsolatedKeyboardInputEvent } from './trusted-input.js';
import { dispatchCdpKey, dispatchTrustedKey, parseKeyCombo } from './trusted-input.js';

describe('trusted browser input', () => {
  test.each([
    ['a', 'a', ['keyDown', 'char', 'keyUp']],
    ['Z', 'Z', ['keyDown', 'char', 'keyUp']],
    ['ArrowDown', 'Down', ['keyDown', 'keyUp']],
  ])(
    'sends %s as Electron key code %s with unhandled redispatch disabled',
    (key, keyCode, types) => {
      const events: IsolatedKeyboardInputEvent[] = [];

      dispatchTrustedKey((event) => {
        events.push(event);
      }, key);

      expect(events).toEqual(
        types.map((type) => ({
          type,
          keyCode,
          skipIfUnhandled: true,
        })),
      );
    },
  );

  test('inserts a named Space keypress', () => {
    const events: IsolatedKeyboardInputEvent[] = [];

    dispatchTrustedKey((event) => {
      events.push(event);
    }, 'Space');

    expect(events).toEqual([
      { type: 'keyDown', keyCode: 'Space', skipIfUnhandled: true },
      { type: 'char', keyCode: ' ', skipIfUnhandled: true },
      { type: 'keyUp', keyCode: 'Space', skipIfUnhandled: true },
    ]);
  });

  test('sends Enter with a carriage-return char so forms submit implicitly', () => {
    const events: IsolatedKeyboardInputEvent[] = [];

    dispatchTrustedKey((event) => {
      events.push(event);
    }, 'Enter');

    expect(events).toEqual([
      { type: 'keyDown', keyCode: 'Enter', skipIfUnhandled: true },
      { type: 'char', keyCode: '\r', skipIfUnhandled: true },
      { type: 'keyUp', keyCode: 'Enter', skipIfUnhandled: true },
    ]);
  });

  test.each([
    ['Enter', 'Enter', []],
    ['enter', 'Enter', []],
    [' ', 'Space', []],
    ['a', 'a', []],
    ['+', '+', []],
    ['Shift+A', 'A', ['Shift']],
    ['control+a', 'a', ['Control']],
    ['Ctrl+Shift++', '+', ['Control', 'Shift']],
    ['Meta+ArrowLeft', 'ArrowLeft', ['Meta']],
    ['f5', 'F5', []],
  ])('parses %j into key %j with modifiers %j', (input, key, modifiers) => {
    expect(parseKeyCombo(input, 'linux')).toEqual({ ok: true, key, modifiers });
  });

  test('ControlOrMeta is Meta on macOS and Control elsewhere', () => {
    expect(parseKeyCombo('ControlOrMeta+a', 'darwin')).toEqual({
      ok: true,
      key: 'a',
      modifiers: ['Meta'],
    });
    expect(parseKeyCombo('ControlOrMeta+a', 'win32')).toEqual({
      ok: true,
      key: 'a',
      modifiers: ['Control'],
    });
  });

  test.each(['NotAKey', 'Hyper+a', 'Shift+', 'ab'])('rejects %j', (input) => {
    expect(parseKeyCombo(input, 'linux')).toMatchObject({ ok: false });
  });

  test('Control combinations type no text, and macOS editing shortcuts carry their command', async () => {
    const sent: Array<Record<string, unknown> | undefined> = [];
    const send = async (_command: string, params?: Record<string, unknown>) => {
      sent.push(params);
      return {};
    };

    await dispatchCdpKey(send, 'a', ['Control'], 'linux');
    await dispatchCdpKey(send, 'a', ['Meta'], 'darwin');

    expect(sent).toEqual([
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 4,
        commands: ['selectAll'],
      },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 },
    ]);
  });
});
