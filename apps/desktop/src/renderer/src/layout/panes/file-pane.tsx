// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/FilePreviewPanel.tsx、ReadOnlySourcePreview.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，只读；工具行与“打开方式”是 Wevir 的。
//
// “文件预览”窗格（U32，0.22.0，desktop-layout.md §19，desktop-tokens.md §36）：会话目录里的一个文件，照 T3 Code 的
// FilePreviewPanel 与 ReadOnlySourcePreview（MIT，ec1313c）——代码用 Pierre 的虚拟化 File 加 Shiki 高亮（与“变更”窗格共用
// worker 池），Markdown 可切换渲染与源码，图片直接显示；顶上一行是路径、换行、刷新、复制路径与“打开方式”（外部编辑器、
// 在访达中显示）。只读，不编辑。从带行号的链接打开时选中并滚到那一行。

import { File, Virtualizer } from '@pierre/diffs/react';
import { cn } from 'cn';
import {
  Check,
  ChevronDown,
  Code,
  Copy,
  Eye,
  FileWarning,
  FolderOpen,
  RotateCw,
  SquareArrowOutUpRight,
  WrapText,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { splitPath } from '@/changes/changes-model';
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from '@/changes/diff-rendering';
import { DiffWorkerPoolProvider, PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isMarkdownPath, toAbsolutePath } from '@/files/file-path';
import { type FileScope, useFileContents, useFilesSupported } from '@/files/files-data';
import { filePrefs, preferredEditor, useEditors, useFileReveal } from '@/files/files-store';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { useTheme } from '@/theme/theme';
import type { PaneContext } from '../pane-registry';
import type { PaneTab } from '../pane-state';
import { fileIcon, Note, useFileScope, useScopeRefreshKey } from './files-pane';

/** 与 DIFF_SURFACE_THEME_UNSAFE_CSS 里的 --diffs-line-height 一致，估算行的位置用。 */
const LINE_HEIGHT = 20;

export function FilePane({ tab, context }: { tab: PaneTab; context: PaneContext }) {
  const supported = useFilesSupported();
  const scope = useFileScope(context);
  const refreshKey = useScopeRefreshKey(context);
  const path = tab.params?.path;
  if (!scope || path === undefined) return <Note>{t('files.noProject')}</Note>;
  if (!supported) return <Note>{t('files.unsupported')}</Note>;
  return <FilePreview key={path} scope={scope} path={path} refreshKey={refreshKey} />;
}

function FilePreview({
  scope,
  path,
  refreshKey,
}: {
  scope: FileScope;
  path: string;
  refreshKey: string;
}) {
  const [manual, setManual] = useState(0);
  const contents = useFileContents(scope, path, `${refreshKey}:${manual}`);
  const prefs = filePrefs.use();
  const result = contents.value;
  const markdown = isMarkdownPath(path) && result?.text !== undefined;
  const rendered = markdown && prefs.renderMarkdown;
  const absolute = toAbsolutePath(path, scope.root);
  const { name, dir } = splitPath(path);
  const Icon = fileIcon(path);
  const reveal = useFileReveal(path);

  let body: ReactNode;
  if (!result) {
    body =
      contents.error !== undefined ? (
        <Note icon={FileWarning}>{t('files.failed', { error: contents.error })}</Note>
      ) : (
        <Note icon={Icon}>{t('common.loading')}</Note>
      );
  } else if (result.unavailable !== undefined) {
    body = <Note icon={FileWarning}>{unavailableText(result.unavailable)}</Note>;
  } else if (result.image) {
    body = (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/40 p-4">
        <img
          src={`data:${result.image.mimeType};base64,${result.image.data}`}
          alt={name}
          data-testid="file-image"
          className="max-h-full max-w-full rounded-sm object-contain shadow-xs"
        />
      </div>
    );
  } else if (rendered) {
    body = (
      <ScrollArea className="h-full">
        <MarkdownView text={result.text ?? ''} streaming={false} className="px-5 py-4" />
      </ScrollArea>
    );
  } else {
    body = <SourceView name={name} path={path} text={result.text ?? ''} wrap={prefs.wrap} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-pane" data-file-path={path}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5" title={path}>
          <span className="shrink-0 truncate text-sm font-medium">{name}</span>
          {dir && <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>}
        </p>
        {markdown && (
          <IconButton
            label={rendered ? t('files.showSource') : t('files.showRendered')}
            onClick={() =>
              filePrefs.set((current) => ({ ...current, renderMarkdown: !current.renderMarkdown }))
            }
          >
            {rendered ? <Code /> : <Eye />}
          </IconButton>
        )}
        {result?.text !== undefined && !rendered && (
          <IconButton
            label={t('changes.wrap')}
            aria-pressed={prefs.wrap}
            className={cn(prefs.wrap && 'bg-accent')}
            onClick={() => filePrefs.set((current) => ({ ...current, wrap: !current.wrap }))}
          >
            <WrapText />
          </IconButton>
        )}
        <IconButton label={t('files.refresh')} onClick={() => setManual((value) => value + 1)}>
          <RotateCw className={cn(contents.loading && 'animate-spin')} />
        </IconButton>
        <CopyPath path={absolute} />
        <OpenInMenu path={absolute} line={reveal?.line} />
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

function unavailableText(reason: string): string {
  if (reason === 'too_large') return t('files.tooLarge');
  if (reason === 'binary') return t('files.binary');
  if (reason === 'not_found') return t('files.notFound');
  return t('files.unavailable');
}

/** 代码：Pierre 的虚拟化 File（只读），从链接带来的行选中并滚到中间。 */
function SourceView({
  name,
  path,
  text,
  wrap,
}: {
  name: string;
  path: string;
  text: string;
  wrap: boolean;
}) {
  const { resolved: theme } = useTheme();
  const reveal = useFileReveal(path);
  const wrapper = useRef<HTMLDivElement>(null);
  const line = reveal?.line;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 同一行再点（id 变了）也要滚过去。
  useEffect(() => {
    if (line === undefined) return;
    // Virtualizer 本身是滚动容器，它不收 ref，从外面这一层取。
    const element = wrapper.current?.firstElementChild;
    if (!(element instanceof HTMLElement)) return;
    // 虚拟列表还没画到那一行：按行高估位置，滚到让它在中间。
    const timer = window.setTimeout(() => {
      const top = (line - 1) * LINE_HEIGHT - element.clientHeight / 2 + LINE_HEIGHT;
      element.scrollTo({ top: Math.max(0, top) });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [line, reveal?.id]);

  return (
    <DiffWorkerPoolProvider>
      <div ref={wrapper} className="h-full min-h-0 bg-(--code-background)">
        <Virtualizer
          key={`${name}:${theme}`}
          className="h-full min-h-0 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={{ name, contents: text, cacheKey: `file:${path}:${text.length}` }}
            selectedLines={line === undefined ? null : { start: line, end: line }}
            options={{
              disableFileHeader: true,
              overflow: wrap ? 'wrap' : 'scroll',
              theme: resolveDiffThemeName(theme),
              themeType: theme,
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      label={copied ? t('files.copied') : t('files.copyPath')}
      onClick={() => void window.wevir.copyText(path).then(() => setCopied(true))}
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}

/** “打开方式”：主按钮用上次的外部编辑器，下拉里选别的编辑器或在访达中显示。 */
function OpenInMenu({ path, line }: { path: string; line?: number }) {
  const editors = useEditors();
  const prefs = filePrefs.use();
  const preferred = preferredEditor(editors, prefs.editor);
  const reveal = () => void window.wevir.revealPath(path).catch(() => undefined);
  const open = (id: string) => {
    filePrefs.set((current) => ({ ...current, editor: id }));
    void window.wevir.openInEditor(id, path, line).catch(() => undefined);
  };
  const revealLabel = IS_MAC ? t('files.revealFinder') : t('files.revealFolder');
  return (
    <span className="flex shrink-0 items-center">
      <IconButton
        label={preferred ? t('files.openIn', { editor: preferred.name }) : revealLabel}
        onClick={() => (preferred ? open(preferred.id) : reveal())}
        data-action="open-in-editor"
      >
        {preferred ? <SquareArrowOutUpRight /> : <FolderOpen />}
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t('files.openWith')}
              className="flex h-7 w-4 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          }
        >
          <ChevronDown aria-hidden className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {(editors ?? []).map((editor) => (
            <DropdownMenuItem key={editor.id} onClick={() => open(editor.id)}>
              <SquareArrowOutUpRight />
              <span className="flex-1">{editor.name}</span>
              {editor.id === preferred?.id && <Check className="text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
          {(editors ?? []).length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={reveal}>
            <FolderOpen />
            {revealLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
