// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/protocol/src/browser-automation/rpc-schemas.ts 与 capabilities.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：命令按 Wevir 的取舍（去掉 evaluate、upload、resize，加上请界面显示标签页的 show）；schema 只做结构声明（host-api.md
// §10 规则 6：不用 refine / transform / default，默认值与“恰好一个条件”由 Host 校验）；错误码、命令名与标签页的操作方是开放
// 字符串，以后多出取值不算收窄；标签页加上操作方 `controller` 与所属会话；请求带会话与它的目录；打开与跳转的结果带主文档的
// HTTP 状态码（0.44.0）。
//
// 内置浏览器（0.33.0，domain-model §3.15）：浏览器在桌面端的主进程里，Host 是另一个进程。桌面端用 `browser.register` 把
// 自己的连接登记为浏览器提供方，Host 经 `browser.request` 通知把会话里的 agent 调的浏览器工具交给它，提供方用
// `browser.respond` 回结果（照 Paseo 的 BrowserToolsBroker）。

import { z } from 'zod';
import { SessionIdSchema } from './common.js';
import { HttpUrlSchema } from './entities.js';

/** 浏览器命令（提供方在 `browser.register` 里声明自己会的）。 */
export const BROWSER_COMMANDS = [
  'list_tabs',
  'new_tab',
  'close_tab',
  'show',
  'snapshot',
  'screenshot',
  'click',
  'fill',
  'type',
  'keypress',
  'select',
  'hover',
  'drag',
  'scroll',
  'navigate',
  'back',
  'forward',
  'reload',
  'wait',
  'logs',
] as const;
export type BrowserCommandName = (typeof BROWSER_COMMANDS)[number];

/** 已知的错误码；线缆上是开放字符串。 */
export const BROWSER_ERROR_CODES = [
  /** 没有浏览器提供方（桌面端没开，或关掉了浏览器工具）。 */
  'browser_no_host',
  'browser_tab_not_found',
  'browser_tab_closed',
  'browser_timeout',
  /** 页面打不开（0.44.0）：消息里是 Chromium 的网络错误名，例如 `ERR_CONNECTION_REFUSED (-102)`。 */
  'browser_load_failed',
  /** 页面还没画出来，截不到图；可以重试。 */
  'screenshot_no_frame',
  /** 不允许：地址不是 http(s)、标签页不属于这个会话、用户正在操作这个标签页等。 */
  'browser_denied',
  'browser_unsupported',
  /** 元素引用过期了，要重新取快照。 */
  'browser_stale_ref',
  'browser_unknown_error',
] as const;
export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];

/** 浏览器请求的 ID（Host 生成，`brq_`）。 */
export const BrowserRequestIdSchema = z.templateLiteral([
  'brq_',
  z.string().regex(/^[0-9A-Za-z]{1,64}$/),
]);
export type BrowserRequestId = z.infer<typeof BrowserRequestIdSchema>;

/** 标签页的 ID（提供方生成，不透明）。 */
export const BrowserTabIdSchema = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);
export type BrowserTabId = z.infer<typeof BrowserTabIdSchema>;

/** 快照里元素的引用，形如 `@e12`，只在同一个标签页最近一次快照之后、页面变化之前有效。 */
export const BrowserRefSchema = z.string().regex(/^@e\d{1,6}$/);
export const BrowserMouseButtonSchema = z.enum(['left', 'right', 'middle']);
export const BrowserModifierSchema = z.enum(['Alt', 'Control', 'Meta', 'Shift']);

const tab = { browserId: BrowserTabIdSchema };

