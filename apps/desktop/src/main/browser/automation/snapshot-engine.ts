// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/snapshot-engine.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 `__WEVIR_BROWSER_AUTOMATION__`；子节点只有与名字相同的文字时不再重复列出。
// 0.46.0：快照按字节预算分段（`offset` 接着读），每段末尾列出后面还有哪些带引用的元素（引用在整个快照里有效）；文件输入框
// 与填不进去的元素给出原因，不再是笼统的脚本错误；填值的事件用元素所在文档（iframe）的构造函数。

import { BROWSER_SNAPSHOT_PAGE_BYTES } from '@wevir/protocol';
import { ARIA_SNAPSHOT_SCRIPT, ARIA_SNAPSHOT_SCRIPT_MARKER } from './aria-snapshot-script.js';

export interface SnapshotPage {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface BrowserAriaSnapshot {
  format: 'aria-yaml';
  snapshot: string;
  truncated: boolean;
  stats: BrowserAriaSnapshotStats;
}

export interface BrowserAriaSnapshotStats {
  nodeCount: number;
  refCount: number;
  textLength: number;
  iframeCount?: number;
  maxDepth?: number;
  totalLines?: number;
  startLine?: number;
  shownLines?: number;
}

interface SnapshotNode {
  kind: 'role' | 'text' | 'group';
  role?: string;
  name?: string;
  text?: string;
  tagName?: string;
  attributes?: string[];
  ref?: string;
  fingerprint?: BrowserRefFingerprint;
  children?: SnapshotNode[];
}

interface BrowserRefFingerprint {
  role: string;
  name: string;
  tagName: string;
  type: string;
  ariaLabel: string;
}

interface RawAriaSnapshot {
  marker: string;
  root: SnapshotNode;
  refs: BrowserRefMetadata[];
  truncated: boolean;
  stats: BrowserAriaSnapshotStats;
}

interface BrowserRefMetadata {
  ref: string;
  fingerprint: BrowserRefFingerprint;
}

interface BrowserRefState {
  refs: Map<string, BrowserRefMetadata>;
}

export type BrowserRefActionResult =
  | { ok: true }
  | { ok: false; reason: 'stale_ref' | 'missing_ref' }
  | { ok: false; reason: 'file_input' | 'not_fillable'; detail?: string };
type BrowserRefFailure = { ok: false; reason: 'stale_ref' | 'missing_ref' };

type BrowserRefResolveResult = { ok: true; metadata: BrowserRefMetadata } | BrowserRefFailure;

/** 一段里正文最多占预算的多少，余下留给“后面还有哪些引用”。 */
const PAGE_BODY_SHARE = 0.75;
/** 一行最长多少字节（超长的文字截断）。 */
const MAX_LINE_BYTES = 600;

export class BrowserSnapshotEngine {
  private readonly statesByBrowserId = new Map<string, BrowserRefState>();

  async snapshot(input: {
    browserId: string;
    page: SnapshotPage;
    /** 从第几行开始（从 0 起）。 */
    offset?: number;
    /** 一段的字节预算，默认 `BROWSER_SNAPSHOT_PAGE_BYTES`。 */
    pageBytes?: number;
  }): Promise<BrowserAriaSnapshot> {
    const rawSnapshot = parseAriaSnapshot(await input.page.executeJavaScript(ARIA_SNAPSHOT_SCRIPT));
    const lines = renderSnapshot(rawSnapshot.root);
    const part = pageOfSnapshot(
      lines,
      input.offset ?? 0,
      input.pageBytes ?? BROWSER_SNAPSHOT_PAGE_BYTES,
      rawSnapshot.truncated,
    );
    this.statesByBrowserId.set(input.browserId, {
      refs: new Map(rawSnapshot.refs.map((ref) => [ref.ref, ref])),
    });
    return {
      format: 'aria-yaml',
      snapshot: part.snapshot,
      truncated: part.truncated,
      stats: {
        ...rawSnapshot.stats,
        refCount: rawSnapshot.refs.length,
        textLength: part.snapshot.length,
        totalLines: lines.length,
        startLine: part.startLine,
        shownLines: part.shownLines,
      },
    };
  }

