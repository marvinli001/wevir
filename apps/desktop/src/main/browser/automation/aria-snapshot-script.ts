// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/aria-snapshot-script.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 其中的 ARIA 快照模型改编自 microsoft/playwright 注入脚本的 ARIA snapshot，Copyright (c) Microsoft Corporation，Apache License 2.0。
// 由 Wevir 修改：标记与页面里的全局名改成 Wevir 的（`__WEVIR_ARIA_SNAPSHOT__`、`__WEVIR_BROWSER_AUTOMATION__`）；输入框带当前的
// `value`（密码只说填了没有，也不再拿密码当名字），下拉框的名字不再拼接所有选项、带选中项；没有可操作角色、但能点的元素（on* 事件属性、tabindex、
// 从它开始的 cursor:pointer）也给引用，标 `clickable`。0.46.0：不再在 1500 个节点处停下（上限 20000，文字总量超出预算后只略过
// 文字、元素照样走完，分段在 snapshot-engine.ts）；同源 iframe 的内容接在 iframe 下面（跨域的写明没包含）；判断元素用
// nodeType 与元素自己的文档、窗口（iframe 是另一个 realm）；文本框的值不再当名字（textarea 的换行保留在 value 里），输入框
// 标出非文本的 `type`，链接带 `url`。0.48.0：脚本带参数（`ariaSnapshotScript`）：节点上限 `maxNodes`（数的是写进快照的节点，
// 停下时报出停在哪个元素的 CSS 路径）、只取某个元素（`selector` 或快照里的引用）、只取视口里的元素、引用从 `refStart` 起编号；
// iframe 标出 `frame=` 编号（从顶层起每层是它在父窗口 `frames` 里的序号），读不到的跨域 iframe 留一个占位节点，由
// snapshot-engine.ts 在那个 frame 里再跑一遍接上；页面里的运行时多了 `register`（browser_query 给找到的元素引用）；
// `mode: 'install'` 只装运行时、不走页面。
// 禁用的元素标 `disabled`；`draggable="true"` 的元素与带 ondrop / ondragover 属性的放置区也给引用（标 `draggable`、`droppable`）；
// label 里的文字算名字时略过 textarea 与下拉框自己的内容（textarea 的初始文字不再混进名字，也不再列成它的子节点）。

export const ARIA_SNAPSHOT_SCRIPT_MARKER = '__WEVIR_ARIA_SNAPSHOT__';

/** 快照脚本的参数（0.48.0）。 */
export interface AriaSnapshotOptions {
  /** `install`：只在没有运行时的时候装上（browser_query 之前），不走页面。 */
  mode?: 'snapshot' | 'install';
  maxNodes?: number;
  maxRefs?: number;
  /** 第一个引用的编号（跨域 frame 接着主页面编）。 */
  refStart?: number;
  selector?: string;
  /** 从这个元素开始（上一次快照里的引用，按指纹核对）。 */
  rootRef?: { ref: string; fingerprint: unknown };
  viewportOnly?: boolean;
}

export function ariaSnapshotScript(options: AriaSnapshotOptions = {}): string {
  return `(${ARIA_SNAPSHOT_FUNCTION})(${JSON.stringify(options)})`;
}

