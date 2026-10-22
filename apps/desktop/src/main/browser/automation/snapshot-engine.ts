// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/snapshot-engine.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：页面里的全局名改成 `__WEVIR_BROWSER_AUTOMATION__`；子节点只有与名字相同的文字时不再重复列出。
// 0.46.0：快照按字节预算分段（`offset` 接着读），每段末尾列出后面还有哪些带引用的元素（引用在整个快照里有效）；文件输入框
// 与填不进去的元素给出原因，不再是笼统的脚本错误；填值的事件用元素所在文档（iframe）的构造函数。
// 0.48.0：快照能只取一个元素（选择器或引用）、一个 frame、视口里的部分，节点上限可调，停下时说明停在哪、怎么缩小范围；跨域
// iframe 的占位节点在那个 frame 里再跑一遍脚本接上，引用全局编号、记下所在的 frame；browser_query 找到的元素也给引用（接着
// 现有的编号）。
// 选择下拉框时核对选项：没有这个值（也没有这段文字）的选项就报错、不动它，不再把选择清空。

import {
  BROWSER_SNAPSHOT_DEFAULT_NODES,
  BROWSER_SNAPSHOT_MAX_NODES,
  BROWSER_SNAPSHOT_PAGE_BYTES,
} from '@wevir/protocol';
import { ARIA_SNAPSHOT_SCRIPT_MARKER, ariaSnapshotScript } from './aria-snapshot-script.js';
import type { TabFrame } from './frames.js';

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
  stoppedAt?: string;
  maxNodes?: number;
}

interface SnapshotNode {
  kind: 'role' | 'text' | 'group' | 'frame';
  /** `frame`：还没接上的跨域 frame 的编号。 */
  frame?: string;
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
  refsTruncated: boolean;
  stoppedAt: string;
  stats: BrowserAriaSnapshotStats;
  error?: string;
  message?: string;
}

interface BrowserRefMetadata {
  ref: string;
  fingerprint: BrowserRefFingerprint;
  /** 元素所在的 frame 的编号（0.48.0）；顶层页面（含接在里面的同源 iframe）是空串。 */
  frame?: string;
}

interface BrowserRefState {
  refs: Map<string, BrowserRefMetadata>;
  /** 下一个引用的编号。 */
  nextRef: number;
}

/** 快照的参数（0.48.0）。 */
export interface SnapshotScope {
  selector?: string;
  /** 从这个引用的元素开始。 */
  ref?: string;
  /** 只取这个 frame（service 已经按 agent 的说法找到）。 */
  frame?: { id: string; page: SnapshotPage };
  viewportOnly?: boolean;
  maxNodes?: number;
}

/** 快照做不了：引用用不了、选择器不对或没找到、引用所在的 frame 没了。 */
export type SnapshotFailure =
  | { ok: false; reason: 'stale_ref' | 'missing_ref' }
  | { ok: false; reason: 'invalid_selector'; message: string }
  | { ok: false; reason: 'not_found' };

/** browser_query 找到的元素（`box` 是元素所在 frame 里的坐标）。 */
export interface QueriedElement {
  ref: string;
  tag: string;
  id?: string;
  classes?: string;
  text: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
}

/** 一次快照里所有 frame 合计的引用上限。 */
const MAX_REFS = 500;
/** 在一个跨域 frame 里跑快照脚本最多等多久（frame 卡住时不拖住整个快照）。 */
const FRAME_SCRIPT_TIMEOUT_MS = 3_000;
const FRAME_UNREADABLE = '(content from another site could not be read)';
/** 节点数到了上限、没轮到读的跨域 frame：不是读不了，让它自己取一次快照。 */
const frameSkipped = (frameId: string) =>
  `(content from another site left out: the snapshot reached its node limit; snapshot it with frame=${frameId})`;

export type BrowserRefActionResult =
  | { ok: true }
  | { ok: false; reason: 'stale_ref' | 'missing_ref' }
  | { ok: false; reason: 'file_input' | 'not_fillable' | 'no_option'; detail?: string };
type BrowserRefFailure = { ok: false; reason: 'stale_ref' | 'missing_ref' };

type BrowserRefResolveResult = { ok: true; metadata: BrowserRefMetadata } | BrowserRefFailure;

