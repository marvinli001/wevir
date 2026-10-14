// 审批卡片的文案与内容（T5.3），按 acp-event-mapping.md §5.5：审批问的是“这一次操作能不能越过工作区的
// 限制”。标题按展示类型；正文是目标、所需权限、Agent 给出的理由，写文件再附内容预览；按钮按请求携带的选项。
// U13 起照 Claude Code 的权限提示：标题是一句问话，目标（命令全文或路径）放在代码块里，选项分左右两组、带数字键。
// 纯函数，组件在 approval-card.tsx。

import type {
  ApprovalOption,
  ApprovalRequest,
  ApprovalResolution,
  ClientIdentity,
} from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';

/** 内容预览最多显示的行数。 */
const PREVIEW_LINES = 6;

export interface ApprovalPresentation {
  title: string;
  /** 目标：命令全文或路径。 */
  target?: string;
  permission?: string;
  justification?: string;
  /** 写文件时的内容开头。 */
  preview?: { text: string; more: boolean };
}

export function presentApproval(approval: ApprovalRequest): ApprovalPresentation {
  const detail = approval.detail;
  if (!detail) return { title: t('approval.title.generic') };
  const kind = detail.display.kind;
  const title =
    kind === 'write' || kind === 'edit'
      ? t('approval.title.file')
      : kind === 'shell'
        ? t('approval.title.shell')
        : t('approval.title.generic');
  const target = (
    kind === 'shell'
      ? (detail.display.command ?? detail.display.summary)
      : (detail.display.paths?.join('\n') ?? detail.display.summary ?? detail.display.command)
  )?.trim();
  const presentation: ApprovalPresentation = { title };
  if (target) presentation.target = target;
  if (detail.sandboxPermissions) {
    presentation.permission =
      detail.sandboxPermissions === 'danger-full-access'
        ? t('approval.permission.fullAccess')
        : detail.sandboxPermissions;
  }
  if (detail.justification) presentation.justification = detail.justification;
  const content = isRecord(detail.input) ? detail.input.content : undefined;
  if (kind === 'write' && typeof content === 'string') {
    const lines = content.split('\n');
    presentation.preview = {
      text: lines.slice(0, PREVIEW_LINES).join('\n'),
      more: lines.length > PREVIEW_LINES,
    };
  }
  return presentation;
}

/**
 * 审批只给两个按钮（照 Claude Code 与 Codex，维护者 2026-10-15 定）：左边“拒绝”（1、Esc），右边“允许”（2、⌘↵，主按钮）。
 * 拒绝取 Codex 的“拒绝并停止”（`reject_cancel`：停下回合等用户说怎么做，同两者的 No / Deny），没有时取第一个拒绝类；允许取
 * 第一个允许类（只允许这一次）。“本会话不再询问”这类选项不再出现，长期放开改用权限模式（自动批准、完全访问，0.11.0）。
 */
export interface ApprovalLayout {
  reject: ApprovalOption | undefined;
  allow: ApprovalOption | undefined;
  /** 从左到右，第 i 个对应数字键 i + 1。 */
  numbered: ApprovalOption[];
}

export function approvalLayout(options: readonly ApprovalOption[]): ApprovalLayout {
  const rejects = options.filter((option) => option.category === 'reject');
  const reject = rejects.find((option) => option.kind === 'reject_cancel') ?? rejects[0];
  const allow = options.find((option) => option.category === 'allow');
  return {
    reject,
    allow,
    numbered: [reject, allow].filter((option) => option !== undefined),
  };
}

/** 选项按钮的文字：认识的 kind 本地化，不认识的显示引擎给的 label（与 CLI 的 optionLabel 一致）。 */
export function optionLabel(option: Pick<ApprovalOption, 'kind' | 'label'>): string {
  const key = OPTION_LABELS[option.kind];
  return key ? t(key) : option.label || option.kind;
}

const OPTION_LABELS: Record<string, PlainMessageKey> = {
  allow_once: 'approval.option.allowOnce',
  allow_always: 'approval.option.allowAlways',
  reject_once: 'approval.option.reject',
  reject_always: 'approval.option.rejectAlways',
};

const CLIENT_KIND_LABELS: Record<ClientIdentity['clientKind'], PlainMessageKey> = {
  desktop: 'client.desktop',
  cli: 'client.cli',
  mobile: 'client.mobile',
};

/** “本机的 CLI”“桌面端（设备 dev-6f1c）”这样的称呼；`self` 是本连接的身份。 */
export function clientLabel(client: ClientIdentity, self: ClientIdentity | undefined): string {
  const kind = t(CLIENT_KIND_LABELS[client.clientKind]);
  if (self && client.deviceId === self.deviceId) {
    return client.clientId === self.clientId
      ? t('client.thisWindow')
      : t('client.sameDevice', { kind });
  }
  return t('client.otherDevice', { kind, device: client.deviceId.slice(0, 10) });
}

/** 审批结算后的一句话，例如“已由本机的 CLI 处理：允许一次”“审批已取消（回合被取消）”。 */
export function resolutionText(
  approval: ApprovalRequest,
  resolution: ApprovalResolution,
  self: ClientIdentity | undefined,
): string {
  if (resolution.reason !== 'user') return t(`approval.ended.${resolution.reason}`);
  const option = approval.options.find((candidate) => candidate.optionId === resolution.optionId);
  const decision = option ? optionLabel(option) : (resolution.optionId ?? '');
  if (!resolution.decidedBy) return t('approval.resolved', { decision });
  return t('approval.resolvedBy', { who: clientLabel(resolution.decidedBy, self), decision });
}

/** 这次结算是不是本窗口做的（本窗口的决定不另外提示）。 */
export function decidedHere(
  resolution: ApprovalResolution | undefined,
  self: ClientIdentity | undefined,
): boolean {
  return (
    resolution?.reason === 'user' &&
    self !== undefined &&
    resolution.decidedBy?.clientId === self.clientId &&
    resolution.decidedBy.deviceId === self.deviceId
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