// Adapted from Playwright's injected ARIA snapshot model.
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
const ARIA_SNAPSHOT_FUNCTION = String.raw`function (options) {
  const MARKER = ${JSON.stringify(ARIA_SNAPSHOT_SCRIPT_MARKER)};
  const MAX_NODES = Math.max(1, Number(options.maxNodes) || 20000);
  // 走过的节点（含没写进快照的）也有个上限，免得极大的页面卡住。
  const MAX_VISITS = 300000;
  const MAX_REFS = Math.max(0, options.maxRefs === undefined ? 500 : Number(options.maxRefs));
  const REF_START = Math.max(1, Number(options.refStart) || 1);
  const VIEWPORT_ONLY = options.viewportOnly === true;
  const MAX_TEXT_LENGTH = 400000;
  const MAX_NODE_TEXT = 300;
  const ACTIONABLE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem'
  ]);

  function normalizeText(value) {
    return String(value || '').replace(/[\u200b\u00ad]/g, '').replace(/[\r\n\s\t]+/g, ' ').trim();
  }

  // iframe 里的节点属于另一个 realm，instanceof 不成立：按 nodeType 判断，样式用元素自己的窗口。
  function isElement(node) {
    return Boolean(node) && node.nodeType === 1;
  }

  function viewOf(element) {
    return (element.ownerDocument && element.ownerDocument.defaultView) || window;
  }

  function styleOf(element) {
    return viewOf(element).getComputedStyle(element);
  }

  function visibilityFor(element) {
    if (!isElement(element)) return false;
    const style = styleOf(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? 'box' : 'boxless';
  }

  function explicitRole(element) {
    const role = element.getAttribute('role');
    if (!role || role === 'presentation' || role === 'none') return null;
    return role.split(/\s+/)[0].toLowerCase();
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (element.isContentEditable) return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'section') return element.getAttribute('aria-label') ? 'region' : null;
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    return null;
  }

  function roleFor(element) {
    return explicitRole(element) || implicitRole(element);
  }

  const POINTER_HANDLERS = ['onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'onmouseover', 'onmouseenter', 'oncontextmenu'];

  // 页面里看不到 addEventListener 加的监听，只能认事件属性、tabindex 与从这个元素开始的 cursor:pointer（子元素继承的不算）。
  function isClickable(element) {
    if (!isElement(element) || !('style' in element)) return false;
    if (POINTER_HANDLERS.some((name) => element.hasAttribute(name) || typeof element[name] === 'function')) return true;
    const tabIndex = element.getAttribute('tabindex');
    if (tabIndex !== null && Number(tabIndex) >= 0) return true;
    if (styleOf(element).cursor !== 'pointer') return false;
    const parent = element.parentElement;
    return !parent || styleOf(parent).cursor !== 'pointer';
  }

  const DROP_HANDLERS = ['ondrop', 'ondragover', 'ondragenter'];

  function isDraggable(element) {
    return isElement(element) && element.getAttribute('draggable') === 'true';
  }

  function isDroppable(element) {
    return isElement(element) && DROP_HANDLERS.some((name) => element.hasAttribute(name) || typeof element[name] === 'function');
  }

  // 没有可操作角色、但能点、能拖或能放的元素。
  function isInteractive(element) {
    return isClickable(element) || isDraggable(element) || isDroppable(element);
  }

  function snapshotRoleFor(element) {
    return roleFor(element) || (isInteractive(element) ? 'generic' : null);
  }

  // 元素里的文字，略过表单控件自己的内容（textarea 的初始文字、下拉框的选项）。
  function textWithoutControls(root) {
    let text = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.textContent;
        } else if (isElement(child)) {
          const tag = child.tagName.toLowerCase();
          if (tag === 'textarea' || tag === 'select' || tag === 'script' || tag === 'style') continue;
          walk(child);
        }
      }
    };
    walk(root);
    return normalizeText(text);
  }

  function labelText(element) {
    if (!isElement(element)) return '';
    if (element.id) {
      const escapedId = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape(element.id)
        : String(element.id).replace(/"/g, '\\"');
      const label = element.ownerDocument.querySelector('label[for="' + escapedId + '"]');
      if (label) return textWithoutControls(label);
    }
    const closestLabel = element.closest('label');
    return closestLabel ? textWithoutControls(closestLabel) : '';
  }

  function nameFor(element, role) {
    const tag = element.tagName.toLowerCase();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent || '').join(' ');
      const normalized = normalizeText(text);
      if (normalized) return normalized;
    }
    const pieces = [
      element.getAttribute('aria-label'),
      labelText(element),
      element.getAttribute('alt'),
      element.getAttribute('title'),
      tag === 'input' || tag === 'textarea' ? element.getAttribute('placeholder') : null,
      // 只有按钮类的输入框拿值当名字；文本框的值在 value 里，不当名字（否则 textarea 的内容成了它的名字）。
      tag === 'input' && ['button', 'submit', 'reset'].includes(String(element.getAttribute('type') || '').toLowerCase())
        ? element.value
        : null,
      tag !== 'select' && (role === 'button' || role === 'link' || role === 'heading' || ACTIONABLE_ROLES.has(role))
        ? element.textContent
        : null,
      role === 'generic' ? normalizeText(element.textContent).slice(0, 80) : null
    ];
    return normalizeText(pieces.find((piece) => normalizeText(piece).length > 0) || '');
  }

  function fingerprintNameFor(element, role, name) {
    const tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return name;
    const mutableValue = normalizeText(element.value);
    if (!mutableValue || name !== mutableValue) return name;
    return '';
  }

  function inheritedDisabled(element) {
    if (!isElement(element)) return false;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return true;
    if (element.closest('fieldset[disabled]')) return true;
    return element.closest('[aria-disabled="true"]') !== null;
  }

  function isActionable(element, role) {
    if (!role || (!ACTIONABLE_ROLES.has(role) && !isInteractive(element))) return false;
    if (visibilityFor(element) !== 'box') return false;
    if (inheritedDisabled(element)) return false;
    return true;
  }

  function fingerprintFor(element, role, name) {
    return {
      role,
      name: fingerprintNameFor(element, role, name),
      tagName: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || '',
      ariaLabel: element.getAttribute('aria-label') || ''
    };
  }

  function fingerprintMatches(element, fingerprint) {
    const role = snapshotRoleFor(element) || 'generic';
    const name = nameFor(element, role);
    const current = fingerprintFor(element, role, name);
    return current.role === fingerprint.role &&
      current.name === fingerprint.name &&
      current.tagName === fingerprint.tagName &&
      current.type === fingerprint.type &&
      current.ariaLabel === fingerprint.ariaLabel;
  }

  const RUNTIME_VERSION = 2;

  function ensureRuntime(reset) {
    const existing = window.__WEVIR_BROWSER_AUTOMATION__;
    if (!reset && existing && existing.version === RUNTIME_VERSION) return existing;
    const runtime = {
      version: RUNTIME_VERSION,
      refs: new Map(),
      resolve(ref, fingerprint) {
        const element = this.refs.get(ref);
        if (!element || !element.isConnected || !fingerprintMatches(element, fingerprint)) {
          return { ok: false, reason: 'stale_ref' };
        }
        return { ok: true, element };
      },
      // browser_query：给找到的元素一个引用，返回它的指纹。
      register(element, ref) {
        this.refs.set(ref, element);
        const role = snapshotRoleFor(element) || 'generic';
        return fingerprintFor(element, role, nameFor(element, role));
      }
    };
    Object.defineProperty(window, '__WEVIR_BROWSER_AUTOMATION__', {
      configurable: true,
      enumerable: false,
      value: runtime
    });
    return runtime;
  }

  function stateAttributes(element, role, name) {
    const attrs = [];
    if (role === 'heading') {
      const tag = element.tagName.toLowerCase();
      const level = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : Number(element.getAttribute('aria-level') || 0);
      if (level) attrs.push('level=' + level);
    }
    if (element.matches?.('input[type="checkbox"], input[type="radio"]')) {
      attrs.push('checked=' + (element.checked ? 'true' : 'false'));
    }
    if (element.getAttribute('aria-checked')) attrs.push('checked=' + element.getAttribute('aria-checked'));
    if (element.getAttribute('aria-expanded')) attrs.push('expanded=' + element.getAttribute('aria-expanded'));
    if (element.getAttribute('aria-pressed')) attrs.push('pressed=' + element.getAttribute('aria-pressed'));
    if (element.getAttribute('aria-selected')) attrs.push('selected=' + element.getAttribute('aria-selected'));
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit') attrs.push('type=' + type);
    }
    if (role === 'link' && element.getAttribute('href')) {
      const href = element.getAttribute('href');
      attrs.push('url=' + JSON.stringify(href.length > 120 ? href.slice(0, 120) + '…' : href));
    }
    if (tag === 'iframe' && element.getAttribute('src')) {
      const src = element.getAttribute('src');
      attrs.push('src=' + JSON.stringify(src.length > 120 ? src.slice(0, 120) + '…' : src));
    }
    const value = currentValue(element, name);
    if (value !== null) attrs.push(value);
    if (!ACTIONABLE_ROLES.has(role) && isClickable(element)) attrs.push('clickable');
    if (isDraggable(element)) attrs.push('draggable');
    if (isDroppable(element)) attrs.push('droppable');
    if ((ACTIONABLE_ROLES.has(role) || isInteractive(element)) && inheritedDisabled(element)) attrs.push('disabled');
    return attrs;
  }

  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);

  // 输入框、文本框与下拉框现在的值；和名字一样时不重复写。
  function currentValue(element, name) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'select') {
      const selected = Array.from(element.selectedOptions || []).map((option) => normalizeText(option.label || option.textContent));
      return 'value=' + JSON.stringify(selected.join(', '));
    }
    if (tag !== 'input' && tag !== 'textarea') return null;
    const type = tag === 'input' ? String(element.getAttribute('type') || '').toLowerCase() : '';
    if (type === 'password') return element.value ? 'filled=true' : null;
    if (tag === 'input' && !TEXT_INPUT_TYPES.has(type)) return null;
    const value = String(element.value || '');
    if (!value || normalizeText(value) === name) return null;
    return 'value=' + JSON.stringify(value.length > 200 ? value.slice(0, 200) + '…' : value);
  }

  function textNode(text) {
    return { kind: 'text', text };
  }

  // 一个窗口的 frame 编号：从顶层起每层是它在父窗口 frames 里的序号，用点连起来（顶层是空串）。跨域也能比较 WindowProxy。
  const framePaths = new Map();
  function framePathOf(win) {
    if (framePaths.has(win)) return framePaths.get(win);
    const parts = [];
    let current = win;
    try {
      while (current !== current.top) {
        const parent = current.parent;
        let index = -1;
        for (let i = 0; i < parent.frames.length; i += 1) {
          if (parent.frames[i] === current) {
            index = i;
            break;
          }
        }
        if (index < 0) return null;
        parts.unshift(index);
        current = parent;
      }
    } catch {
      return null;
    }
    const path = parts.join('.');
    framePaths.set(win, path);
    return path;
  }

  function frameIdOf(iframe) {
    const owner = viewOf(iframe);
    const ownerPath = framePathOf(owner);
    if (ownerPath === null) return null;
    let child = null;
    try {
      child = iframe.contentWindow;
    } catch {
      child = null;
    }
    if (!child) return null;
    for (let i = 0; i < owner.frames.length; i += 1) {
      if (owner.frames[i] === child) return ownerPath === '' ? String(i) : ownerPath + '.' + i;
    }
    return null;
  }

  // 停下时报出位置：最多 6 层的 CSS 路径，有 id 的到此为止。
  function cssPath(element) {
    const parts = [];
    let current = element;
    while (isElement(current) && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(tag + '#' + current.id);
        break;
      }
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (tag === 'body') break;
      current = parent;
    }
    const path = parts.join(' > ');
    const frame = framePathOf(viewOf(element));
    return frame ? path + ' (in frame ' + frame + ')' : path;
  }

  function inViewport(element) {
    const rect = element.getBoundingClientRect();
    const view = viewOf(element);
    return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth;
  }

  function elementNode(element, role, name) {
    return {
      kind: 'role',
      role: role || 'generic',
      name,
      tagName: element.tagName.toLowerCase(),
      attributes: stateAttributes(element, role, name),
      children: []
    };
  }

  if (options.mode === 'install') {
    ensureRuntime(false);
    return JSON.stringify({ marker: MARKER, installed: true });
  }

  // 从哪个元素开始：选择器，或上一次快照的引用（要在换掉运行时之前解析）。
  let rootElement = null;
  if (options.rootRef) {
    const previous = window.__WEVIR_BROWSER_AUTOMATION__;
    const resolved = previous && previous.resolve ? previous.resolve(options.rootRef.ref, options.rootRef.fingerprint) : null;
    if (!resolved || !resolved.ok) return JSON.stringify({ marker: MARKER, error: 'stale_ref' });
    rootElement = resolved.element;
  } else if (options.selector) {
    try {
      rootElement = document.querySelector(options.selector);
    } catch (error) {
      return JSON.stringify({ marker: MARKER, error: 'invalid_selector', message: String((error && error.message) || error) });
    }
    if (!rootElement) return JSON.stringify({ marker: MARKER, error: 'not_found' });
  }

  let nodeCount = 0;
  let visits = 0;
  let refCount = 0;
  let iframeCount = 0;
  let maxDepth = 0;
  let truncated = false;
  let refsTruncated = false;
  let stoppedAt = '';
  let textBudget = MAX_TEXT_LENGTH;
  const runtime = ensureRuntime(true);

  // 写进快照的节点数到了上限就停下，记下停在哪个元素。
  function countNode(depth, domNode) {
    if (nodeCount >= MAX_NODES) {
      if (!truncated) {
        truncated = true;
        const element = isElement(domNode) ? domNode : domNode.parentElement;
        stoppedAt = element ? cssPath(element) : '';
      }
      return false;
    }
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    return true;
  }

  function visitLimitReached(domNode) {
    visits += 1;
    if (visits <= MAX_VISITS) return false;
    if (!truncated) {
      truncated = true;
      const element = isElement(domNode) ? domNode : domNode.parentElement;
      stoppedAt = element ? cssPath(element) : '';
    }
    return true;
  }

  // 一段文字最多 MAX_NODE_TEXT 个字符；总量用完后之后的文字略过，元素照样走（引用不丢）。
  function cappedText(text) {
    const clipped = text.length > MAX_NODE_TEXT ? text.slice(0, MAX_NODE_TEXT) + '…' : text;
    if (clipped.length > textBudget) {
      textBudget = 0;
      return '';
    }
    textBudget -= clipped.length;
    return clipped;
  }

  // offscreen：上层元素不在视口里（viewportOnly），它直接的文字不要；元素自己再看（定位的子元素可能在视口里）。
  function visitNode(domNode, depth, offscreen) {
    if (visitLimitReached(domNode)) return null;
    if (domNode.nodeType === Node.TEXT_NODE) {
      if (offscreen) return null;
      const text = cappedText(normalizeText(domNode.textContent));
      if (!text) return null;
      if (!countNode(depth, domNode)) return null;
      return textNode(text);
    }
    if (!isElement(domNode)) return null;
    const visibility = visibilityFor(domNode);
    if (!visibility) return null;
    if (domNode.getAttribute('aria-hidden') === 'true') return null;

    const outside = VIEWPORT_ONLY && visibility === 'box' && !inViewport(domNode);
    const role = outside ? null : snapshotRoleFor(domNode);
    const name = role ? nameFor(domNode, role) : '';
    // 先占一个节点（元素自己），再走子节点：停下的位置是元素在文档里的顺序。
    if (role && visibility === 'box' && !countNode(depth, domNode)) return null;
    const children = [];
    const isFrame = domNode.tagName.toLowerCase() === 'iframe' || domNode.tagName.toLowerCase() === 'frame';
    // textarea 的子节点是它的初始文字，现在的内容已经在 value 里。
    if (!isFrame && domNode.tagName.toLowerCase() !== 'textarea') {
      for (const child of Array.from(domNode.childNodes)) {
        const childSnapshot = visitNode(child, depth + 1, outside || (offscreen && visibility !== 'box'));
        if (childSnapshot) children.push(childSnapshot);
        if (truncated) break;
      }
    }

    let frameId = null;
    if (isFrame && !outside) {
      iframeCount += 1;
      frameId = frameIdOf(domNode);
      // 同源的 iframe 能读到它的文档：内容接在 iframe 下面，里面的元素照样有引用。跨域的留一个占位节点，由主进程在那个 frame 里
      // 再跑一遍接上。
      let frameDocument = null;
      try {
        frameDocument = domNode.contentDocument;
      } catch {
        frameDocument = null;
      }
      const frameRoot = frameDocument && (frameDocument.body || frameDocument.documentElement);
      if (frameRoot) {
        for (const child of Array.from(frameRoot.childNodes)) {
          const childSnapshot = visitNode(child, depth + 1, false);
          if (childSnapshot) children.push(childSnapshot);
          if (truncated) break;
        }
      } else if (frameId !== null) {
        children.push({ kind: 'frame', frame: frameId });
      } else if (domNode.getAttribute('src')) {
        children.push(textNode('(content from another site; not included in the snapshot)'));
      }
    }

    if (visibility === 'boxless' || outside) {
      return children.length > 0 ? { kind: 'group', children } : null;
    }
    if (!role && children.length === 0) return null;
    const snapshotNode = role ? elementNode(domNode, role, name) : { kind: 'group', children: [] };
    if (role && frameId !== null) snapshotNode.attributes.push('frame=' + frameId);
    snapshotNode.children = children;
    if (role && isActionable(domNode, role) && refCount < MAX_REFS) {
      const ref = '@e' + (REF_START + refCount);
      const fingerprint = fingerprintFor(domNode, role, name);
      refCount += 1;
      runtime.refs.set(ref, domNode);
      snapshotNode.ref = ref;
      snapshotNode.fingerprint = fingerprint;
    } else if (role && isActionable(domNode, role)) {
      refsTruncated = true;
    }
    return snapshotNode;
  }

  const root = {
    kind: 'role',
    role: 'document',
    name: normalizeText(document.title),
    tagName: 'document',
    attributes: [],
    children: []
  };
  const topNodes = rootElement
    ? [rootElement]
    : Array.from(document.body ? document.body.childNodes : document.documentElement.childNodes);
  for (const child of topNodes) {
    const childSnapshot = visitNode(child, 1, false);
    if (childSnapshot) root.children.push(childSnapshot);
    if (truncated) break;
  }

  return JSON.stringify({
    marker: MARKER,
    root,
    refs: Array.from(runtime.refs.entries()).map(([ref, element]) => {
      const role = snapshotRoleFor(element) || 'generic';
      const name = nameFor(element, role);
      return { ref, fingerprint: fingerprintFor(element, role, name) };
    }),
    truncated,
    refsTruncated,
    stoppedAt,
    framePath: framePathOf(window),
    stats: { nodeCount, refCount, textLength: 0, iframeCount, maxDepth }
  });
}`;

/** 默认参数的快照脚本（0.46.0 的形状）。 */
export const ARIA_SNAPSHOT_SCRIPT = ariaSnapshotScript();