/** 一段里正文最多占预算的多少，余下留给“后面还有哪些引用”。 */
const PAGE_BODY_SHARE = 0.75;
/** 一行最长多少字节（超长的文字截断）。 */
const MAX_LINE_BYTES = 600;

export type SnapshotInput = {
  browserId: string;
  page: SnapshotPage;
  /** 从第几行开始（从 0 起）。 */
  offset?: number;
  /** 一段的字节预算，默认 `BROWSER_SNAPSHOT_PAGE_BYTES`。 */
  pageBytes?: number;
  /** 列出子 frame：接跨域 frame、按引用找它所在的 frame 时用。 */
  frames?: () => Promise<TabFrame[]>;
} & SnapshotScope;

export interface QueryInput {
  browserId: string;
  page: SnapshotPage;
  /** 元素所在 frame 的编号；顶层是空串。 */
  frame: string;
  selector: string;
  maxResults: number;
  attributes?: readonly string[];
}

export type QueryResult =
  | { ok: true; count: number; elements: QueriedElement[] }
  | { ok: false; reason: 'invalid_selector'; message: string };

export class BrowserSnapshotEngine {
  private readonly statesByBrowserId = new Map<string, BrowserRefState>();
  /** 每个标签页上快照与查询排队做：引用的编号一次只发一批（并行的 browser_query 以前会拿到同一个编号）。 */
  private readonly serialByBrowserId = new Map<string, Promise<unknown>>();

