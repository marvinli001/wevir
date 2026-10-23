// 增量快照：逐行比较、写成带祖先的块；快照引擎记下上一次的行，`changes` 时只给变了的行，比不了时给整个快照并说明。
// 引用编号在一个文档里只增不减（页面脚本沿用旧引用，这里用假页面给出脚本的结果）。

import { describe, expect, it } from 'vitest';
import { diffLines, renderChanges } from './snapshot-diff.js';
import { BrowserSnapshotEngine, type SnapshotPage } from './snapshot-engine.js';

describe('diffLines', () => {
  it('keeps common lines and finds the smallest edit in the middle', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'add', text: 'e' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ kind: 'add', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ kind: 'remove', text: 'a' }]);
  });

  it('finds an inserted run inside a long list', () => {
    const before = Array.from({ length: 200 }, (_, index) => `line ${index}`);
    const after = [
      ...before.slice(0, 100),
      'new 1',
      'new 2',
      ...before.slice(100, 150),
      ...before.slice(151),
    ];
    const edits = diffLines(before, after) ?? [];
    expect(edits.filter((edit) => edit.kind === 'add').map((edit) => edit.text)).toEqual([
      'new 1',
      'new 2',
    ]);
    expect(edits.filter((edit) => edit.kind === 'remove').map((edit) => edit.text)).toEqual([
      'line 150',
    ]);
  });

  it('gives up past the edit limit', () => {
    const before = Array.from({ length: 50 }, (_, index) => `a${index}`);
    const after = Array.from({ length: 50 }, (_, index) => `b${index}`);
    expect(diffLines(before, after, 20)).toBeUndefined();
    expect(diffLines(before, after, 100)).toHaveLength(100);
  });
});

describe('renderChanges', () => {
  it('labels each run of changes with its ancestors', () => {
    const before = [
      '- document "App"',
      '  - main',
      '    - form "Login"',
      '      - textbox "Email" [ref=@e1]',
      '      - button "Sign in" [ref=@e2]',
      '  - list',
      '    - listitem "One"',
    ];
    const after = [
      '- document "App"',
      '  - main',
      '    - form "Login"',
      '      - textbox "Email" [value="a@b.c" ref=@e1]',
      '      - button "Sign in" [ref=@e2]',
      '  - list',
      '    - listitem "One"',
      '    - listitem "Two"',
    ];
    const changes = renderChanges(diffLines(before, after) ?? [], (line) => line);
    expect(changes).toMatchObject({ added: 2, removed: 1, unchanged: 6 });
    expect(changes.text).toBe(
      [
        '# in: main > form "Login"',
        '-      - textbox "Email" [ref=@e1]',
        '+      - textbox "Email" [value="a@b.c" ref=@e1]',
        '# in: list',
        '+    - listitem "Two"',
      ].join('\n'),
    );
  });
});

