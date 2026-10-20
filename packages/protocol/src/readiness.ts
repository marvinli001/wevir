// 项目环境就绪（0.70.0，Host 功能 `workspace_readiness`）：Agent 动手之前就能看到项目的环境缺什么，并由用户发起按项目约定的安装。
//
// - **预检**（`readiness.get`）只读：读清单、锁文件与安装标记，跑工具的 `--version`（在项目目录之外、关掉 corepack 与包管理器的
//   自动下载），不执行项目代码、不联网。每一项给出状态与依据（读了哪个文件、跑了什么命令）。
// - **安装**（`readiness.install`）只由用户发起：Host 按锁文件与项目约定给出命令（例如 `pnpm install --frozen-lockfile`），用户确认
//   后由 Host 起进程执行，可以取消、有超时、输出可查。不做全局安装、不改包管理器；安装脚本会执行代码，确认时要用户明确知道。
// - **网络**只做诊断与配置建议：引擎的沙箱和这里的安装都不能强制限定包仓库的域名，所以不显示成“已隔离”。私有仓库的凭据存在 Host 的
//   秘密存储（`readiness.setCredential`），只在安装时作为环境变量交给进程，不进日志、事件与聊天。
// - 语言服务器的状态归以后的 LSP 可用性功能，这里只预留 `toolchain`。

import { z } from 'zod';
import {
  CheckIdSchema,
  InstallRunIdSchema,
  IsoTimeSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
} from './common.js';

/** 一份报告最多几项、每项最多几条依据。 */
export const READINESS_ITEMS_MAX = 200;
export const READINESS_EVIDENCE_MAX = 8;
/** 依据里命令输出的最多字数。 */
export const READINESS_EVIDENCE_OUTPUT_MAX_LENGTH = 1000;
/** 安装的超时：缺省 15 分钟，最长 60 分钟。 */
export const INSTALL_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const INSTALL_TIMEOUT_MAX_MS = 60 * 60_000;
/** 安装记录里输出尾部的最多字数、`readiness.output` 一次最多读的字节。 */
export const INSTALL_SUMMARY_MAX_LENGTH = 4000;
export const INSTALL_OUTPUT_PAGE_MAX_BYTES = 256 * 1024;
/** 每个工作区最多存几个安装凭据；凭据值的最大长度。 */
export const READINESS_CREDENTIALS_MAX = 16;
export const READINESS_CREDENTIAL_MAX_LENGTH = 8192;

/**
 * 一项的状态：`ready` 就绪、`missing` 没安装（工具不在 PATH、没有依赖目录、没有锁文件）、`incompatible` 版本不兼容（工具版本不满足
 * 要求、锁文件与清单不一致、依赖比锁文件旧）、`network` 网络失败（上次安装连不上仓库）、`permission` 被权限拦截（目录不可写、仓库
 * 认证失败、沙箱拦截）、`unknown` 未知（读不懂、探测超时）。
 */
export const ReadinessStatusSchema = z.enum([
  'ready',
  'missing',
  'incompatible',
  'network',
  'permission',
  'unknown',
]);
export type ReadinessStatus = z.infer<typeof ReadinessStatusSchema>;

/**
 * 依据：`file` 读了哪个文件（相对检查的根目录；用户级配置写成 `~/…`），`command` 跑了什么命令、退出码与输出开头，`env` 看了哪个环境
 * 变量（只说有没有，不带值）。`detail` 是读到的要点（例如 `packageManager: pnpm@12.6.0`）。
 */
export const ReadinessEvidenceSchema = z.object({
  kind: z.enum(['file', 'command', 'env']),
  path: z.string().max(500).optional(),
  command: z.string().max(500).optional(),
  exitCode: z.int().nullable().optional(),
  output: z.string().max(READINESS_EVIDENCE_OUTPUT_MAX_LENGTH).optional(),
  detail: z.string().max(500).optional(),
});
export type ReadinessEvidence = z.infer<typeof ReadinessEvidenceSchema>;

