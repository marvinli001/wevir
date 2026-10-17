// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/protocol/src/browser-automation/rpc-schemas.ts 与 capabilities.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：命令按 Wevir 的取舍（去掉 evaluate、upload、resize，加上请界面显示标签页的 show）；schema 只做结构声明（host-api.md
// §10 规则 6：不用 refine / transform / default，默认值与“恰好一个条件”由 Host 校验）；错误码、命令名与标签页的操作方是开放
// 字符串，以后多出取值不算收窄；标签页加上操作方 `controller` 与所属会话；请求带会话与它的目录；打开与跳转的结果带主文档的
// HTTP 状态码（0.44.0）；快照可以分段读、带总行数，回答带命令引起的页面变化（跳转、新标签页、下载、选文件），日志带总数与
// 进行中的请求，错误码多了对话框阻塞与参数不对（0.46.0）。0.48.0 加回 Paseo 去掉的 evaluate 与 upload（只在 agent 操作的标签页、
// 文件限会话文件夹），另加 query、network、dialogs、download；快照、等待、执行与查询能指定 frame，快照能限定范围与节点数。
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
  // 0.48.0
  'evaluate',
  'query',
  'network',
  'dialogs',
  'upload',
  'download',
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
  /** 页面弹出的对话框没被处理、挡住了页面（0.46.0）。 */
  'browser_dialog_blocked',
  /** 地址不能打开（0.46.0）：不是 http(s)，或根本不是地址。 */
  'browser_invalid_url',
  /** 参数不对（0.46.0）：引用的形状、按键名、互斥的参数等。 */
  'browser_invalid_argument',
  /** 页面里执行的函数抛了异常（0.48.0），消息里是异常的说明。 */
  'browser_script_error',
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
/**
 * 页面里的一个 frame（0.48.0）：快照里 iframe 上标的 `frame=`（形如 `1`、`1.0`，从顶层起每层是它在父窗口 `frames` 里的序号），
 * 或者 frame 的名字、地址的一段。
 */
export const BrowserFrameSchema = z.string().min(1).max(500);
/** 对话框的处理（0.48.0）：`accept` 接受（confirm 为 true、prompt 给文字、beforeunload 离开），`dismiss` 取消。 */
export const BrowserDialogActionSchema = z.enum(['accept', 'dismiss']);
/** 等元素的哪种状态（0.48.0）：出现、消失、可见、不可见（含不存在）。 */
export const BrowserElementStateSchema = z.enum(['attached', 'detached', 'visible', 'hidden']);