  private async serial<T>(browserId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.serialByBrowserId.get(browserId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.serialByBrowserId.set(browserId, current);
    try {
      return await current;
    } finally {
      if (this.serialByBrowserId.get(browserId) === current)
        this.serialByBrowserId.delete(browserId);
    }
  }

  snapshot(input: SnapshotInput): Promise<BrowserAriaSnapshot | SnapshotFailure> {
    return this.serial(input.browserId, () => this.takeSnapshot(input));
  }

  private async takeSnapshot(input: SnapshotInput): Promise<BrowserAriaSnapshot | SnapshotFailure> {
    const maxNodes = Math.min(
      Math.max(1, input.maxNodes ?? BROWSER_SNAPSHOT_DEFAULT_NODES),
      BROWSER_SNAPSHOT_MAX_NODES,
    );
    let frameList: TabFrame[] | undefined;
    const frames = async () => {
      frameList ??= input.frames ? await input.frames().catch(() => []) : [];
      return frameList;
    };

    let rootPage = input.frame?.page ?? input.page;
    let rootFrame = input.frame?.id ?? '';
    let rootRef: { ref: string; fingerprint: BrowserRefFingerprint } | undefined;
    if (input.ref !== undefined) {
      const resolved = this.resolveRef({ browserId: input.browserId, ref: input.ref });
      if (!resolved.ok) return resolved;
      rootFrame = resolved.metadata.frame ?? '';
      rootRef = { ref: input.ref, fingerprint: resolved.metadata.fingerprint };
      if (rootFrame === '') {
        rootPage = input.page;
      } else {
        const frame = (await frames()).find((candidate) => candidate.id === rootFrame);
        if (!frame) return { ok: false, reason: 'stale_ref' };
        rootPage = frame.page;
      }
    }

    const first = parseAriaSnapshot(
      await rootPage.executeJavaScript(
        ariaSnapshotScript({
          maxNodes,
          maxRefs: MAX_REFS,
          refStart: 1,
          ...(input.selector !== undefined &&
            rootRef === undefined && { selector: input.selector }),
          ...(rootRef !== undefined && { rootRef }),
          ...(input.viewportOnly === true && { viewportOnly: true }),
        }),
      ),
    );
    if (first.error === 'stale_ref') return { ok: false, reason: 'stale_ref' };
    if (first.error === 'not_found') return { ok: false, reason: 'not_found' };
    if (first.error === 'invalid_selector') {
      return {
        ok: false,
        reason: 'invalid_selector',
        message: first.message ?? 'invalid selector',
      };
    }

    const refs: BrowserRefMetadata[] = first.refs.map((ref) => ({ ...ref, frame: rootFrame }));
    let nodeCount = first.stats.nodeCount;
    let iframeCount = first.stats.iframeCount ?? 0;
    let truncated = first.truncated;
    let refsTruncated = first.refsTruncated;
    let stoppedAt = first.stoppedAt;
    // 跨域 frame 的占位节点：在那个 frame 里再跑一遍，接着编号与节点数。
    const pending = collectFramePlaceholders(first.root);
    while (pending.length > 0) {
      const node = pending.shift() as SnapshotNode;
      const frameId = node.frame ?? '';
      node.kind = 'group';
      node.frame = undefined;
      if (truncated || nodeCount >= maxNodes) {
        node.children = [{ kind: 'text', text: frameSkipped(frameId) }];
        continue;
      }
      node.children = [{ kind: 'text', text: FRAME_UNREADABLE }];
      const frame = (await frames()).find((candidate) => candidate.id === frameId);
      if (!frame) continue;
      const raw = await withTimeout(
        frame.page.executeJavaScript(
          ariaSnapshotScript({
            maxNodes: maxNodes - nodeCount,
            maxRefs: Math.max(0, MAX_REFS - refs.length),
            refStart: refs.length + 1,
            ...(input.viewportOnly === true && { viewportOnly: true }),
          }),
        ),
        FRAME_SCRIPT_TIMEOUT_MS,
      )
        .then(parseAriaSnapshot)
        .catch(() => undefined);
      if (!raw || raw.error) continue;
      node.children = raw.root.children ?? [];
      refs.push(...raw.refs.map((ref) => ({ ...ref, frame: frameId })));
      nodeCount += raw.stats.nodeCount;
      iframeCount += raw.stats.iframeCount ?? 0;
      truncated ||= raw.truncated;
      refsTruncated ||= raw.refsTruncated;
      if (!stoppedAt && raw.stoppedAt) stoppedAt = raw.stoppedAt;
      pending.push(...collectFramePlaceholders(node));
    }

    const lines = renderSnapshot(first.root);
    const limitNotes = [
      ...(truncated
        ? [
            `# The snapshot stopped after ${maxNodes} nodes${stoppedAt ? ` at ${stoppedAt}` : ''}; the rest of the page is not included. Snapshot part of the page (selector, ref or frame), only what is on screen (viewportOnly), or raise maxNodes (up to ${BROWSER_SNAPSHOT_MAX_NODES}).`,
          ]
        : []),
      ...(refsTruncated
        ? [
            `# Only the first ${MAX_REFS} elements got refs. Snapshot part of the page (selector, ref, frame or viewportOnly) to get refs for the others.`,
          ]
        : []),
    ];
    const part = pageOfSnapshot(
      lines,
      input.offset ?? 0,
      input.pageBytes ?? BROWSER_SNAPSHOT_PAGE_BYTES,
      limitNotes,
    );
    this.statesByBrowserId.set(input.browserId, {
      refs: new Map(refs.map((ref) => [ref.ref, ref])),
      nextRef: refs.length + 1,
    });
    return {
      format: 'aria-yaml',
      snapshot: part.snapshot,
      truncated: part.truncated,
      stats: {
        ...first.stats,
        nodeCount,
        iframeCount,
        refCount: refs.length,
        textLength: part.snapshot.length,
        totalLines: lines.length,
        startLine: part.startLine,
        shownLines: part.shownLines,
        ...(stoppedAt && { stoppedAt }),
        maxNodes,
      },
    };
  }

  /**
   * 按 CSS 选择器找元素（browser_query），前 `maxResults` 个给引用，接着这个标签页现有的编号（之前快照的引用照样有效）。
   */
  query(input: QueryInput): Promise<QueryResult> {
    return this.serial(input.browserId, () => this.queryNow(input));
  }

  private async queryNow(input: QueryInput): Promise<QueryResult> {
    await input.page.executeJavaScript(ariaSnapshotScript({ mode: 'install' }));
    const state = this.statesByBrowserId.get(input.browserId) ?? { refs: new Map(), nextRef: 1 };
    const refs = Array.from(
      { length: input.maxResults },
      (_, index) => `@e${state.nextRef + index}`,
    );
    const raw = await input.page.executeJavaScript(
      buildQueryScript(input.selector, refs, input.attributes ?? []),
    );
    const parsed = parseQueryResult(raw);
    if (!parsed.ok) return parsed;
    for (const element of parsed.elements) {
      state.refs.set(element.ref, {
        ref: element.ref,
        fingerprint: element.fingerprint,
        frame: input.frame,
      });
    }
    state.nextRef += parsed.elements.length;
    this.statesByBrowserId.set(input.browserId, state);
    return {
      ok: true,
      count: parsed.count,
      elements: parsed.elements.map(({ fingerprint: _fingerprint, ...element }) => element),
    };
  }

  /** 引用的元素在哪个 frame（顶层是空串）。 */
  refFrame(input: { browserId: string; ref: string }): string | BrowserRefFailure {
    const resolved = this.resolveRef(input);
    return resolved.ok ? (resolved.metadata.frame ?? '') : resolved;
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
    if (
      record.reason === 'file_input' ||
      record.reason === 'not_fillable' ||
      record.reason === 'no_option'
    ) {
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
  if (typeof record.error === 'string') {
    return {
      ...emptySnapshot(),
      error: record.error,
      ...(typeof record.message === 'string' && { message: record.message }),
    };
  }
  const root = parseSnapshotNode(record.root);
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: root ?? emptySnapshot().root,
    refs: parseRefs(record.refs),
    truncated: record.truncated === true,
    refsTruncated: record.refsTruncated === true,
    stoppedAt: typeof record.stoppedAt === 'string' ? record.stoppedAt : '',
    stats: parseStats(record.stats),
  };
}

function emptySnapshot(): RawAriaSnapshot {
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: { kind: 'role', role: 'document', name: '', tagName: 'document', children: [] },
    refs: [],
    truncated: false,
    refsTruncated: false,
    stoppedAt: '',
    stats: { nodeCount: 0, refCount: 0, textLength: 0, iframeCount: 0, maxDepth: 0 },
  };
}

/** 还没接上的跨域 frame（按文档顺序）。 */
function collectFramePlaceholders(node: SnapshotNode): SnapshotNode[] {
  if (node.kind === 'frame') return [node];
  return (node.children ?? []).flatMap(collectFramePlaceholders);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseSnapshotNode(value: unknown): SnapshotNode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'role' && kind !== 'text' && kind !== 'group' && kind !== 'frame') {
    return null;
  }
  return {
    kind,
    ...(kind === 'frame' && typeof record.frame === 'string' && { frame: record.frame }),
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
  if (node.kind === 'frame') {
    return [{ text: `${'  '.repeat(depth)}- text: ${JSON.stringify(FRAME_UNREADABLE)}` }];
  }
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
  /** 快照本身没取全时的说明（节点或引用到了上限），每段末尾都给。 */
  limitNotes: readonly string[] = [],
): { snapshot: string; truncated: boolean; startLine: number; shownLines: number } {
  const pageTruncated = limitNotes.length > 0;
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
  const limitBytes = limitNotes.reduce((sum, note) => sum + bytesOf(note) + 1, 0);
  const bodyBudget = Math.floor(pageBytes * PAGE_BODY_SHARE) - limitBytes;
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
      let budget =
        pageBytes -
        used -
        limitBytes -
        notes.reduce((sum, note) => sum + bytesOf(note) + 1, 0) -
        80;
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
  notes.push(...limitNotes);
  return {
    snapshot: [...body, ...notes].join('\n'),
    truncated: start > 0 || end < total || pageTruncated,
    startLine: start,
    shownLines: end - start,
  };
}

/** 在 frame 里按选择器找元素，给前几个登记引用（运行时已经装上）。 */
function buildQueryScript(
  selector: string,
  refs: readonly string[],
  attributes: readonly string[],
): string {
  return `(() => {
    const runtime = window.__WEVIR_BROWSER_AUTOMATION__;
    if (!runtime || typeof runtime.register !== 'function') return { error: 'no_runtime' };
    let nodes;
    try {
      nodes = document.querySelectorAll(${JSON.stringify(selector)});
    } catch (error) {
      return { error: 'invalid_selector', message: String((error && error.message) || error) };
    }
    const refs = ${JSON.stringify(refs)};
    const names = ${JSON.stringify(attributes)};
    const clip = (value, max) => {
      const text = String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
      return text.length > max ? text.slice(0, max) + '…' : text;
    };
    const elements = [];
    for (let index = 0; index < nodes.length && index < refs.length; index += 1) {
      const element = nodes[index];
      const view = (element.ownerDocument && element.ownerDocument.defaultView) || window;
      const rect = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
        style.display !== 'none' && Number(style.opacity || '1') !== 0;
      const attributes = {};
      for (const name of names) {
        const value = element.getAttribute(name);
        if (value !== null) attributes[name] = clip(value, 500);
      }
      const classes = clip(element.getAttribute('class'), 200);
      elements.push({
        ref: refs[index],
        fingerprint: runtime.register(element, refs[index]),
        tag: element.tagName.toLowerCase(),
        ...(element.id ? { id: element.id } : {}),
        ...(classes ? { classes } : {}),
        text: clip(typeof element.innerText === 'string' ? element.innerText : element.textContent, 200),
        visible,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        ...(names.length > 0 ? { attributes } : {}),
      });
    }
    return { count: nodes.length, elements };
  })()`;
}

function parseQueryResult(value: unknown):
  | {
      ok: true;
      count: number;
      elements: Array<QueriedElement & { fingerprint: BrowserRefFingerprint }>;
    }
  | { ok: false; reason: 'invalid_selector'; message: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, reason: 'invalid_selector', message: 'the page did not answer the query' };
  }
  const record = value as Record<string, unknown>;
  if (record.error === 'invalid_selector') {
    return {
      ok: false,
      reason: 'invalid_selector',
      message: readString(record.message) ?? 'invalid selector',
    };
  }
  const elements = Array.isArray(record.elements)
    ? record.elements.flatMap(
        (item): Array<QueriedElement & { fingerprint: BrowserRefFingerprint }> => {
          if (!item || typeof item !== 'object') return [];
          const element = item as Record<string, unknown>;
          const ref = readString(element.ref);
          const fingerprint = parseFingerprint(element.fingerprint);
          const box = element.box as Record<string, unknown> | undefined;
          if (!ref || !fingerprint || !box) return [];
          const attributes =
            element.attributes && typeof element.attributes === 'object'
              ? Object.fromEntries(
                  Object.entries(element.attributes as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string',
                  ),
                )
              : undefined;
          return [
            {
              ref,
              fingerprint,
              tag: readString(element.tag) ?? '',
              ...(readString(element.id) && { id: readString(element.id) as string }),
              ...(readString(element.classes) && {
                classes: readString(element.classes) as string,
              }),
              text: readString(element.text) ?? '',
              visible: element.visible === true,
              box: {
                x: readNumber(box.x) ?? 0,
                y: readNumber(box.y) ?? 0,
                width: readNumber(box.width) ?? 0,
                height: readNumber(box.height) ?? 0,
              },
              ...(attributes && { attributes }),
            },
          ];
        },
      )
    : [];
  return { ok: true, count: readNumber(record.count) ?? elements.length, elements };
}

