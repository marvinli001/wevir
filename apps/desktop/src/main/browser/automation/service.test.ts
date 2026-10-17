// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/service.test.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：类型换成 Wevir 协议的；标签页按会话归属（假注册表的 ownerOf）；去掉 list_tabs、evaluate 与 upload 的用例（Wevir 不在
// 这里处理或不提供）；Enter 带 char，快照里没有的引用与过期的引用分开报。

import type {
  BrowserCommand as BrowserAutomationCommand,
  BrowserConsoleEntry as BrowserAutomationConsoleLogEntry,
  BrowserRequest as BrowserAutomationExecuteRequest,
} from '@wevir/protocol';
import { describe, expect, test, vi } from 'vitest';
import type { BrowserAutomationDialogEvent } from './dialog-handling.js';
import type { BrowserRegistry, TabContents, TabImage } from './service.js';
import { executeAutomationCommand } from './service.js';
import { BrowserSnapshotEngine } from './snapshot-engine.js';
import type { IsolatedKeyboardInputEvent } from './trusted-input.js';

const BROWSER_A = '11111111-1111-4111-8111-111111111111';
const BROWSER_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_A = 'ses_a';
const WORKSPACE_B = 'ses_b';

class FakeImage implements TabImage {
  public constructor(
    private readonly bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    private readonly size = { width: 640, height: 480 },
  ) {}

  public toPNG(): Uint8Array {
    return this.bytes;
  }

  public getSize(): { width: number; height: number } {
    return this.size;
  }
}

class FakeTab implements TabContents {
  public withFrameProduction<T>(capture: () => Promise<T>): Promise<T> {
    return capture();
  }
  public readonly loadedUrls: string[] = [];
  public readonly scripts: string[] = [];
  public readonly actions: string[] = [];
  public readonly capturedViewports: AbortSignal[] = [];
  public readonly debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
  public readonly insertedText: string[] = [];
  public readonly inputEvents: IsolatedKeyboardInputEvent[] = [];
  private readonly captureStartWaiters: Array<() => void> = [];
  private readonly deferredCaptures: Array<(image: TabImage) => void> = [];

  public destroyed = false;
  public bodyText = '';
  public snapshotNodes: Array<{
    role: string;
    name: string;
    tagName: string;
    ref?: string;
    attributes?: string[];
    children?: unknown[];
  }> = [];
  public actionScriptResult: unknown = true;
  public evaluateScriptResult: unknown = null;
  public evaluateScriptThrows = false;
  public evaluateScriptErrorMessage = 'page failed';
  public rejectEditableActionability = false;
  public actionabilityResult: unknown = {
    ok: true,
    target: { point: { x: 40, y: 30 }, rect: { x: 20, y: 10, width: 40, height: 40 } },
  };
  public networkEntries: unknown[] = [];
  public consoleMessages: BrowserAutomationConsoleLogEntry[] = [];
  public dialogsToCapture: BrowserAutomationDialogEvent[] = [];
  public paintDelayMs = 0;
  public captureNeverPaints = false;
  public captureThrows = false;
  public captureErrorMessage = 'capture failed';
  public deferCaptures = false;
  public fullPageScreenshotThrows = false;
  public fullPageScreenshotErrorMessage = 'UnknownVizError';
  public fullPageCaptureFailuresBeforeSuccess = 0;
  public layoutMetrics = {
    cssLayoutViewport: { clientWidth: 390, clientHeight: 844 },
    cssContentSize: { width: 390, height: 1200 },
  };
  public fullPageScreenshotData = 'fullPagePng';
  public documentNodeId = 1;
  public queriedNodeId = 2;
  public canNavigateBack = true;
  public canNavigateForward = false;
  public keypressTargetEditable = false;

  public constructor(
    public readonly id: number,
    private readonly initialUrl: string,
    private readonly title: string,
  ) {}

  public getURL(): string {
    return this.loadedUrls.at(-1) ?? this.initialUrl;
  }

  public getTitle(): string {
    return this.title;
  }

  public canGoBack(): boolean {
    return this.canNavigateBack;
  }

  public canGoForward(): boolean {
    return this.canNavigateForward;
  }

