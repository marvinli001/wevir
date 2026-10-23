// iOS 模拟器（0.122.0，Host 功能 `ios_simulator`，domain-model §3.15.9）：Host 管模拟器的生命周期与应用（`xcrun simctl`），取帧、
// 输入、旋转、录像与辅助功能树交给 Host 拉起的原生 helper（`wevir-ios-simulator`，私有的 CoreSimulator 接口，不涉及系统权限）。
// 窗格用 `simulator.*`，agent 用应用级工具 `simulator_control` / `simulator_build`，两边操作的是同一台设备。
//
// 画面不走 JSON-RPC：`simulator.attach` 给出一次性的令牌，客户端连 Host 的 RPC 端口上的 `GET /simulator/stream?token=…`
// （WebSocket，只收二进制帧）。每条消息是一帧，格式见 `SIMULATOR_FRAME_*`。坐标都是设备的点（左上原点），与 helper 一致。
// 先只有 iOS；`platform` 留给以后的 Android。schema 只做结构声明（host-api.md §10 规则 6），参数的组合由 Host 校验。

import { z } from 'zod';
import { SessionIdSchema, SimulatorRecordingIdSchema } from './common.js';

/** 设备标识：simctl 的 UDID（以后 Android 是 adb 的序列号）。 */
export const SimulatorUdidSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9A-Za-z._:-]+$/);
export type SimulatorUdid = z.infer<typeof SimulatorUdidSchema>;

export const SimulatorPlatformSchema = z.enum(['ios']);
export const SimulatorFamilySchema = z.enum(['iphone', 'ipad', 'watch', 'tv', 'vision', 'other']);
export type SimulatorFamily = z.infer<typeof SimulatorFamilySchema>;
export const SimulatorStateSchema = z.enum(['booted', 'shutdown', 'booting', 'shuttingDown']);
export type SimulatorState = z.infer<typeof SimulatorStateSchema>;
export const SimulatorOrientationSchema = z.enum([
  'portrait',
  'portraitUpsideDown',
  'landscapeLeft',
  'landscapeRight',
]);
export type SimulatorOrientation = z.infer<typeof SimulatorOrientationSchema>;

/** 屏幕：点尺寸与倍率（像素 = 点 × scale），按当前方向。 */
export const SimulatorScreenSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  scale: z.number().positive(),
});
export type SimulatorScreen = z.infer<typeof SimulatorScreenSchema>;

export const SimulatorDeviceSchema = z.object({
  udid: SimulatorUdidSchema,
  name: z.string(),
  platform: SimulatorPlatformSchema,
  /** 运行时标识（`com.apple.CoreSimulator.SimRuntime.iOS-26-5`）。 */
  runtime: z.string(),
  /** 系统版本（`26.5`）；运行时不在了时是空串。 */
  osVersion: z.string(),
  family: SimulatorFamilySchema,
  /** 设备类型标识（`com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`）。 */
  deviceTypeId: z.string().optional(),
  state: SimulatorStateSchema,
  /** 运行时不可用（Xcode 换了版本）时 false，不能启动。 */
  available: z.boolean(),
  /** 这台设备在哪些会话里 attach 过（agent 的 `attach` 与窗格带 `sessionId` 的 `simulator.attach`）。 */
  attachedBy: z.array(SessionIdSchema),
});
export type SimulatorDevice = z.infer<typeof SimulatorDeviceSchema>;

/** 可以新建的设备类型。 */
export const SimulatorDeviceTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  family: SimulatorFamilySchema,
});
export type SimulatorDeviceType = z.infer<typeof SimulatorDeviceTypeSchema>;

export const SimulatorRuntimeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  platform: SimulatorPlatformSchema,
  version: z.string(),
  available: z.boolean(),
});
export type SimulatorRuntime = z.infer<typeof SimulatorRuntimeSchema>;

/** 已知的错误码（helper 与 simctl 的失败、`SIMULATOR_FAILED` 的 `data.code`）；线缆上是开放字符串。 */
export const SIMULATOR_ERROR_CODES = [
  'sim_not_found',
  'sim_not_booted',
  /** 没装 Xcode，或 CoreSimulator 加载不了。 */
  'sim_framework_missing',
  'sim_hid_unavailable',
  'sim_stream_failed',
  'sim_ax_unavailable',
  'sim_invalid_argument',
  'sim_timeout',
  'sim_unknown_error',
  /** helper 没起来或退出了（Host 会重启它）。 */
  'sim_helper_unavailable',
  /** `xcrun simctl` 失败（原因在消息里）。 */
  'sim_simctl_failed',
  /** 设置的 `iosSimulator` 关着。 */
  'sim_disabled',
] as const;
export type SimulatorErrorCode = (typeof SIMULATOR_ERROR_CODES)[number];