/**
 * 页面脚本片段：`element` 是 <select> 时按 `nextValue` 找选项（先比 value，再比显示的文字）并选中；找不到就不动它、说出有哪些选项
 * （给 select.value 赋不存在的值会把选择清空）。fill 与 select 共用。
 */
const SELECT_OPTION_SNIPPET = `if (element instanceof view.HTMLSelectElement) {
      const options = Array.from(element.options);
      const option =
        options.find((item) => item.value === nextValue) ??
        options.find((item) => (item.label || item.text).trim() === nextValue.trim());
      if (!option) {
        const listed = options
          .slice(0, 20)
          .map((item) => JSON.stringify(item.value) + ((item.label || item.text).trim() !== item.value ? ' (' + JSON.stringify((item.label || item.text).trim()) + ')' : ''))
          .join(', ');
        return {
          ok: false,
          reason: 'no_option',
          detail: options.length === 0 ? 'it has no options' : 'its options are ' + listed + (options.length > 20 ? ', …' : ''),
        };
      }
      if (option.disabled) {
        return { ok: false, reason: 'no_option', detail: 'that option is disabled' };
      }
      option.selected = true;
      element.dispatchEvent(new view.Event('input', { bubbles: true }));
      element.dispatchEvent(new view.Event('change', { bubbles: true }));
      return { ok: true };
    }`;

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
    ${SELECT_OPTION_SNIPPET}
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
    ${SELECT_OPTION_SNIPPET}
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