const tab = { browserId: BrowserTabIdSchema };
const selector = z.string().min(1).max(2_000);

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
  /**
   * `offset`（0.46.0）：从快照的第几行（从 0 起）开始给，页面长、一次给不完时分段读。0.48.0：`selector` / `ref` 只取这个元素
   * 及其里面（两者最多给一个），`frame` 只取这个 frame，`viewportOnly` 只取视口里的元素，`maxNodes` 是节点上限
   * （默认 `BROWSER_SNAPSHOT_DEFAULT_NODES`）。
   */
  z.object({
    command: z.literal('snapshot'),
    args: z.object({
      ...tab,
      offset: z.int().min(0).max(1_000_000).optional(),
      selector: selector.optional(),
      ref: BrowserRefSchema.optional(),
      frame: BrowserFrameSchema.optional(),
      viewportOnly: z.boolean().optional(),
      maxNodes: z.int().min(100).max(50_000).optional(),
    }),
  }),
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
  /**
   * 等页面出现这段文字或地址含有这一段；两者恰好给一个（Host 校验）。0.48.0 起条件还可以是地址匹配正则 `urlRegex`、元素
   * `selector` 达到 `state`（默认 `visible`）、网络空闲 `networkIdle`（没有进行中的请求持续 `idleMs`，默认 500），条件恰好一个；
   * `text` 与 `selector` 可以指定 `frame`。
   */
  z.object({
    command: z.literal('wait'),
    args: z.object({
      ...tab,
      text: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      urlRegex: z.string().min(1).max(1_000).optional(),
      selector: selector.optional(),
      state: BrowserElementStateSchema.optional(),
      networkIdle: z.boolean().optional(),
      idleMs: z.int().min(100).max(10_000).optional(),
      frame: BrowserFrameSchema.optional(),
      timeoutMs: z.int().min(1).max(30_000).optional(),
    }),
  }),
  z.object({
    command: z.literal('logs'),
    args: z.object({ ...tab, maxEntries: z.int().min(1).max(200).optional() }),
  }),
  /**
   * 在页面（或 `frame`）里执行一个函数（0.48.0）：`function` 是函数的源码，给了 `ref` 时以那个元素为参数调用；返回值按 JSON 序列化，
   * 超过 `maxBytes`（字符，默认 `BROWSER_EVALUATE_DEFAULT_BYTES`）截断。
   */
  z.object({
    command: z.literal('evaluate'),
    args: z.object({
      ...tab,
      function: z.string().min(1).max(100_000),
      ref: BrowserRefSchema.optional(),
      frame: BrowserFrameSchema.optional(),
      timeoutMs: z.int().min(1).max(30_000).optional(),
      maxBytes: z.int().min(100).max(200_000).optional(),
    }),
  }),
  /** 按 CSS 选择器查元素（0.48.0）：数量与前 `maxResults` 个（默认 20）的文字、可见性、位置与 `attributes` 列出的属性。 */
  z.object({
    command: z.literal('query'),
    args: z.object({
      ...tab,
      selector,
      frame: BrowserFrameSchema.optional(),
      maxResults: z.int().min(1).max(100).optional(),
      attributes: z.array(z.string().min(1).max(100)).max(20).optional(),
    }),
  }),
  /**
   * 网络记录（0.48.0）：按地址片段、方法、状态（`404`、`4xx`、`400-499`）、类型过滤，`failedOnly` 只要失败的；给 `id` 时是这一条的
   * 详情（请求头、响应头、时间），`body` 再带响应体（`maxBytes` 字符）；`clear` 在读完之后清空这个标签页的记录。
   */
  z.object({
    command: z.literal('network'),
    args: z.object({
      ...tab,
      url: z.string().min(1).max(2_000).optional(),
      method: z.string().min(1).max(20).optional(),
      status: z.string().min(1).max(20).optional(),
      type: z.string().min(1).max(40).optional(),
      failedOnly: z.boolean().optional(),
      maxEntries: z.int().min(1).max(200).optional(),
      id: z.string().min(1).max(200).optional(),
      body: z.boolean().optional(),
      maxBytes: z.int().min(100).max(200_000).optional(),
      clear: z.boolean().optional(),
    }),
  }),
  /** 这个标签页之后的对话框怎么处理（0.48.0）：没给的一项不变；标签页关掉或用户接手时回到默认。 */
  z.object({
    command: z.literal('dialogs'),
    args: z.object({
      ...tab,
      confirm: BrowserDialogActionSchema.optional(),
      prompt: BrowserDialogActionSchema.optional(),
      promptText: z.string().max(10_000).optional(),
      beforeunload: BrowserDialogActionSchema.optional(),
    }),
  }),
  /**
   * 给文件输入框设文件（0.48.0）：`ref` 是文件输入框；不给时交给页面刚弹出、被拦下的选文件框。`paths` 是 Host 核对过、在会话文件夹
   * 里的绝对路径。
   */
  z.object({
    command: z.literal('upload'),
    args: z.object({
      ...tab,
      ref: BrowserRefSchema.optional(),
      paths: z.array(z.string().min(1)).min(1).max(20),
    }),
  }),
  /** 下载（0.48.0）：点 `ref` 并保存它开始的下载，或用这个标签页下载 `url`（恰好给一个），存进会话文件夹的 `downloads/`。 */
  z.object({
    command: z.literal('download'),
    args: z.object({
      ...tab,
      ref: BrowserRefSchema.optional(),
      url: HttpUrlSchema.optional(),
      timeoutMs: z.int().min(1).max(120_000).optional(),
    }),
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
  /** 整个快照的行数、这次给出的第一行（从 0 起）与行数（0.46.0）。 */
  totalLines: z.int().min(0).optional(),
  startLine: z.int().min(0).optional(),
  shownLines: z.int().min(0).optional(),
  /** 节点到了上限、停下的地方（0.48.0）：停下时正在看的元素的 CSS 路径。 */
  stoppedAt: z.string().optional(),
  /** 这次的节点上限（0.48.0）。 */
  maxNodes: z.int().min(0).optional(),
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
  /** 还没结束（0.46.0）；有 `status` 的是响应头到了、正文还没读完（页面可能根本不读）。 */
  pending: z.boolean().optional(),
  /** 失败的原因（0.46.0），例如 `net::ERR_ABORTED`。 */
  failed: z.string().optional(),
  /** 这条记录在这个标签页里的编号（0.48.0），`network` 命令的 `id` 用它。 */
  id: z.string().optional(),
  mimeType: z.string().optional(),
  fromCache: z.boolean().optional(),
});
export type BrowserNetworkEntry = z.infer<typeof BrowserNetworkEntrySchema>;

