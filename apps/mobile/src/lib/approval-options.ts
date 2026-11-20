import type { ApprovalOption } from '@wevir/protocol';
import { type MessageKey, t } from '../i18n';

const kinds: Record<string, MessageKey> = {
  allow_once: 'approval.option.allowOnce',
  allow_accept: 'bot.approve',
  allow_always: 'approval.option.allowAlways',
  allow_accept_for_session: 'approval.option.allowForSession',
  reject_once: 'bot.reject',
  reject_decline: 'bot.reject',
  reject_cancel: 'approval.option.rejectAndStop',
  reject_always: 'approval.option.rejectAlways',
};

export function approvalChoices(options: readonly ApprovalOption[]) {
  const reject =
    options.find((o) => o.kind === 'reject_cancel') ??
    options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_decline');
  const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_accept');
  return {
    primary: [reject, allow].filter((o): o is ApprovalOption => o !== undefined),
    other: options.filter((o) => o !== allow && o !== reject),
  };
}

export function approvalLabel(option: ApprovalOption, options: readonly ApprovalOption[]) {
  if (option.kind === 'reject_decline' && options.some((o) => o.kind === 'reject_cancel'))
    return t('approval.declineContinue');
  if (option.policyTarget) {
    const target = option.policyTarget;
    if (option.kind === 'allow_exec_policy') return t('approval.option.allowPrefix', { target });
    if (option.kind === 'allow_network_policy') return t('approval.option.allowHost', { target });
    if (option.kind === 'reject_always_network') return t('approval.option.blockHost', { target });
  }
  if (
    option.label &&
    options.some(
      (other) =>
        other.optionId !== option.optionId &&
        other.kind === option.kind &&
        other.label !== option.label,
    )
  )
    return option.label;
  const key = Object.hasOwn(kinds, option.kind) ? kinds[option.kind] : undefined;
  return key ? t(key) : option.label || option.kind;
}
