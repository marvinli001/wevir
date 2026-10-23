// 电脑操作（0.112.0，Host 功能 `computer_use`，domain-model §3.15.8）：会话里的 agent 经应用级工具 `computer_*` 读屏并操作用户
// 电脑上的桌面应用。截图、辅助功能与输入要用系统权限，权限归在 Wevir.app 上，所以由桌面端主进程拉起的原生 helper 执行（目前只有
// macOS）；Host 是另一个进程。照内置浏览器的提供方模式（browser.ts）：桌面端渲染进程用 `computer.register` 把自己的连接登记为
// 电脑操作的提供方，Host 经 `computer.request` 通知把工具调用交给它，提供方用 `computer.respond` 回结果。
//
// 授权按应用：agent 先 `request_access`，桌面端弹框请用户逐个应用批准，档位由应用的种类定（浏览器只读，终端与 IDE 只能左键点击，
// 其余完全控制），动作落到哪个应用由 helper 在动作之前按“这个点上最前面的窗口 / 接收按键的最前面的应用”核对。坐标是这个会话最近
// 一张截图里的像素。schema 只做结构声明（host-api.md §10 规则 6），参数的组合由 Host 与提供方校验。

import { z } from 'zod';
import { SessionIdSchema } from './common.js';

/** 电脑操作的命令（提供方在 `computer.register` 里声明自己会的）。 */
export const COMPUTER_COMMANDS = [
  'request_access',
  'list_apps',
  'open_app',
  'screenshot',
  'zoom',
  'ax_tree',
  'ax_find',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'set_value',
  'clipboard_read',
  'clipboard_write',
  'batch',
] as const;
export type ComputerCommandName = (typeof COMPUTER_COMMANDS)[number];

/** 已知的错误码；线缆上是开放字符串。 */
export const COMPUTER_ERROR_CODES = [
  /** 没有提供方（桌面端没开、在重连或太旧）。 */
  'computer_no_host',
  /** 这个平台或系统版本没有电脑操作（目前只有 macOS 14 起）。 */
  'computer_unsupported',
  /** 设置里没打开电脑操作。 */
  'computer_disabled',
  /** Wevir 没有系统的屏幕录制或辅助功能权限。 */
  'computer_permission_missing',
  /** 动作落到的应用没有在这个会话里批准过。 */
  'computer_not_granted',
  /** 应用的档位不允许这个动作（浏览器只读，终端与 IDE 只能左键点击与滚动）。 */
  'computer_tier_denied',
  /** 用户拒绝了授权，或动作落到 Wevir 自己。 */
  'computer_denied',
  /** 用户按 Esc 停止了电脑操作；要继续须重新请求授权。 */
  'computer_stopped',
  'computer_app_not_found',
  'computer_window_not_found',
  /** 元素引用过期了，要重新读辅助功能树。 */
  'computer_stale_ref',
  /** 还没有截图，坐标没法换算。 */
  'computer_no_screenshot',
  'computer_invalid_argument',
  'computer_timeout',
  'computer_unknown_error',
] as const;
export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];

/** 授权的档位：`read` 只读（浏览器）、`click` 只能左键点击与滚动（终端、IDE）、`full` 完全控制。 */
export const ComputerAccessTierSchema = z.enum(['read', 'click', 'full']);
export type ComputerAccessTier = z.infer<typeof ComputerAccessTierSchema>;

/** 电脑操作请求的 ID（Host 生成，`crq_`）。 */
export const ComputerRequestIdSchema = z.templateLiteral([
  'crq_',
  z.string().regex(/^[0-9A-Za-z]{1,64}$/),
]);
export type ComputerRequestId = z.infer<typeof ComputerRequestIdSchema>;

/** 辅助功能树里元素的引用，形如 `@a12`，只在那个应用下一次读树之前有效。 */
export const ComputerRefSchema = z.string().regex(/^@a\d{1,7}$/);
export const ComputerMouseButtonSchema = z.enum(['left', 'right', 'middle']);
export const ComputerModifierSchema = z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn']);
/** 应用：bundle ID（`com.apple.Notes`）或显示名（“备忘录”、Notes）。 */
const app = z.string().min(1).max(200);
/** 截图里的像素坐标。 */
const coordinate = z.number().min(-100_000).max(100_000);

