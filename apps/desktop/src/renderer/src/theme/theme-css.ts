// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/themeCss.ts
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：脱离文档剥离后安装；按已审查规则类型允许表拒绝未知规则；保留其它表与减弱动效偏好。

import { themeCssValueFetches } from '@wevir/protocol';

type RuleParent = Pick<CSSStyleSheet, 'cssRules' | 'deleteRule'>;

let themeSheet: CSSStyleSheet | undefined;
let appliedCss = '';
let appliedReducedMotion = false;

const motionProperty = /^(?:all|(?:-webkit-)?(?:animation|transition)(?:-.+)?|scroll-behavior)$/;
const isRuleParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  rule instanceof CSSStyleRule ||
  rule instanceof CSSMediaRule ||
  rule instanceof CSSSupportsRule ||
  rule instanceof CSSLayerBlockRule ||
  rule instanceof CSSContainerRule ||
  rule instanceof CSSScopeRule ||
  rule instanceof CSSStartingStyleRule ||
  rule instanceof CSSPageRule;

const hasReviewedDeclarations = (rule: CSSRule): boolean =>
  rule instanceof CSSStyleRule ||
  rule instanceof CSSNestedDeclarations ||
  rule instanceof CSSFontFaceRule ||
  rule instanceof CSSPageRule;

function stripDeclarations(rule: CSSRule, reducedMotion: boolean): boolean {
  if (!('style' in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (
      themeCssValueFetches(rule.style.getPropertyValue(property)) ||
      (reducedMotion && motionProperty.test(property))
    )
      rule.style.removeProperty(property);
  }
  return true;
}

/** 未知规则的头部也可能取文件（如 @function 默认参数），不能按容器或 style 形状推断安全。 */
function stripFetches(parent: RuleParent, reducedMotion: boolean): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = hasReviewedDeclarations(rule) && stripDeclarations(rule, reducedMotion);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame, reducedMotion);
    } else if (isRuleParent(rule)) {
      stripFetches(rule, reducedMotion);
    } else if (rule instanceof CSSPropertyRule) {
      if (themeCssValueFetches(rule.initialValue ?? '')) parent.deleteRule(index);
    } else if (
      !hasStyle &&
      !(rule instanceof CSSLayerStatementRule) &&
      // namespaceURI 不取文件，且存在样式规则时 CSSOM 不允许删除命名空间。
      !(rule instanceof CSSNamespaceRule)
    ) {
      parent.deleteRule(index);
    }
  }
}

export function applyThemeCss(css: string | undefined, reducedMotion: boolean): void {
  const next = css ?? '';
  if (next === appliedCss && reducedMotion === appliedReducedMotion) return;
  let sheet: CSSStyleSheet | undefined;
  if (next) {
    // replaceSync 不加载 @import；其它取文件声明在接触文档之前全部剥离，更新也不复用已安装的表。
    sheet = new CSSStyleSheet();
    sheet.replaceSync(next);
    stripFetches(sheet, reducedMotion);
  }
  const others = document.adoptedStyleSheets.filter((existing) => existing !== themeSheet);
  document.adoptedStyleSheets = sheet ? [...others, sheet] : others;
  themeSheet = sheet;
  appliedCss = next;
  appliedReducedMotion = reducedMotion;
}