  public isLoading(): boolean {
    return false;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    this.scripts.push(code);
    if (code.includes('requestAnimationFrame') && this.paintDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.paintDelayMs));
    }
    if (code.includes('document.body.innerText')) {
      return this.bodyText;
    }
    if (code.includes('__WEVIR_ARIA_SNAPSHOT__')) {
      return JSON.stringify(snapshotResult(this.snapshotNodes));
    }
    if (code.includes('Timed out waiting') || code.includes('performance.now()')) {
      if (this.rejectEditableActionability && code.includes('const requiresEditable = true')) {
        return { ok: false, reason: 'timeout', detail: 'not editable' };
      }
      return this.actionabilityResult;
    }
    if (code.includes('performance.getEntriesByType')) {
      return JSON.stringify(this.networkEntries);
    }
    if (code.includes('window.innerWidth') && code.includes('window.innerHeight')) {
      return { x: 640, y: 400 };
    }
    if (code.includes('element.focus({ preventScroll: true })')) {
      return { editable: this.keypressTargetEditable };
    }
    if (code.includes('__PASEO_BROWSER_EVALUATE__')) {
      if (this.evaluateScriptThrows) {
        throw new Error(this.evaluateScriptErrorMessage);
      }
      return this.evaluateScriptResult;
    }
    return this.actionScriptResult;
  }

  public async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
  }

  public goBack(): void {
    this.actions.push('back');
  }

  public goForward(): void {
    this.actions.push('forward');
  }

  public reload(): void {
    this.actions.push('reload');
  }

  public async captureFrame(signal: AbortSignal): Promise<TabImage> {
    this.capturedViewports.push(signal);
    this.actions.push('capture');
    this.resolveCaptureStartWaiters();
    if (this.captureThrows) {
      throw new Error(this.captureErrorMessage);
    }
    if (this.captureNeverPaints) {
      return new Promise<never>(() => {});
    }
    if (this.deferCaptures) {
      return new Promise<TabImage>((resolve) => {
        this.deferredCaptures.push(resolve);
      });
    }
    return new FakeImage();
  }

  public invalidate(): void {
    this.actions.push('invalidate');
  }

  public getConsoleMessages(): BrowserAutomationConsoleLogEntry[] {
    return this.consoleMessages;
  }

  public async captureDialogs<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }> {
    return { result: await task(), dialogs: this.dialogsToCapture };
  }

  public async sendDebugCommand(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.actions.push(`debug:${command}`);
    this.debugCommands.push({ command, ...(params ? { params } : {}) });
    if (command === 'Page.getLayoutMetrics') {
      return this.layoutMetrics;
    }
    if (command === 'Page.captureScreenshot') {
      if (this.fullPageCaptureFailuresBeforeSuccess > 0) {
        this.fullPageCaptureFailuresBeforeSuccess -= 1;
        throw new Error(this.fullPageScreenshotErrorMessage);
      }
      if (this.fullPageScreenshotThrows) {
        throw new Error(this.fullPageScreenshotErrorMessage);
      }
      return { data: this.fullPageScreenshotData };
    }
    if (command === 'Runtime.evaluate') {
      return { result: { objectId: 'object-1' } };
    }
    if (command === 'DOM.describeNode') {
      return { node: { backendNodeId: this.queriedNodeId, nodeName: 'INPUT' } };
    }
    return {};
  }

  public sendInputEvent(event: IsolatedKeyboardInputEvent): void {
    this.inputEvents.push(event);
  }

  public async insertText(text: string): Promise<void> {
    this.insertedText.push(text);
  }

  public waitForCaptureStart(count: number): Promise<void> {
    if (this.capturedViewports.length >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.captureStartWaiters.push(() => {
        if (this.capturedViewports.length >= count) {
          resolve();
        }
      });
    });
  }

  public finishNextCapture(): void {
    const resolve = this.deferredCaptures.shift();
    if (!resolve) {
      throw new Error('No deferred capture is waiting');
    }
    resolve(new FakeImage());
  }

  private resolveCaptureStartWaiters(): void {
    for (const waiter of this.captureStartWaiters.splice(0)) {
      waiter();
    }
  }
}

class FakeRegistry implements BrowserRegistry {
  private readonly tabs = new Map<string, { workspaceId: string; tab: FakeTab }>();

  public register(browserId: string, workspaceId: string, tab: FakeTab): void {
    this.tabs.set(browserId, { workspaceId, tab });
  }

  public setActiveBrowser(_workspaceId: string, _browserId: string): void {}

  public getTabContents(browserId: string): TabContents | null {
    return this.tabs.get(browserId)?.tab ?? null;
  }

  public ownerOf(browserId: string): string | null {
    return this.tabs.get(browserId)?.workspaceId ?? null;
  }
}

class BrowserAutomationHarness {
  public readonly registry = new FakeRegistry();
  public readonly snapshotEngine = new BrowserSnapshotEngine();
  public readonly tab = new FakeTab(1, 'https://a.test/form', 'Fixture');

  public constructor() {
    this.registry.register(BROWSER_A, WORKSPACE_A, this.tab);
    this.registry.setActiveBrowser(WORKSPACE_A, BROWSER_A);
  }

  public async execute(
    command: BrowserAutomationCommand,
    input: { requestId?: string; workspaceId?: string; cwd?: string } = {},
  ) {
    return executeAutomationCommand(automationRequest(command, input), this.registry, {
      snapshotEngine: this.snapshotEngine,
    });
  }

  public async snapshot() {
    return this.execute({
      command: 'snapshot',
      args: { browserId: BROWSER_A },
    });
  }
}

function automationRequest(
  command: BrowserAutomationCommand,
  input: { requestId?: string; workspaceId?: string; cwd?: string } = {},
): BrowserAutomationExecuteRequest {
  return {
    requestId: input.requestId ?? `req-${command.command}`,
    sessionId: input.workspaceId || WORKSPACE_A,
    cwd: input.cwd ?? '/work',
    command,
  } as BrowserAutomationExecuteRequest;
}

function formElements() {
  return [
    {
      role: 'textbox',
      tagName: 'input',
      name: 'Name',
      ref: '@e1',
    },
    {
      role: 'checkbox',
      tagName: 'input',
      name: 'Agree',
      ref: '@e2',
      attributes: ['checked=false'],
    },
    {
      role: 'combobox',
      tagName: 'select',
      name: 'Country',
      ref: '@e3',
    },
    {
      role: 'button',
      tagName: 'button',
      name: 'Source',
      ref: '@e4',
    },
    {
      role: 'button',
      tagName: 'button',
      name: 'Target',
      ref: '@e5',
    },
  ];
}

