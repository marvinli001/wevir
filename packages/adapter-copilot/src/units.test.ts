import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCopilotResumeError,
  classifyCopilotTurnError,
  isCopilotAuthRequired,
} from './engine.js';
import {
  commonCopilotDirs,
  copilotAcpArgs,
  copilotEnv,
  copilotLoginCommand,
  copilotTokenEnv,
  findCopilot,
  parseCopilotVersion,
} from './launch.js';
import { parseDeviceCode } from './login.js';
import { copilotModels } from './models.js';
import { readSample } from './test-fixtures/harness.js';
import { copilotToolDisplay } from './tool-display.js';
import { copilotRateLimits, rateLimitsOfEvent } from './usage.js';

describe('错误归类（1.0.103 的原文）', () => {
  it('没登录', () => {
    const error = readSample('authError');
    expect(isCopilotAuthRequired(error)).toBe(true);
    expect(classifyCopilotTurnError(error)).toMatchObject({
      category: 'missing_credentials',
      code: -32000,
    });
    expect(isCopilotAuthRequired({ code: -32603, message: 'Unexpected failure' })).toBe(false);
  });
  it('额度与限流', () => {
    expect(
      classifyCopilotTurnError({ code: -32603, message: 'Premium request quota exhausted' }),
    ).toMatchObject({ category: 'provider' });
    expect(classifyCopilotTurnError({ code: -32603, message: 'boom' }).category).toBe('unknown');
  });
  it('session/load 找不到会话是 lost，其余 unknown', () => {
    expect(classifyCopilotResumeError(readSample('notFound'))).toMatchObject({
      failure: { kind: 'lost', reason: 'not_found' },
    });
    expect(classifyCopilotResumeError({ code: -32603, message: 'boom' }).failure).toEqual({
      kind: 'unknown',
    });
  });
});

