// CDP 的控制台事件写成 browser_logs 的记录；以及 TabMonitor 有调试器时只用 CDP 的记录。

import { describe, expect, it } from 'vitest';
import { consoleApiEntry, exceptionEntry, formatArgs, logEntry } from './console-format.js';
import { adaptWebContents } from './contents.js';

describe('console-format', () => {
  it('keeps the console method as the level and writes objects out', () => {
    expect(
      consoleApiEntry({
        type: 'log',
        timestamp: 1_700_000_000_000.4,
        args: [
          { type: 'string', value: 'log-msg' },
          {
            type: 'object',
            className: 'Object',
            description: 'Object',
            preview: {
              type: 'object',
              description: 'Object',
              overflow: false,
              properties: [
                { name: 'a', type: 'number', value: '1' },
                { name: 'b', type: 'string', value: 'x' },
                { name: 'c', type: 'object', value: 'Array(2)', subtype: 'array' },
                { name: 'd', type: 'object', value: 'null', subtype: 'null' },
              ],
            },
          },
        ],
        stackTrace: { callFrames: [{ url: 'http://127.0.0.1:8766/test.html', lineNumber: 70 }] },
      }),
    ).toEqual({
      level: 'log',
      message: 'log-msg {"a":1,"b":"x","c":Array(2),"d":null}',
      source: 'http://127.0.0.1:8766/test.html',
      line: 71,
      timestamp: 1_700_000_000_000,
    });
  });

  it('formats arrays, primitives, errors and printf placeholders', () => {
    expect(
      formatArgs([
        {
          type: 'object',
          subtype: 'array',
          preview: {
            type: 'object',
            subtype: 'array',
            overflow: true,
            properties: [
              { name: '0', type: 'number', value: '1' },
              { name: '1', type: 'string', value: 'two' },
            ],
          },
        },
        { type: 'undefined' },
        { type: 'object', subtype: 'null', value: null },
        { type: 'boolean', value: true },
        { type: 'object', subtype: 'error', description: 'Error: boom\n    at x.js:1' },
      ]),
    ).toBe('[1,"two",…] undefined null true Error: boom\n    at x.js:1');
    expect(
      formatArgs([
        { type: 'string', value: '%s has %d items%c, 100%%' },
        { type: 'string', value: 'cart' },
        { type: 'number', value: 3.7, description: '3.7' },
        { type: 'string', value: 'color: red' },
        { type: 'string', value: 'extra' },
      ]),
    ).toBe('cart has 3 items, 100% extra');
  });

  it('writes uncaught exceptions and browser log entries', () => {
    expect(
      exceptionEntry({
        timestamp: 5,
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            type: 'object',
            subtype: 'error',
            description: 'TypeError: x is not a function',
          },
          url: 'http://a.test/app.js',
          lineNumber: 9,
        },
      }),
    ).toMatchObject({
      level: 'error',
      message: 'Uncaught TypeError: x is not a function',
      source: 'http://a.test/app.js',
      line: 10,
    });
    expect(
      logEntry({
        entry: {
          level: 'error',
          text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
          url: 'http://a.test/missing.png',
          timestamp: 9,
        },
      }),
    ).toMatchObject({ level: 'error', source: 'http://a.test/missing.png' });
  });
});

describe('TabMonitor console', () => {
  type Listener = (event: unknown, method: string, params?: Record<string, unknown>) => void;

  function fakeTab(withDebugger: boolean) {
    let cdp: Listener | undefined;
    let electron: ((event: Record<string, unknown>) => void) | undefined;
    const contents = {
      id: 20_000 + Math.floor(Math.random() * 1_000_000),
      on: (event: string, handler: (event: Record<string, unknown>) => void) => {
        if (event === 'console-message') electron = handler;
      },
      once: () => {},
      removeListener: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://example.test/',
      mainFrame: { processId: 1, framesInSubtree: [] },
      debugger: {
        isAttached: () => true,
        attach: () => {},
        sendCommand: async () => ({}),
        ...(withDebugger && {
          on: (event: string, handler: Listener) => {
            if (event === 'message') cdp = handler;
          },
        }),
      },
    };
    const tab = adaptWebContents(contents as never);
    return {
      tab,
      cdp: (method: string, params: Record<string, unknown>) => cdp?.({}, method, params),
      electron: (event: Record<string, unknown>) => electron?.(event),
    };
  }

  it('records console calls from CDP and Electron messages only from other processes', () => {
    const { tab, cdp, electron } = fakeTab(true);
    cdp('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }] });
    electron({ level: 'info', message: 'hi', frame: { processId: 1 } });
    electron({ level: 'warning', message: 'from iframe', frame: { processId: 2 } });

    expect(tab.getConsoleMessages?.().map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'log', message: 'hi' },
      { level: 'warning', message: 'from iframe' },
    ]);
    expect(tab.getConsoleTotal?.()).toBe(2);
  });

  it('falls back to Electron messages without a debugger', () => {
    const { tab, electron } = fakeTab(false);
    electron({ level: 'info', message: 'hi', frame: { processId: 1 } });

    expect(tab.getConsoleMessages?.()).toMatchObject([{ level: 'info', message: 'hi' }]);
  });
});
