// 语言服务器的状态与安装（0.71.0，Host 功能 `lsp_status`）：代码智能（`lsp_*` 工具）用的语言服务器在当前项目里实际能不能用。
//
// - `lsp.status` 只读：扫一遍项目目录里出现的语言与各自的项目根（monorepo 可能有多个根），列出每个根用哪个服务器、在哪里、
//   从哪儿装的（项目内 / 用户级 / 系统）、版本、启动状态与原因、服务端声明的能力、最近一次诊断的时间。不启动服务器。
// - `lsp.restart` 关掉再起一次（也清掉崩溃计数）；`lsp.log` 读启动日志（命令、目录、退出原因与服务器的 stderr 末尾）。
// - `lsp.install` 由用户发起：Host 按一个安装方案（`plans` 里的确切命令）起进程，装完重新查找、起服务器、对一个文件做一次诊断，
//   验证真的能用。用户级与系统的方案要 `confirmGlobal: true`。Host 不会因为打开文件或工具调用自己去装。
// - 写能力（rename、code action、格式化）不在这个版本。

import { z } from 'zod';
import { IsoTimeSchema, LspInstallIdSchema, SessionIdSchema, WorkspaceIdSchema } from './common.js';

/** 一次 `lsp.status` 最多列几个服务器（种类 × 项目根）。 */
export const LSP_SERVERS_MAX = 50;
/** 安装输出保留的末尾字符数。 */
export const LSP_INSTALL_OUTPUT_MAX = 64 * 1024;
/** `lsp.log` 最多返回的字符数。 */
export const LSP_LOG_MAX = 64 * 1024;

/** 服务器从哪儿来：`project` 在项目里（node_modules、虚拟环境），`user` 在用户目录，`system` 在系统目录（Homebrew、/usr）。 */
export const LspServerSourceSchema = z.enum(['project', 'user', 'system']);
export type LspServerSource = z.infer<typeof LspServerSourceSchema>;

/**
 * 启动状态。
 * - `missing`：没找到，或找到的可执行文件跑不起来（例如 rustup 的代理没有对应组件）；`reason` 是缺什么。
 * - `outdated`：找到了但版本低于 `minVersion`；Wevir 不用它。
 * - `not_started`：找到了，还没用过或空闲关掉了（第一次 `lsp_*` 工具调用时启动）。
 * - `starting` / `running`。
 * - `failed`：起不来或崩溃；`failures` 是最近 5 分钟的次数，到上限后在 `retryAt` 之前不再自动重启（`lsp.restart` 可以立刻再试）。
 */
export const LspServerStateSchema = z.enum([
  'missing',
  'outdated',
  'not_started',
  'starting',
  'running',
  'failed',
]);
export type LspServerState = z.infer<typeof LspServerStateSchema>;

/** 安装方案装到哪儿：`project` 只改这个项目（依赖或虚拟环境），`user` 装到用户目录，`system` 是系统级（Homebrew 等）。 */
export const LspInstallScopeSchema = z.enum(['project', 'user', 'system']);
export type LspInstallScope = z.infer<typeof LspInstallScopeSchema>;

/**
 * 一个安装方案。`command` 是会运行的确切命令（显示用；Host 按同样的参数直接起进程，不经 shell）；`cwd` 是在哪个目录运行。
 * `runnable` 为 false 的只能手动做（要图形安装器或管理员权限），`lsp.install` 不接受。
 */
export const LspInstallPlanSchema = z.object({
  id: z.string().min(1).max(100),
  scope: LspInstallScopeSchema,
  command: z.string().min(1).max(2000),
  cwd: z.string().min(1).optional(),
  runnable: z.boolean(),
});
export type LspInstallPlan = z.infer<typeof LspInstallPlanSchema>;

/**
 * 一次安装：`running` 装着，`verifying` 装完正在起服务器并做一次诊断，`succeeded` 验证通过，`failed`（`reason` 是安装或验证失败的
 * 原因），`cancelled`，`timed_out`。`output` 是安装命令输出的末尾。
 */