function snapshotResult(nodes: FakeTab['snapshotNodes']) {
  const refs = nodes.flatMap((node) =>
    node.ref
      ? [
          {
            ref: node.ref,
            fingerprint: {
              role: node.role,
              name: node.name,
              tagName: node.tagName,
              type: '',
              ariaLabel: '',
            },
          },
        ]
      : [],
  );
  return {
    marker: '__WEVIR_ARIA_SNAPSHOT__',
    root: {
      kind: 'role',
      role: 'document',
      name: 'Fixture',
      tagName: 'document',
      attributes: [],
      children: nodes.map((node) => ({
        kind: 'role',
        role: node.role,
        name: node.name,
        tagName: node.tagName,
        attributes: node.attributes ?? [],
        ...(node.ref
          ? { ref: node.ref, fingerprint: refs.find((ref) => ref.ref === node.ref)?.fingerprint }
          : {}),
        children: node.children ?? [],
      })),
    },
    refs,
    truncated: false,
    stats: {
      nodeCount: nodes.length + 1,
      refCount: refs.length,
      textLength: 0,
      iframeCount: 0,
      maxDepth: 1,
    },
  };
}

function containsScript(tab: FakeTab, ...parts: string[]): boolean {
  return tab.scripts.some((script) => parts.every((part) => script.includes(part)));
}

function requireSnapshotRefs(result: Awaited<ReturnType<BrowserAutomationHarness['snapshot']>>) {
  expect(result).toEqual({
    requestId: 'req-snapshot',
    ok: true,
    result: {
      command: 'snapshot',
      browserId: BROWSER_A,
      url: 'https://a.test/form',
      title: 'Fixture',
      format: 'aria-yaml',
      snapshot: [
        '- document "Fixture"',
        '  - textbox "Name" [ref=@e1]',
        '  - checkbox "Agree" [checked=false ref=@e2]',
        '  - combobox "Country" [ref=@e3]',
        '  - button "Source" [ref=@e4]',
        '  - button "Target" [ref=@e5]',
      ].join('\n'),
      truncated: false,
      stats: {
        nodeCount: 6,
        refCount: 5,
        textLength: 187,
        iframeCount: 0,
        maxDepth: 1,
        totalLines: 6,
        startLine: 0,
        shownLines: 6,
      },
    },
  });
}

