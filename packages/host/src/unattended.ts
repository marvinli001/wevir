import type { Session } from '@wevir/protocol';

/** 沿用提问与审批的无人值守范围，频道线程仍有人值守。 */
export function unattended(session: Session): boolean {
  return (
    session.automation !== undefined ||
    session.parentSessionId !== undefined ||
    session.openedBy !== undefined
  );
}