/** 一条网络记录的详情（0.48.0）。凭据类的头（cookie、authorization …）只给长度。 */
export const BrowserNetworkDetailSchema = z.object({
  id: z.string(),
  url: z.string(),
  method: z.string(),
  status: z.int().optional(),
  statusText: z.string().optional(),
  type: z.string().optional(),
  mimeType: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  /** 请求体（表单、JSON）的开头。 */
  postData: z.string().optional(),
  postDataTruncated: z.boolean().optional(),
  remoteAddress: z.string().optional(),
  protocol: z.string().optional(),
  fromCache: z.boolean().optional(),
  startTime: z.number(),
  duration: z.number(),
  /** 发出请求到收到响应头（毫秒）。 */
  waitingMs: z.number().optional(),
  transferSize: z.number().optional(),
  pending: z.boolean().optional(),
  failed: z.string().optional(),
  /**
   * 响应体（要了才有）：文本给开头 `text`（`truncated` 表示截了），二进制只给 `binary: true` 与大小；拿不到（还没读完、已经被
   * 浏览器丢掉、太大没留）时 `unavailable` 说明原因。`size` 是解码后的字节数。
   */
  body: z
    .object({
      size: z.int().min(0),
      text: z.string().optional(),
      truncated: z.boolean().optional(),
      binary: z.boolean().optional(),
      unavailable: z.string().optional(),
    })
    .optional(),
});
export type BrowserNetworkDetail = z.infer<typeof BrowserNetworkDetailSchema>;

