// iOS 模拟器窗格（0.122.0，desktop-layout.md §44）的纯逻辑：设备分组与默认设备、指针换算成设备的点、键盘映射、缩放档位、
// 设备外框的尺寸、文件名。组件在 layout/panes/simulator-pane.tsx 与本目录的其他文件。

import type {
  SimulatorDevice,
  SimulatorDeviceType,
  SimulatorFamily,
  SimulatorInput,
  SimulatorOrientation,
  SimulatorRuntime,
} from '@wevir/protocol';
import type { Shortcut } from '@/lib/shortcuts';

/** 窗格里的快捷键（照 Simulator.app 与 Claude Code 的模拟器窗格），只在窗格获得焦点时生效。 */
export const SIMULATOR_SHORTCUTS = {
  home: { code: 'KeyH', mod: true, shift: true },
  rotateRight: { code: 'ArrowRight', mod: true },
  rotateLeft: { code: 'ArrowLeft', mod: true },
  screenshot: { code: 'KeyS', mod: true },
  record: { code: 'KeyR', mod: true },
  zoomIn: { code: 'Equal', mod: true },
  zoomOut: { code: 'Minus', mod: true },
  fit: { code: 'Digit0', mod: true },
  actualSize: { code: 'Digit1', mod: true },
  undo: { code: 'KeyZ', mod: true },
  redo: { code: 'KeyZ', mod: true, shift: true },
  cut: { code: 'KeyX', mod: true },
  copy: { code: 'KeyC', mod: true },
  paste: { code: 'KeyV', mod: true },
  selectAll: { code: 'KeyA', mod: true },
} as const satisfies Record<string, Shortcut>;

/** 设备选择器的两组：已启动的与可以启动的（运行时还在的 iOS 设备）。 */
export function deviceGroups(devices: readonly SimulatorDevice[]): {
  booted: SimulatorDevice[];
  available: SimulatorDevice[];
} {
  const ios = devices.filter((device) => device.platform === 'ios');
  return {
    booted: ios.filter((device) => device.state === 'booted' || device.state === 'booting'),
    available: ios.filter((device) => device.state === 'shutdown' && device.available),
  };
}

/** 窗格打开时看哪台：agent 在这个会话里 attach 过的已启动设备，否则第一台已启动的；都没有时不选。 */
export function defaultDevice(
  devices: readonly SimulatorDevice[],
  sessionId: string | undefined,
): SimulatorDevice | undefined {
  const { booted } = deviceGroups(devices);
  return (
    (sessionId === undefined
      ? undefined
      : booted.find((device) => (device.attachedBy as readonly string[]).includes(sessionId))) ??
    booted[0]
  );
}

