// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/BrowserDocumentFrame.tsx、DelimitedTablePreview.tsx、AudioPreview.tsx、
// apps/web/src/components/media/MediaVideoPlayer.tsx、apps/web/src/components/chat/ZoomableImage.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 以及 different-ai/openwork apps/app/src/react-app/domains/session/artifacts/artifact-spreadsheet-model.ts、
// artifact-spreadsheet-editor.tsx（来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73，Copyright (c) 2026-present Different AI, Inc.）
// 修改：改写。T3 的网页框架只留工作区文件的那一支（agent 的 html_render 与快捷键转发不要）；视频播放器去掉缩略图、画中画与
// 媒体菜单，换地址不重置播放位置的逻辑保留；可缩放图片的“适应”按窗格大小而不是窗口；xlsx 只读，多个工作表用标签切换，
// 列字母与行号照 Excel；docx / pptx 按段落显示文字（files/office-preview.ts），按幻灯片分段。
//
// 文件窗格（0.32.0，desktop-layout.md §19）里各种文件的显示。地址都是 Host 的流式地址（`workspace.fileUrl`）。

import { cn } from 'cn';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { parseDelimitedPreview } from '@/files/delimited-preview';
import type { OfficeKind } from '@/files/file-preview';
import { openLinkResult, readOpenLinkRequest } from '@/files/html-preview-link';
import { type OfficeSection, officePreview } from '@/files/office-preview';
import {
  columnLetters,
  openXlsxWorkbook,
  type XlsxSheetData,
  type XlsxWorkbook,
} from '@/files/workbook';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';

/** 窗格顶上的一行提示（截断、只显示文字等）。 */
export function SurfaceNotice({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {message}
      </span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RotateCw />
          {t('files.retry')}
        </Button>
      )}
    </div>
  );
}

// ── PDF 与网页（T3 的 BrowserDocumentFrame） ────────────────────────────────

/**
 * Chromium's viewer opens with its own toolbar, a thumbnail rail and a small
 * zoom. The panel header is the only chrome we want, so ask for the page
 * alone, fitted to the panel width.
 */
const PDF_VIEWER_FRAGMENT = '#toolbar=0&view=FitH';

/**
 * PDF 用 Chromium 自带的查看器（要不加沙箱的框架，PDF 不跑脚本）；网页放进沙箱框架，不透明 origin 碰不到应用的会话与存储，
 * Host 给它的响应另带沙箱与不能联网的 CSP（host-api.md §1）；主进程不让子框架跳出 Host 的文件地址。
 */