/** `query` 找到的一个元素（0.48.0）。`box` 是顶层页面里的 CSS 像素；`ref` 能直接给 click 等命令用。 */
export const BrowserQueryElementSchema = z.object({
  ref: BrowserRefSchema.optional(),
  tag: z.string(),
  id: z.string().optional(),
  classes: z.string().optional(),
  text: z.string(),
  visible: z.boolean(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});
export type BrowserQueryElement = z.infer<typeof BrowserQueryElementSchema>;

/** 标签页的对话框策略（0.48.0），取值是开放字符串（`accept` / `dismiss`）。 */
export const BrowserDialogPolicySchema = z.object({
  confirm: z.string().min(1),
  prompt: z.string().min(1),
  promptText: z.string().optional(),
  beforeunload: z.string().min(1),
});
export type BrowserDialogPolicy = z.infer<typeof BrowserDialogPolicySchema>;

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
  /** 只含当前页面（最近一次整页载入以来）的记录；`consoleTotal` / `networkTotal`（0.46.0）是这期间的总数，多于返回的条数时前面的省略了。 */
  z.object({
    command: z.literal('logs'),
    ...tabResult,
    console: z.array(BrowserConsoleEntrySchema),
    network: z.array(BrowserNetworkEntrySchema),
    consoleTotal: z.int().min(0).optional(),
    networkTotal: z.int().min(0).optional(),
  }),
  /** `value` 是返回值的 JSON（`undefined` 写成 `undefined`），`type` 是它的 `typeof`；`length` 是截断前的字符数。 */
  z.object({
    command: z.literal('evaluate'),
    ...tabResult,
    value: z.string(),
    type: z.string(),
    truncated: z.boolean(),
    length: z.int().min(0),
  }),
  z.object({
    command: z.literal('query'),
    ...tabResult,
    selector: z.string(),
    count: z.int().min(0),
    elements: z.array(BrowserQueryElementSchema),
  }),
  /** `total` 是这个页面的记录总数，`matched` 是符合过滤条件的条数（`entries` 是其中最后的几条）；给了 `id` 时带 `detail`。 */
  z.object({
    command: z.literal('network'),
    ...tabResult,
    entries: z.array(BrowserNetworkEntrySchema),
    total: z.int().min(0),
    matched: z.int().min(0),
    detail: BrowserNetworkDetailSchema.optional(),
    cleared: z.boolean().optional(),
  }),
  z.object({ command: z.literal('dialogs'), ...tabResult, policy: BrowserDialogPolicySchema }),
  z.object({
    command: z.literal('upload'),
    ...tabResult,
    ref: BrowserRefSchema.optional(),
    files: z.array(z.object({ path: z.string(), size: z.int().min(0) })),
  }),
  /**
   * `state`：`completed`、`in_progress`（到时限还没下完，继续在下）、`cancelled`、`interrupted`、`too_large`（超过
   * `BROWSER_DOWNLOAD_MAX_BYTES`，取消了），开放字符串。`path` 是保存的位置。
   */
  z.object({
    command: z.literal('download'),
    ...tabResult,
    url: z.string(),
    filename: z.string(),
    path: z.string().optional(),
    size: z.int().min(0),
    mimeType: z.string().optional(),
    state: z.string().min(1),
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

/**
 * 页面弹出、由提供方自动处理掉的对话框（alert 接受，confirm / prompt 取消，beforeunload 离开）。0.46.0 起包括两次命令之间
 * （定时器、载入时）弹出的，在这个标签页的下一个命令里报。
 */
export const BrowserDialogEventSchema = z.object({
  /** `alert`、`confirm`、`prompt`、`beforeunload`，开放字符串。 */
  type: z.string().min(1),
  message: z.string(),
  defaultValue: z.string().optional(),
  /** `accepted` 或 `dismissed`，开放字符串。 */
  action: z.string().min(1),
  /** 接受的 prompt 交给页面的文字（0.48.0）。 */
  response: z.string().optional(),
  timestamp: z.number(),
});
export type BrowserDialogEvent = z.infer<typeof BrowserDialogEventSchema>;

/**
 * 命令引起的页面变化（0.46.0）：点击、按键之后主框架跳转到了哪里（`status` 是主文档的 HTTP 状态码）、页面开了哪些新标签页、
 * 下载（内置浏览器一律拦下，`state` 是 `blocked`，开放字符串）、页面要用户选本机文件（不交给页面）。
 */
export const BrowserEffectsSchema = z.object({
  navigation: z
    .object({ url: z.string(), status: z.int().min(100).max(999).optional() })
    .optional(),
  openedTabs: z
    .array(z.object({ browserId: BrowserTabIdSchema, url: z.string() }))
    .max(20)
    .optional(),
  downloads: z
    .array(z.object({ url: z.string(), filename: z.string(), state: z.string().min(1) }))
    .max(20)
    .optional(),
  fileChooser: z.object({ multiple: z.boolean() }).optional(),
});
export type BrowserEffects = z.infer<typeof BrowserEffectsSchema>;

/** 提供方对一个请求的回答（`browser.respond` 的参数）。 */
export const BrowserResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    requestId: BrowserRequestIdSchema,
    ok: z.literal(true),
    result: BrowserResultSchema,
    dialogs: z.array(BrowserDialogEventSchema).max(20).optional(),
    effects: BrowserEffectsSchema.optional(),
  }),
  z.object({
    requestId: BrowserRequestIdSchema,
    ok: z.literal(false),
    error: BrowserErrorSchema,
    dialogs: z.array(BrowserDialogEventSchema).max(20).optional(),
    effects: BrowserEffectsSchema.optional(),
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

/** 快照默认的节点上限（0.48.0，可以用 `maxNodes` 改）。 */
export const BROWSER_SNAPSHOT_DEFAULT_NODES = 20_000;
/** `maxNodes` 的上限（0.48.0）。 */
export const BROWSER_SNAPSHOT_MAX_NODES = 50_000;
/** `evaluate` 的返回值与 `network` 的响应体默认给多少字符（0.48.0）：放得进一次工具输出。 */
export const BROWSER_EVALUATE_DEFAULT_BYTES = 6_000;
/** `maxBytes` 的上限（0.48.0）。 */
export const BROWSER_RESULT_MAX_BYTES = 200_000;
/** 一次上传最多几个文件（0.48.0）。 */
export const BROWSER_UPLOAD_MAX_FILES = 20;
/** 一个下载最大多少字节（0.48.0），超过就取消。 */
export const BROWSER_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

/** 截图（解码后）的上限。 */
export const BROWSER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** 快照文本的上限（字符）。 */
export const BROWSER_SNAPSHOT_MAX_LENGTH = 80_000;
/**
 * 一段快照的大小（UTF-8 字节，0.46.0）：经网关的模型在 Codex 里工具输出只留 10 000 字节（adapter-codex 的
 * `truncation_policy`），超出的从中间删掉；快照按这个预算分段，剩下的用 `offset` 接着读。
 */
export const BROWSER_SNAPSHOT_PAGE_BYTES = 8_000;
