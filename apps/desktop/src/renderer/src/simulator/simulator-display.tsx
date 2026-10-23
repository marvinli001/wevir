// 模拟器的屏幕（0.122.0）：画面流的帧经 WebCodecs `VideoDecoder`（avc1，配置帧作 `description`）解码后画到 canvas；指针换算成
// 设备的点逐事件发 `touch_raw`（按住 Option 拖动是以屏幕中心对称的两根手指，照 Simulator.app）；获得焦点时键盘转成 `text` /
// `key`。键盘落在一个看不见的 textarea 上，输入法的合成文字与粘贴都由它接住；⌘ 组合留给窗格的快捷键（simulator-pane.tsx）。

import type { SimulatorFrame, WevirClient } from '@wevir/client-sdk';
import type {
  SessionId,
  SimulatorInput,
  SimulatorOrientation,
  SimulatorUdid,
} from '@wevir/protocol';
import { cn } from 'cn';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { t } from '@/i18n';
import { subscribeFeed, useMacClipboard } from './simulator-feed';
import {
  avcCodecString,
  mirrorPoint,
  namedKeyInput,
  type Point,
  type Size,
  toDevicePoint,
} from './simulator-model';

/** 解码队列积压到这么多帧时扔掉差分帧，等下一个关键帧。 */
const MAX_DECODE_QUEUE = 30;

export interface SimulatorDisplayHandle {
  focus(): void;
  /**
   * 把 Mac 的剪贴板交给设备（Edit 菜单）：`paste` 发过去再按 ⌘V，`send` 只发过去。经 textarea 的粘贴事件读剪贴板，读不到时返回
   * false。
   */
  pasteFromMac(mode: 'paste' | 'send'): boolean;
  /** 当前画面（canvas）；冻结标注的底图在截图失败时用它。 */
  canvas(): HTMLCanvasElement | null;
}

