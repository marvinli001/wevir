import {
  ClientClosedError,
  ConnectionLostError,
  ConnectTimeoutError,
  FeatureUnavailableError,
  HostUnavailableError,
  ProtocolError,
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
  RequestTimeoutError,
  relayCloseFailure,
  WevirRpcError,
} from '@wevir/client-sdk';
import { CloseCode, PROTOCOL_VERSION } from '@wevir/protocol';
import { engineErrorHint, engineErrorLabel, readOnlyLabel, stateLabel } from './format.js';
import { joinList, t } from './i18n/index.js';

/** CLI 的退出码。 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** 交互输入时按了 Ctrl-C。 */
  interrupted: 130,
} as const;

/** 给用户看的错误：一句说明，加上下一步建议。 */
export class CliError extends Error {
  override readonly name: string = 'CliError';
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: number = EXIT.failure,
  ) {
    super(message);
  }
}

/** 命令行用法错误（退出码 2）。 */
export class UsageError extends CliError {
  override readonly name = 'UsageError';
  constructor(message: string, hint = t('usage.seeHelp')) {
    super(message, hint, EXIT.usage);
  }
}

export interface Described {
  message: string;
  hint?: string;
}

/** 经中继没走通（0.110.0）：中继说明的原因。 */
function describeRelayFailure(failure: RemoteRelayFailure): Described {
  switch (failure) {
    case 'offline':
      return { message: t('err.relayOffline'), hint: t('err.relayOffline.hint') };
    case 'rate_limited':
      return { message: t('err.relayRateLimited'), hint: t('err.relayRetryLater') };
    case 'busy':
      return { message: t('err.relayBusy'), hint: t('err.relayRetryLater') };
    case 'host_unavailable':
      return { message: t('err.relayHostUnavailable'), hint: t('err.relayRetryLater') };
    case 'limit_exceeded':
      return { message: t('err.relayLimit'), hint: t('err.relayRetryLater') };
    case 'protocol_error':
      return { message: t('err.relayProtocol'), hint: t('err.relayProtocol.hint') };
    case 'host_rejected':
      return { message: t('err.relayHostRejected'), hint: t('err.relayHostRejected.hint') };
  }
}