export const BrowserCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('list_tabs'), args: z.object({}) }),
  z.object({
    command: z.literal('new_tab'),
    args: z.object({ url: HttpUrlSchema.optional() }),
  }),
  z.object({ command: z.literal('close_tab'), args: z.object(tab) }),
  /** 在正看着这个会话的窗口里打开浏览器窗格并显示这个标签页（`wevir_show`），给 `url` 时先在新标签页里打开它。 */
  z.object({
    command: z.literal('show'),
    args: z.object({ browserId: BrowserTabIdSchema.optional(), url: HttpUrlSchema.optional() }),
  }),
  z.object({ command: z.literal('snapshot'), args: z.object(tab) }),
  z.object({
    command: z.literal('screenshot'),
    args: z.object({ ...tab, fullPage: z.boolean().optional() }),
  }),
  z.object({
    command: z.literal('click'),
    args: z.object({
      ...tab,
      ref: BrowserRefSchema,
      button: BrowserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(BrowserModifierSchema).max(4).optional(),
    }),
  }),
  z.object({
    command: z.literal('fill'),
    args: z.object({ ...tab, ref: BrowserRefSchema, value: z.string() }),
  }),
  z.object({
    command: z.literal('type'),
    args: z.object({ ...tab, ref: BrowserRefSchema.optional(), text: z.string() }),
  }),
  z.object({
    command: z.literal('keypress'),
    args: z.object({ ...tab, ref: BrowserRefSchema.optional(), key: z.string().min(1).max(32) }),
  }),
  z.object({
    command: z.literal('select'),
    args: z.object({ ...tab, ref: BrowserRefSchema, value: z.string() }),
  }),
  z.object({ command: z.literal('hover'), args: z.object({ ...tab, ref: BrowserRefSchema }) }),
  z.object({
    command: z.literal('drag'),
    args: z.object({ ...tab, sourceRef: BrowserRefSchema, targetRef: BrowserRefSchema }),
  }),
  z.object({
    command: z.literal('scroll'),
    args: z.object({
      ...tab,
      ref: BrowserRefSchema.optional(),
      deltaX: z.number(),
      deltaY: z.number(),
    }),
  }),
  z.object({ command: z.literal('navigate'), args: z.object({ ...tab, url: HttpUrlSchema }) }),
  z.object({ command: z.literal('back'), args: z.object(tab) }),
  z.object({ command: z.literal('forward'), args: z.object(tab) }),
  z.object({ command: z.literal('reload'), args: z.object(tab) }),
  /** 等页面出现这段文字或地址含有这一段；两者恰好给一个（Host 校验）。 */
  z.object({
    command: z.literal('wait'),
    args: z.object({
      ...tab,
      text: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      timeoutMs: z.int().min(1).max(30_000).optional(),
    }),
  }),
  z.object({
    command: z.literal('logs'),
    args: z.object({ ...tab, maxEntries: z.int().min(1).max(200).optional() }),
  }),
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

/** 一个标签页。`controller` 是谁在操作它：`agent`（agent 开的或交给了 agent）、`user`（用户开的或用户接手了）。 */
export const BrowserTabInfoSchema = z.object({
  browserId: BrowserTabIdSchema,
  url: z.string(),
  title: z.string(),
  isActive: z.boolean(),
  isLoading: z.boolean(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  controller: z.string().min(1),
});
export type BrowserTabInfo = z.infer<typeof BrowserTabInfoSchema>;

export const BrowserSnapshotStatsSchema = z.object({
  nodeCount: z.int().min(0),
  refCount: z.int().min(0),
  textLength: z.int().min(0),
  iframeCount: z.int().min(0).optional(),
  maxDepth: z.int().min(0).optional(),
});

export const BrowserConsoleEntrySchema = z.object({
  level: z.string(),
  message: z.string(),
  source: z.string().optional(),
  line: z.int().optional(),
  timestamp: z.number(),
});
export type BrowserConsoleEntry = z.infer<typeof BrowserConsoleEntrySchema>;

export const BrowserNetworkEntrySchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  status: z.int().optional(),
  type: z.string().optional(),
  startTime: z.number(),
  duration: z.number(),
  transferSize: z.number().optional(),
});
export type BrowserNetworkEntry = z.infer<typeof BrowserNetworkEntrySchema>;

const point = { x: z.number().optional(), y: z.number().optional() };
const tabResult = { browserId: BrowserTabIdSchema };
/** 这次载入的主文档的 HTTP 状态码（0.44.0）；没载入地址或不是 HTTP 时没有。404 之类照样是载入成功。 */
const loaded = { status: z.int().min(100).max(999).optional() };

