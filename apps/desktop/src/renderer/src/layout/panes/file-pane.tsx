// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/FilePreviewPanel.tsx、ReadOnlySourcePreview.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写；工具行与“打开方式”是 Wevir 的。0.32.0 起照 FilePreviewPanel 按文件类型分支（图片、音视频、PDF、网页、表格、
// Markdown、可编辑的源码），另加 Office（OpenWork 的 workbook）与系统预览、默认应用。
//
// “文件预览”窗格（U32，0.22.0；0.32.0 补齐办公格式，desktop-layout.md §19，desktop-tokens.md §36）：会话目录里的一个文件，照 T3 Code
// 的 FilePreviewPanel——代码用 Pierre 的虚拟化 File 加 Shiki 高亮（与“变更”窗格共用 worker 池），Host 有 `file_preview` 时直接在里面
// 编辑、停下自动写回（file-editor.tsx）；Markdown 可切换渲染（含公式、Mermaid 与会话目录里的图片）与源码；CSV / TSV 可切换表格与
// 源码；网页可切换沙箱里的页面与源码；图片可缩放；PDF 用 Chromium 自带的查看器；音视频用原生播放器；xlsx 显示成表格，docx / pptx
// 显示抽出的文字，其余 Office 文件交给系统预览（macOS 的 Quick Look）或默认应用（file-viewers.tsx）。PDF、网页、音视频与 Office
// 文件从 Host 的流式地址加载（`workspace.fileUrl`），不走 base64。顶上一行是路径、切换、换行、保存状态、刷新、复制路径、系统预览
// 与“打开方式”（外部编辑器、在访达中显示）。从带行号的链接打开时选中并滚到那一行。
//
// 0.138.0：Host 有 `office_preview` 时，Word、Excel、PowerPoint 与 OpenDocument 文件可以显示成页面：Host 用按需下载的 LibreOffice
// 引擎转成 PDF（`workspace.officePdf`），同样交给 Chromium 的 PDF 查看器，macOS、Windows 与 Linux 一样。引擎没装时照旧显示文字或
// 表格，上面一行给出下载；docx / pptx / xlsx 可以在页面与文字（表格）之间切换。

