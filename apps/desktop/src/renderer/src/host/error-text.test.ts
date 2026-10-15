import {
  ConnectionLostError,
  FeatureUnavailableError,
  ProtocolError,
  WevirRpcError,
} from '@wevir/client-sdk';
import { ErrorCode } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog, setLocale } from '@/i18n';
import { zhCN } from '@/i18n/zh-CN';
import { describeError, hostFailureText } from './error-text';

afterEach(() => setLocale('zh-CN', zhCN));

function rpc(code: number, message: string, data?: unknown): WevirRpcError {
  return new WevirRpcError('session.send', { code, message, ...(data !== undefined && { data }) });
}

describe('hostFailureText', () => {
  it('按原因码说成话，原文跟在后面', () => {
    expect(hostFailureText({ code: 'crashed', exit: { signal: 'SIGKILL' } })).toBe(
      '后台服务异常退出（信号 SIGKILL）',
    );
    expect(
      hostFailureText({
        code: 'startFailed',
        exit: { exitCode: 2 },
        detail: 'wevir-host: --adapter',
      }),
    ).toBe('后台服务启动失败（退出码 2）：wevir-host: --adapter');
    expect(hostFailureText({ code: 'notReady', seconds: 30 })).toBe('后台服务 30 秒内未就绪');
  });

  it('换语言后用那种语言，重启次数按复数说', async () => {
    setLocale('en', await loadCatalog('en'));
    const failure = {
      code: 'restartsFailed',
      attempts: 3,
      first: { code: 'crashed', exit: { exitCode: 1 } },
      last: { code: 'spawnFailed', path: '/no/node', detail: 'ENOENT' },
    } as const;
    expect(hostFailureText(failure)).toBe(
      'Background service exited unexpectedly (exit code 1); 3 restarts failed: Cannot launch /no/node: ENOENT',
    );
    expect(hostFailureText({ ...failure, attempts: 1 })).toContain('; 1 restart failed: ');
  });
});

describe('describeError', () => {
  it('Host 的错误码按界面语言说；原文只是同义句的不显示', async () => {
    expect(describeError(rpc(ErrorCode.SESSION_NOT_FOUND, 'session ses_x not found'))).toBe(
      '会话不存在',
    );
    setLocale('de', await loadCatalog('de'));
    expect(describeError(rpc(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace ws_x not found'))).toBe(
      'Projekt nicht gefunden',
    );
  });

  it('诊断性的错误码与引擎错误带上原文', () => {
    expect(describeError(rpc(ErrorCode.INTERNAL_ERROR, 'boom'))).toBe('后台服务内部错误：boom');
    expect(
      describeError(
        rpc(ErrorCode.ENGINE_ERROR, '401 Unauthorized', {
          category: 'provider',
          message: '401 Unauthorized',
        }),
      ),
    ).toBe('模型服务错误：401 Unauthorized');
  });

  it('认不出的错误码与其他异常照原文，去掉 Electron 的 IPC 前缀', () => {
    expect(describeError(rpc(-31999, 'something new'))).toBe('something new');
    expect(
      describeError(
        new Error(
          "Error invoking remote method 'wevir:get-host-connection': HostStartError: the host is restarting",
        ),
      ),
    ).toBe('the host is restarting');
    expect(describeError('plain')).toBe('plain');
  });

  it('client-sdk 自己的错误按种类说', () => {
    expect(describeError(new ConnectionLostError('session.send', undefined))).toBe(
      '与后台服务的连接已断开',
    );
    expect(describeError(new FeatureUnavailableError('session.configure', '0.1.0'))).toBe(
      '后台服务版本过旧，不支持此功能',
    );
    expect(describeError(new ProtocolError('bad frame'))).toBe('协议错误：bad frame');
  });
});
