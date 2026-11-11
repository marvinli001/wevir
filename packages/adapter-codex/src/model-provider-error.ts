import { AdapterError } from '@wevir/runtime-adapter';
import type { CodexAdapterLogger } from './codex-adapter.js';
import { CodexRpcError } from './codex-process.js';
import { isRecord } from './mapping.js';

/** ModelProviderError.ts；未知 data 保留原 JSON-RPC 错误回退。 */
export function modelProviderFailure(
  error: unknown,
  logger: Pick<CodexAdapterLogger, 'warn'>,
): AdapterError | undefined {
  if (!(error instanceof CodexRpcError)) return undefined;
  const data = error.data;
  if (!isRecord(data) || typeof data.modelProvider !== 'string') return undefined;
  if (data.type === 'modelProviderMismatch' && typeof data.currentModelProvider === 'string') {
    logger.warn('Codex 服务商路由不一致', {
      modelProvider: data.modelProvider,
      currentModelProvider: data.currentModelProvider,
    });
    return new AdapterError('engine_unavailable', 'Codex 服务商路由异常', { cause: error });
  }
  if (data.type === 'modelProviderNotConfigured') {
    return new AdapterError('invalid_input', '服务商已删除或未配置，重新选择服务商', {
      cause: error,
    });
  }
  if (
    data.type === 'modelProviderPolicyConflict' &&
    typeof data.requiredModelProvider === 'string'
  ) {
    return new AdapterError(
      'invalid_input',
      `服务商不符合托管策略（${data.requiredModelProvider}）`,
      {
        cause: error,
      },
    );
  }
  return undefined;
}
