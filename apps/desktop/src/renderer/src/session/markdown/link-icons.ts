// 消息里链接前后的小图标：Markdown 渲染成 HTML 字符串，不能用 lucide-react 组件，这里是同样的图形（lucide 1.55.0，ISC）写成
// SVG 字符串。描边与大小在 styles/markdown.css 的 .md-link-icon 等类里设，CSP 不放行 style 属性。

export type LinkIcon = 'file' | 'text' | 'code' | 'data' | 'image' | 'folder' | 'globe' | 'arrow';

const SHEET =
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
  '<path d="M14 2v5a1 1 0 0 0 1 1h5"/>';

const SHAPES: Record<LinkIcon, string> = {
  file: SHEET,
  text: `${SHEET}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,
  code: `${SHEET}<path d="M10 12.5 8 15l2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/>`,
  data:
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/>' +
    '<path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/>' +
    '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
};

export function linkIconHtml(icon: LinkIcon, className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${SHAPES[icon]}</svg>`;
}

const TEXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'log', 'pdf', 'doc', 'docx']);
const DATA = new Set([
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'xml',
  'csv',
  'tsv',
  'lock',
]);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'heic', 'bmp']);
const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'm',
  'mm',
  'php',
  'lua',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte',
  'astro',
  'sql',
  'graphql',
  'proto',
  'dart',
  'zig',
  'ex',
  'exs',
  'erl',
  'hs',
  'scala',
  'r',
  'jl',
  'nix',
  'tf',
  'dockerfile',
  'makefile',
  'gradle',
]);

/** 文件链接前的图标：按扩展名分成文档、数据、图片、代码；结尾是 `/` 的是目录。 */
export function fileLinkIcon(path: string): LinkIcon {
  if (/[\\/]$/.test(path)) return 'folder';
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : name;
  if (TEXT.has(extension)) return 'text';
  if (DATA.has(extension)) return 'data';
  if (IMAGE.has(extension)) return 'image';
  if (CODE.has(extension)) return 'code';
  return 'file';
}
