// 高风险审批的本人验证（0.131.0）：Host 在审批上标了 `risk`（approval-rules/risk.ts 判定）时，手机上选“允许”之前先过一道验证
// （Face ID / 指纹，没有生物识别时退到设备密码）。拒绝不用验证。收件箱、会话页与助理的审批都走这里；验证本身由界面层装上
// （state/lock.tsx），这里只有判定与调用，测试装假的。没装验证时一律不放行。

import type { ApprovalRisk } from '@wevir/protocol';

/** 验证本人；通过返回 true，用户取消或失败返回 false。 */
export type ApprovalGate = (risk: ApprovalRisk) => Promise<boolean>;

/** 用户没有通过验证（取消、失败，或这台手机没有任何锁屏方式）。 */
export class ApprovalNotVerifiedError extends Error {
  override readonly name = 'ApprovalNotVerifiedError';
  constructor() {
    super('identity was not verified for a high-risk approval');
  }
}

let gate: ApprovalGate | undefined;

/** 装上验证；返回卸下的函数。 */
export function setApprovalGate(next: ApprovalGate): () => void {
  gate = next;
  return () => {
    if (gate === next) gate = undefined;
  };
}

/** 作答前调用：高风险且是允许类时要先通过验证，否则抛 `ApprovalNotVerifiedError`。 */
export async function verifyApproval(
  request: { risk?: ApprovalRisk | undefined },
  category: 'allow' | 'reject',
): Promise<void> {
  if (category !== 'allow' || request.risk?.level !== 'high') return;
  const current = gate;
  if (current === undefined || !(await current(request.risk))) throw new ApprovalNotVerifiedError();
}
