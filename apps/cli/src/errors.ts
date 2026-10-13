import {
  ClientClosedError,
  ConnectionLostError,
  ConnectTimeoutError,
  FeatureUnavailableError,
  HostUnavailableError,
  ProtocolError,
  RequestTimeoutError,
  WevirRpcError,
} from '@wevir/client-sdk';
import { PROTOCOL_VERSION } from '@wevir/protocol';
import { ENGINE_ERROR_HINT, ENGINE_ERROR_LABEL, READ_ONLY_LABEL, STATE_LABEL } from './format.js';

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
  constructor(message: string, hint = '运行 wevir --help 查看用法') {
    super(message, hint, EXIT.usage);
  }
}

export interface Described {
  message: string;
  hint?: string;
}

/** 把任何错误翻译成中文说明与下一步建议。 */
export function describeError(error: unknown): Described {
  if (error instanceof CliError) return withHint(error.message, error.hint);
  if (error instanceof HostUnavailableError) {
    switch (error.reason) {
      case 'not_running':
        return { message: 'Wevir Host 没有在运行。', hint: '先运行 wevir host start' };
      case 'starting':
        return {
          message: 'Wevir Host 正在启动，还不能连接。',
          hint: '稍等几秒再试，或运行 wevir host status 查看',
        };
      case 'invalid_runtime_file':
        return {
          message: `读不了 Host 的运行时文件 ${error.path}。`,
          hint: '运行 wevir host status 检查；确认没有 Host 在运行后删除该文件，再 wevir host start',
        };
    }
  }
  if (error instanceof ConnectTimeoutError) {
    return {
      message: `${error.timeoutMs / 1000} s 内没能连上 Host。`,
      hint: '运行 wevir host status 检查 Host 是否卡住；必要时 wevir host stop 后再 wevir host start',
    };
  }
  if (error instanceof ConnectionLostError) {
    return {
      message: '与 Host 的连接断开了。',
      hint: '运行 wevir host status 检查 Host 是否还在运行',
    };
  }
  if (error instanceof ClientClosedError) {
    return error.cause === undefined
      ? { message: '与 Host 的连接已关闭。' }
      : describeError(error.cause);
  }
  if (error instanceof RequestTimeoutError) {
    return {
      message: `请求 ${error.method} 在 ${error.timeoutMs / 1000} s 内没有得到响应。`,
      hint: error.sent
        ? 'Host 可能仍在处理；运行 wevir host status 检查'
        : '一直没连上 Host；运行 wevir host status 检查',
    };
  }
  if (error instanceof ProtocolError) {
    return {
      message: `Host 的响应不合协议：${error.message}`,
      hint: '确认 CLI 与 Host 来自同一次构建（pnpm build 后 wevir host stop && wevir host start）',
    };
  }
  if (error instanceof FeatureUnavailableError) {
    return {
      message: `Host ${error.hostVersion} 不支持 ${error.feature}。`,
      hint: '升级 Wevir Host',
    };
  }
  if (error instanceof WevirRpcError) return describeRpcError(error);
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

function describeRpcError(error: WevirRpcError): Described {
  if (error.is('UNAUTHORIZED')) {
    return {
      message: 'Host 拒绝了令牌。',
      hint: 'run/host.json 可能来自另一次启动；运行 wevir host status 检查',
    };
  }
  if (error.is('INCOMPATIBLE_PROTOCOL')) {
    const data = error.data;
    return {
      message: data
        ? `CLI（协议 ${PROTOCOL_VERSION}）与 Host ${data.hostVersion}（协议 ${data.protocolVersion}，最低 ${data.minProtocolVersion}）不兼容。`
        : `CLI（协议 ${PROTOCOL_VERSION}）与 Host 的协议不兼容。`,
      hint: '用同一版本的 CLI 与 Host：pnpm build 后 wevir host stop && wevir host start',
    };
  }
  if (error.is('HOST_SHUTTING_DOWN')) {
    return { message: 'Host 正在退出。', hint: '等它退出后运行 wevir host start' };
  }
  if (error.is('WORKSPACE_NOT_FOUND')) {
    return { message: '工作区不存在。', hint: '运行 wevir workspace list 查看' };
  }
  if (error.is('PROVIDER_NOT_FOUND')) {
    return {
      message: 'Provider 不存在。',
      hint: '运行 wevir provider list 查看，或 wevir provider add 添加',
    };
  }
  if (error.is('SESSION_NOT_FOUND')) {
    return { message: '会话不存在。', hint: '运行 wevir session list 查看' };
  }
  if (error.is('APPROVAL_NOT_FOUND')) return { message: '这条审批不存在。' };
  if (error.is('INVALID_STATE')) {
    const data = error.data;
    if (data?.readOnly) {
      return {
        message: `会话只读：${READ_ONLY_LABEL[data.readOnly.reason]}（${data.readOnly.message}）。`,
        hint: '历史仍可用 wevir session attach 查看；要继续对话请新建会话',
      };
    }
    return {
      message: data
        ? `会话处于“${STATE_LABEL[data.state]}”状态，不能执行这个操作。`
        : '会话当前的状态不允许这个操作。',
    };
  }
  if (error.is('SESSION_BUSY')) {
    const state = error.data?.state;
    return {
      message: `会话正忙（${state ? STATE_LABEL[state] : '运行中'}），这条消息没有发出。`,
      hint: '等本轮结束再发送，或在 attach 中按 Ctrl-C 取消当前运行',
    };
  }
  if (error.is('ALREADY_DECIDED')) return { message: '这条审批已经处理过了。' };
  if (error.is('CLIENT_MESSAGE_CONFLICT')) {
    return { message: '同一个消息 ID 已用于另一条内容。' };
  }
  if (error.is('RESOURCE_IN_USE')) {
    const ids = error.data?.sessionIds ?? [];
    return {
      message: `还有未关闭的会话在使用它${ids.length ? `：${ids.join('、')}` : ''}。`,
    };
  }
  if (error.is('WORKSPACE_PATH_INVALID')) {
    const data = error.data;
    const reason = data
      ? {
          not_absolute: '不是绝对路径',
          not_found: '不存在',
          not_directory: '不是目录',
          not_accessible: '无法访问',
        }[data.reason]
      : '不可用';
    return {
      message: `工作区目录${reason}${data ? `：${data.path}` : ''}。`,
      hint: '检查路径；目录被移动过时用新路径重新 wevir workspace add',
    };
  }
  if (error.is('ENGINE_ERROR')) {
    const data = error.data;
    if (!data) return { message: `引擎错误：${error.message}` };
    return {
      message: `引擎错误（${ENGINE_ERROR_LABEL[data.category]}）：${data.message}`,
      hint: ENGINE_ERROR_HINT[data.category],
    };
  }
  if (error.is('INVALID_PARAMS')) {
    const issues = error.data?.issues ?? [];
    return {
      message:
        issues.length > 0
          ? `参数不合法：${issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}`
          : `参数不合法：${error.message}`,
    };
  }
  if (error.is('METHOD_NOT_FOUND')) {
    return { message: `Host 不认识这个请求：${error.message}`, hint: error.data?.hint };
  }
  return { message: `Host 返回错误：${error.message}` };
}

function withHint(message: string, hint: string | undefined): Described {
  return hint === undefined ? { message } : { message, hint };
}