/**
 * 预检的一项。`kind`（开放字符串）：`package_manager`、`runtime`（node、python、go）、`compiler`（rustc、cc、swift）、`build_tool`
 * （cmake、make、meson、ninja）、
 * `lockfile`（锁文件与清单是否一致）、`dependencies`（依赖目录是否存在、是否比锁文件旧）、`check`（回合后验证的检查命令能否解析）。
 * `reason` 是开放字符串（`not_found`、`version_mismatch`、`lockfile_missing`、`lockfile_mismatch`、`dependencies_missing`、
 * `dependencies_outdated`、`command_not_found`、`script_missing`、`registry_auth`、`probe_failed`…）。`blocking`：这一项不就绪时项目的
 * 构建与测试预计跑不起来（回合后验证据此把失败记成环境不可用）。
 */
export const ReadinessItemSchema = z.object({
  id: z.string().min(1).max(300),
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  /** 相对检查的根目录（`''` 是根目录）。 */
  path: z.string().max(500),
  status: ReadinessStatusSchema,
  reason: z.string().min(1).max(80).optional(),
  /** 项目要求的版本（`>=24.15`、`pnpm@12.6.0`、`1.22`）。 */
  required: z.string().max(200).optional(),
  /** 找到的版本。 */
  found: z.string().max(200).optional(),
  blocking: z.boolean(),
  /** `kind: 'check'` 时是哪个检查。 */
  checkId: CheckIdSchema.optional(),
  evidence: z.array(ReadinessEvidenceSchema).max(READINESS_EVIDENCE_MAX),
});
export type ReadinessItem = z.infer<typeof ReadinessItemSchema>;

/** 识别出的一个项目（目录与它用的语言生态：`node`、`python`、`go`、`rust`、`c`）。 */
export const ReadinessProjectSchema = z.object({
  path: z.string().max(500),
  ecosystems: z.array(z.string().min(1).max(20)).max(10),
});
export type ReadinessProject = z.infer<typeof ReadinessProjectSchema>;

/**
 * 安装会不会执行代码：`project` 是项目自己清单里的安装生命周期脚本（`preinstall`、`postinstall`、`prepare`…），依赖的脚本
 * `dependencies`：`run` 会跑（Python 源码包的构建也算）、`restricted` 只跑允许的（pnpm 10 起、bun 默认）、`disabled` 不跑（配置了
 * `ignore-scripts`，或下载本来就不执行代码，例如 `go mod download`、`cargo fetch`）、`unknown`。
 */
export const InstallScriptsSchema = z.object({
  project: z.array(z.string().min(1).max(200)).max(20),
  dependencies: z.enum(['run', 'restricted', 'disabled', 'unknown']),
});
export type InstallScripts = z.infer<typeof InstallScriptsSchema>;

/**
 * 安装要用的凭据：项目或用户的配置里引用的环境变量（`.npmrc` 的 `${NPM_TOKEN}`）。`source`：`env` Host 的环境里有、`wevir` 存在
 * Wevir 里（`readiness.setCredential`）、`missing` 都没有。不带值。
 */
export const InstallCredentialSchema = z.object({
  name: z.string().min(1).max(64),
  source: z.enum(['env', 'wevir', 'missing']),
});
export type InstallCredential = z.infer<typeof InstallCredentialSchema>;

/**
 * 一个安装方案：在 `path` 里跑 `command`。`id` 是方案内容（目录、命令、锁文件与清单的状态）的散列：`readiness.install` 带的 `planId`
 * 与 Host 重算出的不同（锁文件变了）时拒绝，用户要看到新方案再确认。`writesLockfile`：没有锁文件、安装会生成一个。
 */
export const InstallPlanSchema = z.object({
  id: z.string().min(1).max(80),
  path: z.string().max(500),
  manager: z.string().min(1).max(40),
  command: z.string().min(1).max(500),
  lockfile: z.string().max(200).optional(),
  writesLockfile: z.boolean(),
  /** 为什么要装：`dependencies_missing`、`dependencies_outdated`、`lockfile_mismatch`…（开放字符串）。 */
  reason: z.string().min(1).max(80),
  scripts: InstallScriptsSchema,
  credentials: z.array(InstallCredentialSchema).max(READINESS_CREDENTIALS_MAX),
});
export type InstallPlan = z.infer<typeof InstallPlanSchema>;