  async fill(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildFillScript(ref, input.value));
  }

  async select(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildSelectScript(ref, input.value));
  }

  clearBrowser(browserId: string): void {
    this.statesByBrowserId.delete(browserId);
  }

  runtimeElementExpression(input: { browserId: string; ref: string }): string | BrowserRefFailure {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    return buildRuntimeElementExpression(resolved.metadata);
  }

  private async runRefScript(
    input: { browserId: string; page: SnapshotPage; ref: string },
    buildScript: (ref: BrowserRefMetadata) => string,
  ): Promise<BrowserRefActionResult> {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await input.page.executeJavaScript(buildScript(resolved.metadata));
    return readActionResult(result, true);
  }

  private resolveRef(input: { browserId: string; ref: string }): BrowserRefResolveResult {
    const state = this.statesByBrowserId.get(input.browserId);
    if (!state) {
      return { ok: false, reason: 'stale_ref' };
    }
    const metadata = state.refs.get(input.ref);
    if (!metadata) {
      return { ok: false, reason: 'missing_ref' };
    }
    return { ok: true, metadata };
  }
}

function readActionResult(value: unknown, staleWhenFalse: boolean): BrowserRefActionResult {
  if (value === false && staleWhenFalse) {
    return { ok: false, reason: 'stale_ref' };
  }
  if (isActionFailure(value)) {
    return { ok: false, reason: value.reason };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.reason === 'file_input' || record.reason === 'not_fillable') {
      return {
        ok: false,
        reason: record.reason,
        ...(typeof record.detail === 'string' && { detail: record.detail }),
      };
    }
  }
  return { ok: true };
}

function isActionFailure(value: unknown): value is BrowserRefFailure {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const reason = (value as Record<string, unknown>).reason;
  return reason === 'stale_ref' || reason === 'missing_ref';
}

function parseAriaSnapshot(value: unknown): RawAriaSnapshot {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') {
    return emptySnapshot();
  }
  const record = parsed as Record<string, unknown>;
  if (record.marker !== ARIA_SNAPSHOT_SCRIPT_MARKER) {
    return emptySnapshot();
  }
  const root = parseSnapshotNode(record.root);
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: root ?? emptySnapshot().root,
    refs: parseRefs(record.refs),
    truncated: record.truncated === true,
    stats: parseStats(record.stats),
  };
}

function emptySnapshot(): RawAriaSnapshot {
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: { kind: 'role', role: 'document', name: '', tagName: 'document', children: [] },
    refs: [],
    truncated: false,
    stats: { nodeCount: 0, refCount: 0, textLength: 0, iframeCount: 0, maxDepth: 0 },
  };
}

function parseSnapshotNode(value: unknown): SnapshotNode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'role' && kind !== 'text' && kind !== 'group') {
    return null;
  }
  return {
    kind,
    ...(readString(record.role) ? { role: readString(record.role) ?? undefined } : {}),
    ...(readString(record.name) ? { name: readString(record.name) ?? undefined } : {}),
    ...(readString(record.text) ? { text: readString(record.text) ?? undefined } : {}),
    ...(readString(record.tagName) ? { tagName: readString(record.tagName) ?? undefined } : {}),
    ...(readString(record.ref) ? { ref: readString(record.ref) ?? undefined } : {}),
    ...(parseFingerprint(record.fingerprint)
      ? { fingerprint: parseFingerprint(record.fingerprint) ?? undefined }
      : {}),
    attributes: readStringArray(record.attributes),
    children: Array.isArray(record.children)
      ? record.children.flatMap((child): SnapshotNode[] => {
          const parsed = parseSnapshotNode(child);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function parseRefs(value: unknown): BrowserRefMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): BrowserRefMetadata[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const ref = readString(record.ref);
    const fingerprint = parseFingerprint(record.fingerprint);
    return ref && fingerprint ? [{ ref, fingerprint }] : [];
  });
}