export const SIMULATOR_KEYS = [
  'return',
  'delete',
  'forward_delete',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'page_up',
  'page_down',
  'tab',
  'escape',
  'select_all',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
] as const;
export const SimulatorKeySchema = z.enum(SIMULATOR_KEYS);

export const SIMULATOR_BUTTONS = [
  'HOME',
  'LOCK',
  'SIDE_BUTTON',
  'SIRI',
  'APPLE_PAY',
  'VOLUME_UP',
  'VOLUME_DOWN',
] as const;
export const SimulatorButtonSchema = z.enum(SIMULATOR_BUTTONS);

/** `simulator.input` 一次 `text` 的上限（字符）。 */
export const SIMULATOR_TEXT_MAX_LENGTH = 10_000;
/** 一次 `touch` 的采样点上限。 */
export const SIMULATOR_TOUCH_POINTS_MAX = 1000;

const Coord = z.number().min(-10_000).max(10_000);
const DtMs = z.number().min(0).max(1000);

export const SimulatorTouchPointSchema = z.object({ x: Coord, y: Coord, dtMs: DtMs });
export const SimulatorTouch2PointSchema = z.object({
  x1: Coord,
  y1: Coord,
  x2: Coord,
  y2: Coord,
  dtMs: DtMs,
});

/** 一个输入（helper 的同名命令）。`touch` 是一整段手势，`touch_raw` 是窗格的实时拖动，逐事件下发。 */
export const SimulatorInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tap'),
    x: Coord,
    y: Coord,
    /** 按住的秒数，超过 0.5 是长按。 */
    duration: z.number().min(0).max(10).optional(),
  }),
  z.object({
    type: z.literal('touch'),
    points: z.array(SimulatorTouchPointSchema).min(1).max(SIMULATOR_TOUCH_POINTS_MAX).optional(),
    points2: z.array(SimulatorTouch2PointSchema).min(1).max(SIMULATOR_TOUCH_POINTS_MAX).optional(),
  }),
  z.object({
    type: z.literal('touch_raw'),
    phase: z.enum(['down', 'move', 'up']),
    x: Coord,
    y: Coord,
    finger: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(SIMULATOR_TEXT_MAX_LENGTH) }),
  z.object({
    type: z.literal('key'),
    key: SimulatorKeySchema,
    count: z.int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal('button'),
    name: SimulatorButtonSchema,
    duration: z.number().min(0).max(10).optional(),
  }),
  z.object({ type: z.literal('rotate'), direction: z.enum(['left', 'right']) }),
]);
export type SimulatorInput = z.infer<typeof SimulatorInputSchema>;

// ── 方法 ────────────────────────────────────────────────────────────────

/** `simulator.list`：全部设备（已启动的在前）、可以新建的设备类型与运行时。 */
export const SimulatorListParamsSchema = z.object({});
export const SimulatorListResultSchema = z.object({
  devices: z.array(SimulatorDeviceSchema),
  deviceTypes: z.array(SimulatorDeviceTypeSchema),
  runtimes: z.array(SimulatorRuntimeSchema),
});

export const SimulatorUdidParamsSchema = z.object({ udid: SimulatorUdidSchema });
export const SimulatorEmptyResultSchema = z.object({});

/** `simulator.create`：新建设备（不启动）。 */
export const SimulatorCreateParamsSchema = z.object({
  name: z.string().min(1).max(100),
  deviceTypeId: z.string().min(1).max(200),
  runtimeId: z.string().min(1).max(200),
});
export const SimulatorCreateResultSchema = z.object({ device: SimulatorDeviceSchema });

/**
 * `simulator.attach`：要看这台设备的画面。没启动的先启动；Host 向 helper 要一路流（已有就共用）。`streamUrl` 是带令牌的
 * `ws://127.0.0.1:<端口>/simulator/stream?token=…`，令牌只连一次、只对这台设备有效，30 秒内不连就作废。给了 `sessionId` 时设备记在
 * 那个会话的 `attachedBy` 里，agent 不指定设备时用它。同一条连接对同一台设备再调一次会作废旧令牌、断开旧的流。
 */
export const SimulatorAttachParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  sessionId: SessionIdSchema.optional(),
});
export const SimulatorAttachResultSchema = z.object({
  streamUrl: z.string(),
  token: z.string().min(1),
  screen: SimulatorScreenSchema,
  orientation: SimulatorOrientationSchema,
});

/** `simulator.detach`：这条连接不再看这台设备（断开它的流）。没 attach 过也算成功。 */
export const SimulatorDetachParamsSchema = SimulatorUdidParamsSchema;

/** `simulator.input`：`rotate` 的结果带新方向。 */
export const SimulatorInputParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  input: SimulatorInputSchema,
});
export const SimulatorInputResultSchema = z.object({
  orientation: SimulatorOrientationSchema.optional(),
});

