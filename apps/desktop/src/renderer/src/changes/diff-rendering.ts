// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/lib/diffRendering.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：去掉忽略空白（Host 的 diff 不提供）；解析失败与不认识的格式由窗格显示原文，不写英文说明；表面颜色改用 Wevir
// 的代码与状态色变量。
//
// 把 Host 的统一格式 diff 交给 @pierre/diffs：解析成每个文件一项、文件的身份与内容版本、主题名，以及把 Pierre 画的表面
// 映射到 Wevir 设计变量的样式（desktop-tokens.md §33）。

import { type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';

const DIFF_THEME_NAMES = {
  light: 'pierre-light',
  dark: 'pierre-dark',
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: 'light' | 'dark'): DiffThemeName {
  return theme === 'dark' ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = 'changes'): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | { kind: 'files'; files: FileDiffMetadata[] }
  | { kind: 'raw'; text: string; reason: 'unsupported' | 'parse_failed' };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  return files.reduce<DiffLineStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }
      return total;
    },
    { additions: 0, deletions: 0 },
  );
}

/**
 * Pierre 解析部分补丁时，hunk 的渲染起点按源文件的坐标记；虚拟列表却按紧凑的行遍历部分补丁，所以要改成紧凑的起点，同时
 * 留着 `collapsedBefore` 给“N 行未修改”的分隔条。（T3）
 */
function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;
  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = { ...hunk, splitLineStart, unifiedLineStart };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });
  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = 'changes',
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;
  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches
      .flatMap((parsedPatch) => parsedPatch.files)
      .map(compactPartialHunkOffsets);
    if (files.length > 0) return { kind: 'files', files };
    return { kind: 'raw', text: normalizedPatch, reason: 'unsupported' };
  } catch {
    return { kind: 'raw', text: normalizedPatch, reason: 'parse_failed' };
  }
}

/** 文件现在的名字（git 给特殊字符加的引号已由解析器去掉）。 */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? '';
}

/** 改动前的名字；只有重命名时与现在的不同。 */
export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName ?? fileDiff.name ?? '';
}

/**
 * 同一个文件重画时不变、同一个补丁里每段都不同。类型变化（普通文件换成符号链接）是同一路径的一删一增，所以把变化类型算进
 * 身份。（T3）
 */
export function buildFileDiffIdentityKey(fileDiff: FileDiffMetadata): string {
  return `${resolveFileDiffPreviousPath(fileDiff)}\u0000${resolveFileDiffPath(fileDiff)}\u0000${fileDiff.type}`;
}

function hashFileDiffPart(hash: number, value: string | number | boolean | undefined): number {
  const serialized = value === undefined ? 'undefined' : String(value);
  const withLength = fnv1a32(`${typeof value}:${serialized.length}:`, hash);
  return fnv1a32(serialized, withLength);
}

/** 只看内容的版本号，给 CodeView 对账用。Pierre 的 cacheKey 含整个补丁，用它会让一个文件变了所有文件都重画。（T3） */
export function buildFileDiffContentVersion(fileDiff: FileDiffMetadata): number {
  let hash = FNV_OFFSET_BASIS_32;
  const append = (value: string | number | boolean | undefined) => {
    hash = hashFileDiffPart(hash, value);
  };
  append(fileDiff.name);
  append(fileDiff.prevName);
  append(fileDiff.lang);
  append(fileDiff.newObjectId);
  append(fileDiff.prevObjectId);
  append(fileDiff.mode);
  append(fileDiff.prevMode);
  append(fileDiff.type);
  append(fileDiff.isPartial);
  append(fileDiff.splitLineCount);
  append(fileDiff.unifiedLineCount);
  for (const line of fileDiff.additionLines) append(line);
  for (const line of fileDiff.deletionLines) append(line);
  for (const hunk of fileDiff.hunks) {
    append(hunk.collapsedBefore);
    append(hunk.additionStart);
    append(hunk.additionCount);
    append(hunk.additionLines);
    append(hunk.additionLineIndex);
    append(hunk.deletionStart);
    append(hunk.deletionCount);
    append(hunk.deletionLines);
    append(hunk.deletionLineIndex);
    append(hunk.hunkContext);
    append(hunk.hunkSpecs);
    append(hunk.splitLineStart);
    append(hunk.splitLineCount);
    append(hunk.unifiedLineStart);
    append(hunk.unifiedLineCount);
    append(hunk.noEOFCRAdditions);
    append(hunk.noEOFCRDeletions);
    for (const content of hunk.hunkContent) {
      append(content.type);
      append(content.additionLineIndex);
      append(content.deletionLineIndex);
      append(content.type === 'change' ? content.additions : content.lines);
      append(content.type === 'change' ? content.deletions : undefined);
    }
  }
  return hash;
}

/** 折叠箭头的颜色跟着文件的变化：新增成功色、删除失败色、修改与重命名说明文字色。 */
export function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case 'new':
      return 'text-success';
    case 'deleted':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * Pierre 画的 diff 与文件表面都换成 Wevir 的变量：底色是 `--code-background`、字是 `--code-foreground`（窗格把两者设成画布色与
 * 正文色），增删的底色由成功色、失败色与底色混出来（T3 的做法，静器里彩色只表示状态）。
 */
export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-ui) !important;
  --diffs-font-family: var(--font-code) !important;
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-addition-color-override: var(--success);
  --diffs-deletion-color-override: var(--destructive);
  --diffs-modified-color-override: var(--muted-foreground);

  --diffs-bg-context-override: var(--code-background);
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--code-background) 95%, var(--code-foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--code-background) 88%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--code-background) 80%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--code-background) 70%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--code-background) 88%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--code-background) 80%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--code-background) 70%, var(--destructive));

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}
`;
