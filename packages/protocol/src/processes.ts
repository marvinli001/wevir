// 进程输出（0.69.0，Host 功能 `process_output`）：客户端看 Host 起的后台进程。
//
// 两种来源：会话里的 Agent 经 `wevir_process_start` 起的（`agent`），回合后验证跑的检查（`check`，ADR-0008）。客户端能列出、
// 分页读输出（去掉了终端控制序列的文本）、停止；不能写 stdin，也不是终端——用户自己的交互终端另做。进程只在 Host 的内存里登记，
// Host 退出时全部结束，重启后列表是空的。Codex 原生后台终端、Host 的后台进程与以后的用户终端互不共享标识。

import { z } from 'zod';
import {
  CheckIdSchema,
  IsoTimeSchema,
  SessionIdSchema,
  TurnIdSchema,
  VerificationRunIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { VerificationTriggerSchema } from './verification.js';

/** `process.output` 一次最多读的字节。 */
export const PROCESS_OUTPUT_PAGE_MAX_BYTES = 256 * 1024;
export const PROCESS_COMMAND_MAX_LENGTH = 8000;

/**
 * 进程 ID：Agent 的进程是 `p<n>`（Agent 的工具里也用它），检查的进程是 `v<n>`。只在这一次 Host 运行里唯一，Host 重启后从头编号；
 * 客户端用 `id` 加 `startedAt` 认同一个进程。
 */
export const ProcessIdSchema = z.string().regex(/^[a-z][0-9]{1,9}$/);
export type ProcessId = z.infer<typeof ProcessIdSchema>;

/**
 * 进程从哪儿来。
 * - `agent`：会话里的 Agent 起的；`turnId` 是起它时进行中的回合（命令回合、空闲时没有）。
 * - `check`：回合后验证的一次检查；`turnId` 是它验证的回合，`runId` 是验证记录。停止它等于取消这次检查（记 `cancelled`）。
 */
export const ProcessSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('check'),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema.optional(),
    runId: VerificationRunIdSchema,
    checkId: CheckIdSchema,
    trigger: VerificationTriggerSchema,
  }),
]);
export type ProcessSource = z.infer<typeof ProcessSourceSchema>;

/** 客户端能发的停止信号：`SIGINT` 同 Ctrl-C，`SIGTERM` 请它退出，`SIGKILL` 强制结束。 */
export const ProcessStopSignalSchema = z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']);
export type ProcessStopSignal = z.infer<typeof ProcessStopSignalSchema>;

export const HostProcessSchema = z.object({
  id: ProcessIdSchema,
  workspaceId: WorkspaceIdSchema,
  source: ProcessSourceSchema,
  /** 显示名：Agent 给的名字或命令的开头；检查是检查名。 */
  name: z.string().max(200),
  command: z.string().max(PROCESS_COMMAND_MAX_LENGTH),
  /** 绝对路径。 */
  cwd: z.string(),
  pid: z.int().nonnegative().optional(),
  status: z.enum(['running', 'exited']),
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  /** 从启动起写过的字节数（stdout 与 stderr 合在一起，按到达顺序）。 */
  bytes: z.int().nonnegative(),
  /** 谁停的：`agent` 用工具停的，`user` 经 `process.stop` 停的，`host` 是超时、取消检查或会话删除时 Host 停的。 */
  stoppedBy: z.enum(['agent', 'user', 'host']).optional(),
  /** 起不来（cwd 不存在、shell 找不到）的原因。 */
  error: z.string().optional(),
  /**
   * `process.stop` 能发哪些信号：POSIX 上发给整个进程组；Windows 上只有 `SIGKILL`（结束进程树）。检查只有 `SIGTERM`（取消检查，
   * 宽限后 SIGKILL）。进程退出后是空的。
   */
  stopSignals: z.array(ProcessStopSignalSchema),
});
export type HostProcess = z.infer<typeof HostProcessSchema>;

/** `process.list`：工作区或会话的进程；都省略时是全部。 */
export const ProcessListParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  sessionId: SessionIdSchema.optional(),
});
export const ProcessListResultSchema = z.object({ processes: z.array(HostProcessSchema) });

/**
 * `process.output`：从 `offset`（`bytes` 的偏移量）读到 `until` 或文件末尾，最多 `PROCESS_OUTPUT_PAGE_MAX_BYTES`。省略 `offset` 时读
 * 最后一页。去掉了终端控制序列；不是 UTF-8 的字节换成 U+FFFD；不截在半个字符上。
 */
export const ProcessOutputParamsSchema = z.object({
  processId: ProcessIdSchema,
  offset: z.int().nonnegative().optional(),
  until: z.int().nonnegative().optional(),
});
export const ProcessOutputResultSchema = z.object({
  text: z.string(),
  /** 实际从哪儿读起（早于 `start` 的偏移量挪到 `start`，半个字符往后挪）。 */
  from: z.int().nonnegative(),
  /** 下一次的 `offset`。 */
  next: z.int().nonnegative(),
  /** 还能读到的最早偏移量：更早的输出已经轮转丢掉。 */
  start: z.int().nonnegative(),
  /** 此刻写过的字节数。 */
  bytes: z.int().nonnegative(),
  /** `next` 到 `until`（或末尾）之间还有没读的。 */
  more: z.boolean(),
});

/** `process.stop`：省略 `signal` 时是 `SIGTERM`（Windows 上 `SIGKILL`）。必须是进程的 `stopSignals` 里有的。 */
export const ProcessStopParamsSchema = z.object({
  processId: ProcessIdSchema,
  signal: ProcessStopSignalSchema.optional(),
});
export const ProcessStopResultSchema = z.object({ process: HostProcessSchema });

/**
 * `process.changed`：发给调过 `process.*` 的连接。进程起来、退出、被停或输出变多（同一个进程最多每 500 ms 一次）时带它的最新状态；
 * 忘掉了（会话删除、已退出的超出上限）时带 `removed`。
 */
export const ProcessChangedParamsSchema = z.union([
  z.object({ process: HostProcessSchema }),
  z.object({ removed: z.object({ id: ProcessIdSchema, startedAt: IsoTimeSchema }) }),
]);
