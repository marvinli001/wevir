// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/web/src/themeCss.browser.test.ts 与 apps/web/src/themeCss.ts
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Node 下测试规则遍历、安装时序和媒体偏好；浏览器解析及实际请求另以生产 Electron CDP 验收。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Declarations {
  readonly values: Map<string, string>;
  constructor(values: Record<string, string>) {
    this.values = new Map(Object.entries(values));
  }
  get length() {
    return this.values.size;
  }
  item(index: number) {
    return [...this.values.keys()][index] as string;
  }
  getPropertyValue(property: string) {
    return this.values.get(property) ?? '';
  }
  removeProperty(property: string) {
    this.values.delete(property);
  }
}
class Group {
  constructor(public cssRules: object[] = []) {}
  deleteRule(index: number) {
    this.cssRules.splice(index, 1);
  }
}
class StyleRule extends Group {
  readonly style: Declarations;
  constructor(values: Record<string, string>) {
    super();
    this.style = new Declarations(values);
  }
}
class Media extends Group {}
class Supports extends Group {}
class Layer extends Group {}
class Container extends Group {}
class Scope extends Group {}
class StartingStyle extends Group {}
class Page extends StyleRule {}
class NestedDeclarations extends StyleRule {}
class FontFace extends StyleRule {}
class Keyframes extends Group {
  override deleteRule() {
    throw new Error('Keyframe deletion requires a selector');
  }
}
class Property {
  constructor(public initialValue: string) {}
}
class LayerStatement {}
class Namespace {}

const styleRule = (values: Record<string, string>) => new StyleRule(values);
let parsed: object[];
let sheets: Sheet[];
let installed: (sheet: Sheet) => void;
let failParsing: boolean;
class Sheet extends Group {
  replaceSync() {
    if (failParsing) throw new Error('CSS parser unavailable');
    this.cssRules = parsed;
  }
}

beforeEach(() => {
  vi.resetModules();
  parsed = [];
  sheets = [];
  failParsing = false;
  installed = () => {};
  vi.stubGlobal('CSSStyleSheet', Sheet);
  vi.stubGlobal('CSSStyleDeclaration', Declarations);
  vi.stubGlobal('CSSStyleRule', StyleRule);
  vi.stubGlobal('CSSMediaRule', Media);
  vi.stubGlobal('CSSSupportsRule', Supports);
  vi.stubGlobal('CSSLayerBlockRule', Layer);
  vi.stubGlobal('CSSContainerRule', Container);
  vi.stubGlobal('CSSScopeRule', Scope);
  vi.stubGlobal('CSSStartingStyleRule', StartingStyle);
  vi.stubGlobal('CSSPageRule', Page);
  vi.stubGlobal('CSSNestedDeclarations', NestedDeclarations);
  vi.stubGlobal('CSSFontFaceRule', FontFace);
  vi.stubGlobal('CSSKeyframesRule', Keyframes);
  vi.stubGlobal('CSSPropertyRule', Property);
  vi.stubGlobal('CSSLayerStatementRule', LayerStatement);
  vi.stubGlobal('CSSNamespaceRule', Namespace);
  vi.stubGlobal('document', {
    get adoptedStyleSheets() {
      return sheets;
    },
    set adoptedStyleSheets(next: Sheet[]) {
      for (const sheet of next) if (!sheets.includes(sheet)) installed(sheet);
      sheets = next;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('theme CSSOM guard', () => {
  it('strips declarations in nested groups, nested styles and keyframes before adoption', async () => {
    const safe = styleRule({ color: 'rgb(1, 2, 3)', content: '"url(https://example.com)"' });
    const nested = styleRule({ 'background-image': 'url("https://example.com/b")' });
    nested.cssRules = [new Media([styleRule({ cursor: 'url(https://example.com/c), auto' })])];
    const frame = styleRule({ 'background-image': 'url("https://example.com/g")', opacity: '.5' });
    const keyframes = new Keyframes([frame]);
    const variable = styleRule({ '--leak': 'u\\72l(https://example.com/a)' });
    const local = new Property('url("#blur")');
    const namespace = new Namespace();
    const layer = new LayerStatement();
    parsed = [
      safe,
      nested,
      keyframes,
      variable,
      new Property('url(https://example.com/d)'),
      local,
      namespace,
      layer,
      {},
    ];
    installed = (sheet) => {
      expect(sheet.cssRules).toEqual([safe, nested, keyframes, variable, local, namespace, layer]);
      expect(nested.style.length).toBe(0);
      expect((nested.cssRules[0] as Group).cssRules).toEqual([styleRule({})]);
      expect(frame.style.values).toEqual(new Map([['opacity', '.5']]));
      expect(variable.style.length).toBe(0);
    };
    const { applyThemeCss } = await import('./theme-css');
    applyThemeCss('malicious input', false);
    expect(sheets).toHaveLength(1);
    expect(safe.style.getPropertyValue('color')).toBe('rgb(1, 2, 3)');
  });

  it('replaces and removes only its own sheet, without installing failed parses', async () => {
    const existing = new Sheet();
    sheets = [existing];
    const { applyThemeCss } = await import('./theme-css');
    applyThemeCss('first', false);
    const first = sheets[1];
    applyThemeCss('first', false);
    expect(sheets).toEqual([existing, first]);
    failParsing = true;
    expect(() => applyThemeCss('broken', false)).toThrow('CSS parser unavailable');
    expect(sheets).toEqual([existing, first]);
    failParsing = false;
    applyThemeCss('second', false);
    expect(sheets[0]).toBe(existing);
    expect(sheets[1]).not.toBe(first);
    applyThemeCss(undefined, false);
    expect(sheets).toEqual([existing]);
  });

  it('rebuilds for reduced motion, dropping motion and all resets while retaining colors', async () => {
    const values = {
      color: 'red',
      animation: 'pulse 5s infinite',
      '-webkit-animation-delay': '5s',
      'transition-duration': '6s',
      'scroll-behavior': 'smooth',
      all: 'revert-layer',
    };
    parsed = [new Media([styleRule(values)])];
    const { applyThemeCss } = await import('./theme-css');
    applyThemeCss('motion input', false);
    parsed = [new Media([styleRule(values)])];
    applyThemeCss('motion input', true);
    const group = sheets[0]?.cssRules[0] as Group;
    expect(group.cssRules).toEqual([styleRule({ color: 'red' })]);
  });

  it('rejects unreviewed containers and declaration rules even when their bodies look safe', async () => {
    const functionRule = Object.assign(new Group([styleRule({ result: 'var(--img)' })]), {
      prelude: '--remote-image(--img <image>: url(https://example.com/default.png))',
    });
    const futureRule = { style: new Declarations({ color: 'red' }) };
    const knownGroups = [Media, Supports, Layer, Container, Scope, StartingStyle];
    const kept = knownGroups.map((Rule) => new Rule([styleRule({ color: 'red' })]));
    const nestedFunction = new Media([functionRule, styleRule({ opacity: '.5' })]);
    parsed = [functionRule, futureRule, ...kept, nestedFunction];
    const { applyThemeCss } = await import('./theme-css');
    applyThemeCss('unreviewed rule headers', false);
    expect(sheets[0]?.cssRules).toEqual([...kept, nestedFunction]);
    expect(nestedFunction.cssRules).toEqual([styleRule({ opacity: '.5' })]);
  });
});
