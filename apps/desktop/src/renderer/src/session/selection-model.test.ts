import { describe, expect, it } from 'vitest';
import {
  appendQuote,
  normalizeSelection,
  quotableText,
  quoteBlock,
  type Rect,
  type SelectionProbe,
  TOOLBAR_GAP,
  TOOLBAR_MARGIN,
  toolbarPlacement,
} from './selection-model';

const REGION_A = { id: 'a' };
const REGION_B = { id: 'b' };

function probe(overrides: Partial<SelectionProbe<object>> = {}): SelectionProbe<object> {
  return {
    text: '选中的文字',
    collapsed: false,
    start: REGION_A,
    end: REGION_A,
    blocked: false,
    ...overrides,
  };
}

describe('选区能不能引用', () => {
  it('两端在同一个区域里的选区可以引用', () => {
    expect(quotableText(probe())).toBe('选中的文字');
  });

  it('折叠的、只有空白的选区不行', () => {
    expect(quotableText(probe({ collapsed: true }))).toBeUndefined();
    expect(quotableText(probe({ text: ' \n\t   ' }))).toBeUndefined();
    expect(quotableText(probe({ text: '' }))).toBeUndefined();
  });

  it('跨了多个区域（多条消息、多段回答）的选区不行', () => {
    expect(quotableText(probe({ end: REGION_B }))).toBeUndefined();
    expect(quotableText(probe({ start: REGION_B }))).toBeUndefined();
  });

  it('有一端不在任何区域里（输入框、工具行、侧栏）的选区不行', () => {
    expect(quotableText(probe({ start: null }))).toBeUndefined();
    expect(quotableText(probe({ end: null }))).toBeUndefined();
    expect(quotableText(probe({ start: null, end: null }))).toBeUndefined();
  });

  it('落在不能引用的元素里（代码块的复制按钮）的选区不行', () => {
    expect(quotableText(probe({ blocked: true }))).toBeUndefined();
  });
});

describe('整理选中的文字', () => {
  it('统一换行、去掉行尾空白与首尾空行、压缩连续空行', () => {
    expect(normalizeSelection('\n\n第一行  \r\n第二行\t\r\n\r\n\r\n\r\n第三行\n\n')).toBe(
      '第一行\n第二行\n\n第三行',
    );
  });

  it('不换行空格换成空格，行内的文字与符号原样保留', () => {
    expect(normalizeSelection('a b *c* `d` # e')).toBe('a b *c* `d` # e');
  });

  it('缩进保留（代码）', () => {
    expect(normalizeSelection('if (x) {\n  run();\n}')).toBe('if (x) {\n  run();\n}');
  });
});

describe('引用块', () => {
  it('每行前面加 `> `，空行只留 `>`', () => {
    expect(quoteBlock('第一段\n\n第二段\n  缩进')).toBe('> 第一段\n>\n> 第二段\n>   缩进');
  });
});

describe('追加到输入框', () => {
  it('输入框空着：引用后面留一个空行，光标在末尾', () => {
    const next = appendQuote('', '选中的\n两行');
    expect(next).toEqual({ text: '> 选中的\n> 两行\n\n', cursor: 12 });
    expect(next?.cursor).toBe(next?.text.length);
  });

  it('只有空白的输入框当作空', () => {
    expect(appendQuote(' \n ', '文字')?.text).toBe('> 文字\n\n');
  });

  it('已有内容：隔一个空行追加在后面，原来的文字不动', () => {
    const next = appendQuote('先说一句', '引用的');
    expect(next?.text).toBe('先说一句\n\n> 引用的\n\n');
    expect(next?.cursor).toBe(next?.text.length);
  });

  it('已有内容以空行结尾时不叠空行', () => {
    expect(appendQuote('先说一句\n\n\n', '引用的')?.text).toBe('先说一句\n\n> 引用的\n\n');
  });

  it('连着引用两处：各是一个引用块', () => {
    const first = appendQuote('', '甲');
    const second = appendQuote(first?.text ?? '', '乙');
    expect(second?.text).toBe('> 甲\n\n> 乙\n\n');
  });

  it('选区整理后是空的：输入框不动', () => {
    expect(appendQuote('先说一句', ' \n ')).toBeUndefined();
  });

  it('引用里的 Markdown 记号照原样放进去，不夹带渲染产物', () => {
    expect(appendQuote('', '- 条目\n**粗**')?.text).toBe('> - 条目\n> **粗**\n\n');
  });
});

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

const SIZE = { width: 200, height: 32 };
const VIEWPORT = { width: 1000, height: 800 };
const BOUNDS = rect(0, 40, 1000, 700);

describe('工具条的位置', () => {
  it('默认在选区第一行的上方、水平居中', () => {
    const first = rect(300, 200, 500, 220);
    const last = rect(300, 260, 420, 280);
    expect(toolbarPlacement(first, last, SIZE, BOUNDS, VIEWPORT)).toEqual({
      left: 300,
      top: 200 - TOOLBAR_GAP - SIZE.height,
      side: 'above',
    });
  });

  it('水平方向夹在视口里', () => {
    const left = toolbarPlacement(
      rect(0, 200, 30, 220),
      rect(0, 200, 30, 220),
      SIZE,
      BOUNDS,
      VIEWPORT,
    );
    expect(left?.left).toBe(TOOLBAR_MARGIN);
    const right = toolbarPlacement(
      rect(960, 200, 1000, 220),
      rect(960, 200, 1000, 220),
      SIZE,
      BOUNDS,
      VIEWPORT,
    );
    expect(right?.left).toBe(VIEWPORT.width - SIZE.width - TOOLBAR_MARGIN);
  });

  it('上方放不下时翻到最后一行的下方', () => {
    const first = rect(300, 60, 500, 80);
    const last = rect(300, 120, 420, 140);
    expect(toolbarPlacement(first, last, SIZE, BOUNDS, VIEWPORT)).toEqual({
      left: 300,
      top: 140 + TOOLBAR_GAP,
      side: 'below',
    });
  });

  it('选区的第一行滚到了上面、最后一行还在可见区域里：翻到下方', () => {
    const first = rect(300, -400, 500, -380);
    const last = rect(300, 100, 420, 120);
    expect(toolbarPlacement(first, last, SIZE, BOUNDS, VIEWPORT)?.side).toBe('below');
  });

  it('上下都放不下（选区比可见区域还高）时贴着可见区域的顶部', () => {
    const first = rect(300, 50, 500, 70);
    const last = rect(300, 690, 420, 710);
    expect(toolbarPlacement(first, last, SIZE, BOUNDS, VIEWPORT)).toEqual({
      left: 300,
      top: BOUNDS.top + TOOLBAR_MARGIN,
      side: 'inside',
    });
  });

  it('选区完全滚出可见区域时没有位置', () => {
    expect(
      toolbarPlacement(rect(300, -90, 500, -70), rect(300, -50, 420, -30), SIZE, BOUNDS, VIEWPORT),
    ).toBeNull();
    expect(
      toolbarPlacement(rect(300, 720, 500, 740), rect(300, 760, 420, 780), SIZE, BOUNDS, VIEWPORT),
    ).toBeNull();
  });
});
