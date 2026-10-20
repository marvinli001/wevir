import { z } from 'zod';

// Host 生成的 ID：`<前缀>_<主体>`。主体当前是 26 位 ULID（Crockford Base32），可按字典序大致对应
// 创建时间（docs/architecture/host-api.md「ID」）。客户端把 ID 当不透明字符串，schema 只校验前缀
// 和字符集，不校验 ULID 本身，以后换生成算法不算收窄。
const IdBodySchema = z.string().regex(/^[0-9A-Za-z]{1,64}$/);

export const WorkspaceIdSchema = z.templateLiteral(['ws_', IdBodySchema]);
export const SessionIdSchema = z.templateLiteral(['ses_', IdBodySchema]);
export const TurnIdSchema = z.templateLiteral(['trn_', IdBodySchema]);
export const ApprovalIdSchema = z.templateLiteral(['apr_', IdBodySchema]);
export const StreamIdSchema = z.templateLiteral(['stm_', IdBodySchema]);
export const SubscriptionIdSchema = z.templateLiteral(['sub_', IdBodySchema]);
/** 待发消息（0.8.0，R11）。 */
export const PendingMessageIdSchema = z.templateLiteral(['pnd_', IdBodySchema]);
/** 引擎向用户提的一组问题（0.10.0）。 */
export const QuestionIdSchema = z.templateLiteral(['qst_', IdBodySchema]);
/** 建议的后续任务（0.16.0，U23）。 */
export const TaskIdSchema = z.templateLiteral(['tsk_', IdBodySchema]);
/** 保存的环境（0.15.0，U22.1）。 */
export const EnvironmentIdSchema = z.templateLiteral(['env_', IdBodySchema]);
/** 用户消息里的图片（0.28.0）。 */
export const ImageIdSchema = z.templateLiteral(['img_', IdBodySchema]);
/** 自动化与它的一次运行（0.66.0）。 */
export const AutomationIdSchema = z.templateLiteral(['aut_', IdBodySchema]);
export const AutomationRunIdSchema = z.templateLiteral(['arn_', IdBodySchema]);
/** 第二意见（0.75.0）。 */
export const OpinionIdSchema = z.templateLiteral(['opn_', IdBodySchema]);
/** Host 实例 ID：每个数据目录一个，跨重启不变。 */
export const HostIdSchema = z.templateLiteral(['hst_', IdBodySchema]);
/** 工作区的一项检查（0.65.0，回合后验证）。 */
export const CheckIdSchema = z.templateLiteral(['chk_', IdBodySchema]);
/** 一次检查运行，即一条验证记录（0.65.0）。 */
export const VerificationRunIdSchema = z.templateLiteral(['vrn_', IdBodySchema]);
/** 同一次触发的一轮检查（0.65.0）。 */
export const VerificationRoundIdSchema = z.templateLiteral(['vrd_', IdBodySchema]);
/** 一条自动修复链（0.65.0）。 */
export const RepairIdSchema = z.templateLiteral(['rpr_', IdBodySchema]);
/** diff 上的一条行级批注（0.67.0）。 */
export const ReviewCommentIdSchema = z.templateLiteral(['rvc_', IdBodySchema]);
/** 用户的交互终端（0.69.0）。 */
export const TerminalIdSchema = z.templateLiteral(['trm_', IdBodySchema]);
/** 用户发起的一次项目安装（0.70.0）。 */
export const InstallRunIdSchema = z.templateLiteral(['ins_', IdBodySchema]);
/** 一次语言服务器安装（0.71.0）。 */
export const LspInstallIdSchema = z.templateLiteral(['lsi_', IdBodySchema]);
/** 一条审批规则（0.78.0）。 */
export const ApprovalRuleIdSchema = z.templateLiteral(['arl_', IdBodySchema]);

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type EnvironmentId = z.infer<typeof EnvironmentIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type StreamId = z.infer<typeof StreamIdSchema>;
export type SubscriptionId = z.infer<typeof SubscriptionIdSchema>;
export type PendingMessageId = z.infer<typeof PendingMessageIdSchema>;
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export type ImageId = z.infer<typeof ImageIdSchema>;
export type HostId = z.infer<typeof HostIdSchema>;
export type CheckId = z.infer<typeof CheckIdSchema>;
export type VerificationRunId = z.infer<typeof VerificationRunIdSchema>;
export type VerificationRoundId = z.infer<typeof VerificationRoundIdSchema>;
export type RepairId = z.infer<typeof RepairIdSchema>;
export type TerminalId = z.infer<typeof TerminalIdSchema>;
export type InstallRunId = z.infer<typeof InstallRunIdSchema>;
export type LspInstallId = z.infer<typeof LspInstallIdSchema>;
export type ApprovalRuleId = z.infer<typeof ApprovalRuleIdSchema>;
export type AutomationId = z.infer<typeof AutomationIdSchema>;
export type AutomationRunId = z.infer<typeof AutomationRunIdSchema>;
export type ReviewCommentId = z.infer<typeof ReviewCommentIdSchema>;
export type OpinionId = z.infer<typeof OpinionIdSchema>;

/** Provider ID 同时是 dsh 的 provider 路由名，会写进 dsh 会话日志，创建后不可改。 */
export const ProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** ISO 8601，UTC（`Z`），毫秒精度，即 `Date.prototype.toISOString()` 的输出。 */
export const IsoTimeSchema = z.iso.datetime({ precision: 3 });
export type IsoTime = z.infer<typeof IsoTimeSchema>;

/** 会话内事件序号：从 1 开始连续递增。 */
export const SeqSchema = z.int().min(1);
/** `sinceSeq` 一类游标：0 表示“从头开始”。 */
export const SeqCursorSchema = z.int().min(0);

/** 客户端生成的不透明标识（`deviceId`、`clientId`、`clientMessageId`）。 */
export const ClientTokenSchema = z.string().min(1).max(128);

/** `mobile` 为移动端预留（ADR-0002 §2），骨架不会出现。 */
export const ClientKindSchema = z.enum(['desktop', 'cli', 'mobile']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/** 发起操作的客户端，取自该连接 `host.hello` 的参数。 */
export const ClientIdentitySchema = z.object({
  deviceId: ClientTokenSchema,
  clientId: ClientTokenSchema,
  clientKind: ClientKindSchema,
});
export type ClientIdentity = z.infer<typeof ClientIdentitySchema>;
