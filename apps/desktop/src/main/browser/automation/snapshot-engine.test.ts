// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/snapshot-engine.test.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 Wevir 的；加上省掉重复名字的文字子节点。

import { describe, expect, it } from 'vitest';
import { BrowserSnapshotEngine, type SnapshotPage } from './snapshot-engine.js';

class SnapshotFixture implements SnapshotPage {
  public currentUrl = 'https://example.com/form';
  public actionResult: unknown = { ok: true };
  public alreadyTruncated = false;
  public snapshotNodes: unknown[] = [
    {
      kind: 'role',
      role: 'heading',
      name: 'Settings',
      tagName: 'h1',
      attributes: ['level=1'],
      children: [],
    },
    { kind: 'text', text: 'Connected as Maya' },
    {
      kind: 'role',
      role: 'button',
      name: 'Save changes',
      tagName: 'button',
      attributes: [],
      ref: '@e1',
      fingerprint: {
        role: 'button',
        name: 'Save changes',
        tagName: 'button',
        type: '',
        ariaLabel: '',
      },
      children: [],
    },
  ];

  public getURL(): string {
    return this.currentUrl;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    if (code.includes('__WEVIR_ARIA_SNAPSHOT__')) {
      return JSON.stringify({
        marker: '__WEVIR_ARIA_SNAPSHOT__',
        root: {
          kind: 'role',
          role: 'document',
          name: 'Fixture',
          tagName: 'document',
          attributes: [],
          children: this.snapshotNodes,
        },
        refs: [
          {
            ref: '@e1',
            fingerprint: {
              role: 'button',
              name: 'Save changes',
              tagName: 'button',
              type: '',
              ariaLabel: '',
            },
          },
        ],
        truncated: this.alreadyTruncated,
        stats: { nodeCount: 4, refCount: 1, textLength: 0, iframeCount: 0, maxDepth: 1 },
      });
    }
    return this.actionResult;
  }
}

describe('BrowserSnapshotEngine', () => {
  it('renders a hierarchical ARIA YAML snapshot with static text and actionable refs', async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    await expect(engine.snapshot({ browserId: 'browser-1', page })).resolves.toEqual({
      format: 'aria-yaml',
      snapshot: [
        '- document "Fixture"',
        '  - heading "Settings" [level=1]',
        '  - text: "Connected as Maya"',
        '  - button "Save changes" [ref=@e1]',
      ].join('\n'),
      truncated: false,
      stats: {
        nodeCount: 4,
        refCount: 1,
        textLength: 119,
        iframeCount: 0,
        maxDepth: 1,
        totalLines: 4,
        startLine: 0,
        shownLines: 4,
      },
    });
  });

  it('builds a runtime ref expression with the snapshot fingerprint', async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: 'browser-1', page });

    page.currentUrl = 'https://example.com/form?panel=advanced';

    expect(engine.runtimeElementExpression({ browserId: 'browser-1', ref: '@e1' })).toContain(
      '"name":"Save changes"',
    );
  });

  it('treats missing host-side ref metadata as a stale ref', async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: 'browser-1', page });

    expect(engine.runtimeElementExpression({ browserId: 'browser-1', ref: '@e2' })).toEqual({
      ok: false,
      reason: 'missing_ref',
    });
  });

  it('clamps a very long line instead of dropping the snapshot', async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [{ kind: 'text', text: 'A'.repeat(81_000) }];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: 'browser-1', page });

    expect(snapshot.stats.textLength).toBeLessThanOrEqual(1_000);
    expect(snapshot.snapshot).toContain('…');
  });

  it('splits a long page into parts and lists the refs further down', async () => {
    const page = new SnapshotFixture();
    const button = (page.snapshotNodes as unknown[])[2];
    page.snapshotNodes = [
      ...Array.from({ length: 300 }, (_, index) => ({
        kind: 'text',
        text: `row ${index} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod`,
      })),
      button,
    ];
    const engine = new BrowserSnapshotEngine();

    const first = await engine.snapshot({ browserId: 'browser-1', page, pageBytes: 4_000 });
    expect(first.truncated).toBe(true);
    expect(new TextEncoder().encode(first.snapshot).length).toBeLessThanOrEqual(4_000);
    expect(first.stats).toMatchObject({ totalLines: 302, startLine: 0 });
    const next = first.stats.shownLines ?? 0;
    expect(first.snapshot).toContain(`Next part: browser_snapshot with offset=${next}.`);
    expect(first.snapshot).toContain(
      '# Elements with refs further down (usable now):\n- button "Save changes" [ref=@e1]',
    );
    // 列出来的引用马上能用。
    expect(engine.runtimeElementExpression({ browserId: 'browser-1', ref: '@e1' })).toEqual(
      expect.any(String),
    );

    let offset = next;
    let last = first;
    while (last.stats.startLine !== undefined && offset < 302) {
      last = await engine.snapshot({ browserId: 'browser-1', page, offset, pageBytes: 4_000 });
      offset = (last.stats.startLine ?? 0) + (last.stats.shownLines ?? 0);
    }
    expect(last.snapshot).toContain('- button "Save changes" [ref=@e1]');
    expect(last.snapshot).not.toContain('Next part');
    expect(last.snapshot).toContain('their refs stay valid');
  });

  it('says when an offset is past the end', async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: 'browser-1', page, offset: 99 });

    expect(snapshot.snapshot).toMatch(/offset 99 is past the end/);
    expect(snapshot.stats.shownLines).toBe(0);
  });

  it('keeps the last rendered node when a short snapshot was capped by node count', async () => {
    const page = new SnapshotFixture();
    page.alreadyTruncated = true;
    page.snapshotNodes = [
      {
        kind: 'role',
        role: 'button',
        name: 'Final action',
        tagName: 'button',
        attributes: [],
        ref: '@e1',
        fingerprint: {
          role: 'button',
          name: 'Final action',
          tagName: 'button',
          type: '',
          ariaLabel: '',
        },
        children: [],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: 'browser-1', page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - button "Final action" [ref=@e1]',
        '# The page is very large: the snapshot stops after its first 20000 nodes.',
      ].join('\n'),
    );
  });

  it('omits text children that only repeat the node name', async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [
      {
        kind: 'role',
        role: 'heading',
        name: 'Smoke test page',
        tagName: 'h1',
        attributes: ['level=1'],
        children: [{ kind: 'group', children: [{ kind: 'text', text: 'Smoke test page' }] }],
      },
      {
        kind: 'role',
        role: 'listitem',
        name: 'First',
        tagName: 'li',
        attributes: [],
        children: [
          { kind: 'text', text: 'First' },
          { kind: 'text', text: 'and more' },
        ],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: 'browser-1', page });

    expect(snapshot.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - heading "Smoke test page" [level=1]',
        '  - listitem "First"',
        '    - text: "First"',
        '    - text: "and more"',
      ].join('\n'),
    );
  });
});