import { File, Virtualizer } from '@pierre/diffs/react';
import { cn } from 'cn';
import {
  AlignLeft,
  AppWindow,
  Check,
  ChevronDown,
  Code,
  Copy,
  Download,
  Eye,
  FileText,
  FileWarning,
  FolderOpen,
  RotateCw,
  ScanEye,
  SquareArrowOutUpRight,
  Table2,
  WrapText,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { splitPath } from '@/changes/changes-model';
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from '@/changes/diff-rendering';
import { DiffWorkerPoolProvider, PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { filePreviewDelimiter } from '@/files/delimited-preview';
import { resolveRelativeTo, toAbsolutePath } from '@/files/file-path';
import {
  type FilePaneView,
  filePaneView,
  isStreamedView,
  officePdfConvertible,
} from '@/files/file-preview';
import {
  type FileScope,
  useFileContents,
  useFilePreviewSupported,
  useFilesSupported,
  useFileUrl,
  useOfficePdf,
  useOfficePreviewSupported,
} from '@/files/files-data';
import {
  filePrefs,
  openInEditor,
  preferredEditor,
  useEditors,
  useFileReveal,
} from '@/files/files-store';
import { installPercent, type OfficeEngine, useOfficeEngine } from '@/files/office-engine';
import { useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { capabilities, platformApi } from '@/platform/platform';
import { renderDocumentHtml } from '@/session/markdown/markdown-document';
import { type DocumentMarkdown, MarkdownView } from '@/session/markdown/markdown-view';
import { formatFileSize } from '@/session/shared-files-model';
import { useTheme } from '@/theme/theme';
import { canOpenExternally } from '../../../../shared/open-path.js';
import type { PaneContext } from '../pane-registry';
import type { PaneTab } from '../pane-state';
import { EditableSource, type SaveStatus } from './file-editor';
import {
  AudioPlayer,
  DelimitedTable,
  DocumentFrame,
  OfficeTextView,
  SpreadsheetView,
  VideoPlayer,
  ZoomableImage,
} from './file-viewers';
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

/** 渲染与源码之间能切换的几种，以及记住选择的那一项设置。 */
const TOGGLES: Partial<Record<FilePaneView, 'renderMarkdown' | 'renderHtml' | 'renderTable'>> = {
  markdown: 'renderMarkdown',
  html: 'renderHtml',
  table: 'renderTable',
};

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
  const [editorKey, setEditorKey] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const key = `${refreshKey}:${manual}`;
  const prefs = filePrefs.use();
  const preview = useFilePreviewSupported();
  const reveal = useFileReveal(path);
  const view = filePaneView(path);
  const toggle = TOGGLES[view];
  // 带行号打开时显示源码：行只在源码里（T3 同样）。
  const rendered =
    toggle !== undefined &&
    prefs[toggle] &&
    reveal?.line === undefined &&
    (view !== 'html' || preview);
  // 办公文档的页面（0.138.0）：引擎装好时 docx / pptx / xlsx 按设置，旧格式与 OpenDocument 总是页面。
  const officeSupported = useOfficePreviewSupported();
  const engine = useOfficeEngine();
  const convertible = preview && officeSupported && officePdfConvertible(path);
  const engineReady = convertible && engine.status?.state === 'ready';
  const pages = engineReady && (view === 'office' || prefs.renderOffice);
  const offer =
    convertible &&
    !engineReady &&
    engine.status !== undefined &&
    engine.status.state !== 'unsupported';
  const pdf = useOfficePdf(scope, path, key, pages);
  // Host 没有 file_preview（0.32.0 之前）时只有文本与图片（base64）。
  const streamed = preview && !pages && (isStreamedView(view) || (view === 'html' && rendered));
  const contents = useFileContents(scope, path, key, !streamed);
  const url = useFileUrl(scope, path, key, streamed);
  const result = contents.value;
  const absolute = toAbsolutePath(path, scope.root);
  const { name, dir } = splitPath(path);
  const Icon = fileIcon(path);
  const external = canOpenExternally(absolute);
  const loading = pages ? pdf.loading : streamed ? url.loading : contents.loading;
  const showsSource = !streamed && result?.text !== undefined && !rendered;
  const refresh = useCallback(() => setManual((value) => value + 1), []);

  let body: ReactNode;
  const error = pages ? pdf.error : streamed ? url.error : contents.error;
  if (pages) {
    const result = pdf.value;
    body =
      result?.url !== undefined ? (
        <DocumentFrame src={result.url} title={path} pdf />
      ) : result?.unavailable !== undefined ? (
        <Note icon={FileWarning}>
          {t('files.convertFailed', {
            error: result.message ?? unavailableText(result.unavailable),
          })}
        </Note>
      ) : error !== undefined ? (
        <Note icon={FileWarning}>{t('files.failed', { error })}</Note>
      ) : (
        <Note icon={Icon}>{t('files.converting')}</Note>
      );
  } else if (streamed && url.value?.unavailable === undefined && url.src !== undefined) {
    body = (
      <StreamedBody
        view={view}
        src={url.src}
        path={path}
        name={name}
        onRetry={refresh}
        absolute={absolute}
        engine={offer ? engine : undefined}
      />
    );
  } else if (streamed && url.value?.unavailable !== undefined) {
    body =
      view === 'office' ? (
        <OfficeFallback absolute={absolute} engine={offer ? engine : undefined} />
      ) : (
        <Note icon={FileWarning}>{unavailableText(url.value.unavailable)}</Note>
      );
  } else if (!streamed && result) {
    if (result.unavailable !== undefined) {
      body =
        result.unavailable === 'binary' && external && capabilities().localFiles ? (
          <OfficeFallback absolute={absolute} />
        ) : (
          <Note icon={FileWarning}>{unavailableText(result.unavailable)}</Note>
        );
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
    } else if (rendered && view === 'markdown') {
      body = <DocumentBody scope={scope} path={path} text={result.text ?? ''} />;
    } else if (rendered && view === 'table') {
      body = (
        <DelimitedTable
          name={name}
          text={result.text ?? ''}
          delimiter={filePreviewDelimiter({ name: path }) ?? ','}
        />
      );
    } else if (preview && result.text !== undefined) {
      body = (
        <EditableSource
          key={editorKey}
          scope={scope}
          path={path}
          name={name}
          text={result.text}
          mtimeMs={result.mtimeMs}
          wrap={prefs.wrap}
          onStatus={setSaveStatus}
          onReload={() => {
            setEditorKey((value) => value + 1);
            refresh();
          }}
        />
      );
    } else {
      body = <SourceView name={name} path={path} text={result.text ?? ''} wrap={prefs.wrap} />;
    }
  } else {
    body =
      error !== undefined ? (
        <Note icon={FileWarning}>{t('files.failed', { error })}</Note>
      ) : (
        <Note icon={Icon}>{t('common.loading')}</Note>
      );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-pane" data-file-path={path}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5" title={path}>
          <span className="shrink-0 truncate text-sm font-medium">{name}</span>
          {dir && <span className="min-w-0 truncate text-xs text-muted-foreground">{dir}</span>}
        </p>
        <SaveIndicator status={saveStatus} />
        {toggle !== undefined && (view !== 'html' || preview) && (
          <IconButton
            label={rendered ? t('files.showSource') : toggleLabel(view)}
            aria-pressed={rendered}
            onClick={() => filePrefs.set((current) => ({ ...current, [toggle]: !rendered }))}
            data-action="toggle-rendered"
          >
            {rendered ? <Code /> : view === 'table' ? <Table2 /> : <Eye />}
          </IconButton>
        )}
        {engineReady && view !== 'office' && (
          <IconButton
            label={
              pages
                ? view === 'spreadsheet'
                  ? t('files.showTable')
                  : t('files.showText')
                : t('files.showPages')
            }
            aria-pressed={pages}
            onClick={() => filePrefs.set((current) => ({ ...current, renderOffice: !pages }))}
            data-action="toggle-office-pages"
          >
            {pages ? view === 'spreadsheet' ? <Table2 /> : <AlignLeft /> : <FileText />}
          </IconButton>
        )}
        {showsSource && (
          <IconButton
            label={t('changes.wrap')}
            aria-pressed={prefs.wrap}
            className={cn(prefs.wrap && 'bg-accent')}
            onClick={() => filePrefs.set((current) => ({ ...current, wrap: !current.wrap }))}
          >
            <WrapText />
          </IconButton>
        )}
        <IconButton label={t('files.refresh')} onClick={refresh}>
          <RotateCw className={cn(loading && 'animate-spin')} />
        </IconButton>
        <CopyPath path={absolute} />
        {/* 系统应用、编辑器与访达只对这台电脑上的文件有用（platform/platform.ts 的 `localFiles`）。 */}
        {capabilities().localFiles && external && isStreamedView(view) && (
          <ExternalButtons absolute={absolute} />
        )}
        {capabilities().localFiles && <OpenInMenu path={absolute} line={reveal?.line} />}
      </div>
      {offer && view !== 'office' && <OfficeEngineBar engine={engine} />}
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

/** 预览引擎没装时文字（表格）上面的一行：下载、进度与取消、失败后重试。 */
function OfficeEngineBar({ engine }: { engine: OfficeEngine }) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground"
      data-testid="office-engine-bar"
    >
      <FileText aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t('files.pagePreview')}</span>
      <OfficeEngineAction engine={engine} />
    </div>
  );
}

/** 引擎的状态与操作：没装时“下载”，下载中显示进度与“取消”，失败时显示原因与“重试”。 */
function OfficeEngineAction({ engine }: { engine: OfficeEngine }) {
  const status = engine.status;
  if (status === undefined) return null;
  const failure =
    engine.error ?? (status.state === 'failed' ? (status.error ?? undefined) : undefined);
  if (status.state === 'installing') {
    return (
      <>
        <span className="shrink-0 tabular-nums" aria-live="polite">
          {t('files.officeEngine.downloading', { percent: installPercent(status) })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={engine.busy}
          onClick={engine.cancel}
          data-action="office-engine-cancel"
        >
          {t('common.cancel')}
        </Button>
      </>
    );
  }
  return (
    <>
      {failure !== undefined && (
        <span className="min-w-0 truncate text-destructive" title={failure}>
          {t('files.officeEngine.failed', { error: failure })}
        </span>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={engine.busy}
        onClick={engine.install}
        data-action="office-engine-install"
      >
        <Download />
        {failure !== undefined
          ? t('files.officeEngine.retry')
          : t('files.officeEngine.download', {
              size: formatFileSize(status.downloadBytes, currentLocale()),
            })}
      </Button>
    </>
  );
}

function toggleLabel(view: FilePaneView): string {
  if (view === 'table') return t('files.showTable');
  return t('files.showRendered');
}

function unavailableText(reason: string): string {
  if (reason === 'too_large') return t('files.tooLarge');
  if (reason === 'binary') return t('files.binary');
  if (reason === 'not_found') return t('files.notFound');
  return t('files.unavailable');
}

/** 从 Host 的流式地址加载的几种。 */
function StreamedBody({
  view,
  src,
  path,
  name,
  absolute,
  onRetry,
  engine,
}: {
  view: FilePaneView;
  src: string;
  path: string;
  name: string;
  absolute: string;
  onRetry: () => void;
  engine: OfficeEngine | undefined;
}) {
  switch (view) {
    case 'image':
      return <ZoomableImage src={src} name={name} />;
    case 'video':
      return <VideoPlayer src={src} name={name} onRetry={onRetry} />;
    case 'audio':
      return <AudioPlayer src={src} name={name} />;
    case 'pdf':
      return <DocumentFrame src={src} title={path} pdf />;
    case 'html':
      return <DocumentFrame src={src} title={path} pdf={false} />;
    case 'spreadsheet':
      return <SpreadsheetView src={src} name={name} />;
    case 'document':
      return (
        <OfficeTextView src={src} kind={path.toLowerCase().endsWith('.pptx') ? 'pptx' : 'docx'} />
      );
    default:
      return <OfficeFallback absolute={absolute} engine={engine} />;
  }
}

/** 窗格里看不了的文档：交给系统预览或默认应用；能转成 PDF 的旧格式另给下载预览引擎（`engine`）。 */
function OfficeFallback({ absolute, engine }: { absolute: string; engine?: OfficeEngine }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileWarning aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{t('files.noInlinePreview')}</p>
      {engine !== undefined && (
        <div className="flex max-w-80 flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
          <OfficeEngineAction engine={engine} />
        </div>
      )}
      {capabilities().localFiles && canOpenExternally(absolute) && (
        <div className="flex gap-2">
          {IS_MAC && (
            <Button size="sm" variant="secondary" onClick={() => void quickLook(absolute)}>
              <ScanEye />
              {t('files.quickLook')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void openDefault(absolute)}>
            <AppWindow />
            {t('files.openDefault')}
          </Button>
        </div>
      )}
    </div>
  );
}

async function quickLook(path: string): Promise<void> {
  const shown = await platformApi()
    .previewFile(path)
    .catch(() => false);
  if (!shown) await openDefault(path);
}

async function openDefault(path: string): Promise<void> {
  await platformApi()
    .openPath(path)
    .catch(() => undefined);
}

/** 系统预览（macOS 的 Quick Look）与默认应用。 */
function ExternalButtons({ absolute }: { absolute: string }) {
  return (
    <>
      {IS_MAC && (
        <IconButton label={t('files.quickLook')} onClick={() => void quickLook(absolute)}>
          <ScanEye />
        </IconButton>
      )}
      <IconButton
        label={t('files.openDefault')}
        onClick={() => void openDefault(absolute)}
        data-action="open-default"
      >
        <AppWindow />
      </IconButton>
    </>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (status === 'idle') return setVisible(false);
    setVisible(true);
    if (status !== 'saved') return;
    const timer = window.setTimeout(() => setVisible(false), 1500);
    return () => window.clearTimeout(timer);
  }, [status]);
  if (!visible || status === 'idle') return null;
  const text =
    status === 'saving'
      ? t('files.saving')
      : status === 'saved'
        ? t('files.saved')
        : status === 'conflict'
          ? t('files.conflictShort')
          : t('files.saveFailed');
  return (
    <span
      className={cn(
        'shrink-0 px-1 text-xs text-muted-foreground',
        (status === 'conflict' || status === 'failed') && 'text-destructive',
      )}
      aria-live="polite"
      data-save-status={status}
    >
      {text}
    </span>
  );
}

/** Markdown 渲染：公式、Mermaid 与会话目录里的图片（图片地址向 Host 要，按路径缓存）。 */
function DocumentBody({ scope, path, text }: { scope: FileScope; path: string; text: string }) {
  const { client } = useHostConnection();
  const urls = useRef(new Map<string, Promise<string | undefined>>());
  const document = useMemo<DocumentMarkdown>(
    () => ({
      render: (text) =>
        renderDocumentHtml(text, {
          imagePath: (href) => resolveRelativeTo(path, href, scope.root),
        }),
      imageUrl: (image) => {
        let pending = urls.current.get(image);
        if (!pending) {
          pending = client
            ? client
                .request('workspace.fileUrl', {
                  workspaceId: scope.workspaceId,
                  ...(scope.sessionId !== undefined && { sessionId: scope.sessionId }),
                  path: image,
                })
                .then((result) =>
                  result.url === undefined
                    ? undefined
                    : `${result.url}?v=${Math.round(result.mtimeMs ?? 0)}`,
                )
                .catch(() => undefined)
            : Promise.resolve(undefined);
          urls.current.set(image, pending);
        }
        return pending;
      },
    }),
    [client, path, scope],
  );
  // 内容变了（刷新、回合结束）时图片也重新要地址。
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 只用来清缓存。
  useEffect(() => urls.current.clear(), [text]);
  return (
    <ScrollArea className="h-full">
      <MarkdownView text={text} streaming={false} className="px-5 py-4" document={document} />
    </ScrollArea>
  );
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
      onClick={() =>
        void platformApi()
          .copyText(path)
          .then(() => setCopied(true))
      }
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
  const reveal = () =>
    void platformApi()
      .revealPath(path)
      .catch(() => undefined);
  const open = (id: string) => openInEditor(id, path, line);
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
              className="flex h-7 w-4 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring"
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
          {canOpenExternally(path) && (
            <DropdownMenuItem onClick={() => void openDefault(path)}>
              <AppWindow />
              {t('files.openDefault')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={reveal}>
            <FolderOpen />
            {revealLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