describe('executeAutomationCommand', () => {
  test('tab commands return tab not found for an id in another workspace', async () => {
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_B, new FakeTab(1, 'https://a.test', 'A'));

    const result = await executeAutomationCommand(
      automationRequest(
        { command: 'snapshot', args: { browserId: BROWSER_A } },
        { requestId: 'req-snapshot' },
      ),
      registry,
    );

    expect(result).toEqual({
      requestId: 'req-snapshot',
      ok: false,
      error: {
        code: 'browser_tab_not_found',
        message: `No browser tab found for ID: ${BROWSER_A}`,
        retryable: false,
      },
    });
  });

  test('tab commands return tab closed for a destroyed explicit tab', async () => {
    const tab = new FakeTab(1, 'https://a.test', 'A');
    tab.destroyed = true;
    const registry = new FakeRegistry();
    registry.register(BROWSER_A, WORKSPACE_A, tab);

    const result = await executeAutomationCommand(
      automationRequest(
        { command: 'snapshot', args: { browserId: BROWSER_A } },
        { requestId: 'req-snapshot' },
      ),
      registry,
    );

    expect(result).toEqual({
      requestId: 'req-snapshot',
      ok: false,
      error: {
        code: 'browser_tab_closed',
        message: `Browser tab ${BROWSER_A} has been closed`,
        retryable: false,
      },
    });
  });

  test('snapshot and click use refs from the same explicit tab', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = [
      {
        role: 'button',
        tagName: 'button',
        name: 'Submit',
        ref: '@e1',
      },
    ];

    const snapshot = await browser.snapshot();
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e1' },
    });

    expect(snapshot).toEqual({
      requestId: 'req-snapshot',
      ok: true,
      result: {
        command: 'snapshot',
        browserId: BROWSER_A,
        url: 'https://a.test/form',
        title: 'Fixture',
        format: 'aria-yaml',
        snapshot: '- document "Fixture"\n  - button "Submit" [ref=@e1]',
        truncated: false,
        stats: {
          nodeCount: 2,
          refCount: 1,
          textLength: 50,
          iframeCount: 0,
          maxDepth: 1,
          totalLines: 2,
          startLine: 0,
          shownLines: 2,
        },
      },
    });
    expect(click).toEqual({
      requestId: 'req-click',
      ok: true,
      result: { command: 'click', browserId: BROWSER_A, ref: '@e1', x: 40, y: 30 },
    });
    expect(browser.tab.debugCommands).toEqual([
      {
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 40, y: 30, button: 'none', modifiers: 0 },
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          x: 40,
          y: 30,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          modifiers: 0,
        },
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: 40,
          y: 30,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        },
      },
    ]);
  });

  test('click options choose the trusted mouse button, double-click count, and modifiers', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = [
      {
        role: 'button',
        tagName: 'button',
        name: 'Open menu',
        ref: '@e1',
      },
    ];

    await browser.snapshot();
    const click = await browser.execute({
      command: 'click',
      args: {
        browserId: BROWSER_A,
        ref: '@e1',
        button: 'right',
        doubleClick: true,
        modifiers: ['Control', 'Shift'],
      },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: true,
      result: { command: 'click', browserId: BROWSER_A, ref: '@e1', x: 40, y: 30 },
    });
    expect(browser.tab.debugCommands.map((entry) => entry.params)).toEqual([
      { type: 'mouseMoved', x: 40, y: 30, button: 'none', modifiers: 10 },
      {
        type: 'mousePressed',
        x: 40,
        y: 30,
        button: 'right',
        buttons: 2,
        clickCount: 1,
        modifiers: 10,
      },
      {
        type: 'mouseReleased',
        x: 40,
        y: 30,
        button: 'right',
        buttons: 0,
        clickCount: 1,
        modifiers: 10,
      },
      {
        type: 'mousePressed',
        x: 40,
        y: 30,
        button: 'right',
        buttons: 2,
        clickCount: 2,
        modifiers: 10,
      },
      {
        type: 'mouseReleased',
        x: 40,
        y: 30,
        button: 'right',
        buttons: 0,
        clickCount: 2,
        modifiers: 10,
      },
    ]);
  });

  test('commands include dialogs handled during the command', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    browser.tab.dialogsToCapture = [
      {
        type: 'alert',
        message: 'Saved',
        action: 'accepted',
        timestamp: 123,
      },
    ];
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e1' },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: true,
      result: { command: 'click', browserId: BROWSER_A, ref: '@e1', x: 40, y: 30 },
      dialogs: [
        {
          type: 'alert',
          message: 'Saved',
          action: 'accepted',
          timestamp: 123,
        },
      ],
    });
  });

  test.each([
    {
      name: 'fill updates a ref from the latest snapshot',
      command: { command: 'fill', args: { browserId: BROWSER_A, ref: '@e1', value: 'Ada' } },
      result: { command: 'fill', browserId: BROWSER_A, ref: '@e1' },
      scriptParts: ['"@e1"', 'Ada'],
    },
    {
      name: 'select sets the requested value on a ref',
      command: { command: 'select', args: { browserId: BROWSER_A, ref: '@e3', value: 'us' } },
      result: { command: 'select', browserId: BROWSER_A, ref: '@e3', value: 'us' },
      scriptParts: ['"@e3"', 'us'],
    },
  ] as const)('$name', async ({ command, result, scriptParts }) => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute(command);

    expect(action).toEqual({
      requestId: `req-${command.command}`,
      ok: true,
      result,
    });
    expect(containsScript(browser.tab, ...scriptParts)).toBe(true);
  });

  test('hover moves the trusted browser pointer to the actionable point', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'hover',
      args: { browserId: BROWSER_A, ref: '@e4' },
    });

    expect(action).toEqual({
      requestId: 'req-hover',
      ok: true,
      result: { command: 'hover', browserId: BROWSER_A, ref: '@e4', x: 40, y: 30 },
    });
    expect(browser.tab.debugCommands).toEqual([
      {
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 40, y: 30, button: 'none' },
      },
    ]);
  });

  test('scroll sends trusted wheel input at the viewport center', async () => {
    const browser = new BrowserAutomationHarness();

    const action = await browser.execute({
      command: 'scroll',
      args: { browserId: BROWSER_A, deltaX: 10, deltaY: 400 },
    });

    expect(action).toEqual({
      requestId: 'req-scroll',
      ok: true,
      result: {
        command: 'scroll',
        browserId: BROWSER_A,
        deltaX: 10,
        deltaY: 400,
        x: 640,
        y: 400,
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      {
        command: 'Input.dispatchMouseEvent',
        params: { type: 'mouseWheel', x: 640, y: 400, deltaX: 10, deltaY: 400 },
      },
    ]);
  });

  test('scroll with a ref sends trusted wheel input at the actionable point', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'scroll',
      args: { browserId: BROWSER_A, ref: '@e4', deltaX: 0, deltaY: -120 },
    });

    expect(action).toEqual({
      requestId: 'req-scroll',
      ok: true,
      result: {
        command: 'scroll',
        browserId: BROWSER_A,
        ref: '@e4',
        deltaX: 0,
        deltaY: -120,
        x: 40,
        y: 30,
      },
    });
    expect(browser.tab.debugCommands.at(-1)).toEqual({
      command: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 40, y: 30, deltaX: 0, deltaY: -120 },
    });
  });

  test('drag sends trusted pointer input between actionable points', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    browser.tab.actionabilityResult = {
      ok: true,
      target: { point: { x: 100, y: 50 }, rect: { x: 80, y: 30, width: 40, height: 40 } },
    };

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'drag',
      args: { browserId: BROWSER_A, sourceRef: '@e4', targetRef: '@e5' },
    });

    expect(action).toEqual({
      requestId: 'req-drag',
      ok: true,
      result: {
        command: 'drag',
        browserId: BROWSER_A,
        sourceRef: '@e4',
        targetRef: '@e5',
        sourceX: 100,
        sourceY: 50,
        targetX: 100,
        targetY: 50,
      },
    });
    expect(browser.tab.debugCommands.map((entry) => entry.command)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
    expect(browser.tab.debugCommands.at(1)?.params).toMatchObject({
      type: 'mousePressed',
      x: 100,
      y: 50,
      button: 'left',
      buttons: 1,
    });
    expect(browser.tab.debugCommands.at(-1)?.params).toMatchObject({
      type: 'mouseReleased',
      x: 100,
      y: 50,
      button: 'left',
      buttons: 0,
    });
  });

  test('fill with an empty string clears a ref through the regular fill path', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'fill',
      args: { browserId: BROWSER_A, ref: '@e1', value: '' },
    });

    expect(action).toEqual({
      requestId: 'req-fill',
      ok: true,
      result: { command: 'fill', browserId: BROWSER_A, ref: '@e1' },
    });
    expect(containsScript(browser.tab, '"@e1"', 'const nextValue = "";')).toBe(true);
  });

  test('refs become stale after navigation changes the tab URL', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    await browser.execute({
      command: 'navigate',
      args: { browserId: BROWSER_A, url: 'https://a.test/next' },
    });
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e1' },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: false,
      error: {
        code: 'browser_stale_ref',
        message:
          'Browser element reference @e1 is stale: the page changed after the snapshot, or no snapshot was taken since it loaded.',
        retryable: false,
      },
    });
  });

  test('refs become stale when the same URL no longer contains the element', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    browser.tab.actionScriptResult = false;
    const fill = await browser.execute({
      command: 'fill',
      args: { browserId: BROWSER_A, ref: '@e1', value: 'Ada' },
    });

    expect(fill).toEqual({
      requestId: 'req-fill',
      ok: false,
      error: {
        code: 'browser_stale_ref',
        message:
          'Browser element reference @e1 is stale: the page changed after the snapshot, or no snapshot was taken since it loaded.',
        retryable: false,
      },
    });
  });

  test('a ref that is not in the latest snapshot is reported as missing, not stale', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e99' },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: false,
      error: {
        code: 'browser_stale_ref',
        message: 'Browser element reference @e99 is not in the latest snapshot of this tab.',
        retryable: false,
      },
    });
  });

  test('click returns a retryable browser timeout when the ref never becomes actionable', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    browser.tab.actionabilityResult = { ok: false, reason: 'timeout', detail: 'disabled' };

    requireSnapshotRefs(await browser.snapshot());
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e2' },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: false,
      error: {
        code: 'browser_timeout',
        message:
          'Browser element @e2 did not become usable within 5 s (disabled). Take a new browser_snapshot to see its state.',
        retryable: true,
      },
    });
    expect(browser.tab.debugCommands).toEqual([]);
  });

  test('command failures include dialogs handled before the failure', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    browser.tab.actionabilityResult = { ok: false, reason: 'timeout', detail: 'disabled' };

    requireSnapshotRefs(await browser.snapshot());
    browser.tab.dialogsToCapture = [
      {
        type: 'prompt',
        message: 'Name?',
        defaultValue: 'Maya',
        action: 'dismissed',
        timestamp: 124,
      },
    ];
    const click = await browser.execute({
      command: 'click',
      args: { browserId: BROWSER_A, ref: '@e2' },
    });

    expect(click).toEqual({
      requestId: 'req-click',
      ok: false,
      error: {
        code: 'browser_timeout',
        message:
          'Browser element @e2 did not become usable within 5 s (disabled). Take a new browser_snapshot to see its state.',
        retryable: true,
      },
      dialogs: [
        {
          type: 'prompt',
          message: 'Name?',
          defaultValue: 'Maya',
          action: 'dismissed',
          timestamp: 124,
        },
      ],
    });
  });

  test('wait resolves when the explicit tab contains the requested text', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.bodyText = 'Ready';

    const result = await browser.execute({
      command: 'wait',
      args: { browserId: BROWSER_A, text: 'Ready', timeoutMs: 100 },
    });

    expect(result).toEqual({
      requestId: 'req-wait',
      ok: true,
      result: { command: 'wait', browserId: BROWSER_A, matched: 'text' },
    });
  });

  test('wait returns a retryable timeout when text never appears', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.bodyText = 'Still loading';

    const result = await browser.execute({
      command: 'wait',
      args: { browserId: BROWSER_A, text: 'Ready', timeoutMs: 1 },
    });

    expect(result).toEqual({
      requestId: 'req-wait',
      ok: false,
      error: {
        code: 'browser_timeout',
        message:
          'The page did not show the text "Ready" within 0 s. Take a browser_snapshot to see what it shows.',
        retryable: true,
      },
    });
  });

  test('type writes trusted text into a ref', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'type',
      args: { browserId: BROWSER_A, ref: '@e1', text: 'Ada' },
    });

    expect(action).toEqual({
      requestId: 'req-type',
      ok: true,
      result: { command: 'type', browserId: BROWSER_A, ref: '@e1', x: 40, y: 30 },
    });
    expect(browser.tab.insertedText).toEqual(['Ada']);
    expect(browser.tab.debugCommands.map((entry) => entry.command)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
    ]);
  });

  test('type inserts text through the tab, not the window-wide debugger input', async () => {
    const browser = new BrowserAutomationHarness();

    const action = await browser.execute({
      command: 'type',
      args: { browserId: BROWSER_A, text: 'Ada' },
    });

    expect(action).toEqual({
      requestId: 'req-type',
      ok: true,
      result: { command: 'type', browserId: BROWSER_A },
    });
    expect(browser.tab.insertedText).toEqual(['Ada']);
    expect(browser.tab.debugCommands).toEqual([]);
  });

  test('keypress dispatches a trusted key to the focused element when ref is omitted', async () => {
    const browser = new BrowserAutomationHarness();

    const action = await browser.execute({
      command: 'keypress',
      args: { browserId: BROWSER_A, key: 'Enter' },
    });

    expect(action).toEqual({
      requestId: 'req-keypress',
      ok: true,
      result: { command: 'keypress', browserId: BROWSER_A, key: 'Enter' },
    });
    expect(browser.tab.inputEvents).toEqual([
      {
        type: 'keyDown',
        keyCode: 'Enter',
        skipIfUnhandled: true,
      },
      { type: 'char', keyCode: '\r', skipIfUnhandled: true },
      {
        type: 'keyUp',
        keyCode: 'Enter',
        skipIfUnhandled: true,
      },
    ]);
    expect(browser.tab.debugCommands).toEqual([]);
  });

  test('keypress focuses a non-editable ref without clicking before the trusted key', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    browser.tab.rejectEditableActionability = true;

    requireSnapshotRefs(await browser.snapshot());
    const action = await browser.execute({
      command: 'keypress',
      args: { browserId: BROWSER_A, ref: '@e4', key: 'Enter' },
    });

    expect(action).toEqual({
      requestId: 'req-keypress',
      ok: true,
      result: { command: 'keypress', browserId: BROWSER_A, key: 'Enter', ref: '@e4', x: 40, y: 30 },
    });
    expect(containsScript(browser.tab, 'element.focus({ preventScroll: true })')).toBe(true);
    expect(browser.tab.inputEvents).toEqual([
      {
        type: 'keyDown',
        keyCode: 'Enter',
        skipIfUnhandled: true,
      },
      { type: 'char', keyCode: '\r', skipIfUnhandled: true },
      {
        type: 'keyUp',
        keyCode: 'Enter',
        skipIfUnhandled: true,
      },
    ]);
    expect(browser.tab.debugCommands).toEqual([]);
  });

  test('keypress reports unsupported when focusing an editable ref requires unavailable CDP', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    browser.tab.keypressTargetEditable = true;

    requireSnapshotRefs(await browser.snapshot());
    Object.defineProperty(browser.tab, 'sendDebugCommand', { value: undefined });

    await expect(
      browser.execute({
        command: 'keypress',
        args: { browserId: BROWSER_A, ref: '@e1', key: 'Enter' },
      }),
    ).resolves.toEqual({
      requestId: 'req-keypress',
      ok: false,
      error: {
        code: 'browser_unsupported',
        message: 'browser_keypress requires trusted browser input',
        retryable: false,
      },
    });
    expect(browser.tab.inputEvents).toEqual([]);
  });

  test('navigate loads the requested HTTP URL in the explicit tab', async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: 'navigate',
      args: { browserId: BROWSER_A, url: 'https://example.com/next' },
    });

    expect(result).toEqual({
      requestId: 'req-navigate',
      ok: true,
      result: { command: 'navigate', browserId: BROWSER_A, url: 'https://example.com/next' },
    });
    expect(browser.tab.loadedUrls).toEqual(['https://example.com/next']);
  });

  test('navigate denies non-http URLs before loading the explicit tab', async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: 'navigate',
      args: { browserId: BROWSER_A, url: 'file:///tmp/secret.txt' },
    });

    expect(result).toEqual({
      requestId: 'req-navigate',
      ok: false,
      error: {
        code: 'browser_denied',
        message: 'Browser navigation only supports http and https URLs.',
        retryable: false,
      },
    });
    expect(browser.tab.loadedUrls).toEqual([]);
  });

  test('navigation actions dispatch to the explicit tab', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.canNavigateForward = true;

    const back = await executeAutomationCommand(
      automationRequest(
        { command: 'back', args: { browserId: BROWSER_A } },
        { requestId: 'req-back' },
      ),
      browser.registry,
    );
    const forward = await executeAutomationCommand(
      automationRequest(
        { command: 'forward', args: { browserId: BROWSER_A } },
        { requestId: 'req-forward' },
      ),
      browser.registry,
    );
    const reload = await executeAutomationCommand(
      automationRequest(
        { command: 'reload', args: { browserId: BROWSER_A } },
        { requestId: 'req-reload' },
      ),
      browser.registry,
    );

    expect(back).toEqual({
      requestId: 'req-back',
      ok: true,
      result: { command: 'back', browserId: BROWSER_A },
    });
    expect(forward).toEqual({
      requestId: 'req-forward',
      ok: true,
      result: { command: 'forward', browserId: BROWSER_A },
    });
    expect(reload).toEqual({
      requestId: 'req-reload',
      ok: true,
      result: { command: 'reload', browserId: BROWSER_A },
    });
    expect(browser.tab.actions).toEqual(['back', 'forward', 'reload']);
  });

  test('back and forward fail when the tab has no matching history entry', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.canNavigateBack = false;
    browser.tab.canNavigateForward = false;

    const back = await browser.execute({
      command: 'back',
      args: { browserId: BROWSER_A },
    });
    const forward = await browser.execute({
      command: 'forward',
      args: { browserId: BROWSER_A },
    });

    expect(back).toEqual({
      requestId: 'req-back',
      ok: false,
      error: {
        code: 'browser_denied',
        message: 'There is nothing to go back to.',
        retryable: false,
      },
    });
    expect(forward).toEqual({
      requestId: 'req-forward',
      ok: false,
      error: {
        code: 'browser_denied',
        message: 'There is nothing to go forward to.',
        retryable: false,
      },
    });
    expect(browser.tab.actions).toEqual([]);
  });

  test.each([
    { command: { command: 'list_tabs', args: {} } },
    { command: { command: 'new_tab', args: {} } },
    { command: { command: 'close_tab', args: { browserId: BROWSER_A } } },
    { command: { command: 'show', args: { browserId: BROWSER_A } } },
  ] as Array<{ command: BrowserAutomationCommand }>)(
    '$command.command is handled by the browser host',
    async ({ command }) => {
      const browser = new BrowserAutomationHarness();

      await expect(browser.execute(command)).resolves.toEqual({
        requestId: `req-${command.command}`,
        ok: false,
        error: {
          code: 'browser_unsupported',
          message: `${command.command} is handled by the browser host.`,
          retryable: false,
        },
      });
    },
  );

  test('logs returns bounded console messages and network entries from the explicit tab', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.consoleMessages = [
      { level: 'debug', message: 'boot', timestamp: 1 },
      { level: 'info', message: 'ready', source: 'console', line: 3, timestamp: 2 },
    ];
    browser.tab.networkEntries = [
      { url: 'https://a.test/ignored', startTime: 1, duration: 2 },
      {
        url: 'https://a.test/app.js',
        method: 'GET',
        status: 200,
        type: 'script',
        startTime: 3,
        duration: 4,
        transferSize: 123,
      },
    ];

    const result = await browser.execute({
      command: 'logs',
      args: { browserId: BROWSER_A, maxEntries: 1 },
    });

    expect(result).toEqual({
      requestId: 'req-logs',
      ok: true,
      result: {
        command: 'logs',
        browserId: BROWSER_A,
        console: [{ level: 'info', message: 'ready', source: 'console', line: 3, timestamp: 2 }],
        network: [
          {
            url: 'https://a.test/app.js',
            method: 'GET',
            status: 200,
            type: 'script',
            startTime: 3,
            duration: 4,
            transferSize: 123,
          },
        ],
        consoleTotal: 2,
        networkTotal: 2,
      },
    });
  });

  test('logs prefer the tab network log and report totals', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.consoleMessages = [{ level: 'info', message: 'line 999', timestamp: 2 }];
    Object.assign(browser.tab, {
      getConsoleTotal: () => 1000,
      getNetworkLog: () => ({
        entries: [
          { url: 'https://a.test/api', method: 'POST', startTime: 5, duration: 0, pending: true },
        ],
        total: 7,
      }),
    });

    const result = await browser.execute({ command: 'logs', args: { browserId: BROWSER_A } });

    expect(result).toMatchObject({
      ok: true,
      result: {
        console: [{ message: 'line 999' }],
        network: [{ url: 'https://a.test/api', method: 'POST', pending: true }],
        consoleTotal: 1000,
        networkTotal: 7,
      },
    });
    expect(browser.tab.scripts.some((script) => script.includes('getEntriesByType'))).toBe(false);
  });

  test('fill on a file input explains that pages get no local files', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.snapshotNodes = formElements();
    requireSnapshotRefs(await browser.snapshot());
    browser.tab.actionScriptResult = { ok: false, reason: 'file_input' };

    const result = await browser.execute({
      command: 'fill',
      args: { browserId: BROWSER_A, ref: '@e1', value: '/etc/hosts' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'browser_unsupported',
        message: expect.stringContaining('@e1 is a file input'),
      },
    });
  });

  test('screenshot captures the painted viewport', async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: 'screenshot',
      args: { browserId: BROWSER_A },
    });

    expect(result).toEqual({
      requestId: 'req-screenshot',
      ok: true,
      result: {
        command: 'screenshot',
        browserId: BROWSER_A,
        mimeType: 'image/png',
        dataBase64: 'iVBORwECAw==',
        width: 640,
        height: 480,
      },
    });
    expect(browser.tab.capturedViewports).toHaveLength(1);
    expect(browser.tab.capturedViewports[0]?.aborted).toBe(true);
    expect(browser.tab.actions).toEqual(['invalidate', 'capture']);
  });

  test('screenshot returns no-frame when the viewport never paints', async () => {
    vi.useFakeTimers();
    try {
      const browser = new BrowserAutomationHarness();
      browser.tab.captureNeverPaints = true;

      const resultPromise = browser.execute({
        command: 'screenshot',
        args: { browserId: BROWSER_A },
      });
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(resultPromise).resolves.toEqual({
        requestId: 'req-screenshot',
        ok: false,
        error: {
          code: 'screenshot_no_frame',
          message: 'The tab has not painted yet. Retry the screenshot.',
          retryable: true,
        },
      });
      expect(browser.tab.actions).toEqual(['invalidate', 'capture']);
      expect(browser.tab.capturedViewports[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('paint and pixel capture share the five-second screenshot budget', async () => {
    vi.useFakeTimers();
    try {
      const browser = new BrowserAutomationHarness();
      browser.tab.paintDelayMs = 4_000;
      browser.tab.captureNeverPaints = true;
      let result: unknown;
      void browser
        .execute({
          command: 'screenshot',
          args: { browserId: BROWSER_A },
        })
        .then((value) => {
          result = value;
          return value;
        });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ ok: false, error: { code: 'screenshot_no_frame' } });
    } finally {
      vi.useRealTimers();
    }
  });

  test('screenshot surfaces ordinary viewport capture errors', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.captureThrows = true;

    await expect(
      browser.execute({
        command: 'screenshot',
        args: { browserId: BROWSER_A },
      }),
    ).rejects.toThrow('capture failed');

    expect(browser.tab.actions).toEqual(['invalidate', 'capture']);
  });

  test('overlapping screenshots serialize through the shared capture queue', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.deferCaptures = true;

    const first = browser.execute({
      command: 'screenshot',
      args: { browserId: BROWSER_A },
    });
    await browser.tab.waitForCaptureStart(1);

    const second = browser.execute(
      {
        command: 'screenshot',
        args: { browserId: BROWSER_A },
      },
      { requestId: 'req-screenshot-2' },
    );
    await Promise.resolve();

    expect(browser.tab.actions).toEqual(['invalidate', 'capture']);

    browser.tab.finishNextCapture();
    await browser.tab.waitForCaptureStart(2);

    expect(browser.tab.actions).toEqual(['invalidate', 'capture', 'invalidate', 'capture']);

    browser.tab.finishNextCapture();
    await expect(first).resolves.toMatchObject({ requestId: 'req-screenshot', ok: true });
    await expect(second).resolves.toMatchObject({ requestId: 'req-screenshot-2', ok: true });
    expect(browser.tab.actions).toEqual(['invalidate', 'capture', 'invalidate', 'capture']);
  });

  test('overlapping screenshots across browser tabs serialize through the shared capture queue', async () => {
    const registry = new FakeRegistry();
    const firstTab = new FakeTab(1, 'https://a.test', 'A');
    const secondTab = new FakeTab(2, 'https://b.test', 'B');
    firstTab.deferCaptures = true;
    secondTab.deferCaptures = true;
    registry.register(BROWSER_A, WORKSPACE_A, firstTab);
    registry.register(BROWSER_B, WORKSPACE_A, secondTab);

    const first = executeAutomationCommand(
      automationRequest({
        command: 'screenshot',
        args: { browserId: BROWSER_A },
      }),
      registry,
    );
    await firstTab.waitForCaptureStart(1);

    const second = executeAutomationCommand(
      automationRequest(
        {
          command: 'screenshot',
          args: { browserId: BROWSER_B },
        },
        { requestId: 'req-screenshot-2' },
      ),
      registry,
    );
    await Promise.resolve();

    expect(firstTab.actions).toEqual(['invalidate', 'capture']);
    expect(secondTab.actions).toEqual([]);

    firstTab.finishNextCapture();
    await secondTab.waitForCaptureStart(1);

    expect(firstTab.actions).toEqual(['invalidate', 'capture']);
    expect(secondTab.actions).toEqual(['invalidate', 'capture']);

    secondTab.finishNextCapture();
    await expect(first).resolves.toMatchObject({ requestId: 'req-screenshot', ok: true });
    await expect(second).resolves.toMatchObject({ requestId: 'req-screenshot-2', ok: true });
    expect(secondTab.actions).toEqual(['invalidate', 'capture']);
  });

  test('screenshot with fullPage captures the page content area through CDP', async () => {
    const browser = new BrowserAutomationHarness();

    const result = await browser.execute({
      command: 'screenshot',
      args: { browserId: BROWSER_A, fullPage: true },
    });

    expect(result).toEqual({
      requestId: 'req-screenshot',
      ok: true,
      result: {
        command: 'screenshot',
        browserId: BROWSER_A,
        mimeType: 'image/png',
        dataBase64: 'fullPagePng',
        width: 390,
        height: 1200,
      },
    });
    expect(browser.tab.debugCommands).toEqual([
      { command: 'Page.getLayoutMetrics' },
      {
        command: 'Page.captureScreenshot',
        params: {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 390, height: 1200, scale: 1 },
        },
      },
    ]);
    expect(browser.tab.actions).toEqual([
      'invalidate',
      'debug:Page.getLayoutMetrics',
      'debug:Page.captureScreenshot',
    ]);
  });

  test('screenshot with fullPage returns unsupported when CDP returns no image', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.fullPageScreenshotData = '';

    const result = await browser.execute({
      command: 'screenshot',
      args: { browserId: BROWSER_A, fullPage: true },
    });

    expect(result).toEqual({
      requestId: 'req-screenshot',
      ok: false,
      error: {
        code: 'browser_unsupported',
        message: 'browser_screenshot fullPage returned no data',
        retryable: false,
      },
    });
    expect(browser.tab.actions).toEqual([
      'invalidate',
      'debug:Page.getLayoutMetrics',
      'debug:Page.captureScreenshot',
    ]);
  });

  test('screenshot with fullPage retries UnknownVizError until the first CDP frame appears', async () => {
    vi.useFakeTimers();
    try {
      const browser = new BrowserAutomationHarness();
      browser.tab.fullPageCaptureFailuresBeforeSuccess = 1;

      const resultPromise = browser.execute({
        command: 'screenshot',
        args: { browserId: BROWSER_A, fullPage: true },
      });
      await vi.advanceTimersByTimeAsync(200);

      await expect(resultPromise).resolves.toEqual({
        requestId: 'req-screenshot',
        ok: true,
        result: {
          command: 'screenshot',
          browserId: BROWSER_A,
          mimeType: 'image/png',
          dataBase64: 'fullPagePng',
          width: 390,
          height: 1200,
        },
      });
      expect(browser.tab.actions).toEqual([
        'invalidate',
        'debug:Page.getLayoutMetrics',
        'debug:Page.captureScreenshot',
        'invalidate',
        'debug:Page.getLayoutMetrics',
        'debug:Page.captureScreenshot',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('screenshot with fullPage surfaces ordinary CDP capture errors', async () => {
    const browser = new BrowserAutomationHarness();
    browser.tab.fullPageScreenshotThrows = true;
    browser.tab.fullPageScreenshotErrorMessage = 'Debugger detached';

    await expect(
      browser.execute({
        command: 'screenshot',
        args: { browserId: BROWSER_A, fullPage: true },
      }),
    ).rejects.toThrow('Debugger detached');
    expect(browser.tab.actions).toEqual([
      'invalidate',
      'debug:Page.getLayoutMetrics',
      'debug:Page.captureScreenshot',
    ]);
  });
});