describe('BrowserSnapshotEngine changes', () => {
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
  /** 假页面：每次快照给出 `buttons` 现在的样子；记下脚本拿到的 refStart。 */
  function page(buttons: Array<[string, string]>, refNext?: () => number) {
    const starts: number[] = [];
    const fake: SnapshotPage & { starts: number[] } = {
      starts,
      getURL: () => 'https://a.test/',
      executeJavaScript: async (code: string) => {
        const match = /"refStart":(\d+)/.exec(code);
        if (match) starts.push(Number(match[1]));
        return JSON.stringify({
          marker: '__WEVIR_ARIA_SNAPSHOT__',
          root: {
            kind: 'role',
            role: 'document',
            name: 'Fixture',
            tagName: 'document',
            attributes: [],
            children: buttons.map(([ref, name]) => button(ref, name)),
          },
          refs: buttons.map(([ref, name]) => ({ ref, fingerprint: fingerprint(name) })),
          truncated: false,
          ...(refNext && { refNext: refNext() }),
          stats: { nodeCount: buttons.length + 1, refCount: buttons.length, textLength: 0 },
        });
      },
    };
    return fake;
  }
  async function snap(
    engine: BrowserSnapshotEngine,
    input: Parameters<BrowserSnapshotEngine['snapshot']>[0],
  ) {
    const result = await engine.snapshot(input);
    if ('ok' in result) throw new Error(result.reason);
    return result;
  }

  it('lists only what changed, keeps numbering refs and says when nothing changed', async () => {
    const buttons: Array<[string, string]> = [
      ['@e1', 'Save'],
      ['@e2', 'Cancel'],
    ];
    const tab = page(buttons);
    const engine = new BrowserSnapshotEngine();

    const first = await snap(engine, { browserId: 'b', page: tab, changes: true });
    expect(first.snapshot.split('\n')[0]).toMatch(/^# No earlier snapshot/);
    expect(first.snapshot).toContain('- button "Save" [ref=@e1]');
    expect(first.stats.changes).toBeUndefined();

    const same = await snap(engine, { browserId: 'b', page: tab, changes: true });
    expect(same.snapshot).toBe(
      '# Nothing changed since the last snapshot (3 lines); its refs are still valid.',
    );
    expect(same.stats.changes).toEqual({ added: 0, removed: 0, unchanged: 3 });

    buttons.splice(1, 1, ['@e3', 'Delete']);
    const changed = await snap(engine, { browserId: 'b', page: tab, changes: true });
    expect(changed.snapshot).toBe(
      [
        '# Changes since the last snapshot: 1 line added (+), 1 removed (-), 2 unchanged. Refs on unchanged and added lines are valid; a ref only on removed lines is gone.',
        '# in: document "Fixture"',
        '-  - button "Cancel" [ref=@e2]',
        '+  - button "Delete" [ref=@e3]',
      ].join('\n'),
    );
    expect(changed.stats).toMatchObject({ changes: { added: 1, removed: 1, unchanged: 2 } });
    // 新引用接着上一次的编号；旧引用不再登记。
    expect(tab.starts).toEqual([1, 3, 3]);
    expect(engine.refFrame({ browserId: 'b', ref: '@e2' })).toEqual({
      ok: false,
      reason: 'missing_ref',
    });
    expect(engine.refFrame({ browserId: 'b', ref: '@e3' })).toBe('');

    // 页面换了文档：编号从头来，没有可比的快照。
    engine.clearBrowser('b');
    const fresh = await snap(engine, { browserId: 'b', page: tab, changes: true });
    expect(tab.starts.at(-1)).toBe(1);
    expect(fresh.snapshot).toMatch(/^# No earlier snapshot/);
  });

  it('uses refNext from the page script for the next numbers', async () => {
    const tab = page([['@e1', 'Save']], () => 9);
    const engine = new BrowserSnapshotEngine();
    await snap(engine, { browserId: 'b', page: tab });
    await snap(engine, { browserId: 'b', page: tab });
    expect(tab.starts).toEqual([1, 9]);
  });

  it('gives the full snapshot when the scope differs, too much changed, or offset is set', async () => {
    const buttons: Array<[string, string]> = Array.from({ length: 60 }, (_, index) => [
      `@e${index + 1}`,
      `Item ${index}`,
    ]);
    const tab = page(buttons);
    const engine = new BrowserSnapshotEngine();
    await snap(engine, { browserId: 'b', page: tab });

    const scoped = await snap(engine, {
      browserId: 'b',
      page: tab,
      viewportOnly: true,
      changes: true,
    });
    expect(scoped.snapshot).toMatch(/^# The last snapshot of this tab covered a different part/);

    buttons.splice(
      0,
      60,
      ...buttons.map(([ref, name]): [string, string] => [ref, `${name} renamed`]),
    );
    const many = await snap(engine, {
      browserId: 'b',
      page: tab,
      viewportOnly: true,
      changes: true,
    });
    expect(many.snapshot).toMatch(/^# Too much of the page changed/);
    expect(many.snapshot).toContain('Item 0 renamed');

    const paged = await snap(engine, {
      browserId: 'b',
      page: tab,
      viewportOnly: true,
      offset: 2,
      changes: true,
    });
    expect(paged.stats.startLine).toBe(2);
    expect(paged.stats.changes).toBeUndefined();
  });
});