function parseFingerprint(value: unknown): BrowserRefFingerprint | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const role = readString(record.role);
  const name = readString(record.name);
  const tagName = readString(record.tagName);
  const type = readString(record.type);
  const ariaLabel = readString(record.ariaLabel);
  if (role === null || name === null || tagName === null || type === null || ariaLabel === null) {
    return null;
  }
  return { role, name, tagName, type, ariaLabel };
}

function parseStats(value: unknown): BrowserAriaSnapshotStats {
  if (!value || typeof value !== 'object') {
    return { nodeCount: 0, refCount: 0, textLength: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    nodeCount: readNumber(record.nodeCount) ?? 0,
    refCount: readNumber(record.refCount) ?? 0,
    textLength: readNumber(record.textLength) ?? 0,
    ...(readNumber(record.iframeCount) !== null
      ? { iframeCount: readNumber(record.iframeCount) ?? undefined }
      : {}),
    ...(readNumber(record.maxDepth) !== null
      ? { maxDepth: readNumber(record.maxDepth) ?? undefined }
      : {}),
  };
}

/** 快照的一行；`ref` 是这一行元素的引用。 */
interface SnapshotLine {
  text: string;
  ref?: string;
}

function renderSnapshot(root: SnapshotNode): SnapshotLine[] {
  const lines = renderNode(root, 0);
  return lines.length > 0 ? lines : [{ text: '- document' }];
}

function renderNode(node: SnapshotNode, depth: number): SnapshotLine[] {
  if (node.kind === 'group') {
    return (node.children ?? []).flatMap((child) => renderNode(child, depth));
  }
  const indent = '  '.repeat(depth);
  if (node.kind === 'text') {
    return [{ text: `${indent}- text: ${JSON.stringify(node.text ?? '')}` }];
  }
  const attrs = [...(node.attributes ?? [])];
  if (node.ref) {
    attrs.push(`ref=${node.ref}`);
  }
  const suffix = attrs.length > 0 ? ` [${attrs.join(' ')}]` : '';
  const ownLine: SnapshotLine = {
    text: `${indent}- ${node.role ?? 'generic'}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${suffix}`,
    ...(node.ref && { ref: node.ref }),
  };
  if (repeatsName(node)) return [ownLine];
  const childLines = (node.children ?? []).flatMap((child) => renderNode(child, depth + 1));
  return [ownLine, ...childLines];
}

/** 子节点（摊开分组后）全是文字、连起来就是名字：Playwright 的 ARIA 快照也省掉这种子节点。 */
function repeatsName(node: SnapshotNode): boolean {
  if (!node.name) return false;
  const texts: string[] = [];
  const collect = (children: SnapshotNode[]): boolean =>
    children.every((child) => {
      if (child.kind === 'group') return collect(child.children ?? []);
      if (child.kind !== 'text') return false;
      texts.push(child.text ?? '');
      return true;
    });
  if (!collect(node.children ?? []) || texts.length === 0) return false;
  return texts.join(' ').replace(/\s+/g, ' ').trim() === node.name;
}

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text).length;

/** 超长的一行截断到 `MAX_LINE_BYTES` 左右（按字符截，留出引号）。 */
function clampLine(text: string): string {
  if (bytesOf(text) <= MAX_LINE_BYTES) return text;
  let cut = text.slice(0, MAX_LINE_BYTES);
  while (bytesOf(cut) > MAX_LINE_BYTES - 4) cut = cut.slice(0, -16);
  return `${cut}…`;
}

/**
 * 从 `offset` 行起取一段，正文不超过预算的 `PAGE_BODY_SHARE`；后面没给出的行里带引用的元素（去掉缩进）列在末尾，直到用完
 * 预算。说明行用 YAML 注释（`#`）。
 */