/** 新增模拟器的默认值：第一个 iPhone 设备类型（Host 按新到旧列出，iPod 也算 iphone 一族）与最新的可用 iOS 运行时。 */
export function defaultNewDevice(
  deviceTypes: readonly SimulatorDeviceType[],
  runtimes: readonly SimulatorRuntime[],
): { deviceTypeId: string; runtimeId: string; name: string } | undefined {
  const phones = deviceTypes.filter((candidate) => candidate.family === 'iphone');
  const type = phones.find((candidate) => candidate.name.startsWith('iPhone')) ?? phones[0];
  const runtime = runtimes
    .filter((candidate) => candidate.available && candidate.platform === 'ios')
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (type === undefined || runtime === undefined) return undefined;
  return { deviceTypeId: type.id, runtimeId: runtime.id, name: type.name };
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 指针在屏幕元素上的位置换算成设备的点（当前方向，左上原点），夹在屏幕之内。 */
export function toDevicePoint(
  client: Point,
  rect: { left: number; top: number; width: number; height: number },
  screen: Size,
): Point {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const x = ((client.x - rect.left) / rect.width) * screen.width;
  const y = ((client.y - rect.top) / rect.height) * screen.height;
  return { x: round(clamp(x, screen.width)), y: round(clamp(y, screen.height)) };
}

/** Option 拖动的第二根手指：以屏幕中心为对称点（照 Simulator.app 的捏合）。 */
export function mirrorPoint(point: Point, screen: Size): Point {
  return { x: round(screen.width - point.x), y: round(screen.height - point.y) };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** 窗格里没有修饰键（⌘、⌃）的按键对应的设备按键；可打印的字符走 `text`，返回 undefined。 */
const NAMED_KEYS: Readonly<Record<string, Extract<SimulatorInput, { type: 'key' }>['key']>> = {
  Enter: 'return',
  Backspace: 'delete',
  Delete: 'forward_delete',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'page_up',
  PageDown: 'page_down',
  Tab: 'tab',
  Escape: 'escape',
};

export function namedKeyInput(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
): SimulatorInput | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  const key = NAMED_KEYS[event.key];
  return key === undefined ? undefined : { type: 'key', key };
}

/** 缩放档位（设备的点对 CSS 像素）；“实际大小”是 1。 */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const ZOOM_EPSILON = 0.005;

export type Zoom = { mode: 'fit' } | { mode: 'fixed'; scale: number };

export function zoomIn(current: number): number {
  return ZOOM_STEPS.find((step) => step > current + ZOOM_EPSILON) ?? ZOOM_STEPS.at(-1) ?? current;
}

export function zoomOut(current: number): number {
  return [...ZOOM_STEPS].reverse().find((step) => step < current - ZOOM_EPSILON) ?? ZOOM_STEPS[0];
}

/** 设备外框的尺寸（点）：屏幕圆角与边框宽度，照各类设备的大致比例。 */
export function bezelOf(family: SimulatorFamily | undefined): { bezel: number; radius: number } {
  if (family === 'ipad') return { bezel: 22, radius: 18 };
  return { bezel: 14, radius: 55 };
}

export interface SideButton {
  edge: 'left' | 'right' | 'top' | 'bottom';
  /** 沿这条边从起点（左边、上边）量起的位置与长度，按外框这条边的比例。 */
  start: number;
  length: number;
}

/** iPhone 竖放时的侧键：左边是操作按钮与音量键，右边是电源键。 */
const PORTRAIT_BUTTONS: readonly SideButton[] = [
  { edge: 'left', start: 0.17, length: 0.035 },
  { edge: 'left', start: 0.245, length: 0.065 },
  { edge: 'left', start: 0.325, length: 0.065 },
  { edge: 'right', start: 0.27, length: 0.1 },
];

/**
 * 外框上的侧键随方向转：`landscapeLeft` 是设备逆时针转了 90 度（顶部朝左），`landscapeRight` 顺时针。iPad 不画侧键。
 */
export function sideButtons(
  family: SimulatorFamily | undefined,
  orientation: SimulatorOrientation | undefined,
): SideButton[] {
  if (family === 'ipad') return [];
  return PORTRAIT_BUTTONS.map((button) => {
    const flipped = 1 - button.start - button.length;
    switch (orientation) {
      case 'landscapeLeft':
        return {
          edge: button.edge === 'left' ? 'bottom' : 'top',
          start: button.start,
          length: button.length,
        };
      case 'landscapeRight':
        return {
          edge: button.edge === 'left' ? 'top' : 'bottom',
          start: flipped,
          length: button.length,
        };
      case 'portraitUpsideDown':
        return {
          edge: button.edge === 'left' ? 'right' : 'left',
          start: flipped,
          length: button.length,
        };
      default:
        return button;
    }
  });
}

/** 适应窗格的缩放：整台设备（屏幕加外框）放得下，最大 3 倍。 */
export function fitScale(available: Size, screen: Size, bezel: number): number {
  const width = screen.width + bezel * 2;
  const height = screen.height + bezel * 2;
  if (available.width <= 0 || available.height <= 0) return 1;
  return Math.min(available.width / width, available.height / height, 3);
}

/** 解码出的像素尺寸换算成点尺寸（像素 = 点 × 倍率）。 */
export function pointsOf(pixels: Size, scale: number): Size {
  return { width: pixels.width / scale, height: pixels.height / scale };
}

/** avcC 记录对应的 WebCodecs codec 字符串（`avc1.PPCCLL`：profile、约束、level）。 */
export function avcCodecString(avcc: Uint8Array): string {
  const hex = (value: number | undefined) => (value ?? 0).toString(16).padStart(2, '0');
  return `avc1.${hex(avcc[1])}${hex(avcc[2])}${hex(avcc[3])}`;
}

/** 截图与录像的默认文件名：`Simulator <设备> <日期 时.分.秒>.<扩展名>`（macOS 文件名里不放冒号）。 */
export function captureFileName(deviceName: string, date: Date, extension: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const safe = deviceName.replace(/[/\\:]/g, '-');
  return `Simulator ${safe} ${day} ${time}.${extension}`;
}

/** 录制时长：`m:ss`。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