/**
 * 包仓库：`url` 去掉了用户名与口令；`source` 是配置来自哪里（`.npmrc`、`~/.npmrc`、`env:PIP_INDEX_URL`、`default`）。`auth`：
 * `configured` 配了认证、`missing` 引用的凭据找不到、`none` 没配（公共仓库一般不需要）。
 */
export const RegistryInfoSchema = z.object({
  ecosystem: z.string().min(1).max(20),
  url: z.string().max(500),
  source: z.string().max(200),
  auth: z.enum(['configured', 'missing', 'none']),
});
export type RegistryInfo = z.infer<typeof RegistryInfoSchema>;

/**
 * Agent 命令的网络（给了 `sessionId` 时）：`engine` 是会话的引擎，`network`：`sandboxed` 沙箱里不能联网（要联网的命令走审批）、
 * `unrestricted` 不经沙箱、`engine_managed` 由引擎自己的权限管、`unknown`。`domains` 总是 `not_enforced`：没有哪条执行路径能把网络
 * 限定在包仓库的域名里。
 */
export const AgentNetworkSchema = z.object({
  engine: z.string().min(1).max(40),
  permissionMode: z.string().max(40).optional(),
  network: z.enum(['sandboxed', 'unrestricted', 'engine_managed', 'unknown']),
  domains: z.literal('not_enforced'),
});
export type AgentNetwork = z.infer<typeof AgentNetworkSchema>;

/**
 * 网络诊断与配置建议。`proxy` 只列设了哪些代理变量（不带值）。`advice` 是开放的建议代码：`install_by_user`（依赖缺失时由用户在这里
 * 安装，不为了装依赖给 Agent 完全访问）、`registry_auth_missing`、`domains_not_enforced`、`proxy_configured`、`last_install_network`
 * （上次安装连不上仓库）。
 */
export const NetworkDiagnosisSchema = z.object({
  registries: z.array(RegistryInfoSchema).max(20),
  proxy: z.array(z.string().min(1).max(40)).max(10),
  agent: AgentNetworkSchema.optional(),
  advice: z.array(z.string().min(1).max(60)).max(10),
});
export type NetworkDiagnosis = z.infer<typeof NetworkDiagnosisSchema>;

/** 工具链状态（语言服务器等）：预留给以后的 LSP 可用性功能，这个版本的 Host 不填。 */
export const ToolchainStatusSchema = z.looseObject({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  status: ReadinessStatusSchema,
});
export type ToolchainStatus = z.infer<typeof ToolchainStatusSchema>;

/**
 * 一次安装：`running`、`succeeded`、`failed`（`reason` 是归类：`network` 网络失败、`registry_auth` 仓库认证失败、`permission` 没有
 * 写权限、`lockfile_mismatch` 锁文件与清单不一致、`incompatible` 引擎或运行时版本不满足、`not_found` 包管理器找不到、`exit_code`
 * 其他）、`cancelled`（`user` / `host_restarted` / `workspace_removed`）、`timed_out`。`summary` 是输出尾部（凭据已遮住）。
 */
export const InstallStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type InstallStatus = z.infer<typeof InstallStatusSchema>;

export const InstallRunSchema = z.object({
  id: InstallRunIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 绝对路径：检查的根目录（项目目录，或会话的 worktree）。 */
  root: z.string().min(1),
  planId: z.string().min(1).max(80),
  path: z.string().max(500),
  manager: z.string().min(1).max(40),
  command: z.string().min(1).max(500),
  status: InstallStatusSchema,
  reason: z.string().min(1).max(80).optional(),
  startedAt: IsoTimeSchema,
  finishedAt: IsoTimeSchema.optional(),
  durationMs: z.int().min(0).optional(),
  exitCode: z.int().nullable().optional(),
  signal: z.string().optional(),
  timeoutMs: z.int().min(1),
  /** 完整输出的字节数（`readiness.output` 读）。 */
  bytes: z.int().min(0),
  summary: z.string().max(INSTALL_SUMMARY_MAX_LENGTH).optional(),
});
export type InstallRun = z.infer<typeof InstallRunSchema>;