/** 把任何错误翻译成当前语言的说明与下一步建议。 */
export function describeError(error: unknown): Described {
  if (error instanceof CliError) return withHint(error.message, error.hint);
  if (error instanceof HostUnavailableError) {
    switch (error.reason) {
      case 'not_running':
        return { message: t('err.hostNotRunning'), hint: t('err.hostNotRunning.hint') };
      case 'starting':
        return { message: t('err.hostStarting'), hint: t('err.hostStarting.hint') };
      case 'invalid_runtime_file':
        return {
          message: t('err.runtimeFile', { path: error.path }),
          hint: t('err.runtimeFile.hint'),
        };
    }
  }
  if (error instanceof ConnectTimeoutError) {
    return {
      message: t('err.connectTimeout', { seconds: error.timeoutMs / 1000 }),
      hint: t('err.connectTimeout.hint'),
    };
  }
  if (error instanceof ConnectionLostError) {
    // 远程连接（0.109.0）：传输层给的原因与远程的关闭码更能说明问题。
    if (error.cause instanceof Error) return describeError(error.cause);
    switch (error.closeCode) {
      case CloseCode.DEVICE_REVOKED:
        return { message: t('err.deviceRevoked'), hint: t('err.deviceRevoked.hint') };
      case CloseCode.PAIRING_DENIED:
        return { message: t('err.pairingDenied') };
      case CloseCode.REMOTE_DISABLED:
        return { message: t('err.remoteDisabled'), hint: t('err.remoteDisabled.hint') };
    }
    const relay = relayCloseFailure(error.closeCode);
    if (relay !== undefined) return describeRelayFailure(relay);
    return { message: t('err.connectionLost'), hint: t('err.connectionLost.hint') };
  }
  if (error instanceof RemoteUnreachableError) {
    if (error.relay !== undefined) return describeRelayFailure(error.relay);
    return {
      message:
        error.tried.length === 0
          ? t('err.remoteNoAddress')
          : t('err.remoteUnreachable', { addresses: joinList(error.tried) }),
      hint: t('err.remoteUnreachable.hint'),
    };
  }
  if (error instanceof RemoteHandshakeError) {
    switch (error.reason) {
      case 'rejected':
        return { message: t('err.remoteRejected'), hint: t('err.remoteRejected.hint') };
      case 'wrong_secret':
        return { message: t('err.remoteWrongSecret'), hint: t('err.remoteWrongSecret.hint') };
      case 'host_mismatch':
        return { message: t('err.remoteHostMismatch'), hint: t('err.remoteHostMismatch.hint') };
      case 'timeout':
        return {
          message: t('err.remoteTimeout', { address: error.route }),
          hint: t('err.remoteTimeout.hint'),
        };
    }
  }
  if (error instanceof ClientClosedError) {
    return error.cause === undefined
      ? { message: t('err.clientClosed') }
      : describeError(error.cause);
  }
  if (error instanceof RequestTimeoutError) {
    return {
      message: t('err.requestTimeout', {
        method: error.method,
        seconds: error.timeoutMs / 1000,
      }),
      hint: error.sent ? t('err.requestTimeout.sent') : t('err.requestTimeout.unsent'),
    };
  }
  if (error instanceof ProtocolError) {
    return {
      message: t('err.protocol', { message: error.message }),
      hint: t('err.protocol.hint'),
    };
  }
  if (error instanceof FeatureUnavailableError) {
    return {
      message: t('err.featureUnavailable', {
        version: error.hostVersion,
        feature: error.feature,
      }),
      hint: t('err.featureUnavailable.hint'),
    };
  }
  if (error instanceof WevirRpcError) return describeRpcError(error);
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

function describeRpcError(error: WevirRpcError): Described {
  if (error.is('UNAUTHORIZED')) {
    return { message: t('err.unauthorized'), hint: t('err.unauthorized.hint') };
  }
  if (error.is('DEVICE_FORBIDDEN')) {
    return {
      message: t('err.deviceForbidden', {
        permissions: joinList(error.data?.missing ?? []),
      }),
      hint: t('err.deviceForbidden.hint'),
    };
  }
  if (error.is('INCOMPATIBLE_PROTOCOL')) {
    const data = error.data;
    return {
      message: data
        ? t('err.incompatible', {
            cliProtocol: PROTOCOL_VERSION,
            hostVersion: data.hostVersion,
            hostProtocol: data.protocolVersion,
            minProtocol: data.minProtocolVersion,
          })
        : t('err.incompatibleUnknown', { cliProtocol: PROTOCOL_VERSION }),
      hint: t('err.incompatible.hint'),
    };
  }
  if (error.is('HOST_SHUTTING_DOWN')) {
    return { message: t('err.shuttingDown'), hint: t('err.shuttingDown.hint') };
  }
  if (error.is('WORKSPACE_NOT_FOUND')) {
    return { message: t('err.workspaceNotFound'), hint: t('err.workspaceNotFound.hint') };
  }
  if (error.is('PROVIDER_NOT_FOUND')) {
    return { message: t('err.providerNotFound'), hint: t('err.providerNotFound.hint') };
  }
  if (error.is('SESSION_NOT_FOUND')) {
    return { message: t('err.sessionNotFound'), hint: t('err.sessionNotFound.hint') };
  }
  if (error.is('AUTOMATION_NOT_FOUND')) {
    return { message: t('err.automationNotFound'), hint: t('err.automationNotFound.hint') };
  }
  if (error.is('APPROVAL_NOT_FOUND')) return { message: t('err.approvalNotFound') };
  if (error.is('INVALID_STATE')) {
    const data = error.data;
    if (data?.readOnly) {
      return {
        message: t('err.readOnly', {
          reason: readOnlyLabel(data.readOnly.reason),
          message: data.readOnly.message,
        }),
        hint: t('err.readOnly.hint'),
      };
    }
    return {
      message: data
        ? t('err.invalidState', { state: stateLabel(data.state) })
        : t('err.invalidStateUnknown'),
    };
  }
  if (error.is('SESSION_BUSY')) {
    const state = error.data?.state;
    return {
      message: t('err.busy', { state: stateLabel(state ?? 'running') }),
      hint: t('err.busy.hint'),
    };
  }
  if (error.is('ALREADY_DECIDED')) return { message: t('err.alreadyDecided') };
  if (error.is('APPROVAL_EXPIRED')) return { message: t('err.approvalExpired') };
  if (error.is('CLIENT_MESSAGE_CONFLICT')) return { message: t('err.messageConflict') };
  if (error.is('RESOURCE_IN_USE')) {
    const ids = error.data?.sessionIds ?? [];
    return {
      message: ids.length
        ? t('err.resourceInUseIds', { ids: joinList(ids) })
        : t('err.resourceInUse'),
    };
  }
  if (error.is('WORKSPACE_PATH_INVALID')) {
    const data = error.data;
    return {
      message: data
        ? t('err.workspacePath', {
            reason: t(`err.workspacePath.${data.reason}`),
            path: data.path,
          })
        : t('err.workspacePathUnknown'),
      hint: t('err.workspacePath.hint'),
    };
  }
  if (error.is('ENGINE_ERROR')) {
    const data = error.data;
    if (!data) return { message: t('err.engine', { message: error.message }) };
    return {
      message: t('err.engineCategory', {
        category: engineErrorLabel(data.category),
        message: data.message,
      }),
      hint: engineErrorHint(data.category),
    };
  }
  if (error.is('INVALID_PARAMS')) {
    const issues = error.data?.issues ?? [];
    return {
      message: t('err.invalidParams', {
        issues:
          issues.length > 0
            ? issues
                .map((i) => `${i.path.join('.') || t('err.invalidParams.root')} ${i.message}`)
                .join(t('list.semicolon'))
            : error.message,
      }),
    };
  }
  if (error.is('METHOD_NOT_FOUND')) {
    return {
      message: t('err.methodNotFound', { message: error.message }),
      hint: error.data?.hint,
    };
  }
  return { message: t('err.host', { message: error.message }) };
}

function withHint(message: string, hint: string | undefined): Described {
  return hint === undefined ? { message } : { message, hint };
}
