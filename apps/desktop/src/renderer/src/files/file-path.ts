// 文件窗格（U32）的路径换算：助手消息里的文件链接、绝对路径与会话目录之间的相对路径。纯逻辑。

export interface FileTarget {
  path: string;
  /** 从 1 开始。 */
  line?: number;
}

/** 协议（`https:`、`mailto:`）；冒号后面是数字的是行号（`a.ts:12`），不算。 */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 文件链接里的路径与行号：`src/a.ts`、`/abs/a.ts:12`、`a.ts:12:5`、`a.ts#L12`、`a.ts#L12-L20`、`file:///abs/a.ts`。不像文件
 * 路径（http、mailto 等别的协议、只有锚点）时 undefined。
 */
export function parseFileHref(href: string): FileTarget | undefined {
  let value = href.trim();
  if (value === '' || value.startsWith('#')) return undefined;
  if (/^file:/i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return undefined;
    }
  } else if (SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) {
    return undefined;
  }
  let line: number | undefined;
  const anchor = /#L(\d+)(?:-L?\d+)?$/i.exec(value);
  if (anchor) {
    line = Number(anchor[1]);
    value = value.slice(0, anchor.index);
  } else {
    const hash = value.indexOf('#');
    if (hash >= 0) value = value.slice(0, hash);
    const suffix = /:(\d+)(?::\d+)?$/.exec(value);
    if (suffix) {
      line = Number(suffix[1]);
      value = value.slice(0, suffix.index);
    }
  }
  const path = safeDecode(value);
  if (path === '') return undefined;
  return line !== undefined && line > 0 ? { path, line } : { path };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_DRIVE.test(path);
}

/** `/` 分隔、去掉重复与结尾的 `/`。 */
function normalize(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

/**
 * 相对 `cwd`（会话目录，绝对路径）的路径，`/` 分隔；`cwd` 本身是空字符串。在目录外、或相对路径往上走时 undefined。
 */
export function toRelativePath(path: string, cwd: string): string | undefined {
  const target = normalize(path);
  if (isAbsolutePath(target)) {
    const root = normalize(cwd);
    if (target === root) return '';
    return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : undefined;
  }
  const parts = target.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return undefined;
  return parts.join('/');
}

/** 会话目录里的相对路径对应的绝对路径（给外部编辑器与访达）。 */
export function toAbsolutePath(relativePath: string, cwd: string): string {
  const root = cwd.replace(/[\\/]+$/, '');
  if (relativePath === '') return root;
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root}${separator}${separator === '\\' ? relativePath.replace(/\//g, '\\') : relativePath}`;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/**
 * 文件 `from`（相对会话目录）里引用的 `href`（Markdown 的图片，0.32.0）对应的会话目录里的路径：相对路径按 `from` 所在的目录
 * 解析，绝对路径要在 `cwd` 之下；去掉查询串与锚点。往上走出目录、是别的协议时 undefined。
 */
export function resolveRelativeTo(from: string, href: string, cwd: string): string | undefined {
  let value = href.trim().replace(/^<|>$/g, '');
  if (value === '' || SCHEME.test(value)) return undefined;
  value = safeDecode(value.split(/[?#]/, 1)[0] ?? '');
  if (value === '') return undefined;
  if (isAbsolutePath(value)) {
    const relative = toRelativePath(value, cwd);
    return relative === '' ? undefined : relative;
  }
  const parts = from.split('/').slice(0, -1);
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

/** 文件链接的右键菜单（file-link-menu.tsx）要用的几种写法。 */
export interface FileLinkPaths {
  /** 这台电脑上的绝对路径；相对路径往上走出会话目录、或会话没有目录时没有。 */
  absolute?: string;
  /** 相对会话目录，`/` 分隔；在目录外或就是目录本身时没有。 */
  relative?: string;
  /** 最后一段（文件或文件夹名）。 */
  name: string;
  line?: number;
}

export function fileLinkPaths(href: string, cwd: string): FileLinkPaths | undefined {
  const target = parseFileHref(href);
  return target && fileTargetPaths(target, cwd);
}

/** 同上，路径已经拆好（文件卡片、工具行、变更列表里的路径不按链接解析行号与锚点）。 */
export function fileTargetPaths(target: FileTarget, cwd: string): FileLinkPaths {
  const relative = cwd === '' ? undefined : toRelativePath(target.path, cwd);
  const absolute = isAbsolutePath(target.path)
    ? target.path
    : relative !== undefined && cwd !== ''
      ? toAbsolutePath(relative, cwd)
      : undefined;
  const name = normalize(target.path).split('/').pop() || target.path;
  return {
    ...(absolute !== undefined && { absolute }),
    ...(relative && { relative }),
    name,
    ...(target.line !== undefined && { line: target.line }),
  };
}