/**
 * 预检报告。`status`：`ready` 没有阻塞项、`not_ready` 有阻塞项、`unknown` 没识别出项目或探测失败。`root` 是检查的根目录（项目目录，
 * 给了 `sessionId` 时是会话的目录，可能是 worktree）。`install` 是这个根目录最近的一次安装。
 */
export const ReadinessReportSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  root: z.string().min(1),
  status: z.enum(['ready', 'not_ready', 'unknown']),
  checkedAt: IsoTimeSchema,
  durationMs: z.int().min(0),
  projects: z.array(ReadinessProjectSchema).max(50),
  items: z.array(ReadinessItemSchema).max(READINESS_ITEMS_MAX),
  plans: z.array(InstallPlanSchema).max(20),
  network: NetworkDiagnosisSchema,
  toolchain: z.array(ToolchainStatusSchema).max(50).optional(),
  install: InstallRunSchema.optional(),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

// ── 方法 ───────────────────────────────────────────────────────

/** `readiness.get`：Host 缓存工具探测结果几分钟；`refresh` 重新探测。 */
export const ReadinessGetParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  refresh: z.boolean().optional(),
});
export const ReadinessGetResultSchema = z.object({ report: ReadinessReportSchema });

/**
 * `readiness.install`：按报告里的方案安装。`acceptScripts` 必须是 true（用户确认过安装会执行代码）。同一个根目录同时只能有一次安装
 * （`RESOURCE_IN_USE`）；方案变了（锁文件或清单改过、依赖已经就绪）回 `INVALID_PARAMS`（路径 `planId`），客户端重新读报告让用户再确认。
 */
export const ReadinessInstallParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  planId: z.string().min(1).max(80),
  acceptScripts: z.literal(true),
  timeoutMs: z.int().min(10_000).max(INSTALL_TIMEOUT_MAX_MS).optional(),
});
export const ReadinessInstallResultSchema = z.object({ run: InstallRunSchema });

export const ReadinessCancelParamsSchema = z.object({ runId: InstallRunIdSchema });
export const ReadinessCancelResultSchema = z.object({ run: InstallRunSchema });

/** `readiness.output`：从 `offset` 起最多一页，不截在半个字符上；凭据已遮住。 */
export const ReadinessOutputParamsSchema = z.object({
  runId: InstallRunIdSchema,
  offset: z.int().min(0).optional(),
});
export const ReadinessOutputResultSchema = z.object({
  text: z.string(),
  from: z.int().min(0),
  next: z.int().min(0),
  more: z.boolean(),
  bytes: z.int().min(0),
});

/** 凭据名：环境变量名。 */
export const CredentialNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/**
 * `readiness.setCredential`：存一个安装时交给进程的环境变量（私有仓库的令牌），值进 Host 的秘密存储；省略 `value` 是删除。结果只有
 * 名字。
 */
export const ReadinessSetCredentialParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  name: CredentialNameSchema,
  value: z.string().min(1).max(READINESS_CREDENTIAL_MAX_LENGTH).optional(),
});
export const ReadinessSetCredentialResultSchema = z.object({
  credentials: z.array(CredentialNameSchema).max(READINESS_CREDENTIALS_MAX),
});

/**
 * `readiness.changed`：发给调过 `readiness.*` 的连接。安装开始、输出变多（最多每秒一次）、结束时带 `run`；安装结束后重新预检时带
 * `report`。
 */
export const ReadinessChangedParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  root: z.string().min(1),
  run: InstallRunSchema.optional(),
  report: ReadinessReportSchema.optional(),
});