export function pageOfSnapshot(
  lines: SnapshotLine[],
  offset: number,
  pageBytes: number,
  pageTruncated: boolean,
): { snapshot: string; truncated: boolean; startLine: number; shownLines: number } {
  const total = lines.length;
  const start = Math.min(Math.max(0, offset), total);
  if (start >= total && total > 0) {
    return {
      snapshot: `# The snapshot has ${total} lines; offset ${offset} is past the end. Call browser_snapshot without offset.`,
      truncated: true,
      startLine: start,
      shownLines: 0,
    };
  }
  const bodyBudget = Math.floor(pageBytes * PAGE_BODY_SHARE);
  const body: string[] = [];
  let used = 0;
  let end = start;
  while (end < total) {
    const text = clampLine((lines[end] as SnapshotLine).text);
    const cost = bytesOf(text) + 1;
    // 至少给一行，免得一行比预算还长时原地打转。
    if (body.length > 0 && used + cost > bodyBudget) break;
    body.push(text);
    used += cost;
    end += 1;
  }
  const notes: string[] = [];
  if (start > 0) {
    notes.push(
      `# Lines 1–${start} were in earlier parts; their refs stay valid until the page changes.`,
    );
  }
  if (end < total) {
    notes.push(
      `# Showing lines ${start + 1}–${end} of ${total}. Next part: browser_snapshot with offset=${end}.`,
    );
    const later = lines.slice(end).filter((line) => line.ref !== undefined);
    if (later.length > 0) {
      notes.push('# Elements with refs further down (usable now):');
      let budget = pageBytes - used - notes.reduce((sum, note) => sum + bytesOf(note) + 1, 0) - 80;
      let listed = 0;
      for (const line of later) {
        const text = clampLine(line.text.trimStart());
        const cost = bytesOf(text) + 1;
        if (cost > budget) break;
        notes.push(text);
        budget -= cost;
        listed += 1;
      }
      if (listed < later.length) {
        notes.push(`# …and ${later.length - listed} more; read them with offset=${end}.`);
      }
    }
  }
  if (pageTruncated) {
    notes.push('# The page is very large: the snapshot stops after its first 20000 nodes.');
  }
  return {
    snapshot: [...body, ...notes].join('\n'),
    truncated: start > 0 || end < total || pageTruncated,
    startLine: start,
    shownLines: end - start,
  };
}

function buildFillScript(metadata: BrowserRefMetadata, value: string): string {
  return `(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    const view = element.ownerDocument?.defaultView || window;
    if (element.tagName.toLowerCase() === 'input' && String(element.getAttribute('type') || '').toLowerCase() === 'file') {
      return { ok: false, reason: 'file_input' };
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      try {
        element.value = nextValue;
      } catch (error) {
        return { ok: false, reason: 'not_fillable', detail: String(error && error.message || error) };
      }
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
      return { ok: true };
    }
    if (!element.isContentEditable) {
      return { ok: false, reason: 'not_fillable', detail: 'it is not an input, textarea or editable element' };
    }
    element.textContent = nextValue;
    element.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    return { ok: true };
  })()`;
}

function buildSelectScript(metadata: BrowserRefMetadata, value: string): string {
  return `(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    const view = element.ownerDocument?.defaultView || window;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      element.value = nextValue;
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
      return { ok: true };
    }
    return false;
  })()`;
}

function buildRuntimeElementExpression(metadata: BrowserRefMetadata): string {
  return `(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return null;
    return resolved.element;
  })()`;
}

function buildResolveExpression(metadata: BrowserRefMetadata): string {
  return `window.__WEVIR_BROWSER_AUTOMATION__?.resolve(${JSON.stringify(metadata.ref)}, ${JSON.stringify(metadata.fingerprint)}) ?? { ok: false, reason: 'stale_ref' }`;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
