import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HostUnavailableError, RemoteUnreachableError, WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode } from '@wevir/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { approvalPrompt, parseApprovalAnswer } from './attach.js';
import { describeError } from './errors.js';
import { displayWidth, table, truncate } from './format.js';
import { setLocale } from './i18n/index.js';
import { IDENTITY_FILES, loadCliIdentity } from './identity.js';
import { run, useTempDir } from './test-utils.js';

const tempDir = useTempDir();

// runCli 按它的环境变量设语言（测试里默认 WEVIR_LANG=zh）；直接调用的函数在这里固定为中文。
beforeEach(() => setLocale('zh'));

describe('命令行解析', () => {
  it('--help 列出全部命令，wevir <组> --help 列出子命令', async () => {
    const home = tempDir();
    const main = await run(['--help'], { home });
    expect(main.code).toBe(0);
    for (const command of [
      'wevir host start',
      'wevir host status',
      'wevir host stop',
      'wevir workspace add <路径>',
      'wevir workspace list',
      'wevir provider add',
      'wevir provider list',
      'wevir provider test',
      'wevir session new [-w <路径>]',
      'wevir session show <会话 ID>',
      'wevir rule list',
      'wevir session list',
      'wevir session attach <会话 ID>',
    ]) {
      expect(main.out).toContain(command);
    }
    const group = await run(['session', '--help'], { home });
    expect(group.code).toBe(0);
    expect(group.out).toContain('wevir session attach');
    const sub = await run(['session', 'attach', '--help'], { home });
    expect(sub.out).toContain('Ctrl-C');
  });

  it('用法错误：退出码 2，中文说明加下一步', async () => {
    const home = tempDir();
    const cases: Array<[string[], string]> = [
      [['bogus'], '未知命令：bogus'],
      [['host', 'restart'], '未知命令：wevir host restart'],
      [['session', 'new', '--worktree=x'], '选项 --worktree 缺少值或不接受值'],
      [['session', 'config', '--json'], '缺少参数'],
      [['session', 'attach'], '缺少参数'],
      [['workspace', 'list', 'extra'], '多余参数：extra'],
      [['provider', 'add', '--api-key', 'sk-xxx'], '未知选项：--api-key'],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv, { home });
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.err).toContain(`错误：${message}`);
      expect(result.err).toContain('下一步：');
    }
  });

  it('Host 没有运行时提示 wevir host start', async () => {
    const home = tempDir();
    for (const argv of [
      ['session', 'list'],
      ['workspace', 'add', '.'],
      ['provider', 'list'],
    ]) {
      const result = await run(argv, { home });
      expect(result.code).toBe(1);
      expect(result.err).toContain('Wevir Host 未运行');
      expect(result.err).toContain('下一步：运行 wevir host start');
    }
    const status = await run(['host', 'status'], { home });
    expect(status.code).toBe(1);
    expect(status.out).toContain('Host 未运行');
    const stop = await run(['host', 'stop'], { home });
    expect(stop.code).toBe(0);
    expect(stop.out).toContain('Host 未运行');
  });

  it('英文：帮助、用法错误与 Host 没有运行', async () => {
    const home = tempDir();
    const main = await run(['--help'], { home, lang: 'en' });
    expect(main.out).toContain('Usage: wevir <command> [options]');
    expect(main.out).toContain('wevir workspace add <path> [--name <name>]');
    expect(main.out).toContain('Sessions');
    const sub = await run(['session', 'attach', '--help'], { home, lang: 'en' });
    expect(sub.out).toMatch(
      /^Usage: wevir session attach <session ID>\n\nAttach to a session: live output, approvals and follow-ups\n\n/,
    );
    const bogus = await run(['bogus'], { home, lang: 'en' });
    expect(bogus.code).toBe(2);
    expect(bogus.err).toBe('Error: Unknown command: bogus\nNext: Run wevir --help\n');
    const list = await run(['session', 'list'], { home, lang: 'en' });
    expect(list.err).toContain('Error: Wevir Host is not running\nNext: Run wevir host start');
  });

  it('语言跟着 LANG 走，WEVIR_LANG 优先', async () => {
    const home = tempDir();
    const env = { LANG: 'en_US.UTF-8', LC_ALL: '', LC_MESSAGES: '' };
    const byLang = await run(['bogus'], { home, env: { ...env, LANG: 'zh_CN.UTF-8' } });
    expect(byLang.err).toContain('错误：未知命令：bogus');
    const forced = await run(['bogus'], { home, env, lang: 'en' });
    expect(forced.err).toContain('Error: Unknown command: bogus');
  });

  it('--version', async () => {
    const result = await run(['--version'], { home: tempDir() });
    expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('审批输入', () => {
  const options = [
    { optionId: 'allow-once', label: 'Allow', kind: 'allow_once', category: 'allow' as const },
    { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' as const },
  ];

  it('序号、optionId、y / n 都可以', () => {
    expect(parseApprovalAnswer(options, '1')?.optionId).toBe('allow-once');
    expect(parseApprovalAnswer(options, ' 2 ')?.optionId).toBe('reject-once');
    expect(parseApprovalAnswer(options, 'reject-once')?.optionId).toBe('reject-once');
    expect(parseApprovalAnswer(options, 'Y')?.optionId).toBe('allow-once');
    expect(parseApprovalAnswer(options, 'n')?.optionId).toBe('reject-once');
    expect(parseApprovalAnswer(options, '允许')?.optionId).toBe('allow-once');
    expect(parseApprovalAnswer(options, '3')).toBeUndefined();
    expect(parseApprovalAnswer(options, 'maybe')).toBeUndefined();
  });

  it('输入框按请求携带的选项显示', () => {
    expect(approvalPrompt(options)).toBe('审批 [1 允许一次 / 2 拒绝] › ');
    expect(
      approvalPrompt([{ optionId: 'x', label: '仅本次', kind: 'custom', category: 'allow' }]),
    ).toBe('审批 [1 仅本次] › ');
  });
});

describe('错误说明', () => {
  it('Host 与引擎的错误都给出下一步', () => {
    expect(describeError(new HostUnavailableError('not_running', '/x/run/host.json'))).toEqual({
      message: 'Wevir Host 未运行',
      hint: '运行 wevir host start',
    });
    const busy = describeError(
      new WevirRpcError('session.send', {
        code: ErrorCode.SESSION_BUSY,
        message: 'session is busy',
        data: { state: 'running' },
      }),
    );
    expect(busy.message).toBe('会话忙（运行中），消息未发送');
    expect(busy.hint).toContain('Ctrl-C');
    const engine = describeError(
      new WevirRpcError('session.create', {
        code: ErrorCode.ENGINE_ERROR,
        message: 'engine error',
        data: { category: 'provider', message: '401 Unauthorized' },
      }),
    );
    expect(engine.message).toBe('引擎错误（Provider 错误）：401 Unauthorized');
    expect(engine.hint).toContain('wevir provider test');
    const path = describeError(
      new WevirRpcError('workspace.add', {
        code: ErrorCode.WORKSPACE_PATH_INVALID,
        message: 'bad path',
        data: { path: '/nope', reason: 'not_found' },
      }),
    );
    expect(path.message).toBe('工作区目录不存在：/nope');
  });

  it('远程连不上时分清直连与中继：中继本身连不上、证书无效', () => {
    const direct = describeError(new RemoteUnreachableError(['192.168.1.5:47830']));
    expect(direct.message).toBe('连不上那台电脑（试过 192.168.1.5:47830）');
    expect(direct.hint).not.toContain('中继');
    const relay = describeError(
      new RemoteUnreachableError(['192.168.1.5:47830', 'relay.example.com'], 'unreachable'),
    );
    expect(relay.message).toBe('直连连不上那台电脑，中继地址也连不上');
    expect(relay.hint).toContain('中继地址');
    const certificate = describeError(
      new RemoteUnreachableError(['relay.example.com'], 'certificate'),
    );
    expect(certificate.message).toBe('中继的 TLS 证书无效');
  });
});

describe('格式化', () => {
  it('中文按两列宽对齐', () => {
    expect(displayWidth('会话 ID')).toBe(7);
    expect(table(['名称', 'ID'], [['工作区', 'ws_1']])).toBe('名称    ID\n工作区  ws_1');
    expect(truncate('一二三四五六', 7)).toBe('一二三…');
  });
});

describe('客户端身份', () => {
  it('deviceId 与 clientId 持久化在数据目录（0600），再次读取不变', async () => {
    const home = join(tempDir(), 'home');
    const first = await loadCliIdentity(home);
    expect(first.clientKind).toBe('cli');
    expect(first.deviceId).toMatch(/^dev-[0-9a-f]{12}$/);
    expect(first.clientId).toMatch(/^cli-[0-9a-f]{12}$/);
    expect(await loadCliIdentity(home)).toEqual(first);
    const devicePath = join(home, IDENTITY_FILES.deviceId);
    expect(readFileSync(devicePath, 'utf8').trim()).toBe(first.deviceId);
    if (process.platform !== 'win32') expect(statSync(devicePath).mode & 0o777).toBe(0o600);
  });
});
