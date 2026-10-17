// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/trusted-input.test.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 Wevir 的；加上 Enter 的 char。

import { describe, expect, test } from 'vitest';
import type { IsolatedKeyboardInputEvent } from './trusted-input.js';
import { dispatchTrustedKey } from './trusted-input.js';

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
});