describe('模型', () => {
  it('按类别找模型选项；当前值是默认；没有选项时读 ACP 的 models；都没有是 undefined', () => {
    const mode = readSample('modeOption');
    const model = readSample('modelOption') as Record<string, unknown>;
    expect(copilotModels([mode, model])).toEqual({
      models: [
        { id: 'auto', displayName: 'Auto' },
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'auto',
    });
    expect(
      copilotModels([mode], {
        currentModelId: 'b',
        availableModels: [
          { modelId: 'a', name: 'A' },
          { modelId: 'b', name: 'B' },
        ],
      }),
    ).toEqual({
      models: [
        { id: 'a', displayName: 'A' },
        { id: 'b', displayName: 'B' },
      ],
      defaultModelId: 'b',
    });
    expect(copilotModels([mode, { ...model, options: [] }])).toBeUndefined();
    expect(copilotModels(undefined)).toBeUndefined();
  });
});

describe('额度', () => {
  it('assistant.usage 的 quotaSnapshots → 每月窗口：已用 = 100 - 剩余，无限的不列', () => {
    const window = {
      usedPercent: 15,
      period: 'monthly',
      scope: 'Premium requests',
      resetsAt: '2026-11-01T00:00:00.000Z',
    };
    expect(rateLimitsOfEvent(readSample('usageEvent'))).toEqual({
      primary: window,
      windows: [window],
    });
    expect(rateLimitsOfEvent({ type: 'assistant.message', data: {} })).toBeUndefined();
  });
  it('没有剩余百分比时按已用 / 总数算；读不懂的不报', () => {
    expect(
      copilotRateLimits({
        custom_quota: { entitlementRequests: 50, usedRequests: 10 },
        premium_interactions: { remainingPercentage: 40 },
        broken: { usedRequests: 1 },
      })?.windows,
    ).toEqual([
      { usedPercent: 60, period: 'monthly', scope: 'Premium requests' },
      { usedPercent: 20, period: 'monthly', scope: 'custom_quota' },
    ]);
    expect(copilotRateLimits({})).toBeUndefined();
    expect(copilotRateLimits(undefined)).toBeUndefined();
  });
});

describe('设备码登录的输出', () => {
  it('取 1.0.103 打印的网址与码', () => {
    expect(
      parseDeviceCode(
        'To authenticate, visit https://github.com/login/device and enter code AB12-CD34\nWaiting for authorization...\n',
      ),
    ).toEqual({ url: 'https://github.com/login/device', code: 'AB12-CD34' });
    expect(
      parseDeviceCode(
        'Failed to open browser. Please visit https://example.ghe.com/login/device and enter the code WXYZ-0000 manually.',
      ),
    ).toEqual({ url: 'https://example.ghe.com/login/device', code: 'WXYZ-0000' });
    expect(parseDeviceCode('Waiting for authorization...')).toBeUndefined();
  });
});

describe('工具展示', () => {
  const update = (kind: string) =>
    ({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind }) as never;
  it('按 Copilot 的工具名，认不出时按 ACP 的 kind', () => {
    expect(copilotToolDisplay('bash', { command: 'ls -la\nmore' }, update('execute'))).toEqual({
      kind: 'shell',
      command: 'ls -la\nmore',
      summary: 'ls -la',
    });
    expect(copilotToolDisplay('str_replace_editor', { path: 'a.ts' }, update('edit'))).toEqual({
      kind: 'edit',
      paths: ['a.ts'],
      summary: 'a.ts',
    });
    expect(
      copilotToolDisplay('Execute shell command', { command: 'pnpm test' }, update('execute')),
    ).toMatchObject({ kind: 'shell', command: 'pnpm test' });
    expect(copilotToolDisplay('mcp__github__search', {}, update('other'))).toEqual({
      kind: 'unknown',
      mcpServer: 'github',
      summary: 'mcp__github__search',
    });
  });
});

describe('启动', () => {
  it('从 `copilot --version` 取版本', () => {
    expect(
      parseCopilotVersion(
        "GitHub Copilot CLI 1.0.103.\nRun 'copilot update' to check for updates.",
      ),
    ).toBe('1.0.103');
    expect(parseCopilotVersion('GitHub Copilot CLI dev')).toBeUndefined();
  });
  it('Wevir 装的那份不在 PATH 里、不在后台自更新；添加的账号的终端命令带上它的 COPILOT_HOME', () => {
    expect(copilotLoginCommand('/x/copilot', true)).toBe('"/x/copilot" login');
    expect(copilotLoginCommand('/usr/local/bin/copilot', false)).toBe('copilot login');
    expect(copilotLoginCommand('/usr/local/bin/copilot', false, '/a/copilot')).toBe(
      'COPILOT_HOME="/a/copilot" copilot login',
    );
    expect(copilotAcpArgs(true)).toEqual(['--acp', '--stdio', '--no-auto-update']);
    expect(copilotAcpArgs(false)).toEqual(['--acp', '--stdio']);
  });
  it('常见目录含官方脚本、Homebrew 与 WinGet 的位置', () => {
    expect(commonCopilotDirs('/h', 'darwin', {}).slice(0, 3)).toEqual([
      '/h/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
    expect(
      commonCopilotDirs('C:\\Users\\me', 'win32', {
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      })[0],
    ).toBe('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links');
  });
  it('环境：PATH 前加 copilot 所在目录，后补存在的常见目录；首个账号保留令牌，添加的账号换掉配置目录、去掉令牌', () => {
    const parent = { PATH: '/usr/bin', GH_TOKEN: 'gho_x', HTTPS_PROXY: 'http://proxy' };
    const env = copilotEnv(
      parent,
      '/opt/copilot/copilot',
      undefined,
      'darwin',
      '/h',
      (dir) => dir === '/opt/homebrew/bin',
    );
    expect(env.PATH).toBe('/opt/copilot:/usr/bin:/opt/homebrew/bin');
    expect(env.GH_TOKEN).toBe('gho_x');
    expect(copilotTokenEnv(env)).toBe('GH_TOKEN');
    const added = copilotEnv(
      parent,
      '/opt/copilot/copilot',
      { copilotHome: '/a/copilot', ghConfigDir: '/a/gh' },
      'darwin',
      '/h',
      () => false,
    );
    expect(added).toMatchObject({
      COPILOT_HOME: '/a/copilot',
      GH_CONFIG_DIR: '/a/gh',
      HTTPS_PROXY: 'http://proxy',
    });
    expect(added.GH_TOKEN).toBeUndefined();
    expect(copilotTokenEnv(added)).toBeUndefined();
  });
  it('显式的路径无效时报错，不退回 PATH；都没有时用 Wevir 装的', () => {
    expect(() => findCopilot({ customPath: '/nowhere/copilot', env: { PATH: '' } })).toThrow();
    const managed = join(import.meta.dirname, 'test-fixtures', 'fake-copilot.mjs');
    expect(
      findCopilot({ env: { PATH: '' }, home: '/nonexistent-home', managedPath: managed }),
    ).toEqual({ path: managed, source: 'component' });
  });
});
