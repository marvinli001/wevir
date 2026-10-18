// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/snapshot-engine.test.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 Wevir 的；加上省掉重复名字的文字子节点。0.48.0：快照的范围、跨域 frame 的占位、停下时的说明、
// browser_query 的引用。

import { describe, expect, it } from 'vitest';
import {
  type BrowserAriaSnapshot,
  BrowserSnapshotEngine,
  type SnapshotPage,
} from './snapshot-engine.js';

/** 快照成功（失败时让测试失败）。 */
async function snap(
  engine: BrowserSnapshotEngine,
  input: Parameters<BrowserSnapshotEngine['snapshot']>[0],
): Promise<BrowserAriaSnapshot> {
  const result = await engine.snapshot(input);
  if ('ok' in result) throw new Error(`snapshot failed: ${result.reason}`);
  return result;
}

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
        maxNodes: 20000,
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

    const snapshot = await snap(engine, { browserId: 'browser-1', page });

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

    const first = await snap(engine, { browserId: 'browser-1', page, pageBytes: 4_000 });
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
      last = await snap(engine, { browserId: 'browser-1', page, offset, pageBytes: 4_000 });
      offset = (last.stats.startLine ?? 0) + (last.stats.shownLines ?? 0);
    }
    expect(last.snapshot).toContain('- button "Save changes" [ref=@e1]');
    expect(last.snapshot).not.toContain('Next part');
    expect(last.snapshot).toContain('their refs stay valid');
  });

  it('says when an offset is past the end', async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    const snapshot = await snap(engine, { browserId: 'browser-1', page, offset: 99 });

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

    const snapshot = await snap(engine, { browserId: 'browser-1', page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - button "Final action" [ref=@e1]',
        '# The snapshot stopped after 20000 nodes; the rest of the page is not included. Snapshot part of the page (selector, ref or frame), only what is on screen (viewportOnly), or raise maxNodes (up to 50000).',
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

    const snapshot = await snap(engine, { browserId: 'browser-1', page });

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

  describe('0.48.0 scope, frames and limits', () => {
    const fingerprint = (name: string) => ({
      role: 'button',
      name,
      tagName: 'button',
      type: '',
      ariaLabel: '',
    });
    const button = (ref: string, name: string) => ({
      kind: 'role',
      role: 'button',
      name,
      tagName: 'button',
      attributes: [],
      ref,
      fingerprint: fingerprint(name),
      children: [],
    });
    const result = (
      children: unknown[],
      refs: Array<[string, string]>,
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        marker: '__WEVIR_ARIA_SNAPSHOT__',
        root: {
          kind: 'role',
          role: 'document',
          name: 'Fixture',
          tagName: 'document',
          attributes: [],
          children,
        },
        refs: refs.map(([ref, name]) => ({ ref, fingerprint: fingerprint(name) })),
        truncated: false,
        stats: {
          nodeCount: children.length + 1,
          refCount: refs.length,
          textLength: 0,
          iframeCount: 0,
          maxDepth: 1,
        },
        ...extra,
      });
    /** 每次快照脚本都交给 `answer`。 */
    const scripted = (answer: (code: string) => unknown): SnapshotPage & { scripts: string[] } => {
      const scripts: string[] = [];
      return {
        scripts,
        getURL: () => 'https://a.test/',
        executeJavaScript: async (code: string) => {
          scripts.push(code);
          return code.includes('__WEVIR_ARIA_SNAPSHOT__') ? answer(code) : true;
        },
      };
    };

    it('fills a cross-site frame placeholder from that frame and keeps numbering refs', async () => {
      const top = scripted(() =>
        result(
          [
            button('@e1', 'Top'),
            {
              kind: 'role',
              role: 'iframe',
              name: '',
              tagName: 'iframe',
              attributes: ['frame=1'],
              children: [{ kind: 'frame', frame: '1' }],
            },
          ],
          [['@e1', 'Top']],
        ),
      );
      const inner = scripted((code) => {
        // 接着顶层的编号。
        expect(code).toContain('"refStart":2');
        return result([button('@e2', 'Inside')], [['@e2', 'Inside']]);
      });
      const engine = new BrowserSnapshotEngine();

      const snapshot = await snap(engine, {
        browserId: 'b',
        page: top,
        frames: async () => [{ id: '1', url: 'https://b.test/', name: '', page: inner }],
      });

      expect(snapshot.snapshot).toBe(
        [
          '- document "Fixture"',
          '  - button "Top" [ref=@e1]',
          '  - iframe [frame=1]',
          '    - button "Inside" [ref=@e2]',
        ].join('\n'),
      );
      expect(snapshot.stats.refCount).toBe(2);
      expect(engine.refFrame({ browserId: 'b', ref: '@e2' })).toBe('1');
      expect(engine.refFrame({ browserId: 'b', ref: '@e1' })).toBe('');
    });

    it('says when a frame cannot be read', async () => {
      const top = scripted(() =>
        result(
          [
            {
              kind: 'role',
              role: 'iframe',
              name: '',
              tagName: 'iframe',
              attributes: [],
              children: [{ kind: 'frame', frame: '0' }],
            },
          ],
          [],
        ),
      );
      const snapshot = await snap(new BrowserSnapshotEngine(), { browserId: 'b', page: top });
      expect(snapshot.snapshot).toContain('(content from another site could not be read)');
    });

    it('says a frame was left out, not unreadable, when the node limit is reached first', async () => {
      const top = scripted(() =>
        result(
          [
            {
              kind: 'role',
              role: 'iframe',
              name: '',
              tagName: 'iframe',
              attributes: ['frame=1'],
              children: [{ kind: 'frame', frame: '1' }],
            },
          ],
          [],
          { truncated: true, stoppedAt: 'body > p:nth-of-type(100)' },
        ),
      );
      const inner = scripted(() => {
        throw new Error('a frame past the node limit must not be read');
      });

      const snapshot = await snap(new BrowserSnapshotEngine(), {
        browserId: 'b',
        page: top,
        maxNodes: 100,
        frames: async () => [{ id: '1', url: 'https://b.test/', name: '', page: inner }],
      });

      expect(inner.scripts).toEqual([]);
      expect(snapshot.snapshot).toContain(
        '- text: "(content from another site left out: the snapshot reached its node limit; snapshot it with frame=1)"',
      );
      expect(snapshot.snapshot).not.toContain('could not be read');
    });

    it('passes the scope to the page script and reports selector failures', async () => {
      let answer: unknown = result([], []);
      const page = scripted(() => answer);
      const engine = new BrowserSnapshotEngine();

      await snap(engine, {
        browserId: 'b',
        page,
        selector: 'main',
        viewportOnly: true,
        maxNodes: 300,
      });
      expect(page.scripts.at(-1)).toContain('"selector":"main"');
      expect(page.scripts.at(-1)).toContain('"viewportOnly":true');
      expect(page.scripts.at(-1)).toContain('"maxNodes":300');

      answer = JSON.stringify({ marker: '__WEVIR_ARIA_SNAPSHOT__', error: 'not_found' });
      await expect(engine.snapshot({ browserId: 'b', page, selector: '#none' })).resolves.toEqual({
        ok: false,
        reason: 'not_found',
      });
      answer = JSON.stringify({
        marker: '__WEVIR_ARIA_SNAPSHOT__',
        error: 'invalid_selector',
        message: 'bad',
      });
      await expect(engine.snapshot({ browserId: 'b', page, selector: '[' })).resolves.toEqual({
        ok: false,
        reason: 'invalid_selector',
        message: 'bad',
      });
    });

    it('a snapshot from a ref starts at that element in its frame', async () => {
      const top = scripted(() => result([button('@e1', 'Top')], [['@e1', 'Top']]));
      const inner = scripted(() => result([button('@e1', 'Inside')], [['@e1', 'Inside']]));
      const engine = new BrowserSnapshotEngine();
      const frames = async () => [{ id: '0', url: 'https://b.test/', name: '', page: inner }];
      await snap(engine, { browserId: 'b', page: inner, frame: { id: '0', page: inner }, frames });

      await snap(engine, { browserId: 'b', page: top, ref: '@e1', frames });

      expect(inner.scripts.at(-1)).toContain('"rootRef":{"ref":"@e1"');
      expect(top.scripts).toEqual([]);
      await expect(
        engine.snapshot({ browserId: 'b', page: top, ref: '@e9', frames }),
      ).resolves.toEqual({
        ok: false,
        reason: 'missing_ref',
      });
    });

    it('says where a truncated snapshot stopped and how to narrow it', async () => {
      const page = scripted(() =>
        result([button('@e1', 'Top')], [['@e1', 'Top']], {
          truncated: true,
          refsTruncated: true,
          stoppedAt: 'body > ul > li:nth-of-type(100)',
        }),
      );
      const snapshot = await snap(new BrowserSnapshotEngine(), {
        browserId: 'b',
        page,
        maxNodes: 100,
      });

      expect(snapshot.snapshot).toContain(
        '# The snapshot stopped after 100 nodes at body > ul > li:nth-of-type(100); the rest of the page is not included.',
      );
      expect(snapshot.snapshot).toContain('# Only the first 500 elements got refs.');
      expect(snapshot.stats).toMatchObject({
        stoppedAt: 'body > ul > li:nth-of-type(100)',
        maxNodes: 100,
      });
    });

    it('query gives refs after the snapshot refs and keeps both usable', async () => {
      const page = scripted(() => result([button('@e1', 'Top')], [['@e1', 'Top']]));
      page.executeJavaScript = async (code: string) => {
        page.scripts.push(code);
        if (code.includes('__WEVIR_ARIA_SNAPSHOT__'))
          return result([button('@e1', 'Top')], [['@e1', 'Top']]);
        if (code.includes('document.querySelectorAll')) {
          expect(code).toContain('["@e2","@e3"]');
          return {
            count: 5,
            elements: [
              {
                ref: '@e2',
                fingerprint: fingerprint('A'),
                tag: 'a',
                text: 'A',
                visible: false,
                box: { x: 0, y: 0, width: 0, height: 0 },
                attributes: { href: '/a' },
              },
            ],
          };
        }
        return true;
      };
      const engine = new BrowserSnapshotEngine();
      await snap(engine, { browserId: 'b', page });

      const queried = await engine.query({
        browserId: 'b',
        page,
        frame: '',
        selector: 'a',
        maxResults: 2,
        attributes: ['href'],
      });

      expect(queried).toEqual({
        ok: true,
        count: 5,
        elements: [
          {
            ref: '@e2',
            tag: 'a',
            text: 'A',
            visible: false,
            box: { x: 0, y: 0, width: 0, height: 0 },
            attributes: { href: '/a' },
          },
        ],
      });
      expect(engine.runtimeElementExpression({ browserId: 'b', ref: '@e1' })).toEqual(
        expect.any(String),
      );
      expect(engine.runtimeElementExpression({ browserId: 'b', ref: '@e2' })).toEqual(
        expect.any(String),
      );
    });

    it('parallel queries on one tab get different refs and both stay usable', async () => {
      const page = scripted(() => result([], []));
      page.executeJavaScript = async (code: string) => {
        page.scripts.push(code);
        if (code.includes('document.querySelectorAll')) {
          // 第一个查询慢，第二个不等它就回来：以前两个都从同一个编号起。
          const refs = JSON.parse(/\["@e\d+"(?:,"@e\d+")*\]/.exec(code)?.[0] ?? '[]') as string[];
          if (code.includes('first')) await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            count: 1,
            elements: [
              {
                ref: refs[0],
                fingerprint: fingerprint('x'),
                tag: 'button',
                text: 'x',
                visible: true,
                box: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          };
        }
        return true;
      };
      const engine = new BrowserSnapshotEngine();
      const [one, two] = await Promise.all(
        ['first', 'second'].map((selector) =>
          engine.query({
            browserId: 'b',
            page,
            frame: selector === 'first' ? '0' : '1',
            selector,
            maxResults: 3,
          }),
        ),
      );
      if (!one?.ok || !two?.ok) throw new Error('query failed');
      expect(one.elements[0]?.ref).not.toBe(two.elements[0]?.ref);
      for (const element of [...one.elements, ...two.elements]) {
        expect(engine.refFrame({ browserId: 'b', ref: element.ref })).toBe(
          element === one.elements[0] ? '0' : '1',
        );
      }
    });
  });
});
