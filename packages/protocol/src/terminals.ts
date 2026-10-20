// 用户的交互终端（0.68.0，Host 功能 `user_terminal`）：客户端在 Host 上开的 PTY，跑用户的登录 shell。
//
// 终端只由客户端开、只由客户端输入，Agent 看不到也写不了；与 Agent 的后台进程（`process.*`，`p<n>`）、检查的进程（`v<n>`）、
// 引擎自己的终端互不共享标识，也不能接管已经在跑的进程。输出原样转发（含终端控制序列），由客户端的终端模拟器渲染；输入输出
// 只在 Host 的内存里，不写事件库、数据库与日志。终端随 Host：Host 退出时全部结束，重启后列表是空的。
//
// 输出按序编号：`offset` 是从终端开起的输出位置（解码后的 UTF-16 码元数）。连接 `terminal.attach` 之后收 `terminal.output`，
// 断线重连后带上自己读到的位置再 attach，Host 补上中间的输出；补不上（缓冲已丢掉那一段，或没给位置）时给整个屏幕与滚动缓冲的快照。

import { z } from 'zod';
import { IsoTimeSchema, SessionIdSchema, TerminalIdSchema, WorkspaceIdSchema } from './common.js';

/** `terminal.input` 一次最多的字符（粘贴大段文字时客户端分几次发）。 */
export const TERMINAL_INPUT_MAX_LENGTH = 64 * 1024;
export const TERMINAL_COLS_MAX = 1000;
export const TERMINAL_ROWS_MAX = 500;

const ColsSchema = z.int().min(2).max(TERMINAL_COLS_MAX);
const RowsSchema = z.int().min(1).max(TERMINAL_ROWS_MAX);

export const TerminalSchema = z.object({
  id: TerminalIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 从会话开的：起始目录是会话的目录；会话删除时终端随之结束。 */
  sessionId: SessionIdSchema.optional(),
  /** 起始目录（绝对路径）；shell 里 `cd` 之后不跟着变。 */
  cwd: z.string(),
  /** shell 的路径或命令名。 */
  shell: z.string(),
  pid: z.int().nonnegative().optional(),
  /** 程序用 OSC 0 / 2 设的标题；没设时是空串。 */
  title: z.string().max(200),
  /** 前台进程名：Ctrl-C（输入 `\x03`）由终端交给它所在的进程组。Windows 上是 shell。 */
  foreground: z.string().max(200).optional(),
  cols: ColsSchema,
  rows: RowsSchema,
  status: z.enum(['running', 'exited']),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  createdAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  /** 现在 attach 着的连接数（含自己）。 */
  clients: z.int().nonnegative(),
  /** 起不来（目录不存在、shell 找不到）的原因。 */
  error: z.string().optional(),
});
export type Terminal = z.infer<typeof TerminalSchema>;

/**
 * `terminal.create`：省略 `cwd` 时在会话的目录（有 `sessionId` 时）或项目根目录。`cwd` 要是存在的目录（绝对路径）。
 * 每个项目同时最多 10 个在跑的终端。
 */
export const TerminalCreateParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  cwd: z.string().min(1).optional(),
  cols: ColsSchema,
  rows: RowsSchema,
});
export const TerminalCreateResultSchema = z.object({ terminal: TerminalSchema });

/** `terminal.list`：项目或会话的终端；都省略时是全部。已退出的留到 `terminal.close`。 */
export const TerminalListParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
});
export const TerminalListResultSchema = z.object({ terminals: z.array(TerminalSchema) });

/**
 * `terminal.attach`：这条连接之后收这个终端的 `terminal.output`（从 `next` 起，不重不漏）。给了 `since` 且 Host 还留着那之后的
 * 输出时 `reset` 为 false，`data` 是 `since` 到 `next` 之间的输出，接着写；否则 `reset` 为 true，客户端清掉自己的屏幕与滚动缓冲，
 * 写入 `data`（整个屏幕与最近的滚动缓冲的快照，含样式与备用屏）。已经 attach 过的再调一次等于重新开始。
 */
export const TerminalAttachParamsSchema = z.object({
  terminalId: TerminalIdSchema,
  since: z.int().nonnegative().optional(),
});
export const TerminalAttachResultSchema = z.object({
  terminal: TerminalSchema,
  reset: z.boolean(),
  data: z.string(),
  next: z.int().nonnegative(),
});

/** `terminal.detach`：不再收输出，终端照跑。没 attach 过也算成功。 */
export const TerminalDetachParamsSchema = z.object({ terminalId: TerminalIdSchema });
export const TerminalDetachResultSchema = z.object({});

/** `terminal.input`：原样写进终端。Ctrl-C 是 `\x03`，由终端交给前台进程组，不是 Host 发信号。已退出的终端忽略输入。 */
export const TerminalInputParamsSchema = z.object({
  terminalId: TerminalIdSchema,
  data: z.string().min(1).max(TERMINAL_INPUT_MAX_LENGTH),
});
export const TerminalInputResultSchema = z.object({});

/** `terminal.resize`：几个客户端看同一个终端时，以最近一次调用的为准，其他客户端按 `terminal.changed` 里的尺寸显示。 */
export const TerminalResizeParamsSchema = z.object({
  terminalId: TerminalIdSchema,
  cols: ColsSchema,
  rows: RowsSchema,
});
export const TerminalResizeResultSchema = z.object({});

/**
 * `terminal.close`：结束并忘掉这个终端。在跑时 POSIX 上先 SIGHUP 给 shell（shell 转给它的作业），宽限后 SIGKILL 这个终端会话里
 * 还在的进程；Windows 上结束进程树。退出之后发 `terminal.changed` 的 `removed`。
 */
export const TerminalCloseParamsSchema = z.object({ terminalId: TerminalIdSchema });
export const TerminalCloseResultSchema = z.object({});

/** `terminal.output`：发给 attach 过的连接。Host 把一小段时间里的输出合成一条（约 16 ms）。 */
export const TerminalOutputParamsSchema = z.object({
  terminalId: TerminalIdSchema,
  offset: z.int().nonnegative(),
  data: z.string(),
});

/** `terminal.changed`：发给调过 `terminal.*` 的连接。开、退出、标题、前台进程、尺寸、attach 的连接数变了时带最新状态；忘掉了时带 `removed`。 */
export const TerminalChangedParamsSchema = z.union([
  z.object({ terminal: TerminalSchema }),
  z.object({ removed: z.object({ id: TerminalIdSchema }) }),
]);
