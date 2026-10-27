import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, tableColumnWidths } from './markdown';

describe('parseInline', () => {
  it('reads emphasis, code, strikethrough and links', () => {
    expect(parseInline('**Billing** is `80%` ~~up~~ *now*, see [docs](https://x.dev)')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'Billing' }] },
      { kind: 'text', text: ' is ' },
      { kind: 'code', text: '80%' },
      { kind: 'text', text: ' ' },
      { kind: 'del', children: [{ kind: 'text', text: 'up' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'now' }] },
      { kind: 'text', text: ', see ' },
      { kind: 'link', url: 'https://x.dev', children: [{ kind: 'text', text: 'docs' }] },
    ]);
  });

  it('leaves underscores in words, asterisks in maths and markers inside code alone', () => {
    expect(parseInline('snake_case_name and 2*3*4 in `a_b_c **x**`')).toEqual([
      { kind: 'text', text: 'snake_case_name and 2*3*4 in ' },
      { kind: 'code', text: 'a_b_c **x**' },
    ]);
  });

  it('links bare URLs without trailing punctuation', () => {
    expect(parseInline('Open http://localhost:4173.')).toEqual([
      { kind: 'text', text: 'Open ' },
      {
        kind: 'link',
        url: 'http://localhost:4173',
        children: [{ kind: 'text', text: 'http://localhost:4173' }],
      },
      { kind: 'text', text: '.' },
    ]);
  });

  it('nests emphasis', () => {
    expect(parseInline('**bold _and italic_**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'bold ' },
          { kind: 'em', children: [{ kind: 'text', text: 'and italic' }] },
        ],
      },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits headings, paragraphs, rules, quotes and code blocks', () => {
    const blocks = parseMarkdown(
      '## Status\nAll good\nstill good\n\n---\n> quoted\n\n```ts\nconst a = 1;\n```',
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'rule',
      'quote',
      'code',
    ]);
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      inline: [{ kind: 'text', text: 'All good\nstill good' }],
    });
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1;' });
  });

  it('reads a pipe table', () => {
    const [table] = parseMarkdown(
      '| service | p50 |\n|---|---:|\n| api | 47 ms |\n| billing | **125 ms** |',
    );
    expect(table).toEqual({
      kind: 'table',
      header: [[{ kind: 'text', text: 'service' }], [{ kind: 'text', text: 'p50' }]],
      align: ['left', 'right'],
      rows: [
        [[{ kind: 'text', text: 'api' }], [{ kind: 'text', text: '47 ms' }]],
        [
          [{ kind: 'text', text: 'billing' }],
          [{ kind: 'strong', children: [{ kind: 'text', text: '125 ms' }] }],
        ],
      ],
    });
  });

  it('pads short table rows, drops extra cells and keeps escaped pipes', () => {
    const [table] = parseMarkdown('a | b | c\n:-: | -- | --:\n1 | x \\| y\n2 | 3 | 4 | 5');
    expect(table).toEqual({
      kind: 'table',
      header: [
        [{ kind: 'text', text: 'a' }],
        [{ kind: 'text', text: 'b' }],
        [{ kind: 'text', text: 'c' }],
      ],
      align: ['center', 'left', 'right'],
      rows: [
        [[{ kind: 'text', text: '1' }], [{ kind: 'text', text: 'x | y' }], []],
        [
          [{ kind: 'text', text: '2' }],
          [{ kind: 'text', text: '3' }],
          [{ kind: 'text', text: '4' }],
        ],
      ],
    });
  });

  it('sizes table columns by their widest cell', () => {
    const [table] = parseMarkdown(
      '| id | note |\n|---|---|\n| 1 | **a much longer cell** |\n| 2 | 中文 |',
    );
    if (table?.kind !== 'table') throw new Error('expected a table');
    const metrics = { charWidth: 8, padding: 20, min: 40, max: 120 };
    // id: 两个字 → 36，夹到 40；note: 最长 18 个字 → 164，夹到 120。
    expect(tableColumnWidths(table, metrics)).toEqual([40, 120]);
    const [cjk] = parseMarkdown('| 名字 |\n|---|\n| 中文名字 |');
    if (cjk?.kind !== 'table') throw new Error('expected a table');
    // 全角字按两个字宽：4 × 2 × 8 + 20。
    expect(tableColumnWidths(cjk, { ...metrics, max: 200 })).toEqual([84]);
  });

  it('reads ordered, task and nested lists', () => {
    const [ordered, tasks] = parseMarkdown(
      '3. three\n4. four\n\n- [x] done\n- [ ] open\n  - child',
    );
    expect(ordered).toMatchObject({ kind: 'list', ordered: true, start: 3 });
    expect(ordered?.kind === 'list' && ordered.items.length).toBe(2);
    expect(tasks).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [
        { checked: true, inline: [{ kind: 'text', text: 'done' }], children: [] },
        {
          checked: false,
          inline: [{ kind: 'text', text: 'open' }],
          children: [{ kind: 'list', items: [{ inline: [{ kind: 'text', text: 'child' }] }] }],
        },
      ],
    });
  });

  it('keeps a list item with a wrapped line together', () => {
    const [list] = parseMarkdown('- first line\n  continues here\n- second');
    expect(list).toMatchObject({
      kind: 'list',
      items: [
        { inline: [{ kind: 'text', text: 'first line\ncontinues here' }] },
        { inline: [{ kind: 'text', text: 'second' }] },
      ],
    });
  });
});