export function DocumentFrame({ src, title, pdf }: { src: string; title: string; pdf: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // 网页里点的外部链接（Host 插进页面的脚本发来 `ui/open-link`）：框架有焦点、用户刚操作过时才交给系统浏览器（T3 的
  // HtmlRenderDocument）。页面能用脚本抢焦点，这只挡住加载时就打开，挡不住等用户下一次点击的页面。
  useEffect(() => {
    if (pdf) return;
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readOpenLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      void platformApi()
        .openExternal(request.url)
        .catch(() => undefined);
      frame.contentWindow?.postMessage(openLinkResult(request.id), '*');
    };
    window.addEventListener('message', openLink);
    return () => window.removeEventListener('message', openLink);
  }, [pdf]);
  const className = 'h-full w-full border-0 bg-white';
  return pdf ? (
    <iframe
      key={src}
      src={`${src}${PDF_VIEWER_FRAGMENT}`}
      title={title}
      className={className}
      data-testid="file-pdf"
    />
  ) : (
    <iframe
      key={src}
      ref={frameRef}
      src={src}
      title={title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
      data-testid="file-html"
    />
  );
}

// ── CSV / TSV（T3 的 DelimitedTablePreview） ────────────────────────────────

/** A bounded, readable table for CSV and TSV text; the source view keeps every byte. */
export function DelimitedTable({
  name,
  text,
  delimiter,
}: {
  name: string;
  text: string;
  delimiter: ',' | '\t';
}) {
  const table = useMemo(() => parseDelimitedPreview(text, delimiter), [text, delimiter]);
  const [header, ...body] = table.rows;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-table">
      {table.truncated && <SurfaceNotice>{t('files.tableTruncated')}</SurfaceNotice>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-xs" aria-label={name}>
          {header && (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, columnIndex) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表格的列位置固定，值可能相同。
                    key={columnIndex}
                    scope="col"
                    className="max-w-80 border-b border-border bg-muted px-3 py-1.5 text-left align-bottom font-medium break-words whitespace-pre-wrap"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 表格的行位置固定，值可能相同。
              <tr key={rowIndex} className="even:bg-muted/30">
                {row.map((cell, columnIndex) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上。
                    key={columnIndex}
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top break-words whitespace-pre-wrap tabular-nums"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 音视频（T3 的 AudioPreview、MediaVideoPlayer） ─────────────────────────

/** Native playback controls for a workspace audio file. */
export function AudioPlayer({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState<string>();
  if (failed === src) return <Failure message={t('files.mediaFailed')} />;
  return (
    <div className="flex h-full items-center justify-center p-6">
      {/* biome-ignore lint/a11y/useMediaCaption: 会话目录里的音频没有字幕。 */}
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={name}
        className="w-full max-w-xl"
        onError={() => setFailed(src)}
        data-testid="file-audio"
      />
    </div>
  );
}

/**
 * Keeps native range streaming and playback state consistent: a new address (the file changed, or the Host re-issued it)
 * only replaces the source once playback pauses, so the playhead is not reset.
 */
export function VideoPlayer({
  src: latestSrc,
  name,
  onRetry,
}: {
  src: string;
  name: string;
  onRetry: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const src = playing ?? latestSrc;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pauseWhenHidden = () => {
      if (document.hidden && !document.fullscreenElement?.contains(video)) video.pause();
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', pauseWhenHidden);
      video.pause();
    };
  }, []);

  if (failedSrc === src) {
    return (
      <Failure
        message={t('files.mediaFailed')}
        onRetry={() => {
          onRetry();
          setPlaying(null);
          setFailedSrc(null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  const releaseWhenPaused = () => {
    const video = videoRef.current;
    if (!video || video.paused || video.ended) setPlaying(null);
  };
  return (
    <div className="flex h-full items-center justify-center overflow-hidden bg-muted/40">
      {/* biome-ignore lint/a11y/useMediaCaption: 会话目录里的视频没有字幕。 */}
      <video
        key={attempt}
        ref={videoRef}
        src={src}
        aria-label={name}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full bg-black object-contain"
        onPlay={() => setPlaying(src)}
        onPause={releaseWhenPaused}
        onEnded={releaseWhenPaused}
        onError={() => {
          if (src !== latestSrc) setPlaying(null);
          else setFailedSrc(src);
        }}
        data-testid="file-video"
      />
    </div>
  );
}

// ── 可缩放的图片（T3 的 ZoomableImage） ─────────────────────────────────────

const MAX_ZOOM = 8;

/** Zooms around the pointer and keeps the whole image accessible by dragging or scrolling. */
export function ZoomableImage({ src, name }: { src: string; name: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const [failed, setFailed] = useState<string>();
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // 适应窗格（T3 适应的是窗口）：四周留 16px。
  const fit = Math.min(
    1,
    Math.max(1, frame.width - 32) / (naturalSize.width || 1),
    Math.max(1, frame.height - 32) / (naturalSize.height || 1),
  );
  const width = naturalSize.width * fit * zoom;
  const height = naturalSize.height * fit * zoom;

  const changeZoom = (next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const previous = zoomRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!viewport || previous === clamped) return;
    const bounds = viewport.getBoundingClientRect();
    const x = point ? point.x - bounds.left : viewport.clientWidth / 2;
    const y = point ? point.y - bounds.top : viewport.clientHeight / 2;
    anchorRef.current = {
      x: (viewport.scrollLeft + x) / previous,
      y: (viewport.scrollTop + y) / previous,
      clientX: bounds.left + x,
      clientY: bounds.top + y,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  };
  const changeZoomRef = useRef(changeZoom);
  changeZoomRef.current = changeZoom;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    if (!viewport || !anchor) return;
    const bounds = viewport.getBoundingClientRect();
    viewport.scrollLeft = anchor.x * zoom - (anchor.clientX - bounds.left);
    viewport.scrollTop = anchor.y * zoom - (anchor.clientY - bounds.top);
    anchorRef.current = null;
  }, [zoom]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setFrame({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      changeZoomRef.current(zoomRef.current * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, []);

  if (failed === src) return <Failure message={t('files.imageFailed')} />;
  return (
    <div ref={frameRef} className="flex h-full items-center justify-center bg-muted/40">
      <section
        ref={viewportRef}
        aria-label={t('files.zoomableImage', { name })}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: T3 的做法，键盘能缩放与平移。
        tabIndex={0}
        className="max-h-full max-w-full overflow-auto overscroll-contain rounded-sm shadow-xs outline-none focus-visible:focus-ring"
        style={{
          width: width || undefined,
          height: height || undefined,
          cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        onClick={(event) => {
          // Pointer capture also produces a click after dragging; leave the image zoomed.
          if (suppressClickRef.current || event.detail > 1) return;
          changeZoom(zoomRef.current > 1 ? 1 : 2, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!event.repeat) changeZoom(zoomRef.current > 1 ? 1 : 2);
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            changeZoom(zoomRef.current * 1.5);
          } else if (event.key === '-') {
            event.preventDefault();
            changeZoom(zoomRef.current / 1.5);
          } else if (event.key === '0') {
            event.preventDefault();
            changeZoom(1);
          }
        }}
        onPointerDown={(event) => {
          if (dragRef.current) return;
          suppressClickRef.current = false;
          if (event.pointerType !== 'mouse' || event.button !== 0 || zoomRef.current <= 1) return;
          const viewport = event.currentTarget;
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: viewport.scrollLeft,
            top: viewport.scrollTop,
          };
          viewport.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
            suppressClickRef.current = true;
          }
          event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
          event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          data-testid="file-image"
          className="block max-w-none select-none"
          style={naturalSize.width ? { width, height } : { maxWidth: '100%', maxHeight: '100%' }}
          onLoad={(event) =>
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(src)}
        />
      </section>
    </div>
  );
}

// ── Office（OpenWork 的 workbook） ──────────────────────────────────────────

/** 读一个流式地址的字节（xlsx、docx、pptx 在渲染进程里解析）。 */
function useBytes(src: string): { bytes?: Uint8Array; error?: string } {
  const [state, setState] = useState<{ src: string; bytes?: Uint8Array; error?: string }>();
  useEffect(() => {
    let stopped = false;
    fetch(src)
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return new Uint8Array(await response.arrayBuffer());
      })
      .then((bytes) => {
        if (!stopped) setState({ src, bytes });
      })
      .catch((error: unknown) => {
        if (!stopped)
          setState({ src, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      stopped = true;
    };
  }, [src]);
  return state?.src === src ? state : {};
}

/** 表格里最多显示的行与列（OpenWork 的网格上限 GRID_MAX_CELLS 是给编辑用的，这里只读、按窗格能看的量截）。 */
const SHEET_MAX_ROWS = 1000;
const SHEET_MAX_COLUMNS = 100;

interface SheetGrid {
  /** 行号（从 1 开始）。 */
  rows: number[];
  /** 列号（从 1 开始）。 */
  columns: number[];
  cells: Map<string, string>;
  truncated: boolean;
}

/** 一个工作表的网格：从 A1 起，到有值的最后一行、最后一列（照 OpenWork 的 sheetGridRows，超过上限截断而不是报错）。 */
export function sheetGrid(sheet: XlsxSheetData): SheetGrid {
  const lastRow = Math.min(sheet.lastRow, SHEET_MAX_ROWS);
  const lastColumn = Math.min(sheet.lastColumn, SHEET_MAX_COLUMNS);
  const cells = new Map<string, string>();
  for (const cell of sheet.cells) {
    if (cell.row > lastRow || cell.column > lastColumn) continue;
    cells.set(
      `${cell.row}:${cell.column}`,
      cell.displayedValue ?? cell.rawValue ?? (cell.formula ? `=${cell.formula}` : ''),
    );
  }
  return {
    rows: Array.from({ length: sheet.cells.length === 0 ? 0 : lastRow }, (_, index) => index + 1),
    columns: Array.from(
      { length: sheet.cells.length === 0 ? 0 : lastColumn },
      (_, index) => index + 1,
    ),
    cells,
    truncated:
      sheet.lastRow > SHEET_MAX_ROWS ||
      sheet.lastColumn > SHEET_MAX_COLUMNS ||
      sheet.omittedCells > 0,
  };
}

/** xlsx：工作表的标签与只读的网格（列字母、行号照 Excel）。 */
export function SpreadsheetView({ src, name }: { src: string; name: string }) {
  const { bytes, error } = useBytes(src);
  const [workbook, setWorkbook] = useState<{
    bytes: Uint8Array;
    value?: XlsxWorkbook;
    error?: string;
  }>();
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState<{ key: string; data?: XlsxSheetData; error?: string }>();

  useEffect(() => {
    if (!bytes) return;
    let stopped = false;
    openXlsxWorkbook(bytes)
      .then((value) => {
        if (!stopped) setWorkbook({ bytes, value });
      })
      .catch((cause: unknown) => {
        if (!stopped)
          setWorkbook({ bytes, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      stopped = true;
    };
  }, [bytes]);

  const current = workbook?.bytes === bytes ? workbook : undefined;
  const info = current?.value?.sheets[Math.min(active, (current.value.sheets.length || 1) - 1)];
  const sheetKey = info ? `${src}:${info.position}` : undefined;
  useEffect(() => {
    if (!current?.value || !info || !sheetKey) return;
    let stopped = false;
    current.value
      .readSheet(info)
      .then((data) => {
        if (!stopped) setSheet({ key: sheetKey, data });
      })
      .catch((cause: unknown) => {
        if (!stopped)
          setSheet({
            key: sheetKey,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      stopped = true;
    };
  }, [current, info, sheetKey]);

  const loaded = sheet?.key === sheetKey ? sheet : undefined;
  const grid = useMemo(() => (loaded?.data ? sheetGrid(loaded.data) : undefined), [loaded]);
  const failure = error ?? current?.error ?? loaded?.error;
  if (failure !== undefined)
    return <Failure message={t('files.parseFailed', { error: failure })} />;
  if (!current?.value) return <Loading />;
  const sheets = current.value.sheets;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-spreadsheet">
      {grid?.truncated && (
        <SurfaceNotice>
          {t('files.sheetTruncated', { rows: SHEET_MAX_ROWS, columns: SHEET_MAX_COLUMNS })}
        </SurfaceNotice>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!grid ? (
          <Loading />
        ) : grid.rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('files.sheetEmpty')}</p>
        ) : (
          <table
            className="border-separate border-spacing-0 text-xs tabular-nums"
            aria-label={`${name} · ${info?.name ?? ''}`}
          >
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 z-20 min-w-10 border-r border-b border-border bg-muted" />
                {grid.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="min-w-20 border-r border-b border-border bg-muted px-2 py-1 text-center font-medium text-muted-foreground"
                  >
                    {columnLetters(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => (
                <tr key={row}>
                  <th
                    scope="row"
                    className="sticky left-0 border-r border-b border-border bg-muted px-2 py-1 text-right font-medium text-muted-foreground"
                  >
                    {row}
                  </th>
                  {grid.columns.map((column) => (
                    <td
                      key={column}
                      className="max-w-80 border-r border-b border-border/60 px-2 py-1 align-top break-words whitespace-pre-wrap"
                    >
                      {grid.cells.get(`${row}:${column}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheets.length > 1 && (
        <div
          role="tablist"
          aria-label={t('files.sheets')}
          className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border px-1.5"
        >
          {sheets.map((entry, index) => (
            <button
              key={entry.position}
              type="button"
              role="tab"
              aria-selected={entry === info}
              onClick={() => setActive(index)}
              className={cn(
                'h-6 shrink-0 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring',
                entry === info && 'bg-accent text-foreground',
              )}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** docx / pptx：按段落显示文字（格式、图片与版式不显示，顶上说明，完整的看系统预览）。 */
export function OfficeTextView({ src, kind }: { src: string; kind: Exclude<OfficeKind, 'xlsx'> }) {
  const { bytes, error } = useBytes(src);
  const [preview, setPreview] = useState<{
    bytes: Uint8Array;
    value?: Awaited<ReturnType<typeof officePreview>>;
    error?: string;
  }>();
  useEffect(() => {
    if (!bytes) return;
    let stopped = false;
    officePreview(kind, bytes)
      .then((value) => {
        if (!stopped) setPreview({ bytes, value });
      })
      .catch((cause: unknown) => {
        if (!stopped)
          setPreview({ bytes, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      stopped = true;
    };
  }, [bytes, kind]);
  const current = preview?.bytes === bytes ? preview : undefined;
  const failure = error ?? current?.error;
  if (failure !== undefined)
    return <Failure message={t('files.parseFailed', { error: failure })} />;
  if (current?.value === undefined) return <Loading />;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-document">
      <SurfaceNotice>{t('files.textOnly')}</SurfaceNotice>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-6 text-sm leading-relaxed">
          {current.value.sections.map((section) => (
            <section key={`${section.kind}:${section.label ?? ''}`} className="space-y-2">
              {section.kind !== 'body' && (
                <h3 className="text-xs font-medium text-muted-foreground">
                  {sectionTitle(section)}
                </h3>
              )}
              {section.paragraphs.map((paragraph, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 段落按位置排列。
                <p key={index} className="break-words whitespace-pre-wrap">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function sectionTitle(section: OfficeSection): string {
  const n = Number(section.label);
  if (section.kind === 'slide') return t('files.slide', { n });
  if (section.kind === 'notes') return t('files.slideNotes', { n });
  return section.label ?? '';
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t('common.loading')}
    </div>
  );
}
