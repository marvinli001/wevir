import { AdapterError } from '@wevir/runtime-adapter';
import { CodexRpcError } from './codex-process.js';

// Codex 的 ConstraintError::InvalidValue。只保留值与允许列表，省略要求来源中的本地路径和组织信息。
const MANAGED_PERMISSION_REJECTION =
  /(?:^|: )invalid value for `(approval_policy|approvals_reviewer|sandbox_mode)`: `([A-Za-z]{1,32})` is not in the allowed set \[([A-Za-z_ ,:{}()]{1,512})\] \(set by /;

export function managedPermissionFailure(error: unknown): AdapterError | undefined {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return undefined;
  const rejection = MANAGED_PERMISSION_REJECTION.exec(error.rpcMessage);
  if (rejection === null) return undefined;
  const [, setting, requested, allowed] = rejection;
  return new AdapterError(
    'invalid_input',
    `Codex 托管策略拒绝 ${setting}=${requested}。允许值为 ${allowed}。切换权限模式，或联系管理员。`,
    { cause: error },
  );
}
