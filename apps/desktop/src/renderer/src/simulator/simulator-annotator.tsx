// 模拟器的标注（0.122.0，照 Claude Code 的模拟器窗格）：冻结的一帧上画方框、箭头、手绘，点一处写一句文字；完成后合成一张 PNG
// 交给窗格放进当前会话的输入框（不发送）。坐标都按底图的像素记，显示时按 CSS 尺寸缩放。

import { cn } from 'cn';
import { Check, MoveUpRight, Pencil, Square, Type, Undo2, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { formatShortcut } from '@/lib/shortcuts';
import { type Point, SIMULATOR_SHORTCUTS, type Size } from './simulator-model';

export type AnnotationTool = 'box' | 'arrow' | 'pen' | 'text';

export type Shape =
  | { kind: 'box'; from: Point; to: Point }
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'pen'; points: Point[] }
  | { kind: 'text'; at: Point; text: string };

const COLOR = '#ff3b30';

/** 线宽与字号随底图的宽度变（@2x 的 iPhone 截图约 800 像素宽）。 */
function metrics(width: number) {
  const line = Math.max(3, Math.round(width / 110));
  return { line, font: Math.max(14, Math.round(width / 22)) };
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: readonly Shape[], width: number) {
  const { line, font } = metrics(width);
  ctx.lineWidth = line;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLOR;
  ctx.fillStyle = COLOR;
  for (const shape of shapes) {
    if (shape.kind === 'box') {
      const x = Math.min(shape.from.x, shape.to.x);
      const y = Math.min(shape.from.y, shape.to.y);
      ctx.strokeRect(
        x,
        y,
        Math.abs(shape.to.x - shape.from.x),
        Math.abs(shape.to.y - shape.from.y),
      );
    } else if (shape.kind === 'arrow') {
      const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x);
      const head = line * 4;
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(shape.to.x, shape.to.y);
      ctx.lineTo(
        shape.to.x - head * Math.cos(angle - Math.PI / 6),
        shape.to.y - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        shape.to.x - head * Math.cos(angle + Math.PI / 6),
        shape.to.y - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    } else if (shape.kind === 'pen') {
      const [first, ...rest] = shape.points;
      if (!first) continue;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const point of rest) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      ctx.font = `600 ${font}px -apple-system, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      const padding = font * 0.35;
      const textWidth = ctx.measureText(shape.text).width;
      ctx.fillStyle = COLOR;
      ctx.beginPath();
      ctx.roundRect(
        shape.at.x,
        shape.at.y - font * 0.7,
        textWidth + padding * 2,
        font * 1.4,
        font * 0.3,
      );
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(shape.text, shape.at.x + padding, shape.at.y);
      ctx.fillStyle = COLOR;
    }
  }
}

export function SimulatorAnnotator({
  image,
  display,
  radius,
  toolbar,
  onCancel,
  onDone,
}: {
  /** 冻结的一帧：data URL 与像素尺寸。 */
  image: { dataUrl: string; width: number; height: number };
  /** 显示的 CSS 尺寸。 */
  display: Size;
  radius: number;
  /** 窗格底部放工具栏的位置（主工具栏在标注时让出来）。 */
  toolbar: HTMLElement | null;
  onCancel: () => void;
  onDone: (dataUrl: string) => Promise<void>;
}) {
  const [tool, setTool] = useState<AnnotationTool>('box');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape>();
  const [editing, setEditing] = useState<{ at: Point; text: string }>();
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ratio = image.width / display.width;

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, image.width, image.height);
    drawShapes(ctx, draft ? [...shapes, draft] : shapes, image.width);
  }, [shapes, draft, image.width, image.height]);

  const pointAt = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * ratio, y: (event.clientY - rect.top) * ratio };
  };
  const commitText = () => {
    const text = editing?.text.trim();
    if (editing && text)
      setShapes((current) => [...current, { kind: 'text', at: editing.at, text }]);
    setEditing(undefined);
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = pointAt(event);
    if (tool === 'text') {
      event.preventDefault();
      commitText();
      setEditing({ at: point, text: '' });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(
      tool === 'pen' ? { kind: 'pen', points: [point] } : { kind: tool, from: point, to: point },
    );
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const point = pointAt(event);
    setDraft(
      draft.kind === 'pen'
        ? { kind: 'pen', points: [...draft.points, point] }
        : draft.kind === 'text'
          ? draft
          : { ...draft, to: point },
    );
  };
  const onPointerUp = () => {
    if (!draft) return;
    const tiny =
      draft.kind !== 'pen' &&
      draft.kind !== 'text' &&
      Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) < 4;
    if (!tiny) setShapes((current) => [...current, draft]);
    setDraft(undefined);
  };
  const undo = () => setShapes((current) => current.slice(0, -1));

  const finish = async () => {
    commitText();
    const base = new Image();
    base.src = image.dataUrl;
    await base.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(base, 0, 0);
    const pending = editing?.text.trim();
    drawShapes(
      ctx,
      editing && pending ? [...shapes, { kind: 'text', at: editing.at, text: pending }] : shapes,
      image.width,
    );
    setBusy(true);
    try {
      await onDone(canvas.toDataURL('image/png'));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      undo();
    }
  };

  const tools: { id: AnnotationTool; icon: typeof Square; label: string }[] = [
    { id: 'box', icon: Square, label: t('simulator.annotate.box') },
    { id: 'arrow', icon: MoveUpRight, label: t('simulator.annotate.arrow') },
    { id: 'pen', icon: Pencil, label: t('simulator.annotate.pen') },
    { id: 'text', icon: Type, label: t('simulator.annotate.text') },
  ];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 标注区接住 Esc 与 ⌘Z，工具都有按钮。
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative size-full overflow-hidden bg-black outline-none"
      style={{ borderRadius: radius }}
      data-testid="simulator-annotator"
    >
      <img src={image.dataUrl} alt="" className="block size-full select-none" draggable={false} />
      <canvas
        ref={canvasRef}
        width={image.width}
        height={image.height}
        className={cn(
          'absolute inset-0 size-full touch-none',
          tool === 'text' ? 'cursor-text' : 'cursor-crosshair',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="simulator-annotate-canvas"
      />
      {editing && (
        <input
          // biome-ignore lint/a11y/noAutofocus: 点下去就是要写字。
          autoFocus
          value={editing.text}
          maxLength={200}
          aria-label={t('simulator.annotate.text')}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(undefined);
            }
          }}
          onBlur={commitText}
          className="absolute h-7 min-w-24 rounded-md bg-[#ff3b30] px-2 text-sm font-semibold text-white outline-none"
          style={{ left: editing.at.x / ratio, top: editing.at.y / ratio - 14 }}
          data-testid="simulator-annotate-input"
        />
      )}
      {toolbar &&
        createPortal(
          <FloatingBar>
            {tools.map(({ id, icon: Icon, label }) => (
              <IconButton
                key={id}
                label={label}
                tooltipSide="top"
                aria-pressed={tool === id}
                className={cn('rounded-full', tool === id && 'bg-accent text-foreground')}
                onClick={() => setTool(id)}
                data-testid={`simulator-annotate-${id}`}
              >
                <Icon />
              </IconButton>
            ))}
            <IconButton
              label={t('simulator.edit.undo')}
              shortcut={formatShortcut(SIMULATOR_SHORTCUTS.undo)}
              tooltipSide="top"
              className="rounded-full"
              disabled={shapes.length === 0}
              onClick={undo}
            >
              <Undo2 />
            </IconButton>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <IconButton
              label={t('common.cancel')}
              tooltipSide="top"
              className="rounded-full"
              onClick={onCancel}
              data-testid="simulator-annotate-cancel"
            >
              <X />
            </IconButton>
            <Button
              size="sm"
              className="rounded-full"
              disabled={busy}
              onClick={() => void finish()}
              data-testid="simulator-annotate-done"
            >
              <Check />
              {t('simulator.annotate.done')}
            </Button>
          </FloatingBar>,
          toolbar,
        )}
    </div>
  );
}

/** 浮在窗格底部的圆角工具栏（主工具栏与标注共用）。 */
export function FloatingBar({ children }: { children: ReactNode }) {
  return (
    <div
      role="toolbar"
      className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-popover/85 p-1 shadow-md ring-1 ring-foreground/10 backdrop-blur-xl"
    >
      {children}
    </div>
  );
}
