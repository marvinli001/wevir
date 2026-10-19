// 错误的说法（多语言 2026-10-15）：主进程、Host、client-sdk 给的是原因码，这里按界面语言说成话。Host 与引擎的
// 原文（stderr、引擎报错、参数校验）只作诊断细节，不翻译，跟在本地化的说法后面（`hostFailure.withDetail`）。

import { type ClientErrorKind, isRpcError, WevirClientError } from '@wevir/client-sdk';
import type { ErrorCodeName } from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import type { HostExit, HostFailure } from '../../../shared/desktop-api.js';

/** 主进程报的 Host 起不来或意外退出的原因。 */
export function hostFailureText(failure: HostFailure): string {
  return withDetail(failureSummary(failure), failure.detail);
}

function failureSummary(failure: HostFailure): string {
  switch (failure.code) {
    case 'quitting':
      return t('hostFailure.quitting');
    case 'restarting':
      return t('hostFailure.restarting');
    case 'startFailed':
      return exitText(failure.exit, 'hostFailure.startFailedCode', 'hostFailure.startFailedSignal');
    case 'crashed':
      return exitText(failure.exit, 'hostFailure.crashedCode', 'hostFailure.crashedSignal');
    case 'spawnFailed':
      return t('hostFailure.spawnFailed', { path: failure.path });
    case 'notReady':
      return t('hostFailure.notReady', { seconds: failure.seconds });
    case 'otherNotReady':
      return t('hostFailure.otherNotReady');
    case 'staleProcess':
      return t('hostFailure.staleProcess', { pid: failure.pid });
    case 'restartsFailed':
      return t('hostFailure.restartsFailed', {
        first: hostFailureText(failure.first),
        attempts: failure.attempts,
        last: hostFailureText(failure.last),
      });
    case 'manifestInvalid':
      return t('hostFailure.manifestInvalid', { path: failure.path });
    case 'entryMissing':
      return t('hostFailure.entryMissing', { path: failure.path });
    case 'internal':
      return t('hostFailure.internal');
  }
}

function exitText(
  exit: HostExit,
  codeKey: 'hostFailure.startFailedCode' | 'hostFailure.crashedCode',
  signalKey: 'hostFailure.startFailedSignal' | 'hostFailure.crashedSignal',
): string {
  return 'signal' in exit
    ? t(signalKey, { signal: exit.signal })
    : t(codeKey, { code: exit.exitCode });
}

/**
 * Host 的 JSON-RPC 错误码的说法（host-api.md §7）。ENGINE_ERROR 另按引擎错误的类别说（engineError.category）。
 * 列在 `RPC_DETAIL` 里的错误码，Host 的原文有诊断价值，跟在后面；其余的原文只是英文的同义句，不显示。
 */
const RPC_ERROR_TEXT: Record<Exclude<ErrorCodeName, 'ENGINE_ERROR'>, PlainMessageKey> = {
  PARSE_ERROR: 'rpcError.PARSE_ERROR',
  INVALID_REQUEST: 'rpcError.INVALID_REQUEST',
  METHOD_NOT_FOUND: 'rpcError.METHOD_NOT_FOUND',
  INVALID_PARAMS: 'rpcError.INVALID_PARAMS',
  INTERNAL_ERROR: 'rpcError.INTERNAL_ERROR',
  UNAUTHORIZED: 'rpcError.UNAUTHORIZED',
  INCOMPATIBLE_PROTOCOL: 'rpcError.INCOMPATIBLE_PROTOCOL',
  HELLO_REQUIRED: 'rpcError.HELLO_REQUIRED',
  HOST_SHUTTING_DOWN: 'rpcError.HOST_SHUTTING_DOWN',
  WORKSPACE_NOT_FOUND: 'rpcError.WORKSPACE_NOT_FOUND',
  PROVIDER_NOT_FOUND: 'rpcError.PROVIDER_NOT_FOUND',
  SESSION_NOT_FOUND: 'rpcError.SESSION_NOT_FOUND',
  APPROVAL_NOT_FOUND: 'rpcError.APPROVAL_NOT_FOUND',
  PENDING_NOT_FOUND: 'rpcError.PENDING_NOT_FOUND',
  QUESTION_NOT_FOUND: 'rpcError.QUESTION_NOT_FOUND',
  ENVIRONMENT_NOT_FOUND: 'rpcError.ENVIRONMENT_NOT_FOUND',
  IMAGE_NOT_FOUND: 'rpcError.IMAGE_NOT_FOUND',
  MEMORY_NOT_FOUND: 'rpcError.MEMORY_NOT_FOUND',
  INVALID_STATE: 'rpcError.INVALID_STATE',
  SESSION_BUSY: 'rpcError.SESSION_BUSY',
  ALREADY_DECIDED: 'rpcError.ALREADY_DECIDED',
  CLIENT_MESSAGE_CONFLICT: 'rpcError.CLIENT_MESSAGE_CONFLICT',
  RESOURCE_IN_USE: 'rpcError.RESOURCE_IN_USE',
  PENDING_NOT_EDITABLE: 'rpcError.PENDING_NOT_EDITABLE',
  HANDOFF_STALE: 'rpcError.HANDOFF_STALE',
  WORKSPACE_PATH_INVALID: 'rpcError.WORKSPACE_PATH_INVALID',
};

const RPC_DETAIL: ReadonlySet<ErrorCodeName> = new Set([
  'PARSE_ERROR',
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'INTERNAL_ERROR',
  'HELLO_REQUIRED',
]);

/** client-sdk 自己的错误（连接、超时、版本）的说法；`protocol` 带上原文。 */
const CLIENT_ERROR_TEXT: Record<Exclude<ClientErrorKind, 'rpc'>, PlainMessageKey> = {
  request_timeout: 'clientError.request_timeout',
  connect_timeout: 'clientError.connect_timeout',
  connection_lost: 'clientError.connection_lost',
  client_closed: 'clientError.client_closed',
  protocol: 'clientError.protocol',
  feature_unavailable: 'clientError.feature_unavailable',
  host_unavailable: 'clientError.host_unavailable',
};

/**
 * 任意错误的说法，用在各处的 `{error}` 里。认得的错误码按界面语言说；认不出的（Electron 的 IPC 错误、其他异常）
 * 照原文，去掉 Electron 给 IPC 错误加的前缀（“Error invoking remote method '…': HostStartError: ”）。
 */
export function describeError(error: unknown): string {
  if (isRpcError(error)) {
    if (isRpcError(error, 'ENGINE_ERROR')) {
      const category = error.data?.category ?? 'unknown';
      return withDetail(t(`engineError.category.${category}`), error.message);
    }
    const name = error.codeName;
    if (name === undefined || name === 'ENGINE_ERROR') return error.message;
    const text = t(RPC_ERROR_TEXT[name]);
    return RPC_DETAIL.has(name) ? withDetail(text, error.message) : text;
  }
  if (error instanceof WevirClientError && error.kind !== 'rpc') {
    const text = t(CLIENT_ERROR_TEXT[error.kind]);
    return error.kind === 'protocol' ? withDetail(text, error.message) : text;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}

function withDetail(message: string, detail: string | undefined): string {
  return detail ? t('hostFailure.withDetail', { message, detail }) : message;
}