export const BrowserResultSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('list_tabs'), tabs: z.array(BrowserTabInfoSchema) }),
  z.object({ command: z.literal('new_tab'), ...tabResult, url: z.string(), ...loaded }),
  z.object({ command: z.literal('close_tab'), ...tabResult }),
  /** `shown`：有人正看着这个会话、窗格打开了；没有时标签页照样开着，只是没显示。 */
  z.object({
    command: z.literal('show'),
    ...tabResult,
    url: z.string(),
    shown: z.boolean(),
    ...loaded,
  }),
  z.object({
    command: z.literal('snapshot'),
    ...tabResult,
    url: z.string(),
    title: z.string(),
    format: z.literal('aria-yaml'),
    snapshot: z.string(),
    truncated: z.boolean(),
    stats: BrowserSnapshotStatsSchema,
  }),
  z.object({
    command: z.literal('screenshot'),
    ...tabResult,
    mimeType: z.literal('image/png'),
    /** base64，解码后不超过 `BROWSER_SCREENSHOT_MAX_BYTES`。 */
    dataBase64: z.string().min(1),
    width: z.int().min(0),
    height: z.int().min(0),
  }),
  z.object({ command: z.literal('click'), ...tabResult, ref: BrowserRefSchema, ...point }),
  z.object({ command: z.literal('fill'), ...tabResult, ref: BrowserRefSchema }),
  z.object({
    command: z.literal('type'),
    ...tabResult,
    ref: BrowserRefSchema.optional(),
    ...point,
  }),
  z.object({
    command: z.literal('keypress'),
    ...tabResult,
    key: z.string().min(1),
    ref: BrowserRefSchema.optional(),
    ...point,
  }),
  z.object({
    command: z.literal('select'),
    ...tabResult,
    ref: BrowserRefSchema,
    value: z.string(),
  }),
  z.object({ command: z.literal('hover'), ...tabResult, ref: BrowserRefSchema, ...point }),
  z.object({
    command: z.literal('drag'),
    ...tabResult,
    sourceRef: BrowserRefSchema,
    targetRef: BrowserRefSchema,
  }),
  z.object({
    command: z.literal('scroll'),
    ...tabResult,
    ref: BrowserRefSchema.optional(),
    deltaX: z.number(),
    deltaY: z.number(),
    ...point,
  }),
  z.object({ command: z.literal('navigate'), ...tabResult, url: z.string(), ...loaded }),
  z.object({ command: z.literal('back'), ...tabResult }),
  z.object({ command: z.literal('forward'), ...tabResult }),
  z.object({ command: z.literal('reload'), ...tabResult }),
  /** `matched`：`text` 或 `url`，开放字符串。 */
  z.object({ command: z.literal('wait'), ...tabResult, matched: z.string() }),
  z.object({
    command: z.literal('logs'),
    ...tabResult,
    console: z.array(BrowserConsoleEntrySchema),
    network: z.array(BrowserNetworkEntrySchema),
  }),
]);
export type BrowserResult = z.infer<typeof BrowserResultSchema>;

export const BrowserErrorSchema = z.object({
  /** `BROWSER_ERROR_CODES` 之一，开放字符串。 */
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
});
export type BrowserError = z.infer<typeof BrowserErrorSchema>;

/** 命令执行期间页面弹出、由提供方自动处理掉的对话框（alert 接受，其余取消）。 */
export const BrowserDialogEventSchema = z.object({
  /** `alert`、`confirm`、`prompt`、`beforeunload`，开放字符串。 */
  type: z.string().min(1),
  message: z.string(),
  defaultValue: z.string().optional(),
  /** `accepted` 或 `dismissed`，开放字符串。 */
  action: z.string().min(1),
  timestamp: z.number(),
});
export type BrowserDialogEvent = z.infer<typeof BrowserDialogEventSchema>;

/** 提供方对一个请求的回答（`browser.respond` 的参数）。 */
export const BrowserResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: BrowserRequestIdSchema,
    ok: z.literal(true),
    result: BrowserResultSchema,
    dialogs: z.array(BrowserDialogEventSchema).max(20).optional(),
  }),
  z.object({
    requestId: BrowserRequestIdSchema,
    ok: z.literal(false),
    error: BrowserErrorSchema,
    dialogs: z.array(BrowserDialogEventSchema).max(20).optional(),
  }),
]);
export type BrowserResponse = z.infer<typeof BrowserResponseSchema>;

/** Host 交给提供方的一个请求（`browser.request` 通知的参数）。 */
export const BrowserRequestSchema = z.object({
  requestId: BrowserRequestIdSchema,
  /** 调工具的会话：标签页属于它，只能操作它的标签页。 */
  sessionId: SessionIdSchema,
  /** 会话的目录。 */
  cwd: z.string().min(1),
  command: BrowserCommandSchema,
});
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;

/** 截图（解码后）的上限。 */
export const BROWSER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** 快照文本的上限（字符）。 */
export const BROWSER_SNAPSHOT_MAX_LENGTH = 80_000;