export const LspInstallStatusSchema = z.enum([
  'running',
  'verifying',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type LspInstallStatus = z.infer<typeof LspInstallStatusSchema>;

export const LspInstallRunSchema = z.object({
  id: LspInstallIdSchema,
  serverId: z.string().min(1).max(50),
  root: z.string().min(1),
  planId: z.string().min(1).max(100),
  scope: LspInstallScopeSchema,
  command: z.string().min(1).max(2000),
  status: LspInstallStatusSchema,
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema.optional(),
  exitCode: z.int().nullable().optional(),
  output: z.string().max(LSP_INSTALL_OUTPUT_MAX),
  reason: z.string().max(4000).optional(),
  /** 验证通过时：起来的服务器、诊断的文件（相对项目根）与它报的问题数；`timedOut` 是服务器还在加载、诊断可能不全。 */
  verification: z
    .object({
      server: z.string().max(200),
      file: z.string().max(1000),
      diagnostics: z.int().nonnegative(),
      timedOut: z.boolean().optional(),
    })
    .optional(),
});
export type LspInstallRun = z.infer<typeof LspInstallRunSchema>;

export const LspServerStatusSchema = z.object({
  /** 服务器种类：`typescript`、`python`、`go`、`rust`、`c`、`swift`（开放字符串）。 */
  serverId: z.string().min(1).max(50),
  /** 语言名，例如 `TypeScript/JavaScript`。 */
  language: z.string().min(1).max(100),
  /** 项目根（绝对路径）：一个根一个服务器进程。 */
  root: z.string().min(1),
  state: LspServerStateSchema,
  reason: z.string().max(4000).optional(),
  /** 服务器的显示名，例如 `tsc --lsp (TypeScript 7.0.2)`。 */
  name: z.string().max(200).optional(),
  /** 可执行文件的绝对路径。 */
  path: z.string().optional(),
  source: LspServerSourceSchema.optional(),
  version: z.string().max(100).optional(),
  minVersion: z.string().max(100).optional(),
  /** 服务端在 `initialize` 里声明的能力（`definition`、`references`、`rename` 等，开放字符串）；没起过时没有。 */
  capabilities: z.array(z.string().min(1).max(100)).max(100).optional(),
  startedAt: IsoTimeSchema.optional(),
  lastDiagnosticsAt: IsoTimeSchema.optional(),
  failures: z.int().nonnegative().optional(),
  retryAt: IsoTimeSchema.optional(),
  /** 能装或能升级时的方案（`missing`、`outdated`，以及需要时的 `failed`）：项目级在前。 */
  plans: z.array(LspInstallPlanSchema).max(10).optional(),
  /** 这个服务器最近一次安装。 */
  install: LspInstallRunSchema.optional(),
});
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>;

const ServerRefShape = {
  workspaceId: WorkspaceIdSchema,
  /** 读这个会话的目录（环境会话的 worktree）；省略时是工作区目录。 */
  sessionId: SessionIdSchema.optional(),
  serverId: z.string().min(1).max(50),
  root: z.string().min(1),
};

/** `lsp.status`：Host 缓存扫描结果一会儿，`refresh` 重新扫描与查找。 */
export const LspStatusParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  refresh: z.boolean().optional(),
});
export const LspStatusResultSchema = z.object({
  /** 扫描的目录（绝对路径）。 */
  dir: z.string(),
  servers: z.array(LspServerStatusSchema).max(LSP_SERVERS_MAX),
  /** 文件太多没扫完，或服务器超过上限。 */
  truncated: z.boolean().optional(),
});

export const LspRestartParamsSchema = z.object(ServerRefShape);
export const LspRestartResultSchema = z.object({ server: LspServerStatusSchema });

export const LspLogParamsSchema = z.object(ServerRefShape);
export const LspLogResultSchema = z.object({ log: z.string().max(LSP_LOG_MAX) });

/** `lsp.install`：`planId` 来自这个服务器的 `plans`；`user` 与 `system` 方案要 `confirmGlobal: true`。 */
export const LspInstallParamsSchema = z.object({
  ...ServerRefShape,
  planId: z.string().min(1).max(100),
  confirmGlobal: z.boolean().optional(),
});
export const LspInstallResultSchema = z.object({ run: LspInstallRunSchema });

export const LspCancelInstallParamsSchema = z.object({ installId: LspInstallIdSchema });
export const LspCancelInstallResultSchema = z.object({ run: LspInstallRunSchema });

/** `lsp.changed`：发给调过 `lsp.*` 的连接；服务器起来、退出、崩溃或安装有进展时。客户端重新 `lsp.status`。 */
export const LspChangedParamsSchema = z.object({
  serverId: z.string().min(1).max(50).optional(),
  root: z.string().min(1).optional(),
});