export function SimulatorDisplay({
  client,
  udid,
  sessionId,
  points,
  radius,
  onPixels,
  send,
  handle,
}: {
  client: WevirClient;
  udid: SimulatorUdid;
  sessionId: SessionId | undefined;
  /** 屏幕的点尺寸（当前方向）；还没出画面时 undefined。 */
  points: Size | undefined;
  /** 屏幕圆角（CSS 像素）。 */
  radius: number;
  /** 解码出的像素尺寸或方向变了（第一帧、旋转后）。 */
  onPixels: (pixels: Size, orientation: SimulatorOrientation | undefined) => void;
  send: (input: SimulatorInput) => void;
  handle?: Ref<SimulatorDisplayHandle>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const onPixelsRef = useRef(onPixels);
  onPixelsRef.current = onPixels;
  const [focused, setFocused] = useState(false);
  const pasteMode = useRef<'paste' | 'send' | undefined>(undefined);

  useImperativeHandle(handle, () => ({
    focus: () => keysRef.current?.focus({ preventScroll: true }),
    canvas: () => canvasRef.current,
    pasteFromMac: (mode) => {
      const keys = keysRef.current;
      if (!keys) return false;
      keys.focus({ preventScroll: true });
      pasteMode.current = mode;
      try {
        return document.execCommand('paste');
      } finally {
        pasteMode.current = undefined;
      }
    },
  }));

  useEffect(() => {
    let decoder: VideoDecoder | undefined;
    let config: { codec: string; description: Uint8Array } | undefined;
    let waitingForKey = true;
    let width = 0;
    let height = 0;
    let orientation: SimulatorOrientation | undefined;
    const draw = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (canvas) {
        if (frame.displayWidth !== width || frame.displayHeight !== height) {
          width = frame.displayWidth;
          height = frame.displayHeight;
          canvas.width = width;
          canvas.height = height;
          onPixelsRef.current({ width, height }, orientation);
        }
        canvas.getContext('2d')?.drawImage(frame, 0, 0);
      }
      frame.close();
    };
    const create = () => {
      decoder?.close();
      decoder = new VideoDecoder({
        output: draw,
        error: () => {
          // 解码出错（码流断了一截）：重建解码器，等下一个配置或关键帧。
          decoder = undefined;
          waitingForKey = true;
          if (config) configure(config);
        },
      });
    };
    const configure = (next: { codec: string; description: Uint8Array }) => {
      config = next;
      if (!decoder || decoder.state === 'closed') create();
      decoder?.configure({
        codec: next.codec,
        description: next.description,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
      });
      waitingForKey = true;
    };
    const onFrame = (frame: SimulatorFrame) => {
      if (frame.kind === 'size') {
        if (frame.size.orientation !== orientation) {
          orientation = frame.size.orientation;
          if (width > 0) onPixelsRef.current({ width, height }, orientation);
        }
        return;
      }
      if (frame.kind === 'config') {
        configure({ codec: avcCodecString(frame.data), description: frame.data.slice() });
        return;
      }
      if (decoder?.state !== 'configured') return;
      if (frame.kind === 'delta' && (waitingForKey || decoder.decodeQueueSize > MAX_DECODE_QUEUE)) {
        waitingForKey = true;
        return;
      }
      waitingForKey = false;
      decoder.decode(
        new EncodedVideoChunk({
          type: frame.kind === 'key' ? 'key' : 'delta',
          timestamp: frame.ptsMicros,
          data: frame.data,
        }),
      );
    };
    const unsubscribe = subscribeFeed(client, udid, sessionId, { onFrame });
    return () => {
      unsubscribe();
      if (decoder && decoder.state !== 'closed') decoder.close();
    };
  }, [client, udid, sessionId]);

  // ── 指针 ──
  const touching = useRef<{ pointerId: number; twoFingers: boolean } | undefined>(undefined);
  const [hover, setHover] = useState<{ point: Point; twoFingers: boolean }>();

  const pointAt = (event: PointerEvent<HTMLCanvasElement>): Point | undefined => {
    if (!points) return undefined;
    const rect = event.currentTarget.getBoundingClientRect();
    return toDevicePoint({ x: event.clientX, y: event.clientY }, rect, points);
  };
  const touch = (phase: 'down' | 'move' | 'up', point: Point, twoFingers: boolean) => {
    send({ type: 'touch_raw', phase, x: point.x, y: point.y, finger: 0 });
    if (twoFingers && points) {
      const mirrored = mirrorPoint(point, points);
      send({ type: 'touch_raw', phase, x: mirrored.x, y: mirrored.y, finger: 1 });
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || touching.current) return;
    const point = pointAt(event);
    if (!point) return;
    event.preventDefault();
    keysRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    touching.current = { pointerId: event.pointerId, twoFingers: event.altKey };
    touch('down', point, event.altKey);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointAt(event);
    if (!point) return;
    const current = touching.current;
    setHover({ point, twoFingers: current?.twoFingers ?? event.altKey });
    if (current?.pointerId === event.pointerId) touch('move', point, current.twoFingers);
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = touching.current;
    if (current?.pointerId !== event.pointerId) return;
    touching.current = undefined;
    const point = pointAt(event);
    if (point) touch('up', point, current.twoFingers);
  };

  // Option 按下、松开时更新两指的标记（指针不动也要变）。
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Alt' || touching.current) return;
      setHover((current) => current && { ...current, twoFingers: event.type === 'keydown' });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  // ── 键盘 ──
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const input = namedKeyInput(event);
    if (!input) return;
    event.preventDefault();
    send(input);
  };
  const flushText = (target: HTMLTextAreaElement) => {
    const text = target.value;
    target.value = '';
    if (text !== '') send({ type: 'text', text });
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    const mode = pasteMode.current ?? (useMacClipboard.get() ? 'paste' : 'device');
    if (mode === 'device' || text === '') {
      if (mode !== 'send') send({ type: 'key', key: 'paste' });
      return;
    }
    void client
      .request('simulator.clipboard.set', { udid, text })
      .then(() => {
        if (mode === 'paste') send({ type: 'key', key: 'paste' });
      })
      .catch(() => {});
  };

  const scale = points && canvasRef.current ? canvasRef.current.clientWidth / points.width : 1;
  const marks =
    hover && points
      ? [hover.point, ...(hover.twoFingers ? [mirrorPoint(hover.point, points)] : [])]
      : [];

  return (
    <div
      className={cn(
        'relative size-full overflow-hidden bg-black transition-shadow duration-150',
        focused && 'ring-2 ring-primary/40',
      )}
      style={{ borderRadius: radius }}
    >
      <canvas
        ref={canvasRef}
        className="block size-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(undefined)}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="simulator-canvas"
      />
      {hover?.twoFingers &&
        marks.map((mark, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 两个标记的位置就是它们的身份。
            key={index}
            aria-hidden
            className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/80 bg-white/30"
            style={{ left: mark.x * scale, top: mark.y * scale }}
          />
        ))}
      <textarea
        ref={keysRef}
        aria-label={t('simulator.keyboard')}
        className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
        tabIndex={-1}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onInput={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) flushText(event.currentTarget);
        }}
        onCompositionEnd={(event) => flushText(event.currentTarget)}
        onPaste={onPaste}
        data-testid="simulator-keys"
      />
    </div>
  );
}