/** 一张截图里或按元素可以做的动作；`batch` 里也是这些（加上 `wait`）。 */
const actionSchemas = [
  z.object({
    command: z.literal('open_app'),
    args: z.object({ app }),
  }),
  /**
   * 截图：不给参数时是一块屏幕，只含这个会话批准过的应用的窗口；给 `app` 时是它最前面的窗口，给 `windowId` 时是那个窗口
   * （被挡住或不在前台也截得到，之后的点击与按键在后台发给它）；`displayId` 选屏幕。
   */
  z.object({
    command: z.literal('screenshot'),
    args: z.object({
      app: app.optional(),
      windowId: z.int().min(1).optional(),
      displayId: z.int().min(0).optional(),
    }),
  }),
  /** 放大最近一张截图里的一块（像素坐标），按屏幕本身的分辨率再截一次。 */
  z.object({
    command: z.literal('zoom'),
    args: z.object({
      x: coordinate,
      y: coordinate,
      width: z.number().min(1).max(100_000),
      height: z.number().min(1).max(100_000),
    }),
  }),
  /** 点击：坐标（最近一张截图里的像素）或元素引用，恰好给一种（Host 校验）。 */
  z.object({
    command: z.literal('click'),
    args: z.object({
      x: coordinate.optional(),
      y: coordinate.optional(),
      ref: ComputerRefSchema.optional(),
      button: ComputerMouseButtonSchema.optional(),
      clickCount: z.int().min(1).max(3).optional(),
      modifiers: z.array(ComputerModifierSchema).max(5).optional(),
    }),
  }),
  /** 输入文字：给 `ref` 时写进那个元素，否则交给接收按键的应用。 */
  z.object({
    command: z.literal('type'),
    args: z.object({ text: z.string().min(1).max(20_000), ref: ComputerRefSchema.optional() }),
  }),
  /** 按键：`cmd+s`、`Return`、`Escape`……`repeat` 次。 */
  z.object({
    command: z.literal('key'),
    args: z.object({
      keys: z.string().min(1).max(64),
      repeat: z.int().min(1).max(50).optional(),
    }),
  }),
  /** 滚动：在坐标或元素上，`dx` / `dy` 是行数，`dy` 为正向下。 */
  z.object({
    command: z.literal('scroll'),
    args: z.object({
      x: coordinate.optional(),
      y: coordinate.optional(),
      ref: ComputerRefSchema.optional(),
      dx: z.int().min(-200).max(200).optional(),
      dy: z.int().min(-200).max(200).optional(),
    }),
  }),
  z.object({
    command: z.literal('drag'),
    args: z.object({ fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate }),
  }),
  /** 设元素的值（文本框、复选框、滑块）。 */
  z.object({
    command: z.literal('set_value'),
    args: z.object({ ref: ComputerRefSchema, value: z.string().max(20_000) }),
  }),
] as const;

/** `batch` 里的一步。 */
export const ComputerActionSchema = z.discriminatedUnion('command', [
  ...actionSchemas,
  z.object({
    command: z.literal('wait'),
    args: z.object({ seconds: z.number().min(0).max(10) }),
  }),
]);
export type ComputerAction = z.infer<typeof ComputerActionSchema>;

/** `batch` 一次最多几步。 */
export const COMPUTER_BATCH_MAX = 20;

export const ComputerCommandSchema = z.discriminatedUnion('command', [
  /** 请用户批准操作这些应用；桌面端弹框，用户逐个批准。 */
  z.object({
    command: z.literal('request_access'),
    args: z.object({
      apps: z.array(app).min(1).max(10),
      reason: z.string().min(1).max(500),
    }),
  }),
  z.object({ command: z.literal('list_apps'), args: z.object({}) }),
  ...actionSchemas,
  /** 读一个应用（或它的一个窗口）的辅助功能树，元素带 `@a12` 这样的引用。 */
  z.object({
    command: z.literal('ax_tree'),
    args: z.object({
      app,
      windowId: z.int().min(1).optional(),
      maxNodes: z.int().min(20).max(2_000).optional(),
    }),
  }),
  /** 按文字（标题、说明、值、标识里含有）与角色找元素。`text` 与 `role` 至少给一个（Host 校验）。 */
  z.object({
    command: z.literal('ax_find'),
    args: z.object({
      app,
      text: z.string().min(1).max(200).optional(),
      role: z.string().min(1).max(64).optional(),
      windowId: z.int().min(1).optional(),
      maxResults: z.int().min(1).max(100).optional(),
    }),
  }),
  z.object({ command: z.literal('clipboard_read'), args: z.object({}) }),
  z.object({
    command: z.literal('clipboard_write'),
    args: z.object({ text: z.string().max(100_000) }),
  }),
  /** 顺序执行几步，遇到错误就停（之后的不做）。 */
  z.object({
    command: z.literal('batch'),
    args: z.object({ actions: z.array(ComputerActionSchema).min(1).max(COMPUTER_BATCH_MAX) }),
  }),
]);
export type ComputerCommand = z.infer<typeof ComputerCommandSchema>;

/** 结果的内容：文字与图片（截图，base64），原样交给模型。 */
export const ComputerContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg']),
  }),
]);
export type ComputerContent = z.infer<typeof ComputerContentSchema>;

/** 一张截图（解码后）的上限。 */
export const COMPUTER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

export const ComputerResultSchema = z.object({
  content: z.array(ComputerContentSchema).min(1).max(40),
});
export type ComputerResult = z.infer<typeof ComputerResultSchema>;

export const ComputerErrorSchema = z.object({
  /** `COMPUTER_ERROR_CODES` 之一，开放字符串。 */
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ComputerError = z.infer<typeof ComputerErrorSchema>;

/** 提供方对一个请求的回答（`computer.respond` 的参数）。失败时 `content` 是失败之前已经做完的步骤（`batch`）。 */
export const ComputerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: ComputerRequestIdSchema,
    ok: z.literal(true),
    result: ComputerResultSchema,
  }),
  z.object({
    requestId: ComputerRequestIdSchema,
    ok: z.literal(false),
    error: ComputerErrorSchema,
    content: z.array(ComputerContentSchema).max(40).optional(),
  }),
]);
export type ComputerResponse = z.infer<typeof ComputerResponseSchema>;

/** Host 交给提供方的一个请求（`computer.request` 通知的参数）。 */
export const ComputerRequestSchema = z.object({
  requestId: ComputerRequestIdSchema,
  /** 调工具的会话：授权、最近一张截图与元素引用都按会话分开。 */
  sessionId: SessionIdSchema,
  command: ComputerCommandSchema,
});
export type ComputerRequest = z.infer<typeof ComputerRequestSchema>;

/** 一个请求的默认时限。 */
export const COMPUTER_DEFAULT_TIMEOUT_MS = 30_000;
/** `request_access` 的时限：等用户在授权框里选。 */
export const COMPUTER_ACCESS_TIMEOUT_MS = 10 * 60_000;