/**
 * `simulator.screenshot`：给了 `path`（绝对路径，客户端让用户选的）时写到那里，结果带 `path`；否则结果带 base64 的 `data`。
 * `scale` 相对点尺寸：1（默认）是点，2 是 @2x，取屏幕倍率就是像素。`width` / `height` 是图片的像素。
 */
export const SimulatorScreenshotParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  format: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().min(0).max(1).optional(),
  scale: z.number().min(0.25).max(4).optional(),
  path: z.string().min(1).optional(),
});
export const SimulatorScreenshotResultSchema = z.object({
  path: z.string().optional(),
  data: z.string().optional(),
  mimeType: z.enum(['image/png', 'image/jpeg']),
  width: z.int().positive(),
  height: z.int().positive(),
});

/** `simulator.record.start`：录到 Host 的临时目录；一台设备同时只录一段。 */
export const SimulatorRecordStartParamsSchema = SimulatorUdidParamsSchema;
export const SimulatorRecordStartResultSchema = z.object({
  recordingId: SimulatorRecordingIdSchema,
});
/** `simulator.record.stop`：结果是 Host 临时目录里的 .mp4，客户端另存后它在 Host 退出时清掉。 */
export const SimulatorRecordStopParamsSchema = z.object({
  recordingId: SimulatorRecordingIdSchema,
});
export const SimulatorRecordStopResultSchema = z.object({
  path: z.string(),
  durationMs: z.int().nonnegative(),
});

/**
 * `simulator.configure`：只改给出的项。`statusBar: clean` 是 9:41、满格信号与电量（simctl `status_bar override`），`live` 清掉覆盖。
 * `hardwareKeyboard` 连上或断开 Mac 的键盘；`softwareKeyboard` 显示或收起屏幕键盘。
 */
export const SimulatorConfigureParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  appearance: z.enum(['light', 'dark']).optional(),
  statusBar: z.enum(['live', 'clean']).optional(),
  slowAnimations: z.boolean().optional(),
  hardwareKeyboard: z.boolean().optional(),
  softwareKeyboard: z.enum(['show', 'hide']).optional(),
});

/** `simulator.clipboard.get` / `.set`：设备的剪贴板（纯文本）。 */
export const SimulatorClipboardGetResultSchema = z.object({ text: z.string() });
export const SimulatorClipboardSetParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  text: z.string().max(1_000_000),
});

// ── 通知 ────────────────────────────────────────────────────────────────

/** `simulator.changed`：设备列表或某台的状态、`attachedBy` 变了，带全部设备。 */
export const SimulatorChangedParamsSchema = z.object({
  devices: z.array(SimulatorDeviceSchema),
});

/** `simulator.show`：agent 在这个会话里 attach 了设备，请界面在那个会话旁打开模拟器窗格。 */
export const SimulatorShowParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  sessionId: SessionIdSchema,
});

/** `simulator.orientation`：设备转了方向（屏幕的点尺寸随之交换）。 */
export const SimulatorOrientationParamsSchema = z.object({
  udid: SimulatorUdidSchema,
  orientation: SimulatorOrientationSchema,
  screen: SimulatorScreenSchema.optional(),
});

// ── 画面流的帧 ──────────────────────────────────────────────────────────

/**
 * `/simulator/stream` 上每条二进制消息是一帧：`u8 kind | u64 ptsMicros | u32 length | bytes`，大端。与 helper 在 fd 3 上的帧相同，只是
 * 去掉了开头的 `u32 streamId`（一条 WebSocket 只有一台设备）。新连接先收最近的尺寸、编解码配置与关键帧。
 */
export const SIMULATOR_FRAME_HEADER_BYTES = 13;
export const SIMULATOR_FRAME_KIND = {
  /** 编解码配置：`avcC` 记录，WebCodecs `VideoDecoder.configure` 的 `description`。 */
  config: 0,
  key: 1,
  delta: 2,
  /** 尺寸变化：payload 是 UTF-8 JSON `{width, height, orientation}`（像素），之后是新的配置与关键帧。 */
  size: 3,
} as const;
export type SimulatorFrameKind = (typeof SIMULATOR_FRAME_KIND)[keyof typeof SIMULATOR_FRAME_KIND];

/** 尺寸变化帧的 payload。 */
export const SimulatorFrameSizeSchema = z.object({
  width: z.int().positive(),
  height: z.int().positive(),
  orientation: SimulatorOrientationSchema,
});
export type SimulatorFrameSize = z.infer<typeof SimulatorFrameSizeSchema>;

/** 流的路径（与 RPC 同端口）。 */
export const SIMULATOR_STREAM_PATH = '/simulator/stream';
