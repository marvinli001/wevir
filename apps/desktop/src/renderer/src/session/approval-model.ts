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
 * 选项按钮怎么排（照 Claude Code）：拒绝类在左，允许类在右，第一个允许类是主按钮、排在最右（⌘↵）；数字键按从左到右的
 * 顺序。Codex 的“拒绝并停止”（`reject_cancel`）还接 Esc，同输入框里 Esc 停止回合的意思一致；别的引擎没有这一项，Esc
 * 照旧停止回合。
 */
export interface ApprovalLayout {
  start: ApprovalOption[];
  end: ApprovalOption[];
  primary: ApprovalOption | undefined;
  escape: ApprovalOption | undefined;
  /** 从左到右，第 i 个对应数字键 i + 1。 */
  numbered: ApprovalOption[];
}

export function approvalLayout(options: readonly ApprovalOption[]): ApprovalLayout {
  const start = options.filter((option) => option.category === 'reject');
  const allows = options.filter((option) => option.category === 'allow');
  const primary = allows[0];
  const end = primary ? [...allows.slice(1), primary] : allows;
  return {
    start,
    end,
    primary,
    escape: start.find((option) => option.kind === 'reject_cancel'),
    numbered: [...start, ...end],
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
